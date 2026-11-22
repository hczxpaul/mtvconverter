/**
 * 分离后端校正（reconcileSeparation）单元测试。
 * 背景：探测阶段只能按「平台 + 显卡」推断，实际能否上 GPU 取决于装的是哪个 onnxruntime；
 * 曾在 N 卡 Windows 机器上把 CPU 分离谎报成 cuda，这里锁住校正行为。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { reconcileSeparation, inferTorchBackend } from '../src/main/hardware/detectors';
import { setHardwareLogger } from '../src/main/hardware/log';
import type { BackendDecision } from '../src/shared/contracts';

// 校正函数会写一条结构化日志；测试里注入空 sink，避免污染测试输出
beforeAll(() => {
  setHardwareLogger({ info: () => undefined, warn: () => undefined, error: () => undefined });
});

const base = (patch: Partial<BackendDecision> = {}): BackendDecision => ({
  platform: 'win32',
  arch: 'x64',
  separationBackend: 'cuda',
  encodeEncoder: 'hevc_nvenc',
  previewEncoder: 'h264_nvenc',
  reasonCode: 'HW_CUDA_OK',
  reasonText: '已启用 NVIDIA CUDA 分离 + HEVC / NVENC 硬件编码',
  degraded: false,
  ...patch,
});

describe('reconcileSeparation：用运行时 provider 校正分离后端', () => {
  it('运行时确有 CUDA provider 时保持 cuda，并记录 provider 名', () => {
    const out = reconcileSeparation(base(), ['CUDAExecutionProvider', 'CPUExecutionProvider']);
    expect(out.separationBackend).toBe('cuda');
    expect(out.separationProvider).toBe('CUDAExecutionProvider');
    expect(out.reasonText).toBe(base().reasonText);
  });

  it('只装了 CPU 版 onnxruntime 时降为 cpu，并在 reasonText 里说明原因', () => {
    const out = reconcileSeparation(base(), ['CPUExecutionProvider']);
    expect(out.separationBackend).toBe('cpu');
    expect(out.separationProvider).toBe('CPUExecutionProvider');
    expect(out.reasonText).toContain('分离实际走 CPU');
    // 编码侧结论不受影响：硬解/硬编仍可用，不能因此标记整体降级
    expect(out.encodeEncoder).toBe('hevc_nvenc');
    expect(out.degraded).toBe(false);
  });

  it('DirectML provider 映射为 directml', () => {
    const out = reconcileSeparation(base({ separationBackend: 'directml' }), ['DmlExecutionProvider', 'CPUExecutionProvider']);
    expect(out.separationBackend).toBe('directml');
    expect(out.separationProvider).toBe('DmlExecutionProvider');
  });

  it('provider 探测失败（空数组）时原样返回，不猜测', () => {
    const input = base();
    const out = reconcileSeparation(input, []);
    expect(out).toEqual(input);
    expect(out.separationProvider).toBeUndefined();
  });

  it('macOS 的 CoreML 不计入（MDX 算子不支持，垫片强制 CPU）', () => {
    const out = reconcileSeparation(
      base({ platform: 'darwin', arch: 'arm64', separationBackend: 'mps', encodeEncoder: 'hevc_videotoolbox' }),
      ['CoreMLExecutionProvider', 'CPUExecutionProvider'],
    );
    expect(out.separationBackend).toBe('cpu');
    expect(out.reasonText).toContain('分离实际走 CPU');
  });
});

describe('inferTorchBackend：Roformer 的可用性看 torch，不看 ONNX', () => {
  it('macOS Apple Silicon → mps（即便 ONNX 校正后是 cpu）', () => {
    expect(inferTorchBackend('darwin', 'arm64', 'mps')).toBe('mps');
    // 关键回归：reconcileSeparation 把 separationBackend 校正为 cpu 后，
    // torch 仍是 mps，Roformer 不应被误禁
    expect(inferTorchBackend('darwin', 'arm64', 'cpu')).toBe('mps');
  });

  it('Windows NVIDIA（分离后端 cuda）→ cuda', () => {
    expect(inferTorchBackend('win32', 'x64', 'cuda')).toBe('cuda');
  });

  it('Windows 无 GPU / 分离后端非 cuda → cpu', () => {
    expect(inferTorchBackend('win32', 'x64', 'cpu')).toBe('cpu');
    expect(inferTorchBackend('win32', 'x64', 'directml')).toBe('cpu');
  });

  it('macOS Intel → cpu', () => {
    expect(inferTorchBackend('darwin', 'x64', 'cpu')).toBe('cpu');
  });

  it('Linux → cpu', () => {
    expect(inferTorchBackend('linux', 'x64', 'cpu')).toBe('cpu');
  });
});
