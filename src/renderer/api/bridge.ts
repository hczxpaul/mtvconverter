import type { MtvBridge } from '../../shared/preload-api';

declare global {
  interface Window {
    /** preload 提供的拖拽文件路径解析（冻结 MtvBridge 之外的可选补充）。 */
    mtvDroppedPath?: (file: File) => string;
  }
}

/** 取预加载桥；未注入时返回 null，让界面降级到「尚未就绪」而不是崩溃。 */
export function getBridge(): MtvBridge | null {
  return window.mtv ?? null;
}

/**
 * 解析拖入文件的本地绝对路径。
 * 优先走 preload 的 webUtils.getPathForFile；缺失时兼容旧版 File.path；
 * 都拿不到返回 undefined，由调用方回退到「选择视频」对话框。
 */
export function resolveDroppedPath(file: File): string | undefined {
  const viaBridge = window.mtvDroppedPath?.(file);
  if (viaBridge) return viaBridge;
  const legacy = (file as File & { path?: string }).path;
  return legacy || undefined;
}
