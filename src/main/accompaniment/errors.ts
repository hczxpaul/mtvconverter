/**
 * 伴奏来源层的类型化错误与「需编排层决策」提示的统一载体。
 * 错误码一律取自共享契约，本模块不重复定义任何错误码 / 类型 / 通道。
 */
import type { ErrorCode } from '../../shared/contracts';

export interface AccompanimentErrorOptions {
  /** 共享契约错误码；硬错误必填，notice 型提示可省略 */
  code?: ErrorCode;
  /** 中文、面向用户的可读文案（可直接作为 userMessage） */
  message: string;
  /** 内部细节（stdout / stderr、堆栈等），仅用于本地日志，不下发渲染层 */
  cause?: unknown;
  /** 提示型错误携带：伴奏 PCM 已生成，编排层可据此继续 */
  outputPath?: string;
  /** 质量检测 / 时长差异等非阻断提示（中文） */
  warnings?: string[];
  /** 为 true 表示「需编排层决定是否等待确认」的提示，不是硬失败 */
  notice?: boolean;
}

/**
 * 伴奏层抛出的异常。
 * - 硬错误：带 code，由编排层 ErrorService 归一化为 AppErrorPayload。
 * - notice 型：notice=true、不带 code，表示提示而非失败，携带 outputPath 供编排层继续。
 */
export class AccompanimentError extends Error {
  readonly code?: ErrorCode;
  readonly notice: boolean;
  readonly outputPath?: string;
  readonly warnings: string[];
  readonly causeDetail?: unknown;

  constructor(opts: AccompanimentErrorOptions) {
    super(opts.message);
    this.name = 'AccompanimentError';
    this.code = opts.code;
    this.notice = opts.notice ?? false;
    this.outputPath = opts.outputPath;
    this.warnings = opts.warnings ?? [];
    this.causeDetail = opts.cause;
    // 保证在常见编译目标下 instanceof 仍然成立
    Object.setPrototypeOf(this, AccompanimentError.prototype);
  }
}
