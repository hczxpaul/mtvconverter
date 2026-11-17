import type { ReactNode } from 'react';

type Tone = 'success' | 'warn' | 'error' | 'info';

/** 语义状态一律「图标 + 文字」，不靠颜色单独传达（UX-003 / NFR-13）。 */
const GLYPH: Record<Tone, ReactNode> = {
  success: (
    <>
      <circle cx="8" cy="8" r="6.6" />
      <path d="M4.9 8.2l2.1 2.1 4.2-4.4" />
    </>
  ),
  warn: (
    <>
      <path d="M8 1.6 15 14H1z" />
      <path d="M8 6.1v4.1" />
      <circle cx="8" cy="12.2" r="0.65" fill="currentColor" stroke="none" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6.6" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.6" />
      <path d="M8 7.2v4.3" />
      <circle cx="8" cy="4.8" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
};

const LABEL: Record<Tone, string> = {
  success: '通过',
  warn: '提醒',
  error: '出错',
  info: '说明',
};

export function Semantic({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) {
  return (
    <span className={`sem sem--${tone}`}>
      <svg
        className="sem__icon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={LABEL[tone]}
      >
        {GLYPH[tone]}
      </svg>
      <span className="sem__text">{children}</span>
    </span>
  );
}
