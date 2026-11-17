/**
 * HardwarePort 适配实现：硬件加速探测 + HEVC 编码器 1 秒自检 + 可观测降级。
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IPC, type BackendDecision, type HardwarePort, type MediaCapabilities, type RuntimePaths } from '../../shared/contracts';
import { detectBackend } from './detectors';
import { logHardware, setHardwareLogger, type ModuleLogSink } from './log';

export class HardwareProbe extends EventEmitter implements HardwarePort {
  private readonly paths: RuntimePaths;

  constructor(paths: RuntimePaths) {
    super();
    this.paths = paths;
  }

  /** 供编排层注入统一 Logger（日志留痕进 app.log 与 IPC.event.log）。 */
  setLogger(logger: ModuleLogSink | null): void {
    setHardwareLogger(logger);
  }

  async detect(caps: MediaCapabilities): Promise<BackendDecision> {
    const decision = await detectBackend(this.paths, caps, (encoder) => this.selfTestEncoder(encoder));
    logHardware(decision.degraded ? 'warn' : 'info', 'hardware.detect.result', {
      platform: decision.platform,
      arch: decision.arch,
      separationBackend: decision.separationBackend,
      encodeEncoder: decision.encodeEncoder,
      previewEncoder: decision.previewEncoder,
      reasonCode: decision.reasonCode,
      degraded: decision.degraded,
    });
    if (decision.degraded) {
      // 禁止静默降级：日志已留痕；再以事件形式把决策交给编排层（信息可达 + 一键展开由 UI 完成）。
      this.emit(IPC.event.fallback, decision);
    }
    return decision;
  }

  /** 用 FFmpeg 生成 1 秒样本尝试编码，成功返回 true；不写明文路径到日志。 */
  async selfTestEncoder(encoder: string): Promise<boolean> {
    // 一次失败可能只是瞬时负载（系统忙/并发任务）：再试一次再判定为不可用，
    // 避免把「偶发超时」当成「编码器不可用」而错误降级。
    let ok = await this.probeOnce(encoder);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 500));
      ok = await this.probeOnce(encoder);
    }
    logHardware(ok ? 'info' : 'warn', 'hardware.encoder.selftest', {
      encoder, result: ok ? '通过' : '失败',
    });
    return ok;
  }

  private async probeOnce(encoder: string): Promise<boolean> {
    const tmp = path.join(os.tmpdir(), `mtv-enc-${randomUUID()}.ts`);
    const args: string[] = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=15:d=1',
      '-t', '1', '-c:v', encoder,
    ];
    if (encoder === 'libx264' || encoder === 'libx265') args.push('-preset', 'veryfast');
    args.push('-pix_fmt', 'yuv420p', '-f', 'mpegts', tmp);
    const ok = await this.runEncoderProbe(encoder, args);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return ok;
  }

  private runEncoderProbe(encoder: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.paths.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, 8000);
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < 2048) stderr += d.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        logHardware('warn', 'hardware.encoder.spawn.error', { encoder });
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          logHardware('warn', 'hardware.encoder.exit', {
            encoder, code, stderrFirstLine: stderr.split(/\r?\n/)[0] ?? '',
          });
        }
        finish(code === 0);
      });
    });
  }
}
