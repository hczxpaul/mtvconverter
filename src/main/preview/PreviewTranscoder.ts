/**
 * 预览转码：FFmpeg 把源 / 输出实时转 H.264/AAC 的 HLS。
 * 输出一条纯视频 variant 与两条独立音频 variant（对应原唱 / 伴奏），由 LocalPreviewServer
 * 组装成含 audio rendition 的 master playlist；切轨不重载视频流。
 * 硬件 H.264 优先、CPU libx264 veryfast；低线程低码率与主管线错峰；停止即杀进程并清理切片。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULTS, type AudioTrack, type BackendDecision } from '../../shared/contracts';
import { errText, logPreview } from './log';

export interface PreviewTranscoderOptions {
  ffmpegPath: string;
  inputPath: string;
  workDir: string;
  audioTracks: AudioTrack[];
  backend: BackendDecision;
}

export class PreviewTranscoder {
  private child: ChildProcess | null = null;
  private stderr = '';
  private readonly opts: PreviewTranscoderOptions;

  constructor(opts: PreviewTranscoderOptions) {
    this.opts = opts;
  }

  /** 启动并等待首个切片就绪；首选（硬件）编码失败自动降级一次到 libx264。 */
  async start(): Promise<void> {
    const preferred = this.pickEncoder();
    this.spawnFfmpeg(preferred);
    try {
      // 1080p 长视频首片需要「片段时长 + 编码启动 + 解码」叠加，10s 在负载下偏紧；
      // 放宽到 25s，宁可多等也不要把可用的 HLS 误判成失败而降级成单音轨直放。
      await this.waitForFirstOutput(25_000);
    } catch (firstErr) {
      if (preferred === 'libx264') throw firstErr;
      // 自动降级一次：写原因码、不静默
      logPreview('warn', 'preview.transcode.encoder.fallback', {
        reasonCode: 'E_PREVIEW_PROXY', from: preferred, to: 'libx264', cause: errText(firstErr),
      });
      await this.killChild();
      await fsp.rm(this.opts.workDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.mkdir(this.opts.workDir, { recursive: true });
      this.spawnFfmpeg('libx264');
      await this.waitForFirstOutput(10_000); // 第二次失败抛出，交给整体降级链
    }
  }

  /** 停止子进程并清理切片目录（切换预览对象 / 关闭页面 / 任务完成或取消 / TTL 时调用）。 */
  async stop(): Promise<void> {
    await this.killChild();
    await fsp.rm(this.opts.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private pickEncoder(): string {
    const e = this.opts.backend.previewEncoder;
    return e === 'h264_nvenc' || e === 'h264_videotoolbox' || e === 'libx264' ? e : 'libx264';
  }

  private buildArgs(encoder: string): string[] {
    const { inputPath, workDir, audioTracks } = this.opts;
    const hasAccomp = audioTracks.includes('accompaniment');
    // var_stream_map 的流顺序即输出 pl_%v.m3u8 的编号：0 视频 / 1 原唱 / 2 伴奏
    const varMap = hasAccomp ? 'v:0 a:0 a:1' : 'v:0 a:0';
    const args: string[] = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0',
    ];
    if (hasAccomp) args.push('-map', '0:a:1');
    args.push(
      '-c:v', encoder,
      '-b:v', '1600k', '-maxrate', '2000k', '-bufsize', '3200k',
      '-pix_fmt', 'yuv420p',
      // 按切片时长强制关键帧，保证 -hls_time 真正按 4s 切片（否则 libx264 默认
      // GOP 250 帧会让一个切片长达十几秒，起播慢、寻址粒度差）。
      '-force_key_frames', `expr:gte(t,n_forced*${DEFAULTS.previewSegmentSec})`,
      // 低线程 + 低码率：与主管线的 H.265 编码错峰，避免抢占 CPU / GPU
      '-threads', encoder === 'libx264' ? '2' : '1',
    );
    if (encoder === 'libx264') args.push('-preset', 'veryfast', '-profile:v', 'baseline');
    args.push(
      '-c:a', 'aac', '-b:a', '128k',
      '-ar', String(DEFAULTS.audioSampleRate), '-ac', String(DEFAULTS.audioChannels),
      '-f', 'hls',
      '-hls_time', String(DEFAULTS.previewSegmentSec),
      // 用 event 而非 vod：vod 模式下 FFmpeg 只在**整片转完**才写 playlist，
      // 4 分钟 1080p 要转数分钟，预览会一直等到超时并降级。event 模式边转边追加，
      // 首片即可开播；结束时 FFmpeg 自动补 ENDLIST。配合 hls_list_size=0 保留全部切片。
      '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_segment_filename', path.join(workDir, 'seg_%v_%d.ts'),
      '-var_stream_map', varMap,
      '-master_pl_name', 'ffmaster.m3u8',
      path.join(workDir, 'pl_%v.m3u8'),
    );
    return args;
  }

  private spawnFfmpeg(encoder: string): void {
    const args = this.buildArgs(encoder);
    const child = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    this.stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (this.stderr.length < 4096) this.stderr += d.toString('utf8');
    });
    child.on('error', (e) => { this.stderr += `\n${e.message}`; });
    // 只记编码器与切片时长，不记录命令全文（含绝对路径）与任何令牌
    logPreview('info', 'preview.transcode.spawn', { encoder, segmentSec: DEFAULTS.previewSegmentSec });
  }

  /** 等待首个视频 playlist + 切片，优先等 ENDLIST（VOD 完整）以保证从头播、可寻址。 */
  private waitForFirstOutput(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let exited = false;
      let exitCode: number | null = null;
      let timer: NodeJS.Timeout | undefined;
      const onClose = (code: number | null): void => { exited = true; exitCode = code; };
      this.child?.once('close', onClose);
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.child?.off('close', onClose);
      };
      /** vod=已写 ENDLIST，partial=仅首片就绪，none=尚未产出。 */
      const check = async (): Promise<'vod' | 'partial' | 'none'> => {
        try {
          const names = await fsp.readdir(this.opts.workDir);
          const hasSegment = names.some((n) => /^seg_\d+_\d+\.ts$/.test(n));
          if (!names.includes('pl_0.m3u8') || !hasSegment) return 'none';
          const text = await fsp.readFile(path.join(this.opts.workDir, 'pl_0.m3u8'), 'utf8');
          return text.includes('#EXT-X-ENDLIST') ? 'vod' : 'partial';
        } catch { return 'none'; }
      };
      const tick = (): void => {
        void (async () => {
          const state = await check();
          // 首片就绪即可开播：不必等 ENDLIST（event 模式下 ENDLIST 要到转码结束才写）。
          if (state === 'vod' || state === 'partial') { cleanup(); resolve(); return; }
          if (exited) {
            cleanup();
            reject(new Error(`FFmpeg 提前退出（code=${exitCode}）：${this.stderr.split(/\r?\n/)[0] ?? ''}`));
            return;
          }
          if (Date.now() > deadline) {
            cleanup();
            // 带上 FFmpeg 最后两行 stderr，否则失败原因只有「超时」无法定位
            const tail = this.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
            reject(new Error(`预览首个切片生成超时（${Math.round(timeoutMs / 1000)}s）${tail ? `：${tail}` : ''}`));
            return;
          }
          timer = setTimeout(tick, 200);
        })();
      };
      timer = setTimeout(tick, 0);
    });
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('close', done);
      child.kill('SIGTERM');
      const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500);
      const guard = setTimeout(done, 3000);
      force.unref?.();
      guard.unref?.();
    });
  }
}
