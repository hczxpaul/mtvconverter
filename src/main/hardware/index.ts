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
import { detectBackend, pickAutoSeparationModel, reconcileSeparation } from './detectors';
import { logHardware, setHardwareLogger, type ModuleLogSink } from './log';

export class HardwareProbe extends EventEmitter implements HardwarePort {
  private readonly paths: RuntimePaths;
  /** 分离运行时真实 provider 的来源（由组装层注入）；未注入时不做校正 */
  private providers?: () => Promise<string[]>;
  /** 分离运行时真实 torch 设备来源（Roformer 走 torch，决定 roformerReady） */
  private torchDevice?: () => Promise<'cuda' | 'mps' | 'cpu'>;

  constructor(paths: RuntimePaths) {
    super();
    this.paths = paths;
  }

  /** 供编排层注入统一 Logger（日志留痕进 app.log 与 IPC.event.log）。 */
  setLogger(logger: ModuleLogSink | null): void {
    setHardwareLogger(logger);
  }

  /**
   * 供组装层注入「分离运行时 provider」探测（通常指向 AccompanimentPort.onnxProviders）。
   * 探测只能按平台/显卡推断分离后端，注入后 detect() 会用实际 provider 校正，
   * 保证日志、IPC 事件与界面看到的是同一个「实际生效」的结论。
   */
  setSeparationProviders(fn: () => Promise<string[]>): void {
    this.providers = fn;
  }

  /**
   * 注入 torch 设备探测。Roformer / Demucs 走 torch，与 ONNX provider 无关：
   * macOS 上 ONNX 是 CPU 但 torch 是 MPS，Roformer 仍可硬件加速——本注入用于把
   * 「推断」校成「事实」，避免 UI 用 ONNX 后端误禁 Roformer。
   */
  setTorchDevice(fn: () => Promise<'cuda' | 'mps' | 'cpu'>): void {
    this.torchDevice = fn;
  }

  async detect(caps: MediaCapabilities): Promise<BackendDecision> {
    const detected = await detectBackend(this.paths, caps, (encoder) => this.selfTestEncoder(encoder));
    const providers = this.providers ? await this.providers() : [];
    const reconciled = reconcileSeparation(detected, providers);
    // torch 设备以运行时事实为准（Roformer 的可用性看它，而不是 ONNX 的 separationBackend）
    const torchBackend = this.torchDevice ? await this.torchDevice() : reconciled.torchBackend;
    const roformerReady = (torchBackend ?? 'cpu') !== 'cpu';
    // 「自动」= 按候选顺序取本机已下载的模型（Karaoke 优先，其次 BS-Roformer）；
    // 一个都没下载时留空，管线回落 MDX/CPU。文件判断放这里，UI 与管线共用同一结果。
    const autoSeparationModel = roformerReady ? pickAutoSeparationModel(this.paths.modelDir) : '';
    const decision: BackendDecision = {
      ...reconciled,
      ...(torchBackend ? { torchBackend } : {}),
      roformerReady,
      autoSeparationModel,
    };
    logHardware(decision.degraded ? 'warn' : 'info', 'hardware.detect.result', {
      platform: decision.platform,
      arch: decision.arch,
      separationBackend: decision.separationBackend,
      separationProvider: decision.separationProvider,
      torchBackend: decision.torchBackend,
      roformerReady: decision.roformerReady,
      autoSeparationModel: decision.autoSeparationModel,
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
    // 样本尺寸不能太小：NVENC 的 HEVC 编码器有最小帧尺寸限制，128x128 会被直接拒绝
    // （实测 Windows/RTX 4070 Ti SUPER：`InitializeEncoder failed: invalid param (8):
    // Frame dimensions are less than the minimum supported value`），
    // 结果是每台 N 卡 Windows 机器都被误判成「硬件编码器不可用」而静默降级 CPU。
    // 256x256 对 NVENC / VideoToolbox / libx265 都安全，1 秒 15fps 仍只耗时几百毫秒。
    const args: string[] = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=15:d=1',
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
