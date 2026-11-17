/**
 * 歌词列表独立列：拿到歌词后出现，按时间列出每一句。
 * 支持界面校对（不做快捷键）：每行可「打点」（用预览当前时间作该句起点）与「删除」，
 * 改动会同时同步给主进程，保证烧录用的是同一份歌词。
 */
import { memo, useEffect, useRef, useState } from 'react';
import { formatLrcTime } from '../api/format';
import type { LyricLine, LyricsConfig, LyricsPayload } from '../../shared/contracts';

interface Props {
  payload: LyricsPayload | null;
  /** 校对后的行；缺省用 payload.lines */
  lines?: LyricLine[];
  version: LyricsConfig['version'];
  offsetMs: number;
  currentSec?: number;
  onSeekTo: (ms: number) => void;
  onLinesChange?: (next: LyricLine[] | null) => void;
}

/** 相邻两句之间至少留出的显示时长，防止打点把上一句压成负时长 */
const MIN_GAP_MS = 120;

function LyricsTimelineInner({
  payload,
  lines: overrideLines,
  version,
  offsetMs,
  currentSec,
  onSeekTo,
  onLinesChange,
}: Props) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const lines = overrideLines ?? payload?.lines ?? [];
  const visible = lines.slice(0, 200);

  let currentIndex = -1;
  if (currentSec !== undefined) {
    const t = currentSec * 1000;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startMs + offsetMs <= t) currentIndex = i;
      else break;
    }
  }

  useEffect(() => {
    if (currentIndex < 0) return;
    const node = listRef.current?.children[currentIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [currentIndex]);

  // 打点高亮只亮 2 秒，避免和「当前句」混淆
  useEffect(() => {
    if (pinnedIndex === null) return;
    const timer = window.setTimeout(() => setPinnedIndex(null), 2000);
    return () => window.clearTimeout(timer);
  }, [pinnedIndex]);

  const canEdit = Boolean(onLinesChange);

  const pin = (index: number): void => {
    if (!onLinesChange || currentSec === undefined) return;
    const target = Math.round(currentSec * 1000 - offsetMs);
    const prev = lines[index - 1];
    const floor = prev ? prev.startMs + MIN_GAP_MS : 0;
    const next = lines.slice();
    next[index] = { ...next[index], startMs: Math.max(target, floor) };
    onLinesChange(next);
    setPinnedIndex(index);
  };

  const remove = (index: number): void => {
    if (!onLinesChange) return;
    const next = lines.filter((_, i) => i !== index);
    if (next.length === 0) return;
    onLinesChange(next);
  };

  if (!payload && lines.length === 0) {
    return (
      <section className="card card--lyrics timeline" aria-label="歌词列表">
        <div className="card__head">
          <h2 className="card__title">歌词列表</h2>
          <span className="card__hint">等待歌词</span>
        </div>
        <p className="note-inline">拿到歌词后，这里会按时间列出每一句；点一行就跳到对应时刻。</p>
      </section>
    );
  }

  return (
    <section className="card card--lyrics timeline" aria-label="歌词列表">
      <div className="card__head">
        <h2 className="card__title">歌词列表</h2>
        <span className="card__hint">
          {lines.length > 200 ? `共 ${lines.length} 句 · 显示前 200` : `共 ${lines.length} 句`}
        </span>
      </div>
      {canEdit && (
        <p className="note-inline timeline__tip">
          点行首 <b className="timeline__glyph">◉</b> 用预览当前时间给这句打点，点行尾 <b className="timeline__glyph">×</b> 删除。
        </p>
      )}
      <ul className="lyrics__lines" ref={listRef}>
        {visible.map((line, i) => {
          const primary = version === 'translation' ? (line.translation ?? line.text) : line.text;
          const secondary = version === 'bilingual' && line.translation ? line.translation : null;
          return (
            <li
              key={`${line.startMs}-${i}`}
              aria-current={i === currentIndex ? 'true' : undefined}
              data-pinned={pinnedIndex === i ? 'true' : undefined}
            >
              {canEdit && (
                <button
                  type="button"
                  className="timeline__pin"
                  onClick={() => pin(i)}
                  title="用预览当前时间给这一句打点"
                  aria-label={`用预览当前时间给第 ${i + 1} 句打点`}
                >
                  <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true" focusable="false">
                    <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    <circle cx="6" cy="6" r="1.5" fill="currentColor" />
                  </svg>
                </button>
              )}
              <button
                className="lyrics__row-main"
                type="button"
                onClick={() => onSeekTo(line.startMs + offsetMs)}
                aria-label={`跳到第 ${i + 1} 句，${formatLrcTime(line.startMs + offsetMs)}`}
              >
                <span className="mono">{formatLrcTime(line.startMs + offsetMs)}</span>
                <span className="lyrics__line-text">{primary}</span>
                {secondary && <span className="lyrics__line-trans">{secondary}</span>}
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="timeline__del"
                  onClick={() => remove(i)}
                  title="删除这一句"
                  aria-label={`删除第 ${i + 1} 句`}
                >
                  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
                    <path
                      d="M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 用 memo 包住：列宽补间（每帧一次渲染）与拖动时 App 会频繁重渲染，
 * 这个列表最多 200 行，不需要跟着重画。props 都是稳定引用或基本类型，memo 有效。
 */
export const LyricsTimeline = memo(LyricsTimelineInner);
