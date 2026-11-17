import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * 覆盖层焦点闭环：打开时把主内容设为 inert、把焦点移入面板，
 * Tab / Shift+Tab 在面板内循环，关闭后移除 inert 并把焦点还给触发元素。
 *
 * 不处理 Escape —— 由各覆盖层组件自行处理，避免重复绑定。
 */
export function useFocusTrap(
  open: boolean,
  containerRef: RefObject<HTMLElement>,
  mainContentSelector = '.app__main',
): void {
  const previousRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousRef.current = document.activeElement as HTMLElement | null;
    const main = document.querySelector<HTMLElement>(mainContentSelector);
    main?.setAttribute('inert', '');

    const container = containerRef.current;
    const focusables = (): HTMLElement[] =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

    // 初始焦点：优先标了 data-autofocus 的安全按钮，否则取第一个可聚焦元素
    const preferred = container?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    preferred?.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && index <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && index === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      main?.removeAttribute('inert');
      const previous = previousRef.current;
      if (previous && document.contains(previous)) previous.focus();
      previousRef.current = null;
    };
  }, [open, containerRef, mainContentSelector]);
}
