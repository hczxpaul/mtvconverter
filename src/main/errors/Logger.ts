import { appendFileSync, mkdirSync, renameSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, StageCode } from '../../shared/contracts';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3;

/** 结构化 JSON 日志：单行一事件、携带 jobId / 阶段，脱敏、按大小轮转。 */
export class Logger {
  private readonly dir: string;
  private readonly file: string;
  private level: 'info' | 'warn' | 'error';
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(cacheDir: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.dir = join(cacheDir, 'logs');
    this.file = join(this.dir, 'app.log');
    this.level = level;
    mkdirSync(this.dir, { recursive: true });
  }

  setLevel(level: 'info' | 'warn' | 'error'): void { this.level = level; }
  onEntry(cb: (e: LogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  info(event: string, data?: Record<string, unknown>, jobId?: string, stage?: StageCode): void {
    this.write('info', event, data, jobId, stage);
  }
  warn(event: string, data?: Record<string, unknown>, jobId?: string, stage?: StageCode): void {
    this.write('warn', event, data, jobId, stage);
  }
  error(event: string, data?: Record<string, unknown>, jobId?: string, stage?: StageCode): void {
    this.write('error', event, data, jobId, stage);
  }

  /** 导出脱敏后的诊断包，不含令牌与隐私字段。 */
  exportText(): string {
    try {
      return readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
  }

  private write(level: LogEntry['level'], event: string, data?: Record<string, unknown>, jobId?: string, stage?: StageCode): void {
    const rank = { info: 0, warn: 1, error: 2 };
    if (rank[level] < rank[this.level]) return;
    const entry: LogEntry = { ts: Date.now(), level, event, ...(jobId ? { jobId } : {}), ...(stage ? { stage } : {}), ...(data ? { data: redact(data) } : {}) };
    const line = JSON.stringify(entry) + '\n';
    try {
      this.rotate();
      appendFileSync(this.file, line, 'utf8');
    } catch {
      // 日志失败不阻断业务流程
    }
    for (const cb of this.listeners) {
      try { cb(entry); } catch { /* 忽略订阅者异常 */ }
    }
  }

  private rotate(): void {
    let size = 0;
    try { size = statSync(this.file).size; } catch { return; }
    if (size < MAX_BYTES) return;
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      try { renameSync(from, to); } catch { /* 文件不存在 */ }
    }
    try { renameSync(this.file, `${this.file}.1`); } catch { /* 忽略 */ }
  }
}

/** 移除令牌 / 密码 / 密钥类字段，避免日志泄露。 */
function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (/(token|password|secret|apikey|api_key|authorization|cookie)/i.test(k)) {
      out[k] = '[已脱敏]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
