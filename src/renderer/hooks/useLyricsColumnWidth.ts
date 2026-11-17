/**
 * 歌词列宽自适应：按「最长一句」的实际渲染宽度算列宽，再 clamp 到区间。
 *
 * 为什么要量而不是固定比例：一列里最宽的永远是少数长句（或网易云带的
 * 「制作人:xxx@Studio」这类署名行），按比例分配会让整列为了个别长句
 * 常年占着宽，挤压预览。量出真实需求后，多余宽度就能还给预览。
 *
 * 依赖：CSS 里 `.lyrics__line-text` 继承了 body 的 13px 与 --font 字体栈；
 * 若以后单独改歌词字号，需同步这里的 FONT 常量，否则算出的宽度会偏。
 */
import { useMemo } from 'react';
import type { LyricLine, LyricsConfig } from '../../shared/contracts';

/** 下限：再窄时间码 + 四五个字就换行了 */
export const LYRICS_COL_MIN = 250;
/** 上限：再长的句子就换行（一句歌词通常 12–16 字，360 足够；极端长句换行比撑宽整列更好） */
export const LYRICS_COL_MAX = 360;

/**
 * 行内固定开销（与 CSS 对齐，改样式时要一起改）：
 *   li 左打点按钮 22 + 列间距 2 + 右删除按钮 22 + 列间距 2  = 48
 *   行内 padding 左右 6 + 6 = 12
 *   时间码与文本 gap 10
 *   时间码「00:00.00」等宽 10.5px 约 52
 *   列表 border 左右 2
 *   卡片 padding 左右 11 + 11 = 22
 *   竖直滚动条预留 8（macOS 覆盖式滚动条通常为 0，留出余量避免长句贴边）
 */
const ROW_CHROME = 48 + 12 + 10 + 52 + 2 + 22 + 8;

const FONT =
  "13px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

function measureText(ctx: CanvasRenderingContext2D | null, text: string): number {
  if (!ctx || !text) return 0;
  ctx.font = FONT;
  return ctx.measureText(text).width;
}

/** 返回列宽（px）；没有歌词时返回 0，由调用方决定不显示该列 */
export function useLyricsColumnWidth(
  lines: LyricLine[],
  version: LyricsConfig['version'],
): number {
  return useMemo(() => {
    if (lines.length === 0) return 0;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
    let widest = 0;
    for (const line of lines) {
      const primary = version === 'translation' ? (line.translation ?? line.text) : line.text;
      widest = Math.max(widest, measureText(ctx, primary));
      // 双语时两行都要显示，取更宽的那行
      if (version === 'bilingual' && line.translation) {
        widest = Math.max(widest, measureText(ctx, line.translation));
      }
    }
    // 拿不到 canvas（极端情况）时退回上限，避免列被压到不可用
    if (widest === 0) return LYRICS_COL_MAX;
    const need = Math.ceil(widest) + ROW_CHROME;
    return Math.min(LYRICS_COL_MAX, Math.max(LYRICS_COL_MIN, need));
  }, [lines, version]);
}
