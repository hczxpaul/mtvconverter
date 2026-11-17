import { describe, expect, it } from 'vitest';
import { toAssText, toAssTime } from '../src/shared/ass';
import { makeDefaultConfig } from '../src/shared/contracts';
import type { LyricLine } from '../src/shared/contracts';

function cfgWith(size: number) {
  const cfg = makeDefaultConfig('/tmp/source.mp4', '/tmp/out');
  return { ...cfg, subtitle: { ...cfg.subtitle, fontSize: size } };
}

const lines: LyricLine[] = [
  { startMs: 0, endMs: 2000, text: '第一句' },
  { startMs: 2000, endMs: 4000, text: '第二句', translation: 'line two' },
];

function header(ass: string): { playResX: number; playResY: number; fontSize: number; marginV: number } {
  const playResX = Number(/PlayResX: (\d+)/.exec(ass)?.[1] ?? 0);
  const playResY = Number(/PlayResY: (\d+)/.exec(ass)?.[1] ?? 0);
  const style = ass.split('\n').find((l) => l.startsWith('Style:')) ?? '';
  const parts = style.split(',');
  return { playResX, playResY, fontSize: Number(parts[2] ?? 0), marginV: Number(parts[21] ?? 0) };
}

describe('ASS 画布：按视频真实分辨率生成', () => {
  it('1080p 横屏：PlayRes 1920×1080，字号原样', () => {
    const ass = toAssText(lines, cfgWith(72), 10, { width: 1920, height: 1080 });
    const h = header(ass);
    expect(h.playResX).toBe(1920);
    expect(h.playResY).toBe(1080);
    expect(h.fontSize).toBe(72);
  });

  it('720p：字号按高度等比缩到 48，视觉比例不变', () => {
    const ass = toAssText(lines, cfgWith(72), 10, { width: 1280, height: 720 });
    const h = header(ass);
    expect(h.playResX).toBe(1280);
    expect(h.playResY).toBe(720);
    expect(h.fontSize).toBe(48); // 72 * 720/1080
    // 字号占画布高度比例与 1080p 一致
    expect(h.fontSize / h.playResY).toBeCloseTo(72 / 1080, 5);
  });

  it('竖屏 1080×1920：PlayRes 跟随竖屏，字号按高度放大', () => {
    const ass = toAssText(lines, cfgWith(72), 10, { width: 1080, height: 1920 });
    const h = header(ass);
    expect(h.playResX).toBe(1080);
    expect(h.playResY).toBe(1920);
    expect(h.fontSize).toBe(128); // 72 * 1920/1080 = 128
    expect(h.fontSize / h.playResY).toBeCloseTo(72 / 1080, 2);
  });

  it('低分辨率 480×270：字号不小于下限 8px', () => {
    const ass = toAssText(lines, cfgWith(24), 10, { width: 480, height: 270 });
    const h = header(ass);
    expect(h.playResX).toBe(480);
    expect(h.playResY).toBe(270);
    expect(h.fontSize).toBeGreaterThanOrEqual(8);
  });

  it('未传 frame 时回落 1920×1080（兼容旧调用）', () => {
    const h = header(toAssText(lines, cfgWith(72), 10));
    expect(h.playResX).toBe(1920);
    expect(h.playResY).toBe(1080);
    expect(h.fontSize).toBe(72);
  });

  it('非法 frame（0 或负数）也回落默认值', () => {
    const h = header(toAssText(lines, cfgWith(72), 10, { width: 0, height: -5 }));
    expect(h.playResX).toBe(1920);
    expect(h.playResY).toBe(1080);
  });

  it('垂直边距随字号缩放，且不小于下限', () => {
    const small = header(toAssText(lines, cfgWith(24), 10, { width: 480, height: 270 }));
    const large = header(toAssText(lines, cfgWith(72), 10, { width: 1920, height: 1080 }));
    expect(large.marginV).toBeGreaterThan(small.marginV);
    expect(small.marginV).toBeGreaterThanOrEqual(8);
  });
});

describe('ASS 时间轴与文本', () => {
  it('时间格式为 H:MM:SS.CC', () => {
    expect(toAssTime(0)).toBe('0:00:00.00');
    expect(toAssTime(65_430)).toBe('0:01:05.43');
    expect(toAssTime(3_723_456)).toBe('1:02:03.45');
  });

  it('双语 2 行用 \\N 分隔；1 行合并为空格', () => {
    const two = toAssText(lines, cfgWith(72), 10);
    expect(two).toContain('第一句');
    expect(two).toContain('第二句\\Nline two');

    const cfg = makeDefaultConfig('/tmp/a.mp4', '/tmp/out');
    const one = toAssText(lines, { ...cfg, subtitle: { ...cfg.subtitle, bilingualLines: 1 } }, 10);
    expect(one).toContain('第二句 line two');
  });

  it('超出时长的句子被裁剪，完全在外则丢弃', () => {
    const ass = toAssText(
      [{ startMs: 0, endMs: 2000, text: 'A' }, { startMs: 20_000, endMs: 25_000, text: 'B' }],
      cfgWith(72),
      10,
    );
    expect(ass).toContain('A');
    expect(ass).not.toContain(',B\n');
    expect(ass).not.toContain('B\n');
  });
});
