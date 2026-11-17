/**
 * 列宽拖拽把手：贴在两列之间，按住左右拖即改前一列的宽度。
 *
 * 约束原则（主人要求「都要协调，守住各自下限」）：
 *   - 每列有硬下限，拖到头就停住，不会把某一列压没；
 *   - 预览的 320 最小宽度优先，所以被拖列的 max 由「容器 - 其它列 - 预览下限」算出；
 *   - 双击恢复自动宽度（歌词列回到按最长句实测的值）。
 *
 * 交互：指针拖动（Pointer Events，触控板/鼠标/笔通用）、双击复位、
 * 聚焦后 ←/→ 每次 10px、Home/End 到两端。
 */
import { useCallback, useRef, useState } from 'react';
import { clampColumnWidth } from './columnWidth';

interface Props {
  /** 把手在父容器内的横坐标（px） */
  left: number;
  /** 被拖列当前宽度，作为拖动起点 */
  width: number;
  min: number;
  max: number;
  /** 无障碍名称，如「调整设置栏宽度」 */
  label: string;
  /** 拖动中实时应用（每帧） */
  onResize: (next: number) => void;
  /** 双击恢复自动 */
  onReset: () => void;
}

const STEP = 10;

export function ColumnResizer({ left, width, min, max, label, onResize, onReset }: Props) {
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef({ startX: 0, startWidth: 0 });
  const clampedMax = Math.max(min, max);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 只响应主键；触控笔/触控板同样走 pointer
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      stateRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const { startX, startWidth } = stateRef.current;
      onResize(clampColumnWidth(startWidth, e.clientX - startX, min, clampedMax));
    },
    [dragging, min, clampedMax, onResize],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = width - STEP;
      else if (e.key === 'ArrowRight') next = width + STEP;
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = clampedMax;
      if (next === null) return;
      e.preventDefault();
      onResize(clampColumnWidth(width, next - width, min, clampedMax));
    },
    [width, min, clampedMax, onResize],
  );

  return (
    <div
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(clampedMax)}
      tabIndex={0}
      data-dragging={dragging ? 'true' : undefined}
      style={{ left }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
