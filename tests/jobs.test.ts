/**
 * 管线状态机测试（vitest / Node 环境，不触网、不启子进程、不依赖真实 GPU / 模型权重）。
 * import 主 Agent 实现的 JobService / PipelineController，用 mock 端口断言：
 *   NEEDS_CONFIRMATION 阻断（音轨数 ≠ 1 不产出文件）、取消（CANCELLED + signal aborted + 杀子进程树）、
 *   幂等 jobId（fingerprint 稳定 + create 幂等 + 配置变更新 id）。
 * 依据 docs/MTV转换器-设计文档与开发方案.md §5.1 / §8.3 / V-15。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobService, PipelineController } from '../src/main/jobs/index';
import type { JobEvents, PipelinePorts } from '../src/main/jobs/index';
import type { Logger } from '../src/main/errors/Logger';
import { makeDefaultConfig } from '../src/shared/contracts';
import type { JobConfig, RuntimePaths } from '../src/shared/contracts';

function makePaths(cacheDir: string): RuntimePaths {
  return {
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
    cacheDir, fontsDir: join(cacheDir, 'fonts'),
    uvrRoot: join(cacheDir, 'uvr'), uvrPython: 'python3',
    modelDir: join(cacheDir, 'models'), modelName: 'UVR-MDX-NET-Inst_HQ_3',
    lyricsBaseUrl: 'https://lyric.photix.cc', lyricsTimeoutMs: 8000,
    previewHost: '127.0.0.1', maxConcurrentJobs: 1,
    logLevel: 'info', platform: process.platform, arch: process.arch,
  };
}

function makeMediaInfo(audioCount: number) {
  return {
    path: '/tmp/src.mp4', durationSec: 3, fileSizeBytes: 1000,
    width: 320, height: 180, fps: 30, videoCodec: 'h264', pixFmt: 'yuv420p',
    sar: '1:1', rotation: 0, start_time: 0, vfr: false, alreadyHevc: false,
    audioStreams: Array.from({ length: audioCount }, (_, i) => ({
      index: i + 1, codec: 'aac', sampleRate: 48000, channels: 2, durationSec: 3,
    })),
  };
}

function makeMocks(cacheDir: string) {
  const caps = {
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', libx265: true,
    hevcVideotoolbox: true, hevcNvenc: false, libx264: true,
    h264Videotoolbox: true, h264Nvenc: false, libass: false, hlsMuxer: true,
  };
  const backend = {
    platform: process.platform, arch: process.arch, separationBackend: 'cpu',
    encodeEncoder: 'libx265', previewEncoder: 'libx264',
    reasonCode: '', reasonText: '', degraded: false,
  };
  const report = {
    passed: true, checks: [], sourceSizeBytes: 1000, outputSizeBytes: 600,
    compressionRatio: 0.6, accompanimentSource: 'imported', backend: 'cpu',
    compressionPreset: 'balanced',
  };
  const media = {
    capabilities: vi.fn().mockResolvedValue(caps),
    probe: vi.fn().mockResolvedValue(makeMediaInfo(1)),
    extractOriginal: vi.fn().mockResolvedValue(undefined),
    align: vi.fn().mockResolvedValue(undefined),
    encodeMux: vi.fn().mockResolvedValue({ outputPath: join(cacheDir, 'out.mtv') }),
    validate: vi.fn().mockResolvedValue(report),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const accompaniment = {
    selfTest: vi.fn().mockResolvedValue({ ok: true }),
    separate: vi.fn().mockResolvedValue(join(cacheDir, 'instrumental.raw.wav')),
    importFile: vi.fn().mockResolvedValue(join(cacheDir, 'instrumental.raw.wav')),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const lyrics = {
    fetchOnline: vi.fn(), fromLocal: vi.fn(), fromPasted: vi.fn(), toAss: vi.fn(),
  };
  const hardware = { detect: vi.fn().mockResolvedValue(backend), selfTestEncoder: vi.fn().mockResolvedValue(true) };
  const preview = {
    start: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined),
  };
  const presentation = {
    classify: vi.fn().mockReturnValue(null), isDetailedMode: vi.fn().mockReturnValue(false), setDetailedMode: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const events = { progress: vi.fn(), status: vi.fn(), fallback: vi.fn() };
  const paths = makePaths(cacheDir);
  const ports = { media, accompaniment, lyrics, hardware, preview, presentation, logger, paths };
  return { media, accompaniment, preview, paths, logger, events, ports };
}

describe('JobService / PipelineController 状态机（mock 端口）', () => {
  let cacheDir: string;
  let mocks: ReturnType<typeof makeMocks>;
  let jobs: JobService;
  let controller: PipelineController;

  const cfg = (patch: Partial<JobConfig> = {}): JobConfig => ({
    ...makeDefaultConfig(join(cacheDir, 'src.mp4'), cacheDir),
    ...patch,
  });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'mtv-jobs-'));
    mocks = makeMocks(cacheDir);
    jobs = new JobService(mocks.paths, mocks.logger as unknown as Logger, mocks.events as unknown as JobEvents);
    controller = new PipelineController(jobs, mocks.ports as unknown as PipelinePorts);
  });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  describe('输出路径：绝不覆盖源文件', () => {
    // 期望值必须由 path.join 拼：Windows 上 join 产出反斜杠，写死 POSIX 斜杠会假失败
    const MUSIC = join('/tmp', '歌曲');
    const SRC = join(MUSIC, '歌.mp4');

    it('输出目录 = 源目录且扩展名与源相同时，自动加「-伴奏版」后缀', () => {
      const c = cfg({ sourcePath: SRC, outputDir: MUSIC, extension: '.mp4', outputName: '' });
      expect(jobs.defaultOutputPath(c)).toBe(join(MUSIC, '歌-伴奏版.mp4'));
    });

    it('输出目录不同则保留原名，不加后缀', () => {
      const c = cfg({ sourcePath: SRC, outputDir: join('/tmp', 'out'), extension: '.mp4', outputName: '' });
      expect(jobs.defaultOutputPath(c)).toBe(join('/tmp', 'out', '歌.mp4'));
    });

    it('自定义 outputName 与源同名时同样加后缀', () => {
      const c = cfg({ sourcePath: SRC, outputDir: MUSIC, extension: '.mp4', outputName: '歌' });
      expect(jobs.defaultOutputPath(c)).toBe(join(MUSIC, '歌-伴奏版.mp4'));
    });

    it('扩展名与源不同时不加后缀（输出 .mkv）', () => {
      const c = cfg({ sourcePath: SRC, outputDir: MUSIC, extension: '.mkv', outputName: '' });
      expect(jobs.defaultOutputPath(c)).toBe(join(MUSIC, '歌.mkv'));
    });

    it('命名是确定性的：连续调用结果一致（保证断点续跑不漂移）', () => {
      const c = cfg({ sourcePath: SRC, outputDir: MUSIC, extension: '.mp4', outputName: '' });
      expect(jobs.defaultOutputPath(c)).toBe(jobs.defaultOutputPath(c));
    });

    it('后缀可自定义', () => {
      const c = cfg({
        sourcePath: SRC, outputDir: MUSIC, extension: '.mp4',
        outputName: '', outputConflict: 'suffix', outputSuffix: '-双音轨',
      });
      expect(jobs.defaultOutputPath(c)).toBe(join(MUSIC, '歌-双音轨.mp4'));
    });

    it('后缀含路径分隔符时被清掉（防目录穿越），清空则回退默认', () => {
      const dirty = cfg({
        sourcePath: SRC, outputDir: MUSIC, extension: '.mp4',
        outputName: '', outputConflict: 'suffix', outputSuffix: '../x/y',
      });
      // 斜杠被移除后仍停留在源目录内，不会拼出上级路径
      expect(jobs.defaultOutputPath(dirty)).toBe(join(MUSIC, '歌..xy.mp4'));

      const empty = cfg({
        sourcePath: SRC, outputDir: MUSIC, extension: '.mp4',
        outputName: '', outputConflict: 'suffix', outputSuffix: '   ',
      });
      expect(jobs.defaultOutputPath(empty)).toBe(join(MUSIC, '歌-伴奏版.mp4'));
    });

    it('选择覆盖源文件时直接返回源路径（由编排层用临时文件替换）', () => {
      const c = cfg({
        sourcePath: SRC, outputDir: MUSIC, extension: '.mp4',
        outputName: '', outputConflict: 'overwrite',
      });
      expect(jobs.defaultOutputPath(c)).toBe(SRC);
    });
  });

  describe('幂等 jobId（§8.3）', () => {
    it('fingerprint 对相同配置稳定，配置变更即产生新 jobId', () => {
      const c1 = cfg();
      const id1 = jobs.fingerprint(c1);
      expect(jobs.fingerprint({ ...c1 })).toBe(id1);
      expect(jobs.fingerprint(cfg({ compressionPreset: 'size' }))).not.toBe(id1);
      expect(jobs.fingerprint(cfg({ sourcePath: join(cacheDir, 'other.mp4') }))).not.toBe(id1);
      expect(id1).toMatch(/^[0-9a-f]{20}$/);
    });

    it('create 幂等：相同配置重复创建返回同一 record，不新增队列项', () => {
      const c1 = cfg();
      const r1 = jobs.create(c1);
      const r2 = jobs.create(c1);
      expect(r2.id).toBe(r1.id);
      expect(r2).toBe(r1);
      expect(jobs.list()).toHaveLength(1);
      expect(r1.status).toBe('DRAFT'); // 创建即草稿，未进入执行队列
      expect(r1.lyricsStatus).toBe('OFF'); // 默认关闭歌词
    });
  });

  describe('NEEDS_CONFIRMATION 阻断（§5.1 / V-15）', () => {
    it('2 条音轨：阻断为 NEEDS_CONFIRMATION，不调用 extractOriginal / encodeMux（不产出文件）', async () => {
      mocks.media.probe.mockResolvedValue(makeMediaInfo(2));
      const r = jobs.create(cfg());
      const out = await controller.run(r.id);
      expect(out.status).toBe('NEEDS_CONFIRMATION');
      expect(jobs.get(r.id)?.status).toBe('NEEDS_CONFIRMATION');
      expect(mocks.media.extractOriginal).not.toHaveBeenCalled();
      expect(mocks.media.encodeMux).not.toHaveBeenCalled();
      expect(mocks.media.validate).not.toHaveBeenCalled();
    });

    it('3 条音轨同样阻断（非单轨一律确认，不静默选 a:0）', async () => {
      mocks.media.probe.mockResolvedValue(makeMediaInfo(3));
      const r = jobs.create(cfg({ sourcePath: join(cacheDir, 'three.mp4') }));
      const out = await controller.run(r.id);
      expect(out.status).toBe('NEEDS_CONFIRMATION');
      expect(mocks.media.encodeMux).not.toHaveBeenCalled();
    });

    it('1 条音轨：标准路径不阻断，走完 7 阶段到 COMPLETED（进度 100、报告通过）', async () => {
      mocks.media.probe.mockResolvedValue(makeMediaInfo(1));
      const r = jobs.create(cfg({ sourcePath: join(cacheDir, 'single.mp4') }));
      const out = await controller.run(r.id);
      expect(out.status).toBe('COMPLETED');
      expect(out.status).not.toBe('NEEDS_CONFIRMATION');
      expect(out.progress).toBe(100);
      expect(out.report?.passed).toBe(true);
      expect(mocks.media.encodeMux).toHaveBeenCalledTimes(1);
      expect(mocks.media.validate).toHaveBeenCalledTimes(1);
    });
  });

  describe('取消（§8.3）', () => {
    it('cancel 标记 CANCELLED 且 AbortSignal 已触发', () => {
      const r = jobs.create(cfg({ sourcePath: join(cacheDir, 'cancel.mp4') }));
      jobs.cancel(r.id);
      expect(jobs.get(r.id)?.status).toBe('CANCELLED');
      expect(jobs.isCancelled(r.id)).toBe(true);
      expect(jobs.signalFor(r.id).aborted).toBe(true);
    });

    it('cancelAll 终止整个子进程树：media / accompaniment / preview 的 cancel 均被调用', async () => {
      const r = jobs.create(cfg({ sourcePath: join(cacheDir, 'cancelall.mp4') }));
      await controller.cancelAll(r.id);
      expect(jobs.get(r.id)?.status).toBe('CANCELLED');
      expect(mocks.media.cancel).toHaveBeenCalledTimes(1);
      expect(mocks.accompaniment.cancel).toHaveBeenCalledTimes(1);
      expect(mocks.preview.cancel).toHaveBeenCalledTimes(1);
    });
  });
});
