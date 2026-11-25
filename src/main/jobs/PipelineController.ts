import { join, resolve, dirname, basename, extname } from 'node:path';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type {
  MediaPort, AccompanimentPort, LyricsPort, HardwarePort, PreviewPort,
  PresentationPort, JobConfig, JobRecord, StageCode, RuntimePaths,
  ValidationReport, LyricsPayload, BackendDecision, MediaInfo,
} from '../../shared/contracts';
import { STAGE_WEIGHTS, crfFor } from '../../shared/contracts';
import { JobService } from './JobService';
import type { Logger } from '../errors/Logger';
import { makeError, toPayload } from '../errors/AppError';

export interface PipelinePorts {
  media: MediaPort;
  accompaniment: AccompanimentPort;
  lyrics: LyricsPort;
  hardware: HardwarePort;
  preview: PreviewPort;
  presentation: PresentationPort;
  logger: Logger;
  paths: RuntimePaths;
}

type Cancellable = { cancel?: () => Promise<void> | void };

/** 7 阶段编排：权重进度、歌词并行、断点续跑、取消、硬件降级、三分支等价输出。 */
export class PipelineController {
  constructor(private readonly jobs: JobService, private readonly ports: PipelinePorts) {}

  async run(jobId: string): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) throw makeError('E_UNKNOWN', 'APP');
    if (!this.jobs.reserve()) return this.jobs.setStatus(jobId, 'QUEUED');

    let completed = 0;
    const cfg = job.config;
    const wd = this.jobs.workDir(jobId);
    const weights = { ...STAGE_WEIGHTS };
    if (cfg.accompanimentSource === 'imported') {
      weights.ENCODE_MUX += 30;
      weights.ACCOMPANIMENT -= 30;
    }

    // 进入阶段：立刻切 stage 与文案，进度停在上一步的累计值。
    // 之前只在阶段「结束后」推进，导致耗时最长的分离阶段一直显示上一阶段（找歌词）的文案。
    const enter = (stage: StageCode, message: string): void => {
      this.jobs.setProgress(jobId, completed, stage, message);
    };
    // 完成阶段：累加该阶段权重，进度前进。
    const done = (stage: StageCode): void => {
      completed += weights[stage];
      this.jobs.setProgress(jobId, completed, stage, '');
    };
    const checkCancel = (): void => {
      if (this.jobs.isCancelled(jobId)) throw makeError('E_CANCELLED', 'APP');
    };

    try {
      this.jobs.setStatus(jobId, 'RUNNING');
      const caps = await this.ports.media.capabilities();

      // ── PROBE ──────────────────────────────────────────────
      enter('PROBE', '正在读取视频…');
      const media = await this.ports.media.probe(cfg.sourcePath);
      this.jobs.setStatus(jobId, 'RUNNING', { mediaInfo: media });
      if (media.audioStreams.length !== 1 && cfg.originalAudioStreamIndex === undefined) {
        this.jobs.setStatus(jobId, 'NEEDS_CONFIRMATION', { mediaInfo: media });
        this.ports.logger.warn('job.needsConfirmation', { tracks: media.audioStreams.length }, jobId, 'PROBE');
        return this.jobs.get(jobId)!;
      }
      done('PROBE');

      // ── 硬件探测（降级一次，不静默） ────────────────────────
      // 分离后端已由 HardwareProbe 在 detect() 内部按运行时真实 provider 校正过
      // （见 setSeparationProviders 注入），这里拿到的就是「实际生效」的结论。
      const backend: BackendDecision = await this.ports.hardware.detect(caps);
      if (backend.degraded) {
        this.jobs.emitFallback(backend);
        this.ports.logger.warn('hardware.fallback', { code: backend.reasonCode, reason: backend.reasonText }, jobId);
      }

      // ── EXTRACT ────────────────────────────────────────────
      enter('EXTRACT', '正在准备原唱音轨…');
      const originalWav = join(wd, 'original.wav');
      if (!this.jobs.stageDone(jobId, 'EXTRACT') || !existsSync(originalWav)) {
        await this.ports.media.extractOriginal(cfg.sourcePath, originalWav, cfg.originalAudioStreamIndex);
        this.jobs.markStageDone(jobId, 'EXTRACT');
      }
      checkCancel();
      done('EXTRACT');

      // ── LYRICS（并行可选分支，失败不阻断） ───────────────────
      enter('LYRICS', '正在找歌词…');
      const lyricsPromise = this.runLyrics(jobId, cfg, media.durationSec, caps.libass);
      done('LYRICS');

      // ── ACCOMPANIMENT ──────────────────────────────────────
      enter('ACCOMPANIMENT', '正在生成伴奏…');
      let rawAccompaniment = join(wd, 'instrumental.raw.wav');
      if (this.jobs.stageDone(jobId, 'ACCOMPANIMENT') && existsSync(rawAccompaniment)) {
        rawAccompaniment = String(this.jobs.readStageMeta(jobId, 'ACCOMPANIMENT').path ?? rawAccompaniment);
      } else if (cfg.accompanimentSource === 'imported') {
        if (!cfg.accompanimentPath) throw makeError('E_ACCOMPANIMENT_IMPORT_INVALID', 'ACCOMPANIMENT');
        try {
          rawAccompaniment = await this.ports.accompaniment.importFile(cfg.accompanimentPath, originalWav, wd);
        } catch (err) {
          // 时长差 > 2s 属「提示性」结果：已生成 PCM，继续走对齐与封装，不当失败
          const notice = err as { notice?: boolean; outputPath?: string; message?: string };
          if (notice.notice === true && typeof notice.outputPath === 'string') {
            this.ports.logger.warn('accompaniment.versionMismatch', { message: notice.message }, jobId, 'ACCOMPANIMENT');
            rawAccompaniment = notice.outputPath;
          } else {
            throw err;
          }
        }
      } else {
        const selfTest = await this.ports.accompaniment.selfTest();
        if (!selfTest.ok) throw makeError('E_UVR_MODEL_MISSING', 'ACCOMPANIMENT', selfTest.reason);
        // 用户在 L2 显式选了模型就用它；空字符串 = 自动：
        // 按候选顺序取本机已下载的 Roformer（Karaoke 优先，其次 BS），由探测写入 autoSeparationModel；
        // 一个都没有 / torch 不可用则回落运行时默认（MDX / ONNX CPU）。
        const separationModel = cfg.separationModel
          || backend.autoSeparationModel
          || this.ports.paths.modelName;
        this.ports.logger.info('accompaniment.model', {
          model: separationModel,
          source: cfg.separationModel ? 'user' : (backend.autoSeparationModel ? 'auto' : 'fallback'),
        }, jobId, 'ACCOMPANIMENT');
        rawAccompaniment = await this.ports.accompaniment.separate(originalWav, wd, backend, separationModel);
      }
      this.jobs.markStageDone(jobId, 'ACCOMPANIMENT', { path: rawAccompaniment, source: cfg.accompanimentSource });
      checkCancel();
      done('ACCOMPANIMENT');

      // ── ALIGN ──────────────────────────────────────────────
      enter('ALIGN', '正在对齐伴奏…');
      const alignedWav = join(wd, 'instrumental.wav');
      if (!this.jobs.stageDone(jobId, 'ALIGN') || !existsSync(alignedWav)) {
        await this.ports.media.align(rawAccompaniment, originalWav, media.durationSec, alignedWav);
        this.jobs.markStageDone(jobId, 'ALIGN');
      }
      checkCancel();
      done('ALIGN');

      // ── 歌词分支汇合（必须在 ENCODE_MUX 前） ─────────────────
      const lyrics = await lyricsPromise;
      checkCancel();

      // ── ENCODE_MUX（单次 H.265 编码） ────────────────────────
      enter('ENCODE_MUX', '正在压缩视频…');
      const outputPath = this.jobs.defaultOutputPath(cfg);
      // CRF 量纲随编码格式不同（x265 0–51 / SVT-AV1 0–63），按格式取对应档位
      const crf = crfFor(cfg.videoCodec, cfg.compressionPreset);
      const assPath = lyrics.status === 'READY' && cfg.lyrics.burn && caps.libass
        ? await this.ports.lyrics.toAss(lyrics, cfg, media.durationSec, { width: media.width, height: media.height })
        : undefined;
      if (cfg.lyrics.burn && !caps.libass) {
        this.ports.logger.warn('subtitle.libassMissing', undefined, jobId, 'ENCODE_MUX');
      }
      if (!this.jobs.stageDone(jobId, 'ENCODE_MUX') || !existsSync(outputPath)) {
        // 用户选择「覆盖源文件」时输出路径就是源路径。FFmpeg 不能边读边写同一文件，
        // 因此先编码到同目录的临时文件，成功后原子 rename 替换源文件。
        const replacingSource = resolve(outputPath) === resolve(cfg.sourcePath);
        // 编码器按「格式 + 用户偏好 + 探测结果」三层决定：
        // AV1 有 av1_nvenc（RTX 40）才上硬件，否则 SVT-AV1；
        // HEVC 用户选硬件且探测确实给出硬件编码器才用，否则回落 libx265。
        const av1HwReady = backend.av1Encoder === 'av1_nvenc';
        const encoder = cfg.videoCodec === 'av1'
          ? (cfg.videoEncoder === 'hardware' && av1HwReady ? 'av1_nvenc' : 'libsvtav1')
          : cfg.videoEncoder === 'hardware' && backend.encodeEncoder !== 'libx265'
            ? backend.encodeEncoder
            : 'libx265';
        const ext = extname(outputPath);
        const encodeTarget = replacingSource
          ? join(dirname(outputPath), `.${basename(outputPath, ext)}.tmp${ext}`)
          : outputPath;
        try {
          await this.ports.media.encodeMux({
            sourcePath: cfg.sourcePath,
            originalWav,
            accompanimentWav: alignedWav,
            outputPath: encodeTarget,
            container: cfg.container,
            crf,
            encoder,
            codec: cfg.videoCodec,
            ...(assPath ? { subtitleAssPath: assPath } : {}),
            fontsDir: this.ports.paths.fontsDir,
            durationSec: media.durationSec,
            colorArgs: buildColorArgs(media),
          });
          if (replacingSource) {
            renameSync(encodeTarget, outputPath);
            this.ports.logger.info('output.replacedSource', { path: outputPath }, jobId, 'ENCODE_MUX');
          }
        } finally {
          // 编码失败时清掉临时文件，避免在源目录留下垃圾
          if (replacingSource && existsSync(encodeTarget)) {
            try { rmSync(encodeTarget, { force: true }); } catch { /* 忽略 */ }
          }
        }
        this.jobs.markStageDone(jobId, 'ENCODE_MUX', { outputPath });
      }
      checkCancel();
      done('ENCODE_MUX');

      // ── VALIDATE ────────────────────────────────────────────
      enter('VALIDATE', '正在检查结果…');
      const report: ValidationReport = await this.ports.media.validate(outputPath, media, cfg, {
        accompanimentSource: cfg.accompanimentSource,
        backend: backend.separationBackend,
        compressionPreset: cfg.compressionPreset,
        ...(assPath ? { subtitleAssPath: assPath } : {}),
      });
      this.jobs.setProgress(jobId, 100, 'VALIDATE', '正在检查结果…');
      this.ports.logger.info('job.validated', { passed: report.passed, checks: report.checks.length }, jobId, 'VALIDATE');
      return this.jobs.setStatus(jobId, report.passed ? 'COMPLETED' : 'FAILED', {
        outputPath, report,
        ...(report.passed ? {} : { error: toPayload(makeError('E_VALIDATION_TRACK_ORDER', 'VALIDATE'), 'VALIDATE') }),
      });
    } catch (err) {
      const payload = toPayload(err);
      if (payload.code === 'E_CANCELLED') {
        return this.jobs.setStatus(jobId, 'CANCELLED');
      }
      // 把错误自带的原因文本一并落盘：适配层的 stderr 截断常常是唯一根因线索
      const causeDetail = (err as { causeDetail?: unknown } | null)?.causeDetail;
      const causeText = typeof causeDetail === 'string'
        ? causeDetail.slice(0, 800)
        : causeDetail === undefined ? '' : JSON.stringify(causeDetail).slice(0, 800);
      this.ports.logger.error('job.failed', {
        code: payload.code,
        stage: payload.stage,
        detail: String(err),
        ...(causeText ? { cause: causeText } : {}),
      }, jobId);
      return this.jobs.setStatus(jobId, 'FAILED', { error: payload });
    } finally {
      this.jobs.release();
    }
  }

  /** 歌词三分支：失败 / 为空 / 关闭烧录均产出等价的无字幕合法输出。 */
  private async runLyrics(jobId: string, cfg: JobConfig, durationSec: number, libass: boolean): Promise<LyricsPayload> {
    const empty = (status: 'UNAVAILABLE' | 'EMPTY', reasonCode?: LyricsPayload['reasonCode']): LyricsPayload => ({
      status, lines: [], version: cfg.lyrics.version, format: cfg.lyrics.format, source: cfg.lyrics.source,
      ...(reasonCode ? { reasonCode } : {}),
    });
    if (!cfg.lyrics.enabled) {
      this.jobs.setStatus(jobId, 'RUNNING', { lyricsStatus: 'OFF' });
      return empty('UNAVAILABLE');
    }
    try {
      let payload: LyricsPayload;
      if (cfg.lyrics.source === 'online') {
        payload = await this.ports.lyrics.fetchOnline(cfg.lyrics.songLink ?? '');
      } else if (cfg.lyrics.source === 'local') {
        payload = await this.ports.lyrics.fromLocal(cfg.lyrics.localPath ?? '', cfg.lyrics.format);
      } else {
        payload = await this.ports.lyrics.fromPasted(cfg.lyrics.pastedText ?? '', cfg.lyrics.format);
      }
      if (payload.status !== 'READY' || payload.lines.length === 0) {
        this.jobs.setStatus(jobId, 'RUNNING', { lyricsStatus: payload.status === 'EMPTY' ? 'EMPTY' : 'UNAVAILABLE' });
        this.ports.logger.warn(`lyrics.${payload.status === 'EMPTY' ? 'empty' : 'unavailable'}`, { reason: payload.reasonCode }, jobId, 'LYRICS');
        return empty(payload.status === 'EMPTY' ? 'EMPTY' : 'UNAVAILABLE', payload.reasonCode);
      }
      // 超时长歌词由 toAss 裁剪；此处只校验时间轴不晚于视频时长
      const clipped = payload.lines.filter((l) => l.startMs < durationSec * 1000);
      this.jobs.setStatus(jobId, 'RUNNING', { lyricsStatus: cfg.lyrics.burn && libass ? 'BURN_CONFIRMED' : 'READY' });
      return { ...payload, lines: clipped };
    } catch (err) {
      this.jobs.setStatus(jobId, 'RUNNING', { lyricsStatus: 'UNAVAILABLE' });
      this.ports.logger.warn('lyrics.unavailable', { detail: String(err) }, jobId, 'LYRICS');
      return empty('UNAVAILABLE', 'E_LYRICS_PARSE');
    }
  }

  /** 取消时终止所有适配器的子进程树。 */
  async cancelAll(jobId: string): Promise<void> {
    this.jobs.cancel(jobId);
    for (const port of [this.ports.media, this.ports.accompaniment, this.ports.preview] as Cancellable[]) {
      try { await port.cancel?.(); } catch { /* 忽略清理异常 */ }
    }
  }
}

/** 色彩元数据透传，避免 HDR / 广色域源在重编码后偏色。 */
function buildColorArgs(media: MediaInfo): string[] {
  const args: string[] = [];
  if (media.colorPrimaries) args.push('-color_primaries', media.colorPrimaries);
  if (media.colorTransfer) args.push('-color_trc', media.colorTransfer);
  if (media.colorSpace) args.push('-colorspace', media.colorSpace);
  return args;
}
