import type { BackendDecision, StageCode } from '../../shared/contracts';
import { Semantic } from './Semantic';

interface Props {
  text: string;
  percent: number | null;
  busy: boolean;
  completed: boolean;
  hasOutput: boolean;
  /** 当前阶段，用于底部紧凑阶段链 */
  stageCode?: StageCode | null;
  /** 输出文件等次要信息 */
  outputMeta?: string;
  /** 临时提示：独立一行，绝不覆盖主状态文本 */
  notice?: string;
  canStart: boolean;
  onStart: () => void;
  onCancel: () => void;
  onDetails: () => void;
  onOpenFolder: () => void;
  onPreviewOutput: () => void;
  fallback: BackendDecision | null;
  detailLine?: string;
}

const STAGES: { code: StageCode; name: string }[] = [
  { code: 'PROBE', name: '读取视频' },
  { code: 'EXTRACT', name: '准备声音' },
  { code: 'LYRICS', name: '整理歌词' },
  { code: 'ACCOMPANIMENT', name: '生成伴奏' },
  { code: 'ALIGN', name: '对齐声音' },
  { code: 'ENCODE_MUX', name: '压缩视频' },
  { code: 'VALIDATE', name: '检查成品' },
];

/**
 * 底部常驻操作带：状态、进度、阶段链、主操作与成品动作集中在同一视线带。
 * notice 独立成行，不再像旧版那样顶掉状态文本（审查报告 P0）。
 */
export function StatusRow({
  text,
  percent,
  busy,
  completed,
  hasOutput,
  stageCode,
  outputMeta,
  notice,
  canStart,
  onStart,
  onCancel,
  onDetails,
  onOpenFolder,
  onPreviewOutput,
  fallback,
  detailLine,
}: Props) {
  const currentIndex = stageCode ? STAGES.findIndex((s) => s.code === stageCode) : -1;

  return (
    <>
      <div className="dock__inner">
        <div className="dock__state" role="status" aria-live="polite">
          <div className="status__line">
            <span className="status__text">{text}</span>
            {fallback?.degraded && <Semantic tone="info">已改用 CPU，预计多花约 2 分钟</Semantic>}
            {detailLine && <span className="status__detail mono">{detailLine}</span>}
          </div>
          {outputMeta && <div className="status__meta">{outputMeta}</div>}
          {percent !== null && (
            <div
              className="progress"
              role="progressbar"
              aria-label="转换进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              aria-valuetext={`${Math.round(percent)}%${stageCode ? `，${STAGES.find((s) => s.code === stageCode)?.name ?? ''}` : ''}`}
            >
              <div
                className="progress__fill"
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
          )}
          <div className="techline" aria-label="阶段进度">
            {completed
              ? <span className="done">7 / 7 阶段完成</span>
              : STAGES.map((s, i) => (
                <span
                  key={s.code}
                  className={busy && i === currentIndex ? 'now' : busy && i < currentIndex ? 'done' : ''}
                  aria-current={busy && i === currentIndex ? 'step' : undefined}
                >
                  {busy && i === currentIndex ? `${s.name} ${Math.round(percent ?? 0)}%` : s.name}
                </span>
              ))}
          </div>
        </div>
        <div className="dock__actions">
          {busy && (
            <button className="btn btn--ghost btn--sm" type="button" onClick={onCancel}>取消</button>
          )}
          {completed && hasOutput && (
            <button className="btn btn--primary btn--sm" type="button" onClick={onOpenFolder}>打开成品</button>
          )}
          {completed && hasOutput && (
            <button className="btn btn--ghost btn--sm" type="button" onClick={onPreviewOutput}>预览输出</button>
          )}
          <button className="btn btn--ghost btn--sm" type="button" onClick={onDetails}>详情</button>
          <button
            className="btn btn--primary"
            type="button"
            disabled={!canStart}
            onClick={onStart}
          >
            开始转换
          </button>
        </div>
      </div>
      {notice && (
        <div className="notice" role="status">
          <div className="notice__inner">{notice}</div>
        </div>
      )}
    </>
  );
}
