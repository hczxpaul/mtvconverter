/** 硬件模块结构化日志：可注入统一 Logger，未注入时降级为控制台单行 JSON。 */
export type LogLevel = 'info' | 'warn' | 'error';

/** 与主编排层 Logger 结构兼容的最小接口（构造签名冻结，靠设值注入）。 */
export interface ModuleLogSink {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

let sink: ModuleLogSink | null = null;

/** 由编排层调用，把日志汇入统一文件与 IPC.event.log；传 null 恢复控制台。 */
export function setHardwareLogger(next: ModuleLogSink | null): void {
  sink = next;
}

/** 日志只写原因码 / 后端 / 结果，绝不写令牌、绝对路径或命令全文。 */
export function logHardware(level: LogLevel, event: string, data: Record<string, unknown>): void {
  const safe = sanitizeData(data);
  if (sink) {
    sink[level](event, safe);
    return;
  }
  const line = JSON.stringify({ ts: Date.now(), level, module: 'hardware', event, data: safe });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** FFmpeg 自检报错常带临时文件绝对路径，写出前统一脱敏为 [路径]。 */
function sanitizeString(s: string): string {
  return s
    .replace(/[A-Za-z]:\\[^\s"'，,；;()（）]+/g, '[路径]')
    .replace(/(?:\/[^\s"'，,；;()（）]+){2,}/g, '[路径]');
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' ? sanitizeString(v) : v;
  }
  return out;
}
