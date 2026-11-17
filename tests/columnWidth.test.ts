import { describe, expect, it } from 'vitest';
import {
  COL_GAP_PX,
  COL_MIN_PX,
  clampColumnWidth,
  maxLyricsWidth,
  maxSideWidth,
} from '../src/renderer/components/columnWidth';

/**
 * 主人要求「三列都可拖拽，但要守住各自的下限」：
 * 这些用例锁定「拖到头会停住」与「预览最小宽度优先」两条不可回退的行为。
 */
describe('clampColumnWidth', () => {
  it('正常位移直接相加', () => {
    expect(clampColumnWidth(340, 60, 290, 500)).toBe(400);
    expect(clampColumnWidth(340, -40, 290, 500)).toBe(300);
  });

  it('撞下限停在下限，不会把列拖没', () => {
    expect(clampColumnWidth(340, -400, 290, 500)).toBe(290);
  });

  it('撞上限停在上限，不会侵占邻居', () => {
    expect(clampColumnWidth(340, 900, 290, 500)).toBe(500);
  });

  it('max 小于 min（容器太窄）时退化为下限，而不是算出负数', () => {
    expect(clampColumnWidth(340, -50, 290, 200)).toBe(290);
  });

  it('结果取整，避免亚像素导致网格抖动', () => {
    expect(Number.isInteger(clampColumnWidth(340.4, 10.7, 290, 500))).toBe(true);
  });
});

describe('maxSideWidth', () => {
  const total = 1372;

  it('三列：给歌词列与预览下限各留够空间', () => {
    // 1372 - (gap*2=20) - max(250, 337) - 320 = 695
    expect(maxSideWidth(total, 337, true)).toBe(695);
  });

  it('三列且歌词列比下限还窄时，按下限预留', () => {
    expect(maxSideWidth(total, 0, true)).toBe(total - COL_GAP_PX * 2 - COL_MIN_PX.lyrics - COL_MIN_PX.viewer);
  });

  it('两列：只需给预览留 340', () => {
    expect(maxSideWidth(total, 0, false)).toBe(total - COL_GAP_PX - COL_MIN_PX.viewerNoLyrics);
  });

  it('容器未知（0）时返回下限，不返回负值', () => {
    expect(maxSideWidth(0, 0, true)).toBe(COL_MIN_PX.side);
  });

  it('容器窄到装不下时也至少返回下限', () => {
    expect(maxSideWidth(600, 300, true)).toBe(COL_MIN_PX.side);
  });
});

describe('maxLyricsWidth', () => {
  it('给设置列与预览各留够空间', () => {
    // 1372 - 20 - max(290, 360) - 320 = 672
    expect(maxLyricsWidth(1372, 360)).toBe(672);
  });

  it('设置列被拖得很宽时，歌词列上限随之收窄（互相挤压要有限度）', () => {
    expect(maxLyricsWidth(1372, 600)).toBe(1372 - 20 - 600 - 320);
  });

  it('设置列比下限还窄时按下限预留', () => {
    expect(maxLyricsWidth(1372, 0)).toBe(1372 - 20 - COL_MIN_PX.side - 320);
  });

  it('永远不小于歌词列下限', () => {
    expect(maxLyricsWidth(500, 400)).toBe(COL_MIN_PX.lyrics);
  });
});

describe('三列同时拖满：预览必须仍拿到最小宽度', () => {
  it('设置列与歌词列都拖到各自上限时，预览 ≥ 320', () => {
    const total = 1372;
    const side = maxSideWidth(total, COL_MIN_PX.lyrics, true); // 先拉满设置列
    const lyrics = maxLyricsWidth(total, side); // 再拉满歌词列
    const preview = total - COL_GAP_PX * 2 - side - lyrics;
    expect(preview).toBeGreaterThanOrEqual(COL_MIN_PX.viewer);
  });
});
