/**
 * 媒体适配层 —— MediaPort 实现（§4.2 / §5.2 / §5.3 / §6.3 / §6.4 / §9.1）。
 *
 * 编排层只依赖冻结的 MediaPort 接口；本类负责 FFmpeg / FFprobe 的全部外部调用：
 * 能力探测、源探测、原唱提取、伴奏对齐、单次 H.265 编码封装、输出校验。
 * 所有子进程一律以 argv 数组 spawn，路径中的中文 / 空格 / 盘符冒号均不经过 shell。
 */
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  DEFAULTS, TRACK_METADATA,
  type EncodeMuxInput, type ErrorCode, type JobConfig, type MediaCapabilities,
  type MediaInfo, type MediaPort, type RuntimePaths, type StageCode,
  type ValidationReport,
} from '../../shared/contracts';
import { AppError, makeError } from '../errors/AppError';
import { escapeFilterPath, parseNamedList, runProcess, type RunContext } from './runner';
import { ffprobeJson, parseMediaInfo, parseOutputInfo, parsePackets } from './ffprobe';
import { analyzePcm16Wav } from './pcm';
import { buildValidationReport, type AssCheck, type QualitySample } from './validate';

/**
 * 不同编码器的质量参数映射。
 *
 * 关键差异：VideoToolbox 的 `-q:v` 是 **0–100、值越大画质越好**，
 * 与 x265 的 CRF（0–51、越小越好）方向相反。早期实现直接把 CRF 当 q 传，
 * 等于用「27/100」的质量上限，实测 VMAF 只有 63（源同段 VMAF≈96），画质劣化明显。
 * 这里按线性反向映射：crf 10→q100、crf 51→q0。
 */
function qualityArgs(encoder: string, crf: number): string[] {
  const e = encoder.toLowerCase();
  // SVT-AV1：preset 8 在本机实测比 libx265 fast 更快，画质只比 preset 4 差约 5%
  if (e.includes('svtav1')) return ['-crf', String(crf), '-preset', '8'];
  // libaom 的「恒定质量」需要把目标码率置 0，否则 CRF 不生效
  if (e.includes('libaom')) return ['-crf', String(crf), '-b:v', '0', '-cpu-used', '6'];
  // NVENC 的 cq 与 x265 的 CRF 不是同一把尺子：实测（1080p / 60s / hvc1）
  //   cq=crf28 → 138% 源体积；cq=33 → 84%（≈ x265 crf28 的 85%），VMAF 94.7 vs 93.0。
  // 故按 cq = crf + 5 映射；同时必须显式 `-rc vbr -b:v 0`，否则残留的默认码率目标
  // 会把「恒定质量」顶成高码率（实测 -cq 28 不加 -b:v 0 也是 138%）。
  // AV1 NVENC：实测（1080p / 20s / 同一无损参考）cq=crf+4 时体积约 +5%、VMAF 低约 1 分；
  // cq=crf+5 体积持平但 VMAF 低约 1.5 分。取 +4 偏向画质；量程 0–63，不能套 HEVC 的 51 上限。
  if (e === 'av1_nvenc') {
    const cq = Math.min(63, Math.max(0, Math.round(crf) + 4));
    return ['-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-preset', 'p5', '-tune', 'hq'];
  }
  if (e.includes('nvenc')) {
    const cq = Math.min(51, Math.max(0, Math.round(crf) + 5));
    return ['-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-preset', 'p5', '-tune', 'hq'];
  }
  if (e.includes('videotoolbox')) {
    const q = Math.round(100 - (crf - 10) * (100 / 41));
    return ['-q:v', String(Math.min(100, Math.max(10, q)))];
  }
  // 软件编码：preset fast 在 8 核 M 系列上约 1/3 实时，画质与 medium 仅差约 1 分 VMAF
  return ['-crf', String(crf), '-preset', 'fast'];
}

/** ASS 时间 "0:00:11.93" → 秒。 */
function parseAssTime(raw: string): number | undefined {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,2}))?\s*$/.exec(raw.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const cc = m[4] ? Number(m[4]) / (m[4].length === 2 ? 100 : 10) : 0;
  return h * 3600 + mm * 60 + ss + cc;
}

async function statSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

/** 依据 FFmpeg stderr 把编码阶段失败细分为不同错误码（§8.1 错误码分组）。 */
function classifyEncodeFailure(err: unknown): unknown {
  if (!(err instanceof AppError) || err.code === 'E_CANCELLED') return err;
  const detail = String(err.causeDetail ?? '').toLowerCase();
  if (/subtitles|libass|error setting option filename|error initializing filter/.test(detail)) {
    return makeError('E_SUBTITLE_LIBASS', err.stage, err.causeDetail);
  }
  if (/muxer|muxing|write header|error opening output|could not write|unable to choose an output format/.test(detail)) {
    return makeError('E_FFMPEG_MUX', err.stage, err.causeDetail);
  }
  return err;
}

export class MediaAdapter implements MediaPort {
  private readonly paths: RuntimePaths;
  private abortController = new AbortController();
  private boundExternal?: AbortSignal;
  private cachedCapabilities?: MediaCapabilities;
  private cachedFilterNames?: Set<string>;

  constructor(paths: RuntimePaths) {
    this.paths = paths;
  }

  /** 外部信号 abort 时联动终止本适配器在途子进程（箭头函数动态读取当前 controller）。 */
  private readonly onExternalAbort = (): void => {
    this.abortController.abort();
  };

  /**
   * 编排层 PipelineController.cancelAll() 的集成点：终止所有在途 FFmpeg / FFprobe 子进程树（§8.3）。
   * MediaPort 方法签名未含 signal，故由适配器自己持有 AbortController。
   */
  cancel(): void {
    this.abortController.abort();
  }

  /** 可选：把编排层的任务级 AbortSignal 桥接到内部控制器。 */
  setAbortSignal(signal: AbortSignal): void {
    if (this.boundExternal) this.boundExternal.removeEventListener('abort', this.onExternalAbort);
    this.boundExternal = signal;
    signal.addEventListener('abort', this.onExternalAbort, { once: true });
    if (signal.aborted) this.abortController.abort();
  }

  private runContext(label: string, stage: StageCode, errorCode: ErrorCode): RunContext {
    return { label, stage, errorCode, signal: this.abortController.signal };
  }

  private async getFilterNames(): Promise<Set<string>> {
    if (this.cachedFilterNames) return this.cachedFilterNames;
    const res = await runProcess(this.paths.ffmpegPath, ['-hide_banner', '-filters'],
      this.runContext('检测滤镜', 'PROBE', 'E_PROBE_FAILED'));
    this.cachedFilterNames = parseNamedList(`${res.stdout}\n${res.stderr}`);
    return this.cachedFilterNames;
  }

  async capabilities(): Promise<MediaCapabilities> {
    // 每个 job 以 capabilities() 起步；上次取消后重建控制器，避免新任务被旧取消态影响
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    if (this.cachedCapabilities) return this.cachedCapabilities;
    const [encRes, muxRes] = await Promise.all([
      runProcess(this.paths.ffmpegPath, ['-hide_banner', '-encoders'],
        this.runContext('检测编码器', 'PROBE', 'E_PROBE_FAILED')),
      runProcess(this.paths.ffmpegPath, ['-hide_banner', '-muxers'],
        this.runContext('检测封装器', 'PROBE', 'E_PROBE_FAILED')),
    ]);
    // 验证 ffprobe 二进制可用
    await runProcess(this.paths.ffprobePath, ['-version'],
      this.runContext('读取 FFprobe 版本', 'PROBE', 'E_PROBE_FAILED'));
    const filters = await this.getFilterNames();
    const encoders = parseNamedList(`${encRes.stdout}\n${encRes.stderr}`);
    const muxers = parseNamedList(`${muxRes.stdout}\n${muxRes.stderr}`);
    const caps: MediaCapabilities = {
      ffmpegPath: this.paths.ffmpegPath,
      ffprobePath: this.paths.ffprobePath,
      libx265: encoders.has('libx265'),
      hevcVideotoolbox: encoders.has('hevc_videotoolbox'),
      hevcNvenc: encoders.has('hevc_nvenc'),
      libx264: encoders.has('libx264'),
      h264Videotoolbox: encoders.has('h264_videotoolbox'),
      h264Nvenc: encoders.has('h264_nvenc'),
      av1Nvenc: encoders.has('av1_nvenc'),
      // libass 能力以 subtitles / ass 滤镜是否存在为准（本机 FFmpeg 8.1 实测缺 libass）
      libass: filters.has('subtitles') || filters.has('ass'),
      hlsMuxer: muxers.has('hls'),
    };
    this.cachedCapabilities = caps;
    return caps;
  }

  async probe(filePath: string): Promise<MediaInfo> {
    const data = await ffprobeJson(this.paths.ffprobePath,
      ['-show_streams', '-show_format', filePath],
      this.runContext('探测源文件', 'PROBE', 'E_PROBE_FAILED'));
    return parseMediaInfo(filePath, data, await statSize(filePath));
  }

  async extractOriginal(sourcePath: string, destWav: string, audioStreamIndex?: number): Promise<void> {
    // 非单轨输入经用户确认后使用其指定的全局 stream index；默认取第一条音频流 0:a:0
    const mapArg = audioStreamIndex === undefined ? '0:a:0' : `0:${audioStreamIndex}`;
    // 源常见「音轨比画面短」（灌录差异 / AAC 编码边界）。以容器（≈视频）时长为基准补齐，
    // 否则 a:0 解析时长会短于视频：末尾被提前截掉，且全程漂移断言必然失败。
    const info = await this.probe(sourcePath);
    const target = info.durationSec > 0 ? info.durationSec : undefined;
    const args = [
      '-hide_banner', '-nostdin', '-nostats', '-y',
      '-i', sourcePath,
      '-map', mapArg, '-vn',
      '-ac', '2', '-ar', '48000',
    ];
    if (target !== undefined) args.push('-af', 'apad', '-t', String(target));
    args.push('-c:a', 'pcm_s16le', destWav);
    await runProcess(this.paths.ffmpegPath, args, this.runContext('提取原唱基准', 'EXTRACT', 'E_INPUT_NO_AUDIO'));
  }

  async align(accompanimentWav: string, originalWav: string, durationSec: number, destWav: string): Promise<void> {
    // 边界校验：原唱基准 WAV 必须存在；裁剪 / 补零仍严格以源时长 durationSec 为唯一基准
    try {
      await fs.access(originalWav);
    } catch (err) {
      throw makeError('E_UNKNOWN', 'ALIGN', `原唱基准 WAV 不存在：${originalWav}\n${String(err)}`);
    }
    // 重采样 + 声道统一 + 补零 + 精确裁剪 + pts 归零；async=0 与禁用 atempo 确保不拉伸、不改变内容
    const filter = [
      'aresample=48000:async=0',
      'aformat=sample_fmts=s16:channel_layouts=stereo',
      'apad',
      `atrim=0:${durationSec}`,
      'asetpts=N/SR/TB',
    ].join(',');
    await runProcess(this.paths.ffmpegPath, [
      '-hide_banner', '-nostdin', '-nostats', '-y',
      '-i', accompanimentWav,
      '-map', '0:a:0', '-vn',
      '-af', filter,
      '-ar', '48000', '-ac', '2',
      '-c:a', 'pcm_s16le',
      '-t', String(durationSec),
      destWav,
    ], this.runContext('伴奏对齐', 'ALIGN', 'E_UNKNOWN'));

    // 削波 / 直流 / 静音检查：只读产物、不修改内容、不阻断主流程（§6.2 为告警级）
    const analysis = await analyzePcm16Wav(destWav);
    if (analysis.silent) {
      console.warn('[MediaAdapter] 伴奏质量检查：输出接近全静音，疑似音源无效，请人工复核');
    }
    if (analysis.clippedRatio > 0.01) {
      console.warn(`[MediaAdapter] 伴奏质量检查：检测到削波样本 ${(analysis.clippedRatio * 100).toFixed(2)}%`);
    }
    if (Math.abs(analysis.dcOffset) > 0.05) {
      console.warn(`[MediaAdapter] 伴奏质量检查：检测到直流偏移 ${analysis.dcOffset.toFixed(4)}`);
    }
  }

  async encodeMux(input: EncodeMuxInput): Promise<{ outputPath: string }> {
    // 最后一道防线：ffmpeg 带 -y，输出路径若与源相同会直接毁掉源文件
    if (path.resolve(input.sourcePath) === path.resolve(input.outputPath)) {
      throw new Error('输出路径与源文件相同，已阻止覆盖源文件');
    }
    const args: string[] = [
      '-hide_banner', '-nostdin', '-nostats', '-y',
      // 保留源旋转显示元数据，避免 ffmpeg 默认 autorotate 物理旋转画面（§6.3）
      '-noautorotate',
      '-i', input.sourcePath,
      '-i', input.originalWav,
      '-i', input.accompanimentWav,
      // -map 书写顺序即音轨顺序：a:0 原唱 / a:1 伴奏（§5.2 唯一权威保证）
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
      '-c:v', input.encoder,
      ...qualityArgs(input.encoder, input.crf),
      '-pix_fmt', 'yuv420p',
    ];

    // 颜色参数透传（§5.3 / §6.3），由编排层依据 probe 结果构造
    args.push(...input.colorArgs);

    // 烧录字幕并入同一次编码通道；libass 缺失时降级为无字幕（§8.2，不阻断主流程）
    if (input.subtitleAssPath) {
      const filters = await this.getFilterNames();
      if (filters.has('subtitles')) {
        const fontsDir = input.fontsDir ?? this.paths.fontsDir;
        args.push('-vf',
          `subtitles=${escapeFilterPath(input.subtitleAssPath)}:fontsdir=${escapeFilterPath(fontsDir)}`);
      } else {
        console.warn('[MediaAdapter] FFmpeg 缺少 libass/subtitles 滤镜，已降级为无字幕输出（不阻断主流程）');
      }
    }

    args.push('-fps_mode', 'passthrough', '-map_metadata', '0');

    // 显式指定容器格式：不依赖扩展名推断，保证用户自定义命名也能正确封装
    args.push('-f', input.container === 'mkv' ? 'matroska' : 'mp4');
    if (input.container === 'mp4') {
      // HEVC 必须 hvc1（hev1 会让部分播放器不认）；AV1 用 av01
      args.push('-tag:v', input.codec === 'av1' ? 'av01' : DEFAULTS.videoTag, '-movflags', '+faststart');
    }

    args.push(
      // MP4 的 track 名在不同 FFmpeg 版本落在不同字段：8.x 写 udta/name（读作 tags.name），
      // 7.x 只认 handler_name。两个都写，保证跨版本都能识别原唱 / 伴奏。
      '-metadata:s:a:0', `title=${TRACK_METADATA.original.title}`,
      '-metadata:s:a:0', `handler_name=${TRACK_METADATA.original.title}`,
      '-metadata:s:a:0', `language=${TRACK_METADATA.original.language}`,
      '-metadata:s:a:1', `title=${TRACK_METADATA.accompaniment.title}`,
      '-metadata:s:a:1', `handler_name=${TRACK_METADATA.accompaniment.title}`,
      '-metadata:s:a:1', `language=${TRACK_METADATA.accompaniment.language}`,
      '-disposition:a:0', TRACK_METADATA.original.disposition,
      '-disposition:a:1', TRACK_METADATA.accompaniment.disposition,
      '-c:a', DEFAULTS.audioCodec,
      '-b:a', DEFAULTS.audioBitrate,
      '-ar', String(DEFAULTS.audioSampleRate),
      '-ac', String(DEFAULTS.audioChannels),
      '-t', String(input.durationSec),
      input.outputPath,
    );

    try {
      await runProcess(this.paths.ffmpegPath, args,
        this.runContext('H.265 编码与双音轨封装', 'ENCODE_MUX', 'E_ENCODE_HEVC_FAILED'));
    } catch (err) {
      throw classifyEncodeFailure(err);
    }
    return { outputPath: input.outputPath };
  }

  async validate(
    outputPath: string,
    source: MediaInfo,
    config: JobConfig,
    reportMeta: Partial<ValidationReport>,
  ): Promise<ValidationReport> {
    const ctx = this.runContext('校验输出文件', 'VALIDATE', 'E_PROBE_FAILED');
    const [streamData, packetData] = await Promise.all([
      ffprobeJson(this.paths.ffprobePath, ['-show_streams', '-show_format', outputPath], ctx),
      ffprobeJson(this.paths.ffprobePath,
        ['-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time', outputPath], ctx),
    ]);
    const output = parseOutputInfo(streamData, await statSize(outputPath));
    const packets = parsePackets(packetData);

    const sourceSizeBytes = reportMeta.sourceSizeBytes ?? await statSize(source.path);
    const outputSizeBytes = output.sizeBytes || await statSize(outputPath);

    const ass = config.lyrics.burn
      ? await this.inspectAss(await this.locateAss(config, reportMeta))
      : undefined;
    const quality = await this.sampleQuality(outputPath, source.path, config.lyrics.burn);

    return buildValidationReport({
      output, packets, source, config, reportMeta,
      sourceSizeBytes, outputSizeBytes, quality, ass,
    });
  }

  /** 定位 ASS：优先编排层在 reportMeta 附加的 subtitleAssPath，其次输出目录下的 lyrics.ass。 */
  private async locateAss(config: JobConfig, reportMeta: Partial<ValidationReport>): Promise<string | undefined> {
    const extra = reportMeta as Partial<ValidationReport> & { subtitleAssPath?: string };
    if (extra.subtitleAssPath) {
      try {
        await fs.access(extra.subtitleAssPath);
        return extra.subtitleAssPath;
      } catch {
        // 附加路径不可用，继续按约定目录查找
      }
    }
    const candidate = path.join(config.outputDir, 'lyrics.ass');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }

  /** 解析 ASS 的末句结束时间与句数（V-09）。 */
  private async inspectAss(assPath: string | undefined): Promise<AssCheck> {
    if (!assPath) return { found: false, lastEndSec: 0, lineCount: 0 };
    try {
      const text = await fs.readFile(assPath, 'utf8');
      let endIndex = 2;
      for (const line of text.split(/\r?\n/)) {
        const fm = /^\s*Format:\s*(.+)$/i.exec(line);
        if (!fm) continue;
        const cols = fm[1].split(',').map((s) => s.trim().toLowerCase());
        const idx = cols.indexOf('end');
        if (idx >= 0) endIndex = idx;
      }
      let lastEndSec = 0;
      let lineCount = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!/^\s*Dialogue:/i.test(line)) continue;
        const cols = line.replace(/^\s*Dialogue:\s*/i, '').split(',');
        const t = parseAssTime(cols[endIndex] ?? '');
        if (t === undefined) continue;
        lineCount++;
        if (t > lastEndSec) lastEndSec = t;
      }
      return { found: true, lastEndSec, lineCount };
    } catch {
      return { found: false, lastEndSec: 0, lineCount: 0 };
    }
  }

  /**
   * 画质抽样（V-06）：本机有 psnr / libvmaf 时比对前 3 秒；烧录版因字幕区差异需人工复核。
   * 任何失败都返回 available=false（标 warn），绝不伪造通过。
   */
  private async sampleQuality(outputPath: string, sourcePath: string, burn: boolean): Promise<QualitySample> {
    if (burn) {
      return { available: false, kind: 'psnr', value: 0, reason: '烧录版字幕区差异需人工复核' };
    }
    const filters = await this.getFilterNames();
    if (!filters.has('psnr') && !filters.has('libvmaf')) {
      return { available: false, kind: 'psnr', value: 0, reason: '本机 FFmpeg 无 psnr / libvmaf 滤镜' };
    }
    const args = [
      '-hide_banner', '-nostdin', '-nostats',
      '-t', '3', '-i', outputPath,
      '-t', '3', '-i', sourcePath,
      '-filter_complex', '[0:v][1:v]psnr',
      '-f', 'null', '-',
    ];
    try {
      const res = await runProcess(this.paths.ffmpegPath, args,
        this.runContext('画质抽样比对', 'VALIDATE', 'E_PROBE_FAILED'));
      const m = /average:\s*([\d.]+|inf)/i.exec(`${res.stderr}\n${res.stdout}`);
      if (!m) {
        return { available: false, kind: 'psnr', value: 0, reason: '未解析到 PSNR 汇总行' };
      }
      const value = m[1].toLowerCase() === 'inf'
        ? Number.POSITIVE_INFINITY
        : Number.parseFloat(m[1]);
      return {
        available: Number.isFinite(value),
        kind: 'psnr',
        value,
        reason: Number.isFinite(value) ? undefined : 'PSNR 为无穷，需人工复核',
      };
    } catch {
      return { available: false, kind: 'psnr', value: 0, reason: '画质抽样计算失败' };
    }
  }
}
