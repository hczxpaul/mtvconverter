/**
 * 预加载桥契约（冻结）。preload 与 renderer 都按此实现；
 * 主进程 ipc/handlers.ts 按 IPC.invoke 常量提供同名通道。
 */
import type {
  JobConfig, JobRecord, JobProgressEvent, LyricsPayload, PreviewRequest,
  PreviewSession, MediaCapabilities, LogEntry, BackendDecision, StageCode, EditCommand,
  LyricLine,
} from './contracts';

export interface LyricsFetchInput {
  source: 'online' | 'local' | 'paste';
  songLink?: string;
  localPath?: string;
  pastedText?: string;
  version: 'original' | 'translation' | 'bilingual';
  format: 'lrc' | 'srt';
  offsetMs: number;
}

export interface HealthResult {
  ok: boolean;
  version: string;
  capabilities: MediaCapabilities;
  backend: BackendDecision;
  missing: string[];
}

export interface MtvBridge {
  health(): Promise<HealthResult>;
  configGet(): Promise<JobConfig>;
  configSet(patch: Partial<JobConfig>): Promise<JobConfig>;
  capabilities(): Promise<MediaCapabilities>;
  jobCreate(config: JobConfig): Promise<JobRecord>;
  jobStart(jobId: string): Promise<void>;
  jobCancel(jobId: string): Promise<void>;
  jobList(): Promise<JobRecord[]>;
  jobGet(jobId: string): Promise<JobRecord | undefined>;
  jobConfirmTracks(jobId: string, audioStreamIndex: number | null): Promise<void>;
  jobRetryStage(jobId: string, stage: StageCode): Promise<void>;
  lyricsFetch(input: LyricsFetchInput): Promise<LyricsPayload>;
  /** 把界面校对后的歌词同步给主进程（null = 恢复原始歌词） */
  lyricsApplyEdits(lines: LyricLine[] | null): Promise<void>;
  previewStart(request: PreviewRequest): Promise<PreviewSession>;
  previewStop(sessionId: string): Promise<void>;
  selectFile(kind: 'video' | 'audio' | 'lyrics'): Promise<string | undefined>;
  /** 读取随包字体（仅 fonts 目录）为字节，供字幕实时预览的 libass WASM 加载 */
  readFont(fontFileName: string): Promise<Uint8Array>;
  /** 执行编辑/窗口命令（无原生菜单时的快捷键通道） */
  editCommand(command: EditCommand): Promise<void>;
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  logExport(): Promise<string>;
  onProgress(cb: (e: JobProgressEvent) => void): () => void;
  onStatus(cb: (r: JobRecord) => void): () => void;
  onLog(cb: (e: LogEntry) => void): () => void;
  onFallback(cb: (d: BackendDecision) => void): () => void;
}

declare global {
  interface Window {
    mtv: MtvBridge;
  }
}
