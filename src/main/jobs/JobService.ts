import { createHash } from 'node:crypto';
import { statSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { buildOutputStem } from '../../shared/contracts';
import type {
  JobConfig, JobRecord, JobStatus, StageCode, RuntimePaths,
  JobProgressEvent, BackendDecision,
} from '../../shared/contracts';
import type { Logger } from '../errors/Logger';

export interface JobEvents {
  progress(e: JobProgressEvent): void;
  status(r: JobRecord): void;
  fallback(d: BackendDecision): void;
}

/** 任务队列：状态机 / 并发 1 / 幂等 jobId / .done 断点续跑 / 取消。 */
export class JobService {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly aborts = new Map<string, AbortController>();
  private running = 0;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly logger: Logger,
    private readonly events: JobEvents,
  ) {}

  /** jobId = hash(文件指纹 + 配置指纹)，配置变更即新 jobId。 */
  fingerprint(config: JobConfig): string {
    let filePart = config.sourcePath;
    try {
      const st = statSync(config.sourcePath);
      filePart = `${config.sourcePath}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch { /* 文件尚不可读时只用路径 */ }
    return createHash('sha256').update(filePart).update(JSON.stringify(config)).digest('hex').slice(0, 20);
  }

  workDir(jobId: string): string {
    const dir = join(this.paths.cacheDir, 'jobs', jobId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  stageDone(jobId: string, stage: StageCode): boolean {
    return existsSync(join(this.workDir(jobId), `${stage}.done`));
  }

  markStageDone(jobId: string, stage: StageCode, meta: Record<string, unknown> = {}): void {
    writeFileSync(join(this.workDir(jobId), `${stage}.done`), JSON.stringify({ ts: Date.now(), ...meta }), 'utf8');
  }

  clearStageDone(jobId: string, stages: StageCode[]): void {
    for (const stage of stages) {
      const p = join(this.workDir(jobId), `${stage}.done`);
      if (existsSync(p)) rmSync(p);
    }
  }

  readStageMeta(jobId: string, stage: StageCode): Record<string, unknown> {
    const p = join(this.workDir(jobId), `${stage}.done`);
    try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return {}; }
  }

  create(config: JobConfig): JobRecord {
    const id = this.fingerprint(config);
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const record: JobRecord = {
      // DRAFT 而非 QUEUED：导入只是建好了配置，并没有进入执行队列。
      // 用 QUEUED 会让界面显示「正在排队」并把「开始转换」按钮禁用。
      id, status: 'DRAFT', config: { ...config }, progress: 0, lyricsStatus: config.lyrics.enabled ? 'FETCHING' : 'OFF',
    };
    this.jobs.set(id, record);
    this.logger.info('job.created', { outputDir: config.outputDir }, id);
    this.emitStatus(record);
    return record;
  }

  get(jobId: string): JobRecord | undefined { return this.jobs.get(jobId); }
  list(): JobRecord[] { return [...this.jobs.values()]; }

  setStatus(jobId: string, status: JobStatus, patch: Partial<JobRecord> = {}): JobRecord {
    const r = this.require(jobId);
    Object.assign(r, patch, { status });
    this.emitStatus(r);
    return r;
  }

  setProgress(jobId: string, percent: number, stage: StageCode, message: string): void {
    const r = this.require(jobId);
    r.progress = Math.max(0, Math.min(100, Math.round(percent)));
    r.stage = stage;
    this.events.progress({ jobId, stage, percent: r.progress, message, timestamp: Date.now() });
  }

  canStart(): boolean { return this.running < this.paths.maxConcurrentJobs; }
  reserve(): boolean {
    if (!this.canStart()) return false;
    this.running += 1;
    return true;
  }
  release(): void { this.running = Math.max(0, this.running - 1); }

  signalFor(jobId: string): AbortSignal {
    let c = this.aborts.get(jobId);
    if (!c) { c = new AbortController(); this.aborts.set(jobId, c); }
    return c.signal;
  }
  isCancelled(jobId: string): boolean { return this.aborts.get(jobId)?.signal.aborted ?? false; }

  cancel(jobId: string): void {
    const c = this.aborts.get(jobId) ?? new AbortController();
    c.abort();
    this.aborts.set(jobId, c);
    this.setStatus(jobId, 'CANCELLED');
    this.logger.info('job.cancelled', undefined, jobId);
  }

  emitFallback(d: BackendDecision): void { this.events.fallback(d); }

  defaultOutputPath(config: JobConfig): string {
    // 结构化命名优先；没填完整时回退 outputName → 源文件名，保证旧配置与脚本调用不受影响
    const namingStem = buildOutputStem(config.naming);
    const base = namingStem
      ? `${namingStem}${config.extension}`
      : config.outputName || `${basename(config.sourcePath, extname(config.sourcePath))}${config.extension}`;
    const name = base.endsWith(config.extension) ? base : `${base}${config.extension}`;
    const full = join(config.outputDir, name);
    if (resolve(full) !== resolve(config.sourcePath)) return full;

    // 与源同路径：默认输出目录就是源所在目录，扩展名同为 .mp4 时会撞名。
    // 覆盖源文件是用户显式选择的结果，否则另存为（确定性命名，保证断点续跑不漂移）。
    if (config.outputConflict === 'overwrite') return full;

    // 后缀里不允许出现路径分隔符或文件名非法字符，避免被拼出目录穿越
    const cleaned = (config.outputSuffix ?? '').replace(/[\\/:*?"<>|\r\n]/g, '').trim();
    const suffix = cleaned || '-伴奏版';
    const stem = name.slice(0, Math.max(0, name.length - config.extension.length));
    return join(config.outputDir, `${stem}${suffix}${config.extension}`);
  }

  private require(jobId: string): JobRecord {
    const r = this.jobs.get(jobId);
    if (!r) throw new Error(`任务不存在：${jobId}`);
    return r;
  }

  private emitStatus(r: JobRecord): void { this.events.status({ ...r }); }
}
