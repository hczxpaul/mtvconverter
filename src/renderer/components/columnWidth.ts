/**
 * 列宽拖拽的数值逻辑（与 DOM 解耦，便于单测）。
 *
 * 三条规矩来自主人的要求「都要可拖拽，但要守住各自下限」：
 *   1. 每列有硬下限，拖到头就停；
 *   2. 预览的最小宽度优先——被拖列的 max 由「容器 − 其它列 − 预览下限」算出；
 *   3. 容器窄到算不出正数空间时，退化为该列下限（宁可不动，也不把别的列压没）。
 */
export interface ColMin {
  side: number;
  lyrics: number;
  viewer: number;
  viewerNoLyrics: number;
}

export const COL_GAP_PX = 10;
export const COL_MIN_PX: ColMin = {
  side: 290,
  lyrics: 250,
  viewer: 320,
  viewerNoLyrics: 340,
};

/** 拖动结果：起点宽度 + 位移，夹在 [min, max] 内；max 小于 min 时取下限 */
export function clampColumnWidth(
  startWidth: number,
  deltaX: number,
  min: number,
  max: number,
): number {
  const upper = Math.max(min, max);
  return Math.round(Math.min(upper, Math.max(min, startWidth + deltaX)));
}

/** 设置列可拖到的最大宽度（三列时另一列是歌词列，两列时没有歌词列） */
export function maxSideWidth(
  containerWidth: number,
  lyricsWidth: number,
  hasLyrics: boolean,
  min: ColMin = COL_MIN_PX,
): number {
  if (!containerWidth) return min.side;
  const reserved = hasLyrics
    ? COL_GAP_PX * 2 + Math.max(min.lyrics, lyricsWidth) + min.viewer
    : COL_GAP_PX + min.viewerNoLyrics;
  return Math.max(min.side, containerWidth - reserved);
}

/** 歌词列可拖到的最大宽度（必须给预览留下 viewer 下限） */
export function maxLyricsWidth(
  containerWidth: number,
  sideWidth: number,
  min: ColMin = COL_MIN_PX,
): number {
  if (!containerWidth) return min.lyrics;
  const reserved = COL_GAP_PX * 2 + Math.max(min.side, sideWidth) + min.viewer;
  return Math.max(min.lyrics, containerWidth - reserved);
}
