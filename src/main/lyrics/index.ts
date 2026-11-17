/**
 * 歌词与字幕层适配器：在线获取 / 本地导入 / 手工粘贴 / ASS 生成。
 * 失败一律返回 UNAVAILABLE / EMPTY 值对象，绝不把异常抛到主管线（§6.6）。
 * 依据 docs/MTV转换器-设计文档与开发方案.md §6.5 / §6.6 / §6.7 / §7.9。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULTS } from '../../shared/contracts';
import type {
  ErrorCode,
  JobConfig,
  LyricsFormat,
  LyricsPayload,
  LyricsPort,
  LyricsSource,
  LyricLine,
  RuntimePaths,
} from '../../shared/contracts';

import {
  isLyricsEmpty,
  mergeTranslation,
  parseLrc,
  parseSrt,
  parseSongId,
} from './parse';
import { toAssText } from './ass';

// 纯函数对外导出，便于单元测试（不触网、不依赖运行时路径）
export { parseSongId, isLyricsEmpty, parseLrc, parseSrt } from './parse';
export { toAssText } from './ass';

type FetchOutcome =
  | { kind: 'ok'; body: string }
  | { kind: 'retryable'; reason: ErrorCode };

function payloadFromLines(lines: LyricLine[], source: LyricsSource, format: LyricsFormat): LyricsPayload {
  if (lines.length === 0) {
    return { status: 'EMPTY', lines: [], version: 'original', format, source };
  }
  const hasTranslation = lines.some((l) => l.translation !== undefined);
  return {
    status: 'READY',
    lines,
    version: hasTranslation ? 'bilingual' : 'original',
    format,
    source,
  };
}

function unavailable(source: LyricsSource, reasonCode: ErrorCode): LyricsPayload {
  return { status: 'UNAVAILABLE', lines: [], version: 'original', format: 'lrc', source, reasonCode };
}

function empty(source: LyricsSource, format: LyricsFormat): LyricsPayload {
  return { status: 'EMPTY', lines: [], version: 'original', format, source };
}

function normalizeBase(base: string): string {
  const b = typeof base === 'string' && base.trim() ? base.trim() : 'https://lyric.photix.cc';
  return b.replace(/\/+$/, '');
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LyricsService implements LyricsPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly assDir: string;
  /** 界面校对结果：非空时覆盖取词结果，保证打点/删行能进烧录 */
  private editedLines: LyricLine[] | null = null;

  constructor(paths: RuntimePaths) {
    this.baseUrl = normalizeBase(paths.lyricsBaseUrl);
    this.timeoutMs = positiveOr(paths.lyricsTimeoutMs, DEFAULTS.lyricsTimeoutMs);
    this.maxRetries = DEFAULTS.lyricsMaxRetries;
    this.assDir = paths.cacheDir;
  }

  setEditedLines(lines: LyricLine[] | null): void {
    this.editedLines = lines && lines.length > 0 ? lines : null;
  }

  private applyEdits(payload: LyricsPayload): LyricsPayload {
    if (!this.editedLines) return payload;
    return { ...payload, status: 'READY', lines: this.editedLines };
  }

  async fetchOnline(songIdOrLink: string): Promise<LyricsPayload> {
    return this.applyEdits(await this.fetchOnlineRaw(songIdOrLink));
  }

  private async fetchOnlineRaw(songIdOrLink: string): Promise<LyricsPayload> {
    try {
      const id = parseSongId(songIdOrLink);
      if (id === null) {
        return unavailable('online', 'E_LYRICS_INVALID_ID'); // 其它来源 / 非法 ID
      }
      // 仅发送用户主动提供的数字 ID，不上传任何媒体文件（NFR-09）。
      const url = `${this.baseUrl}/api/lyric?id=${encodeURIComponent(id)}`;
      let lastReason: ErrorCode = 'E_LYRICS_TIMEOUT';
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) {
          // 仅对可重试错误做简单指数退避（1s、2s…）。
          await delay(Math.min(1000 * 2 ** (attempt - 1), 4000));
        }
        const outcome = await this.requestOnce(url);
        if (outcome.kind === 'ok') {
          // 业务错误 / 空歌词 / 契约变更都在此直接返回，不重试。
          return this.parseOnlineBody(outcome.body);
        }
        lastReason = outcome.reason;
      }
      return unavailable('online', lastReason);
    } catch {
      return unavailable('online', 'E_LYRICS_TIMEOUT');
    }
  }

  async fromLocal(filePath: string, format: LyricsFormat): Promise<LyricsPayload> {
    return this.applyEdits(await this.fromLocalRaw(filePath, format));
  }

  private async fromLocalRaw(filePath: string, format: LyricsFormat): Promise<LyricsPayload> {
    try {
      const text = await readFile(filePath, 'utf8');
      const lines = format === 'srt' ? parseSrt(text) : parseLrc(text);
      return payloadFromLines(lines, 'local', format);
    } catch {
      return unavailable('local', 'E_LYRICS_PARSE');
    }
  }

  async fromPasted(text: string, format: LyricsFormat): Promise<LyricsPayload> {
    return this.applyEdits(await this.fromPastedRaw(text, format));
  }

  private async fromPastedRaw(text: string, format: LyricsFormat): Promise<LyricsPayload> {
    try {
      const lines = format === 'srt' ? parseSrt(text) : parseLrc(text);
      return payloadFromLines(lines, 'paste', format);
    } catch {
      return unavailable('paste', 'E_LYRICS_PARSE');
    }
  }

  async toAss(
    payload: LyricsPayload,
    config: JobConfig,
    durationSec: number,
    frame?: { width: number; height: number },
  ): Promise<string> {
    try {
      // 空 lines 也写出合法 ASS 骨架（0 个 Dialogue 事件），保证三种「无字幕」结果等价。
      const text = toAssText(payload.lines ?? [], config, durationSec, frame);
      await mkdir(this.assDir, { recursive: true });
      const assPath = join(this.assDir, 'lyrics.ass');
      await writeFile(assPath, text, 'utf8');
      return assPath; // 编排层把返回值作为 subtitleAssPath 使用
    } catch {
      // 写盘失败降级：返回空字符串，编排层据此跳过烧录，产出合法无字幕文件。
      return '';
    }
  }

  /** 单次请求：超时用 AbortController；不依赖 Content-Type，直接读 body 文本。 */
  private async requestOnce(url: string): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      if (response.status >= 500) {
        return { kind: 'retryable', reason: 'E_LYRICS_TIMEOUT' };
      }
      const body = await response.text();
      return { kind: 'ok', body };
    } catch {
      // 超时（AbortError）/ DNS / 连接失败：可重试。
      return { kind: 'retryable', reason: 'E_LYRICS_TIMEOUT' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 解析在线响应 body：业务码、空歌词哨兵、契约变更分别归类。 */
  private parseOnlineBody(body: string): LyricsPayload {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return unavailable('online', 'E_LYRICS_PARSE'); // 非 JSON / 解析异常
    }
    if (!isRecord(data)) {
      return unavailable('online', 'E_LYRICS_PARSE');
    }
    // 业务错误用 HTTP 200 承载（{"code":400,"msg":"wrong params"}），必须解析 body 的 code。
    if (data.code !== undefined && data.code !== null && Number(data.code) !== 200) {
      return unavailable('online', 'E_LYRICS_PARSE');
    }
    if (data.uncollected === true) {
      return empty('online', 'lrc');
    }
    if (!isRecord(data.lrc) || typeof data.lrc.lyric !== 'string') {
      return unavailable('online', 'E_LYRICS_CONTRACT_CHANGED'); // 契约变更
    }
    const raw = data.lrc.lyric;
    if (isLyricsEmpty(raw)) {
      return empty('online', 'lrc'); // 哨兵 / 仅元信息行
    }
    const original = parseLrc(raw);
    if (original.length === 0) {
      return empty('online', 'lrc');
    }
    // klyric（逐字）实测常为空、不可依赖，首版忽略；翻译取自 tlyric。
    let translated: LyricLine[] = [];
    if (isRecord(data.tlyric) && typeof data.tlyric.lyric === 'string' && !isLyricsEmpty(data.tlyric.lyric)) {
      translated = parseLrc(data.tlyric.lyric);
    }
    return payloadFromLines(mergeTranslation(original, translated), 'online', 'lrc');
  }
}
