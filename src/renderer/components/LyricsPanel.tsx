import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  LyricsConfig, LyricsPayload, LyricsStatus, MediaCapabilities, SubtitleStyle,
} from '../../shared/contracts';
import type { LyricsFetchInput } from '../../shared/preload-api';
import { formatLrcTime } from '../api/format';
import { Semantic } from './Semantic';

interface Props {
  expanded: boolean;
  onToggle: () => void;
  lyrics: LyricsConfig;
  subtitle: SubtitleStyle;
  onLyricsChange: (patch: Partial<LyricsConfig>) => void;
  onSubtitleChange: (patch: Partial<SubtitleStyle>) => void;
  status: LyricsStatus;
  payload: LyricsPayload | null;
  busy: boolean;
  onFetch: (input: LyricsFetchInput) => void;
  onSelectLocal: () => void;
  onBurnRequest: () => void;
  onSeekTo: (ms: number) => void;
  capabilities: MediaCapabilities | null;
  /** 当前播放秒数，用于标记时间轴里的当前句 */
  currentSec?: number;
}

/** 六态一行平实文案，图标 + 文字，不用横幅、不显示错误码。 */
function statusLine(
  status: LyricsStatus,
  payload: LyricsPayload | null,
  busy: boolean,
): ReactNode {
  if (busy || status === 'FETCHING') {
    return <Semantic tone="info">正在找歌词…</Semantic>;
  }
  const count = payload?.lines.length ?? 0;
  switch (status) {
    case 'READY':
      return <Semantic tone="success">已找到 {count} 句歌词</Semantic>;
    case 'BURN_CONFIRMED':
      return <Semantic tone="success">已确认烧进画面，共 {count} 句</Semantic>;
    case 'UNAVAILABLE':
      return <Semantic tone="warn">没拿到歌词，可以重试或换一种方式</Semantic>;
    case 'EMPTY':
      return <Semantic tone="info">这首歌没有歌词</Semantic>;
    default:
      return null;
  }
}

/** 控件 5：首页「歌词（可选）▸」折叠区，默认折叠；收起时零技术术语。 */
export function LyricsPanel({
  expanded,
  onToggle,
  lyrics,
  subtitle,
  onLyricsChange,
  onSubtitleChange,
  status,
  payload,
  busy,
  onFetch,
  onSelectLocal,
  onBurnRequest,
  onSeekTo,
  capabilities,
  currentSec,
}: Props) {
  const [styleOpen, setStyleOpen] = useState(false);

  // 时间偏移支持手动输入：编辑期用草稿值，失焦或回车才提交，
  // 避免输入 "-" / 空串这类中间态被立刻格式化成 0。
  const [offsetDraft, setOffsetDraft] = useState(String(lyrics.offsetMs));
  useEffect(() => {
    setOffsetDraft(String(lyrics.offsetMs));
  }, [lyrics.offsetMs]);
  const commitOffset = (): void => {
    const n = Number(offsetDraft.trim());
    if (!Number.isFinite(n)) {
      setOffsetDraft(String(lyrics.offsetMs));
      return;
    }
    const next = Math.round(n);
    if (next !== lyrics.offsetMs) onLyricsChange({ offsetMs: next });
    setOffsetDraft(String(next));
  };

  const buildInput = (source: LyricsFetchInput['source']): LyricsFetchInput => ({
    source,
    songLink: lyrics.songLink,
    localPath: lyrics.localPath,
    pastedText: lyrics.pastedText,
    version: lyrics.version,
    format: lyrics.format,
    offsetMs: lyrics.offsetMs,
  });

/** ASS 颜色 &HAABBGGRR → #RRGGBB（取低 6 位，忽略 alpha）。 */
function assToHex(value: string, fallback: string): string {
  const m = /^&H([0-9A-Fa-f]{8})$/.exec(value ?? '');
  if (!m) return fallback;
  const raw = m[1].slice(2); // BBGGRR
  return `#${raw.slice(4, 6)}${raw.slice(2, 4)}${raw.slice(0, 2)}`;
}

/** #RRGGBB → ASS &H00BBGGRR。 */
function hexToAss(hex: string): string {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex ?? '');
  if (!m) return '&H00FFFFFF';
  const [rr, gg, bb] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

  const currentLineIndex = useMemo(() => {
    const lines = payload?.lines ?? [];
    if (lines.length === 0 || currentSec === undefined) return -1;
    const t = currentSec * 1000;
    let idx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startMs + (lyrics.offsetMs ?? 0) <= t) idx = i;
      else break;
    }
    return idx;
  }, [payload, currentSec, lyrics.offsetMs]);

  const canBurn =
    status !== 'EMPTY' && status !== 'UNAVAILABLE' && capabilities?.libass !== false;

  return (
    <section className="lyrics" aria-label="歌词设置">
      <button
        type="button"
        className="lyrics__toggle"
        aria-expanded={expanded}
        aria-controls="lyrics-body"
        onClick={onToggle}
      >
        <span>歌词与字幕<small>
          {payload?.lines?.length ?? 0} 句 · {lyrics.version === 'original' ? '原文' : lyrics.version === 'translation' ? '翻译' : '双语'} · {subtitle.bilingualLines} 行 · 偏移 {lyrics.offsetMs} ms · {lyrics.burn ? '已烧录' : '不烧录'}
        </small></span>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      <div className="lyrics__body" id="lyrics-body" hidden={!expanded}>
          <label className="switch">
            <input
              type="checkbox"
              checked={lyrics.enabled}
              onChange={(e) => onLyricsChange({ enabled: e.target.checked })}
            />
            <span>为这个视频添加歌词</span>
          </label>

          {lyrics.enabled && (
            <>
              <fieldset className="lyrics__group">
                <legend>① 从哪拿歌词</legend>
                <div className="lyrics__radios">
                  <label>
                    <input
                      type="radio"
                      name="lyrics-source"
                      checked={lyrics.source === 'online'}
                      onChange={() => onLyricsChange({ source: 'online' })}
                    />
                    歌曲链接或 ID
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="lyrics-source"
                      checked={lyrics.source === 'local'}
                      onChange={() => onLyricsChange({ source: 'local' })}
                    />
                    本地 .lrc / .srt 文件
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="lyrics-source"
                      checked={lyrics.source === 'paste'}
                      onChange={() => onLyricsChange({ source: 'paste' })}
                    />
                    手动粘贴
                  </label>
                </div>

                {lyrics.source === 'online' && (
                  <div className="lyrics__fetch">
                    <input
                      className="input"
                      type="text"
                      value={lyrics.songLink ?? ''}
                      placeholder="粘贴网易云单曲链接或数字 ID"
                      aria-label="歌曲链接或数字 ID"
                      onChange={(e) => onLyricsChange({ songLink: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy || !(lyrics.songLink ?? '').trim()}
                      onClick={() => onFetch(buildInput('online'))}
                      aria-busy={busy}
                    >
                      {busy ? '获取中…' : '获取歌词'}
                    </button>
                  </div>
                )}

                {lyrics.source === 'local' && (
                  <div className="lyrics__fetch">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={onSelectLocal}
                    >
                      选择歌词文件
                    </button>
                    {lyrics.localPath && (
                      <span className="lyrics__path" title={lyrics.localPath}>
                        {lyrics.localPath.split(/[\\/]/).pop()}
                      </span>
                    )}
                    <select
                      className="select"
                      value={lyrics.format}
                      onChange={(e) =>
                        onLyricsChange({ format: e.target.value as LyricsConfig['format'] })
                      }
                      aria-label="歌词文件格式"
                    >
                      <option value="lrc">LRC</option>
                      <option value="srt">SRT</option>
                    </select>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy || !lyrics.localPath}
                      onClick={() => onFetch(buildInput('local'))}
                      aria-busy={busy}
                    >
                      {busy ? '读取中…' : '用这个文件'}
                    </button>
                  </div>
                )}

                {lyrics.source === 'paste' && (
                  <div className="lyrics__paste">
                    <textarea
                      className="textarea"
                      rows={4}
                      value={lyrics.pastedText ?? ''}
                      placeholder="把歌词内容粘贴到这里"
                      aria-label="粘贴歌词内容"
                      onChange={(e) => onLyricsChange({ pastedText: e.target.value })}
                    />
                    <div className="lyrics__paste-actions">
                      <select
                        className="select"
                        value={lyrics.format}
                        onChange={(e) =>
                          onLyricsChange({ format: e.target.value as LyricsConfig['format'] })
                        }
                        aria-label="歌词格式"
                      >
                        <option value="lrc">LRC</option>
                        <option value="srt">SRT</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={busy || !(lyrics.pastedText ?? '').trim()}
                        onClick={() => onFetch(buildInput('paste'))}
                        aria-busy={busy}
                      >
                        {busy ? '解析中…' : '用这段歌词'}
                      </button>
                    </div>
                  </div>
                )}
              </fieldset>

              <div className="lyrics__status" role={status === 'UNAVAILABLE' ? 'alert' : undefined}>{statusLine(status, payload, busy)}</div>
              {status === 'UNAVAILABLE' && (
                <div className="lyrics__actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => onFetch(buildInput(lyrics.source))}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={onSelectLocal}
                  >
                    导入本地文件
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onLyricsChange({ source: 'paste' })}
                  >
                    粘贴歌词
                  </button>
                </div>
              )}

              <fieldset className="lyrics__group">
                <legend>② 歌词内容</legend>
                <div className="lyrics__radios">
                  <label>
                    <input
                      type="radio"
                      name="lyrics-version"
                      checked={lyrics.version === 'original'}
                      onChange={() => onLyricsChange({ version: 'original' })}
                    />
                    原文
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="lyrics-version"
                      checked={lyrics.version === 'translation'}
                      onChange={() => onLyricsChange({ version: 'translation' })}
                    />
                    翻译
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="lyrics-version"
                      checked={lyrics.version === 'bilingual'}
                      onChange={() => onLyricsChange({ version: 'bilingual' })}
                    />
                    双语
                  </label>
                </div>
                <div className="lyrics__offset">
                  <span>时间偏移</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-label="减少 10 毫秒"
                    onClick={() => onLyricsChange({ offsetMs: lyrics.offsetMs - 10 })}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    className="input lyrics__offset-input"
                    aria-label="时间偏移毫秒数"
                    aria-describedby="offset-help"
                    step={10}
                    value={offsetDraft}
                    onChange={(e) => setOffsetDraft(e.target.value)}
                    onBlur={commitOffset}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitOffset();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <span className="lyrics__offset-unit">ms</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-label="增加 10 毫秒"
                    onClick={() => onLyricsChange({ offsetMs: lyrics.offsetMs + 10 })}
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onLyricsChange({ offsetMs: 0 })}
                  >
                    重置
                  </button>
                </div>
                <p className="note-inline" id="offset-help">单位毫秒；负数提前、正数延后。停手后自动试听这一句。</p>
              </fieldset>

              {payload && payload.lines.length > 0 && (
                <div className="lyrics__preview">
                  <span className="lyrics__preview-title">
                    时间轴预览 · {payload.lines.length > 200 ? `共 ${payload.lines.length} 句，显示前 200 句` : `共 ${payload.lines.length} 句`} · 点一行跳到对应时刻
                  </span>
                  <ul className="lyrics__lines">
                    {payload.lines.slice(0, 200).map((line, i) => {
                      // 版本裁剪与 toAssText 保持一致：payload.lines 始终含原文与翻译，
                      // 由本地配置决定显示哪部分，不用 payload.version。
                      const primary =
                        lyrics.version === 'translation'
                          ? (line.translation ?? line.text)
                          : line.text;
                      const secondary =
                        lyrics.version === 'bilingual' && line.translation
                          ? line.translation
                          : null;
                      return (
                        <li key={`${line.startMs}-${i}`} aria-current={i === currentLineIndex ? 'true' : undefined}>
                          <button
                            type="button"
                            onClick={() => onSeekTo(line.startMs + lyrics.offsetMs)}
                          >
                            <span className="mono">
                              {formatLrcTime(line.startMs + lyrics.offsetMs)}
                            </span>
                            <span className="lyrics__line-text">{primary}</span>
                            {secondary && (
                              <span className="lyrics__line-trans">{secondary}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <section className="lyrics__sub">
                <button
                  type="button"
                  className="lyrics__sub-toggle"
                  aria-expanded={styleOpen}
                  aria-controls="subtitle-style"
                  onClick={() => setStyleOpen((v) => !v)}
                >
                  ③ 字幕样式
                  <span aria-hidden="true">{styleOpen ? '▾' : '▸'}</span>
                </button>
                  <div className="lyrics__sub-body" id="subtitle-style" hidden={!styleOpen}>
                    <label className="field">
                      <span className="field__label">字体</span>
                      <select
                        className="select"
                        value={subtitle.fontFamily}
                        onChange={(e) => onSubtitleChange({ fontFamily: e.target.value })}
                      >
                        <option value="Noto Sans CJK SC">Noto Sans CJK SC（内置）</option>
                        {subtitle.fontFamily !== 'Noto Sans CJK SC' && (
                          <option value={subtitle.fontFamily}>{subtitle.fontFamily}（会回落）</option>
                        )}
                      </select>
                      <span className="unit">仅内置这一款</span>
                    </label>
                    <label className="field">
                      <span className="field__label">字号</span>
                      <input
                        className="input"
                        type="number"
                        min={12}
                        max={120}
                        value={subtitle.fontSize}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) onSubtitleChange({ fontSize: Math.min(120, Math.max(12, n)) });
                        }}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">主色</span>
                      <input
                        className="input"
                        type="color"
                        value={assToHex(subtitle.primaryColor, '#FFFFFF')}
                        onChange={(e) => onSubtitleChange({ primaryColor: hexToAss(e.target.value) })}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">描边色</span>
                      <input
                        className="input"
                        type="color"
                        value={assToHex(subtitle.outlineColor, '#000000')}
                        onChange={(e) => onSubtitleChange({ outlineColor: hexToAss(e.target.value) })}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">描边宽度</span>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={8}
                        step={0.5}
                        value={subtitle.outlineWidth}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) onSubtitleChange({ outlineWidth: Math.min(8, Math.max(0, n)) });
                        }}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">位置</span>
                      <select
                        className="select"
                        value={subtitle.position}
                        onChange={(e) =>
                          onSubtitleChange({
                            position: e.target.value as SubtitleStyle['position'],
                          })
                        }
                      >
                        <option value="bottom">画面底部</option>
                        <option value="top">画面顶部</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field__label">双语行数</span>
                      <select
                        className="select"
                        value={subtitle.bilingualLines}
                        onChange={(e) =>
                          onSubtitleChange({
                            bilingualLines: Number(e.target.value) as SubtitleStyle['bilingualLines'],
                          })
                        }
                      >
                        <option value={1}>单行</option>
                        <option value={2}>双行</option>
                      </select>
                    </label>
                  </div>
              </section>

              {capabilities?.libass === false && (
                <div className="lyrics__status">
                  <Semantic tone="warn">
                    当前环境不能把歌词烧进画面，仍可预览歌词
                  </Semantic>
                </div>
              )}

              <label className="switch lyrics__burn">
                <input
                  type="checkbox"
                  checked={lyrics.burn}
                  disabled={!canBurn}
                  onChange={(e) => {
                    if (e.target.checked) onBurnRequest();
                    else onLyricsChange({ burn: false });
                  }}
                />
                <span>把歌词烧进画面（之后去不掉）</span>
              </label>
            </>
          )}

          <p className="lyrics__footer">
            歌词仅供个人学习交流；收起即保存配置，不会启动转换
          </p>
        </div>
    </section>
  );
}
