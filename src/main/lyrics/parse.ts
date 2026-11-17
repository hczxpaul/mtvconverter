/**
 * 歌词解析纯函数：歌曲 ID 解析、空歌词判定、LRC / SRT 解析与双语合并。
 * 本文件不触网、不读写文件、不启动子进程，便于单元测试。
 * 依据 docs/MTV转换器-设计文档与开发方案.md §6.5 / §6.7 / §7.9。
 */
import type { LyricLine } from '../../shared/contracts';

// LRC 时间戳标签 [mm:ss.xx] / [mm:ss.xxx]，以及元信息标签 [ti:..] 等
const LRC_TIME_TAG_G = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
const LRC_TIME_TAG_ONE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]$/;
const LRC_META_LINE = /^\[[a-zA-Z][\w-]*:/;
const SRT_TIME_LINE = /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/** 把 LRC / SRT 的小数部分（1/2/3 位）换算成毫秒。 */
function fracToMs(frac: string): number {
  const n = Number(frac);
  if (frac.length === 1) return n * 100;
  if (frac.length === 2) return n * 10;
  return n;
}

interface TimedText {
  startMs: number;
  text: string;
}

/**
 * 仅接受网易云单曲链接（music.163.com/#/song?id=<数字>）或纯数字 ID。
 * 其它来源或无法解析时返回 null，由调用方映射为 E_LYRICS_INVALID_ID。
 */
export function parseSongId(input: string): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;

  // 校验域名，避免把其它平台链接误当作歌曲 ID。
  let hostname: string;
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    hostname = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/(^|\.)163\.com$/i.test(hostname)) return null;

  // id 可能位于 hash 之后的查询串（/#/song?id=123），故用字符串正则提取。
  const match = s.match(/[?&]id=(\d+)/i);
  return match ? match[1] : null;
}

/**
 * 判断原始歌词文本是否为空：空串、哨兵文本、未收录标记、仅元信息行 / 空时间戳行。
 * 用于在线接口 lrc.lyric 的空歌词判定（§6.5 / §6.6）。
 */
export function isLyricsEmpty(raw: string): boolean {
  if (typeof raw !== 'string') return true;
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return true;
  if (/暂无歌词|暂无文本|纯音乐|uncollected\s*=\s*true/i.test(text)) return true;
  for (const rawLine of text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    if (LRC_META_LINE.test(t)) continue; // 过滤 [ti:/ar:/al:/by:/offset:] 等元信息
    const body = t.replace(LRC_TIME_TAG_G, '').trim();
    if (body) return false; // 存在有效歌词文本 → 非空
  }
  return true;
}

function lrcTagToMs(tag: string): number | null {
  const m = LRC_TIME_TAG_ONE.exec(tag);
  if (!m) return null;
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + fracToMs(m[3] ?? '0');
}

/** 把 (startMs, text) 序列按时间戳分组，同时间戳第二条作为翻译，并推导句末时间。 */
function groupToLines(entries: TimedText[]): LyricLine[] {
  entries.sort((a, b) => a.startMs - b.startMs);
  const grouped = new Map<number, string[]>();
  for (const e of entries) {
    const arr = grouped.get(e.startMs);
    if (arr) {
      if (arr.length < 2) arr.push(e.text); // 原文在上、翻译在下，最多两行
    } else {
      grouped.set(e.startMs, [e.text]);
    }
  }
  const starts = [...grouped.keys()].sort((a, b) => a - b);
  const lines: LyricLine[] = starts.map((startMs) => {
    const texts = grouped.get(startMs)!;
    const line: LyricLine = { startMs, text: texts[0] };
    if (texts.length > 1) line.translation = texts[1];
    return line;
  });
  // 用下一句起点推导本句结束；末句不填，留给 ASS 阶段裁剪到视频时长。
  for (let i = 0; i < lines.length - 1; i++) {
    lines[i].endMs = lines[i + 1].startMs;
  }
  return lines;
}

/** 解析 LRC（[mm:ss.xx] 行），过滤元信息行，支持同时间戳双语合并。 */
export function parseLrc(text: string): LyricLine[] {
  if (typeof text !== 'string') return [];
  const entries: TimedText[] = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    if (LRC_META_LINE.test(t)) continue;
    const tags = t.match(LRC_TIME_TAG_G);
    if (!tags) continue; // 无时间戳行忽略
    const body = t.replace(LRC_TIME_TAG_G, '').trim();
    if (!body) continue; // 纯时间戳、无文本
    for (const tag of tags) {
      const startMs = lrcTagToMs(tag);
      if (startMs !== null) entries.push({ startMs, text: body });
    }
  }
  return groupToLines(entries);
}

/** 解析 SRT，块内多行文本的前两行分别作为原文与翻译。 */
export function parseSrt(text: string): LyricLine[] {
  if (typeof text !== 'string') return [];
  const blocks = text.replace(/^\uFEFF/, '').trim().split(/\r?\n\s*\r?\n/);
  const lines: LyricLine[] = [];
  for (const block of blocks) {
    const rows = block.split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0);
    if (rows.length === 0) continue;
    let timeRow = -1;
    let startMs = 0;
    let endMs = 0;
    for (let i = 0; i < rows.length; i++) {
      const m = SRT_TIME_LINE.exec(rows[i]);
      if (m) {
        startMs = Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + fracToMs(m[4]);
        endMs = Number(m[5]) * 3600000 + Number(m[6]) * 60000 + Number(m[7]) * 1000 + fracToMs(m[8]);
        timeRow = i;
        break;
      }
    }
    if (timeRow < 0) continue;
    const textRows = rows.slice(timeRow + 1);
    if (textRows.length === 0) continue;
    const line: LyricLine = { startMs, text: textRows[0] };
    if (endMs > startMs) line.endMs = endMs;
    if (textRows.length > 1) line.translation = textRows[1];
    lines.push(line);
  }
  lines.sort((a, b) => a.startMs - b.startMs);
  return lines;
}

/**
 * 在线接口的原文 LRC 与翻译 LRC（tlyric）按同时间戳合并。
 * klyric（逐字）实测常为空、不可依赖，首版不参与合并（§6.7 / P2）。
 */
export function mergeTranslation(original: LyricLine[], translation: LyricLine[]): LyricLine[] {
  if (translation.length === 0) return original;
  const byStart = new Map<number, string>();
  for (const t of translation) {
    if (!byStart.has(t.startMs)) byStart.set(t.startMs, t.text);
  }
  return original.map((o) => {
    const t = byStart.get(o.startMs);
    if (t !== undefined && t !== '' && t !== o.text && o.translation === undefined) {
      return { ...o, translation: t };
    }
    return o;
  });
}
