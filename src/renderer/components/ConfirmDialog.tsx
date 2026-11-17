import { useEffect, useRef, useState } from 'react';
import type { AudioStreamInfo } from '../../shared/contracts';
import { useFocusTrap } from '../hooks/useFocusTrap';

/** L3 打断只有两类：非单轨确认、烧录不可逆确认。其余一律不弹窗。 */
export type ConfirmState =
  | { kind: 'tracks'; jobId: string; streams: AudioStreamInfo[] }
  | { kind: 'burn' }
  | null;

interface Props {
  state: ConfirmState;
  onTracksContinue: (audioStreamIndex: number) => void;
  onTracksSkip: () => void;
  onBurnConfirm: () => void;
  onBurnCancel: () => void;
}

function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function streamLabel(s: AudioStreamInfo, i: number): string {
  const bits = [
    `音轨 ${i + 1}`,
    s.codec,
    `${s.channels}ch`,
    formatSeconds(s.durationSec),
    s.language,
    s.title,
  ].filter(Boolean);
  return bits.join(' · ');
}

export function ConfirmDialog({
  state,
  onTracksContinue,
  onTracksSkip,
  onBurnConfirm,
  onBurnCancel,
}: Props) {
  const [selected, setSelected] = useState<number | ''>('');
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useFocusTrap(state !== null, dialogRef);

  useEffect(() => {
    if (!state) return;
    if (state.kind === 'tracks') {
      setSelected(state.streams[0]?.index ?? '');
    }
    // 默认焦点落在安全按钮（「再想想」/「跳过」），不是破坏性动作
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (state.kind === 'burn') onBurnCancel();
      else onTracksSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onBurnCancel, onTracksSkip]);

  if (!state) return null;

  return (
    <div className="dialog__backdrop">
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-desc"
      >
        {state.kind === 'tracks' ? (
          <>
            <h2 id="dialog-title" className="dialog__title">
              这个文件不止一条音轨，用哪条当原唱？
            </h2>
            <p id="dialog-desc" className="dialog__text">
              选好再继续，不然可能把伴奏当成了原唱。
            </p>
            <label className="field">
              <span className="field__label">选一条音轨</span>
              <select
                className="select"
                value={selected}
                onChange={(e) =>
                  setSelected(e.target.value === '' ? '' : Number(e.target.value))
                }
              >
                {state.streams.length === 0 ? (
                  <option value="">暂时读不到音轨信息</option>
                ) : (
                  state.streams.map((s, i) => (
                    <option key={s.index} value={s.index}>
                      {streamLabel(s, i)}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="dialog__actions">
              <button
                ref={cancelRef}
                data-autofocus
                className="btn btn--ghost"
                type="button"
                onClick={onTracksSkip}
              >
                跳过这个文件
              </button>
              <button
                className="btn btn--primary"
                type="button"
                disabled={selected === ''}
                onClick={() => onTracksContinue(Number(selected))}
              >
                继续
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="dialog-title" className="dialog__title">
              把歌词烧进画面？
            </h2>
            <p id="dialog-desc" className="dialog__text">
              歌词会成为画面的一部分，之后没法去掉。确定继续吗？
            </p>
            <div className="dialog__actions">
              <button
                ref={cancelRef}
                data-autofocus
                className="btn btn--ghost"
                type="button"
                onClick={onBurnCancel}
              >
                再想想
              </button>
              <button
                className="btn btn--primary btn--danger"
                type="button"
                onClick={onBurnConfirm}
              >
                确定，烧进画面
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
