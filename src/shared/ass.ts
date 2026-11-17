/**
 * ASS 字幕生成（主进程烧录与渲染层实时预览共用）。
 *
 * 放在 shared 的原因：烧录走 ffmpeg 的 libass，预览走 jassub（同一个 libass 的 WASM 版）。
 * 只要两边吃的是同一份 ASS 文本，就能做到「预览所见 = 导出所得」，避免各写一套导致漂移。
 *
 * 约束：本文件必须是纯函数、只依赖 shared/contracts 的类型，不得引入 node 内置模块。
 * 设计依据：docs/MTV转换器-设计文档与开发方案.md §6.7 / §7.9 / V-09。
 */
import { DEFAULT_SUBTITLE_STYLE } from './contracts';
import type { JobConfig, LyricLine, LyricsVersion, SubtitleStyle } from './contracts';

/** ASS 样式表的坐标基准；不传时回落到 1080p。 */
export interface AssFrame {
  width: number;
  height: number;
}

/** 字号/描边/边距的基准高度：SubtitleStyle.fontSize 按 1080p 画面高度标定。 */
const BASE_HEIGHT = 1080;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 毫秒 → ASS 时间 H:MM:SS.CC（厘秒）。 */
export function toAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const cs = Math.floor(total / 10) % 100;
  const totalSec = Math.floor(total / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 颜色仅接受 &H 开头 8 位十六进制，防止非法值破坏 Style 行字段分隔。 */
function safeColor(value: string, fallback: string): string {
  return typeof value === 'string' && /^&H[0-9A-Fa-f]{8}$/.test(value) ? value : fallback;
}

/** 字体名中的逗号 / 换行会破坏 Format 行（逗号为字段分隔符）。 */
function safeFont(value: string, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[,\r\n]/g, '').trim();
  return cleaned || fallback;
}

/**
 * 中文按 UTF-8 原样写入，仅做最小必要的 ASS 控制字符处理：
 * 换行 → \N（硬换行）、花括号移除（避免被当作 override tag 注入）。
 * 不做 URL / HTML / Unicode 转义，保证中文不缺字、不乱码。
 */
function escapeAssText(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n|\r|\n/g, '\\N').replace(/[{}]/g, '').trim();
}

/** 按版本与双语行数决定一句 ASS 事件显示哪些文本。 */
function renderLineText(line: LyricLine, version: LyricsVersion, bilingualLines: 1 | 2): string {
  const original = escapeAssText(line.text);
  const translation = line.translation ? escapeAssText(line.translation) : '';
  if (version === 'translation') return translation || original;
  if (version === 'bilingual' && translation && translation !== original) {
    // 双语行数：2 → 原文在上、翻译在下（\N 换行）；1 → 压成一行。
    return bilingualLines === 2 ? `${original}\\N${translation}` : `${original} ${translation}`;
  }
  return original;
}

/**
 * 生成 Style 行。字号/描边/垂直边距都按画布高度等比缩放：
 * style.fontSize 的语义是「1080p 画面下的像素高度」，这样同一套配置在 480p / 1080p /
 * 竖屏素材上视觉比例一致，也避免竖屏时字幕被拉得过大或过小。
 */
function buildStyleLine(s: SubtitleStyle, scale: number): { format: string; style: string } {
  const alignment = s.position === 'top' ? 8 : 2; // ASS numpad：8=顶部居中，2=底部居中
  const font = safeFont(s.fontFamily, DEFAULT_SUBTITLE_STYLE.fontFamily);
  const baseSize = Number.isFinite(s.fontSize) && s.fontSize > 0
    ? s.fontSize : DEFAULT_SUBTITLE_STYLE.fontSize;
  const size = Math.max(8, Math.round(baseSize * scale));
  const primary = safeColor(s.primaryColor, DEFAULT_SUBTITLE_STYLE.primaryColor);
  const outline = safeColor(s.outlineColor, DEFAULT_SUBTITLE_STYLE.outlineColor);
  const baseOutline = Number.isFinite(s.outlineWidth) && s.outlineWidth >= 0
    ? s.outlineWidth : DEFAULT_SUBTITLE_STYLE.outlineWidth;
  const outlineW = Math.max(1, Math.round(baseOutline * scale));
  const marginV = Math.max(8, Math.round(size * 0.5));
  const marginH = Math.max(8, Math.round(size * 0.35));
  const format = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
  const style = `Style: Default,${font},${size},${primary},&H000000FF,${outline},&H80000000,0,0,0,0,100,100,0,0,1,${outlineW},0,${alignment},${marginH},${marginH},${marginV},1`;
  return { format, style };
}

/**
 * 生成完整 ASS 文本（[Script Info] / [V4+ Styles] / [Events]）。
 *
 * @param frame 视频真实宽高。不传则按 1920×1080 生成（兼容旧调用）。
 *              竖屏或非 16:9 素材必须传，否则 libass 会按 16:9 缩放导致字幕比例失真。
 */
export function toAssText(
  lines: LyricLine[],
  config: JobConfig,
  durationSec: number,
  frame?: AssFrame,
): string {
  const width = frame && Number.isFinite(frame.width) && frame.width > 0
    ? Math.round(frame.width) : DEFAULT_WIDTH;
  const height = frame && Number.isFinite(frame.height) && frame.height > 0
    ? Math.round(frame.height) : DEFAULT_HEIGHT;
  const scale = height / BASE_HEIGHT;

  const subtitle: SubtitleStyle = config.subtitle ?? DEFAULT_SUBTITLE_STYLE;
  const version: LyricsVersion = config.lyrics?.version ?? 'bilingual';
  const bilingualLines: 1 | 2 = subtitle.bilingualLines === 1 ? 1 : 2;
  const offsetMs = config.lyrics?.offsetMs;
  const offset = typeof offsetMs === 'number' && Number.isFinite(offsetMs) ? offsetMs : 0;
  const durationMs = Number.isFinite(durationSec) && durationSec > 0
    ? Math.max(0, Math.floor(durationSec * 1000)) : 0;

  const { format, style } = buildStyleLine(subtitle, scale);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    format,
    style,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const source = Array.isArray(lines) ? lines : [];
  const dialogues: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const line = source[i];
    const rawStart = Number(line.startMs) + offset;
    if (!Number.isFinite(rawStart)) continue;
    const nextStart = source[i + 1]?.startMs;
    const baseEnd = line.endMs !== undefined
      ? line.endMs
      : nextStart !== undefined ? nextStart : undefined;
    const rawEnd = baseEnd !== undefined ? Number(baseEnd) + offset : durationMs;
    // 裁剪到视频时长：末句结束不得超过 durationSec；完全在视频外的句子直接丢弃。
    const start = clamp(rawStart, 0, durationMs);
    const end = clamp(rawEnd, 0, durationMs);
    if (end <= start) continue;
    const text = renderLineText(line, version, bilingualLines);
    if (!text) continue;
    dialogues.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`);
  }

  return [...header, ...dialogues, ''].join('\n');
}
