/**
 * 硬件后端探测与决策（设计文档 §10.2 / §10.3）。
 * 严格按「平台 → 架构 → 设备 → 驱动/运行时 → 显存 → 模型兼容 → HEVC 编码器 1 秒自检」顺序执行；
 * 每一步都记录可读原因码并写日志；任一关键环节失败自动降级到 CPU 一次，绝不静默降级。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Backend, BackendDecision, MediaCapabilities, RuntimePaths } from '../../shared/contracts';
import { logHardware } from './log';

/** 原因码：写入 BackendDecision.reasonCode 与日志，供「详情」一键展开。 */
export const REASON = {
  CUDA_OK: 'HW_CUDA_OK',
  DIRECTML_OK: 'HW_DIRECTML_OK',
  MPS_OK: 'HW_MPS_OK',
  MAC_INTEL_CPU: 'HW_MAC_INTEL_CPU',
  NO_GPU: 'HW_NO_GPU',
  DRIVER_MISSING: 'HW_DRIVER_MISSING',
  VRAM_INSUFFICIENT: 'HW_VRAM_INSUFFICIENT',
  RUNTIME_MISSING: 'HW_RUNTIME_MISSING',
  MODEL_INCOMPATIBLE: 'HW_MODEL_INCOMPATIBLE',
  ENCODER_UNAVAILABLE: 'HW_ENCODER_UNAVAILABLE',
  HEVC_SELFTEST_FAILED: 'HW_HEVC_SELFTEST_FAILED',
  CPU_FALLBACK: 'E_GPU_FALLBACK',
} as const;

/** §10.2：NVIDIA 建议 ≥8GB，最低按 ≥6GB 判定。 */
const MIN_VRAM_MB = 6 * 1024;

interface ProbeStep {
  name: string;
  ok: boolean;
  detail: string;
  reasonCode?: string;
}

interface NvidiaInfo {
  ok: boolean;
  name?: string;
  driverVersion?: string;
  vramMb?: number;
  detail: string;
}

type GpuKind = 'nvidia' | 'amd-intel' | 'apple-silicon' | 'none';

function step(name: string, ok: boolean, detail: string, reasonCode?: string): ProbeStep {
  return { name, ok, detail, ...(reasonCode ? { reasonCode } : {}) };
}

/** argv 数组调用 nvidia-smi 查询设备/驱动/显存；任何失败都以「未检出」返回，不抛异常。 */
function queryNvidiaSmi(): Promise<NvidiaInfo> {
  return new Promise((resolve) => {
    const child = spawn('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (info: NvidiaInfo): void => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, detail: 'nvidia-smi 查询超时' });
    }, 4000);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false, detail: '未检出 NVIDIA 设备或驱动' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        finish({ ok: false, detail: 'nvidia-smi 无有效输出' });
        return;
      }
      const first = out.trim().split(/\r?\n/)[0] ?? '';
      const parts = first.split(',').map((s) => s.trim());
      const vramMb = Number.parseInt(parts[1] ?? '', 10);
      finish({
        ok: true,
        name: parts[0] || undefined,
        vramMb: Number.isFinite(vramMb) ? vramMb : undefined,
        driverVersion: parts[2] || undefined,
        detail: `NVIDIA ${parts[0] ?? '未知'} / 驱动 ${parts[2] ?? '未知'} / 显存 ${parts[1] ?? '未知'} MB`,
      });
    });
  });
}

/** ffmpeg / ffprobe 路径为绝对值时校验存在；为命令名时视为由 PATH 解析。 */
function runtimeReady(execPath: string): boolean {
  return path.isAbsolute(execPath) ? fs.existsSync(execPath) : execPath.length > 0;
}

/**
 * 推断 torch 侧设备（Roformer / Demucs 走 torch，与 ONNX provider 无关）。
 * macOS Apple Silicon → MPS；分离后端已是 cuda（Windows NVIDIA）→ CUDA；其余 → CPU。
 * HardwareProbe.detect 会用运行时探测结果覆盖本推断。
 */
export function inferTorchBackend(
  platform: NodeJS.Platform,
  arch: string,
  separationBackend: Backend,
): 'cuda' | 'mps' | 'cpu' {
  if (platform === 'darwin' && arch === 'arm64') return 'mps';
  if (separationBackend === 'cuda') return 'cuda';
  return 'cpu';
}

function buildDecision(
  platform: NodeJS.Platform,
  arch: string,
  separationBackend: Backend,
  encodeEncoder: string,
  av1Encoder: string,
  previewEncoder: string,
  reasonCode: string,
  reasonText: string,
  degraded: boolean,
): BackendDecision {
  const torchBackend = inferTorchBackend(platform, arch, separationBackend);
  return {
    platform, arch, separationBackend, encodeEncoder, av1Encoder, previewEncoder,
    reasonCode, reasonText, degraded,
    torchBackend,
    roformerReady: torchBackend !== 'cpu',
  };
}

/**
 * 用运行时实际 provider 校正分离后端（探测只能「推断」，这里才是「事实」）。
 *
 * 探测阶段按「平台 + 显卡」判断：有 N 卡就当 CUDA 可用。但分离能不能真上 GPU，
 * 取决于装的是哪个 onnxruntime 变体——随包 `audio-separator[cpu]` 装的是
 * `onnxruntime`（只有 CPU / Azure），`onnxruntime-gpu` 才有 CUDAExecutionProvider，
 * `onnxruntime-directml` 才有 DmlExecutionProvider。
 * macOS 侧 CoreML 对 MDX 模型算子不支持（启动垫片强制 CPU），因此也不计入。
 *
 * providers 为空（探测失败 / 实现方不支持）时原样返回，不猜。
 */
export function reconcileSeparation(decision: BackendDecision, providers: string[]): BackendDecision {
  if (providers.length === 0) return decision;
  const has = (name: string): boolean => providers.includes(name);
  const actual: Backend = has('CUDAExecutionProvider')
    ? 'cuda'
    : has('DmlExecutionProvider')
      ? 'directml'
      : 'cpu';
  const providerName = actual === 'cuda'
    ? 'CUDAExecutionProvider'
    : actual === 'directml'
      ? 'DmlExecutionProvider'
      : 'CPUExecutionProvider';
  if (actual === decision.separationBackend) {
    return { ...decision, separationProvider: providerName };
  }
  const note = actual === 'cpu'
    ? `；分离实际走 CPU（运行时 provider：${providers.join(' / ')}，未安装 GPU 版 onnxruntime）`
    : `；分离实际 provider：${providerName}`;
  logHardware('info', 'hardware.separation.reconciled', {
    detected: decision.separationBackend, actual, providers,
  });
  return {
    ...decision,
    separationBackend: actual,
    separationProvider: providerName,
    reasonText: decision.reasonText + note,
  };
}

/**
 * 完整探测流程。selfTest 由 HardwareProbe 注入（对指定编码器生成 1 秒样本自检）。
 * 返回值始终可解释：degraded=true 即 CPU 模式，编排层据此发 IPC.event.fallback 与「使用 CPU 模式 ⓘ」。
 */
export async function detectBackend(
  paths: RuntimePaths,
  caps: MediaCapabilities,
  selfTest: (encoder: string) => Promise<boolean>,
): Promise<BackendDecision> {
  const platform = paths.platform;
  const arch = paths.arch;
  const steps: ProbeStep[] = [];

  // 1) 平台
  steps.push(step('平台', true, `platform=${platform}`));
  // 2) 架构
  steps.push(step('架构', true, `arch=${arch}`));

  // 3) 设备
  let nvidia: NvidiaInfo = { ok: false, detail: '非 Windows 平台，跳过 NVIDIA 探测' };
  if (platform === 'win32') nvidia = await queryNvidiaSmi();
  const gpuKind: GpuKind =
    platform === 'win32' ? (nvidia.ok ? 'nvidia' : 'amd-intel')
      : platform === 'darwin' ? (arch === 'arm64' ? 'apple-silicon' : 'none')
        : 'none';
  steps.push(step('设备', gpuKind !== 'none',
    gpuKind === 'nvidia' ? nvidia.detail
      : gpuKind === 'apple-silicon' ? 'Apple Silicon（M1 及以上，MPS 可用）'
        : gpuKind === 'amd-intel' ? '未检出 NVIDIA，按 AMD / Intel 核显处理'
          : '未检出可用 GPU',
    gpuKind === 'none' ? REASON.NO_GPU : undefined));

  // 4) 驱动 / 运行时
  const driverOk = gpuKind !== 'nvidia' || Boolean(nvidia.driverVersion);
  steps.push(step('驱动/运行时', driverOk,
    gpuKind === 'nvidia' ? `NVIDIA 驱动 ${nvidia.driverVersion ?? '未知'}` : '驱动信息不适用或由系统托管',
    driverOk ? undefined : REASON.DRIVER_MISSING));
  const ffmpegReady = runtimeReady(paths.ffmpegPath) && runtimeReady(paths.ffprobePath);
  steps.push(step('运行时', ffmpegReady, ffmpegReady ? 'FFmpeg / FFprobe 可用' : 'FFmpeg / FFprobe 不可用',
    ffmpegReady ? undefined : REASON.RUNTIME_MISSING));

  // 5) 显存
  const vramOk = gpuKind !== 'nvidia' || (nvidia.vramMb !== undefined && nvidia.vramMb >= MIN_VRAM_MB);
  steps.push(step('显存', vramOk,
    gpuKind === 'nvidia' ? `显存 ${nvidia.vramMb ?? '未知'} MB（阈值 ${MIN_VRAM_MB} MB）` : '显存检查不适用',
    vramOk ? undefined : REASON.VRAM_INSUFFICIENT));

  // 6) 模型兼容（软检查：UVR 运行时 / 模型配置；缺失仅告警，不否决主编码后端）
  const modelRuntimeOk = Boolean(paths.modelDir) && Boolean(paths.modelName);
  steps.push(step('模型兼容', modelRuntimeOk,
    modelRuntimeOk ? 'UVR 运行时与模型配置就绪' : 'UVR 运行时 / 模型未就绪（仅影响分离后端）',
    modelRuntimeOk ? undefined : REASON.MODEL_INCOMPATIBLE));

  // 逐步留痕：任何一环失败都有原因码落日志，禁止静默
  for (const s of steps) {
    logHardware(s.ok ? 'info' : 'warn', 'hardware.probe.step', {
      name: s.name, ok: s.ok, detail: s.detail,
      ...(s.reasonCode ? { reasonCode: s.reasonCode } : {}),
    });
  }

  // 决策矩阵（§10.2 + 派发口径）
  let gpuPath: 'cuda' | 'directml' | 'mps' | null = null;
  let gpuEncode = '';
  let gpuPreview = '';
  let gpuHevc = '';
  let av1Encoder = 'libsvtav1';
  let degradeReason = '';

  if (platform === 'win32' && gpuKind === 'nvidia') {
    if (!driverOk) degradeReason = REASON.DRIVER_MISSING;
    else if (!vramOk) degradeReason = REASON.VRAM_INSUFFICIENT;
    else if (!caps.hevcNvenc || !caps.h264Nvenc) degradeReason = REASON.ENCODER_UNAVAILABLE;
    else { gpuPath = 'cuda'; gpuEncode = 'hevc_nvenc'; gpuPreview = 'h264_nvenc'; gpuHevc = 'hevc_nvenc'; }
  } else if (platform === 'win32' && gpuKind === 'amd-intel') {
    // DirectML 版 UVR 可用时启用；以「UVR 运行时 + FFmpeg 就绪」作为可用判据，否则回退 CPU
    if (modelRuntimeOk && ffmpegReady) { gpuPath = 'directml'; gpuEncode = 'libx265'; gpuPreview = 'libx264'; gpuHevc = 'libx265'; }
    else degradeReason = REASON.RUNTIME_MISSING;
  } else if (platform === 'darwin' && arch === 'arm64') {
    if (!caps.hevcVideotoolbox || !caps.h264Videotoolbox) degradeReason = REASON.ENCODER_UNAVAILABLE;
    else { gpuPath = 'mps'; gpuEncode = 'hevc_videotoolbox'; gpuPreview = 'h264_videotoolbox'; gpuHevc = 'hevc_videotoolbox'; }
  } else {
    // macOS Intel / Linux / 无 GPU：按矩阵走 CPU
    degradeReason = REASON.NO_GPU;
  }

  // 7) HEVC 编码器 1 秒自检
  const selftestTarget = gpuPath ? gpuHevc : 'libx265';
  const encoderOk = await selfTest(selftestTarget);
  logHardware(encoderOk ? 'info' : 'warn', 'hardware.probe.step', {
    name: 'HEVC 编码器 1 秒自检', ok: encoderOk, detail: selftestTarget,
    ...(encoderOk ? {} : { reasonCode: REASON.HEVC_SELFTEST_FAILED }),
  });
  if (gpuPath && !encoderOk) {
    degradeReason = REASON.HEVC_SELFTEST_FAILED;
    gpuPath = null;
  }

  if (gpuPath) {
    // AV1 硬件编码单独自检：只影响 AV1，HEVC 成功了没必要整体降级
    if (gpuPath === 'cuda' && caps.av1Nvenc) {
      const av1Ok = await selfTest('av1_nvenc');
      logHardware(av1Ok ? 'info' : 'warn', 'hardware.probe.step', {
        name: 'AV1 编码器 1 秒自检', ok: av1Ok, detail: 'av1_nvenc',
        ...(av1Ok ? {} : { reasonCode: REASON.ENCODER_UNAVAILABLE }),
      });
      if (av1Ok) av1Encoder = 'av1_nvenc';
    }

    const hevcText = gpuPath === 'cuda'
      ? (av1Encoder === 'av1_nvenc'
        ? '已启用 NVIDIA CUDA 分离 + HEVC / AV1 NVENC 硬件编码'
        : '已启用 NVIDIA CUDA 分离 + HEVC NVENC 硬件编码；AV1 仍走 CPU（av1_nvenc 自检未通过）')
      : gpuPath === 'mps'
        ? '已启用 Apple Silicon MPS 分离 + VideoToolbox 硬件编码（HEVC）；AV1 走 CPU'
        : '已启用 DirectML 分离；主编码使用 libx265 / libsvtav1';
    const success: Record<'cuda' | 'directml' | 'mps', { code: string; text: string }> = {
      cuda: { code: REASON.CUDA_OK, text: hevcText },
      directml: { code: REASON.DIRECTML_OK, text: hevcText },
      mps: { code: REASON.MPS_OK, text: hevcText },
    };
    const info = success[gpuPath];
    return buildDecision(platform, arch, gpuPath, gpuEncode, av1Encoder, gpuPreview, info.code, info.text, false);
  }

  // CPU 兜底：失败自动降级一次；CPU 模式本身也需可观测（degraded=true）
  const hardFailure = degradeReason !== '' && degradeReason !== REASON.NO_GPU;
  let cpuPreview = 'libx264';
  if (!hardFailure && platform === 'darwin' && arch === 'x64' && caps.h264Videotoolbox) {
    cpuPreview = 'h264_videotoolbox';
  }

  let reasonCode: string;
  let reasonText: string;
  if (!encoderOk) {
    reasonCode = 'E_HEVC_ENCODER_UNAVAILABLE';
    reasonText = `HEVC 编码器 1 秒自检未通过（${selftestTarget}），已降级为 CPU 模式：主编码 libx265、预览 ${cpuPreview}；请检查 FFmpeg 构建`;
  } else if (hardFailure) {
    reasonCode = REASON.CPU_FALLBACK;
    reasonText = `GPU 路径不可用（${degradeReason}），已自动降级为 CPU 模式一次：主编码 libx265、预览 ${cpuPreview}；H.265 软编码耗时较长，可在详情查看耗时预估`;
  } else {
    reasonCode = (platform === 'darwin' && arch === 'x64') ? REASON.MAC_INTEL_CPU : REASON.NO_GPU;
    reasonText = reasonCode === REASON.MAC_INTEL_CPU
      ? `Intel Mac 不适用 MPS，按决策矩阵使用 CPU 模式：主编码 libx265、预览 ${cpuPreview}`
      : `未检出可用 GPU，使用 CPU 模式：主编码 libx265、预览 ${cpuPreview}`;
  }
  return buildDecision(platform, arch, 'cpu', 'libx265', 'libsvtav1', cpuPreview, reasonCode, reasonText, true);
}
