/**
 * 兼容出口：ASS 生成逻辑已迁至 src/shared/ass.ts，供主进程烧录与渲染层实时预览共用。
 * 保留本文件是为了不打断既有 `./ass` 导入路径。
 */
export { toAssText, toAssTime } from '../../shared/ass';
export type { AssFrame } from '../../shared/ass';
