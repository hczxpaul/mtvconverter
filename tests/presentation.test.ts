/**
 * 提示分级测试（vitest / Node 环境，不触网、不启子进程）。
 * import 主 Agent 实现的 UiPresentationPolicy，按 §7.8 断言 L1/L2/L3 映射与「详细模式」回滚。
 *
 * 口径说明：L0 是「主页面常驻层」（文件/时长/预览/音轨/歌词折叠区/开始转换/完成结果），
 * 由 UI 结构保证、不经事件 classify 产生，见 §7.3 / V-17；因此 classify 的输出只覆盖 L1/L2/L3，
 * 本测试据此断言「classify 不产出 L0」，并逐条覆盖 L1/L2/L3 与详细模式切换。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UiPresentationPolicy } from '../src/main/presentation/index';
import type { DomainEvent, RuntimePaths } from '../src/shared/contracts';

function makePaths(): RuntimePaths {
  return {
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
    cacheDir: '/tmp/mtv-test-cache', fontsDir: '/tmp/mtv-test-fonts',
    uvrRoot: '/tmp/mtv-test-uvr', uvrPython: 'python3',
    modelDir: '/tmp/mtv-test-models', modelName: 'UVR-MDX-NET-Inst_HQ_3',
    lyricsBaseUrl: 'https://lyric.photix.cc', lyricsTimeoutMs: 8000,
    previewHost: '127.0.0.1', maxConcurrentJobs: 1,
    logLevel: 'info', platform: process.platform, arch: process.arch,
  };
}

const L2_EVENTS = [
  'stage.detail', 'encode.backend', 'compression.ratio',
  'accompaniment.source', 'error.code', 'log.entry', 'validation.report',
];

describe('UiPresentationPolicy（§7.8 提示分级）', () => {
  let policy: UiPresentationPolicy;

  beforeEach(() => {
    process.env.MTVC_DETAILED_MODE = 'false'; // 构造函数读取该环境变量
    policy = new UiPresentationPolicy(makePaths());
  });
  afterEach(() => { delete process.env.MTVC_DETAILED_MODE; });

  it('默认非详细模式，host 取 127.0.0.1（显式 IPv4）', () => {
    expect(policy.isDetailedMode()).toBe(false);
    expect(policy.host).toBe('127.0.0.1');
  });

  it('L1 状态行：进度事件按阶段映射为一句人话 + 可展开 + open-details', () => {
    const d = policy.classify({ type: 'job.progress', stage: 'ACCOMPANIMENT' } as DomainEvent);
    expect(d?.level).toBe('L1');
    expect(d?.message).toBe('正在生成伴奏…');
    expect(d?.expandable).toBe(true);
    expect(d?.action).toBe('open-details');
    expect(policy.classify({ type: 'job.progress', stage: 'ENCODE_MUX' } as DomainEvent)?.message).toBe('正在压缩视频…');
  });

  it('L1 状态行：歌词三分支各为一行平实文案，重试/导入入口为 import-lyrics', () => {
    const unavailable = policy.classify({ type: 'lyrics.unavailable' } as DomainEvent);
    expect(unavailable?.level).toBe('L1');
    expect(unavailable?.message).toBe('未找到歌词，已生成无字幕版本');
    expect(unavailable?.action).toBe('import-lyrics');
    const empty = policy.classify({ type: 'lyrics.empty' } as DomainEvent);
    expect(empty?.message).toBe('这首歌没有歌词');
    expect(empty?.action).toBe('import-lyrics');
  });

  it('L1 状态行：CPU 降级 / 预览降级只留一行，不弹横幅', () => {
    expect(policy.classify({ type: 'hardware.fallback' } as DomainEvent)?.message).toBe('使用 CPU 模式 ⓘ');
    expect(policy.classify({ type: 'hardware.fallback' } as DomainEvent)?.level).toBe('L1');
    expect(policy.classify({ type: 'preview.fallback' } as DomainEvent)?.message).toBe('预览已改用系统播放器');
  });

  it('L1 状态行：完成 / 取消 / 失败映射', () => {
    expect(policy.classify({ type: 'job.completed' } as DomainEvent)?.level).toBe('L1');
    const cancelled = policy.classify({ type: 'job.cancelled' } as DomainEvent);
    expect(cancelled?.message).toBe('已取消');
    expect(cancelled?.expandable).toBe(false);
    expect(cancelled?.action).toBe('none');
    expect(policy.classify({ type: 'job.failed' } as DomainEvent)?.message).toBe('转换没完成，点详情看原因');
  });

  it('L3 打断：仅「非单轨确认」与「烧录不可逆确认」两类，均不可展开', () => {
    const needs = policy.classify({ type: 'job.needsConfirmation' } as DomainEvent);
    expect(needs?.level).toBe('L3');
    expect(needs?.action).toBe('choose-track');
    expect(needs?.expandable).toBe(false);
    const burn = policy.classify({ type: 'subtitle.burnConfirm' } as DomainEvent);
    expect(burn?.level).toBe('L3');
    expect(burn?.expandable).toBe(false);
    expect(burn?.action).toBe('none');
  });

  it('L3 白名单：一组领域事件中只有两类的 level 为 L3', () => {
    const types = [
      'job.progress', 'job.completed', 'job.cancelled', 'job.failed',
      'lyrics.unavailable', 'lyrics.empty', 'hardware.fallback', 'preview.fallback',
      'job.needsConfirmation', 'subtitle.burnConfirm', ...L2_EVENTS,
    ];
    const l3 = types.filter((t) => policy.classify({ type: t } as DomainEvent)?.level === 'L3');
    expect(l3.sort()).toEqual(['job.needsConfirmation', 'subtitle.burnConfirm'].sort());
  });

  it('L2 详情抽屉：阶段/后端/压缩比/来源/错误码/日志/报告 默认收敛到 L2', () => {
    for (const type of L2_EVENTS) {
      const d = policy.classify({ type, payload: { message: '后端=libx265' } } as DomainEvent);
      expect(d?.level).toBe('L2');
      expect(d?.message).toBe('后端=libx265');
      expect(d?.expandable).toBe(true);
      expect(d?.action).toBe('open-details');
    }
  });

  it('详细模式：一键把 L2 详情事件升级为 L1，可再回滚', () => {
    policy.setDetailedMode(true);
    expect(policy.isDetailedMode()).toBe(true);
    const d = policy.classify({ type: 'compression.ratio', payload: { message: '体积为源 52%' } } as DomainEvent);
    expect(d?.level).toBe('L1');
    expect(d?.message).toBe('体积为源 52%');
    policy.setDetailedMode(false);
    expect(policy.classify({ type: 'compression.ratio', payload: { message: 'x' } } as DomainEvent)?.level).toBe('L2');
  });

  it('L0 为常驻层：classify 不产出 L0，未知事件返回 null', () => {
    expect(policy.classify({ type: 'unknown.event' } as DomainEvent)).toBeNull();
    const all = [
      'job.progress', 'job.completed', 'job.needsConfirmation', 'subtitle.burnConfirm',
      'hardware.fallback', ...L2_EVENTS,
    ].map((t) => policy.classify({ type: t } as DomainEvent)?.level);
    expect(all).not.toContain('L0');
  });
});
