/**
 * 全局共享契约（冻结基座）。
 * 所有模块只依赖本文件；禁止在各自模块内重复定义同名类型、通道或错误码。
 * 依据 docs/MTV转换器-设计文档与开发方案.md。
 */

// ── 阶段与状态 ────────────────────────────────────────────────
export type StageCode =
  | 'PROBE' | 'EXTRACT' | 'LYRICS' | 'ACCOMPANIMENT'
  | 'ALIGN' | 'ENCODE_MUX' | 'VALIDATE';

export type JobStatus =
  /** 已创建配置、尚未开始执行（导入或改配置后停留在此态） */
  | 'DRAFT'
  | 'QUEUED' | 'NEEDS_CONFIRMATION' | 'RUNNING'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type AccompanimentSource = 'uvr' | 'imported';
export type LyricsStatus = 'OFF' | 'FETCHING' | 'READY' | 'UNAVAILABLE' | 'EMPTY' | 'BURN_CONFIRMED';
export type LyricsSource = 'online' | 'local' | 'paste';
export type LyricsVersion = 'original' | 'translation' | 'bilingual';
export type LyricsFormat = 'lrc' | 'srt';
export type CompressionPreset = 'quality' | 'balanced' | 'size';
export type OutputContainer = 'mp4' | 'mkv';

/** 输出与源同路径时的处理方式：suffix=另存为（加后缀），overwrite=替换源文件（不可逆） */
export type OutputConflict = 'suffix' | 'overwrite';

/** 不依赖原生菜单的编辑/窗口命令（由渲染层快捷键触发） */
export type EditCommand =
  | 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo'
  | 'quit' | 'close' | 'minimize';

/**
 * 视频编码格式。
 *   av1  —— 同画质比 H.265 省约 26%（实测），编码也更快，但老设备播不了
 *   hevc —— 兼容性最广，点歌系统通用
 */
export type VideoCodec = 'av1' | 'hevc';

/** 编码器偏好（仅 hevc 有意义）：software=libx265（画质优先，慢）；hardware=VideoToolbox/NVENC（快，效率低） */
export type VideoEncoderPreference = 'software' | 'hardware';
export type PreviewSource = 'input' | 'output';
export type AudioTrack = 'original' | 'accompaniment';
export type Backend = 'cuda' | 'mps' | 'directml' | 'cpu';
export type PresentationLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** §4.2 阶段权重（耗时占比，导入伴奏时由 PipelineController 动态转移） */
export const STAGE_WEIGHTS: Record<StageCode, number> = {
  PROBE: 3, EXTRACT: 4, LYRICS: 3, ACCOMPANIMENT: 40,
  ALIGN: 5, ENCODE_MUX: 40, VALIDATE: 5,
};

/** §5.3 压缩档：CRF 恒定质量 + 可选目标体积上限 */
/**
 * 压缩档 CRF 依据真机实测 + 行业共识标定（1080p，libx265 preset=fast，源 1400 kbps）：
 *   crf 24 ≈ VMAF 95（Kah 2021：主观不可区分）· crf 28 ≈ VMAF 91.8、体积 -21%
 *   crf 30 ≈ VMAF 89.3、体积 -36%
 * 共识：VMAF 93 是「可察觉但不烦人」线，95 是「不可区分」线，97 以上纯属浪费码率；
 * 相差 2 分以内观众分辨不出。默认档取 28 —— 用 1.75 分的代价换 21% 空间。
 */
/**
 * 压缩档：HEVC 与 AV1 的 CRF 量纲不同（x265 0–51 / SVT-AV1 0–63），
 * 所以每档各存一份，按实际编码格式取。数值均由真机 VMAF 实测标定：
 *   hevc crf24≈97 / 28≈91.8 / 31≈87
 *   av1  crf35≈95 / 40≈93.9 / 44≈91（同画质下码率比 HEVC 低约 26%）
 */
export const COMPRESSION_PRESETS: Record<
  CompressionPreset,
  { crf: number; av1Crf: number; label: string; targetRatio: number }
> = {
  quality: { crf: 24, av1Crf: 35, label: '质量优先', targetRatio: 1.0 },
  balanced: { crf: 28, av1Crf: 40, label: '均衡', targetRatio: 0.8 },
  size: { crf: 31, av1Crf: 44, label: '体积优先', targetRatio: 0.55 },
};

/** 按输出编码格式取该档的 CRF */
export function crfFor(codec: VideoCodec, preset: CompressionPreset): number {
  const p = COMPRESSION_PRESETS[preset];
  return codec === 'av1' ? p.av1Crf : p.crf;
}

/** §5.2 输出契约：音轨顺序由 -map 书写顺序保证，非全局 stream index */
export const TRACK_METADATA = {
  original: { title: '原唱', language: 'zho', disposition: 'default' },
  accompaniment: { title: '伴奏', language: 'zho', disposition: '0' },
} as const;

export const DEFAULTS = {
  container: 'mp4' as OutputContainer,
  extension: '.mp4',
  // 默认走软件编码：实测同等体积下 libx265 画质明显优于 VideoToolbox
  // （1204 kbps 达 VMAF 93.7 vs 硬件需 2700 kbps 才 97），代价是编码慢约 4 倍
  // 默认 AV1：同画质比 H.265 省约 26%，且 SVT-AV1 preset 8 比 x265 fast 更快
  videoCodec: 'av1' as VideoCodec,
  videoEncoder: 'software' as VideoEncoderPreference,
  outputConflict: 'suffix' as OutputConflict,
  outputSuffix: '-伴奏版',
  videoTag: 'hvc1',
  compressionPreset: 'balanced' as CompressionPreset,
  audioCodec: 'aac',
  audioBitrate: '192k',
  audioSampleRate: 48000,
  audioChannels: 2,
  firstScreenMaxControls: 7,
  lyricsTimeoutMs: 8000,
  lyricsMaxRetries: 2,
  multiTrackPolicy: 'neq1', // 音轨数 ≠ 1 一律阻断确认
  accompanimentDurationDiffSec: 2,
  syncToleranceMs: 40,
  previewSwitchToleranceMs: 200,
  previewBindHost: '127.0.0.1',
  previewSegmentSec: 2,
  previewIdleTtlMs: 5 * 60 * 1000,
  maxConcurrentJobs: 1,
  psnrThresholdDb: 38,
  vmafThreshold: 93,
  compressionTargetRatio: 0.8,
  uvrSelfTestSec: 1,
} as const;

/** §8.1 类型化错误码（客户端只见规范化结构） */
export type ErrorCode =
  | 'E_INPUT_UNSUPPORTED' | 'E_INPUT_NO_AUDIO' | 'E_INPUT_MULTI_TRACK_CONFIRM'
  | 'E_PROBE_FAILED' | 'E_UVR_MODEL_MISSING' | 'E_UVR_OOM' | 'E_UVR_FAILED' | 'E_UVR_NO_OUTPUT'
  | 'E_ACCOMPANIMENT_IMPORT_INVALID'
  | 'E_LYRICS_TIMEOUT' | 'E_LYRICS_INVALID_ID' | 'E_LYRICS_PARSE' | 'E_LYRICS_EMPTY'
  | 'E_LYRICS_CONTRACT_CHANGED'
  | 'E_SUBTITLE_FONT' | 'E_SUBTITLE_LIBASS'
  | 'E_ENCODE_HEVC_FAILED' | 'E_HEVC_ENCODER_UNAVAILABLE' | 'E_COMPRESSION_TARGET_MISSED'
  | 'E_FFMPEG_MUX' | 'E_DISK_FULL'
  | 'E_PREVIEW_PROXY' | 'E_PREVIEW_TRACK_SWITCH'
  | 'E_GPU_FALLBACK'
  | 'E_VALIDATION_TRACK_ORDER' | 'E_VALIDATION_AV_DRIFT'
  | 'E_CANCELLED' | 'E_UNKNOWN';

export type ErrorAction =
  | 'retry' | 'choose-track' | 'skip-file' | 'import-accompaniment'
  | 'import-lyrics' | 'paste-lyrics' | 'disable-burn' | 'check-disk'
  | 'open-details' | 'rerun-encode' | 'none';

export interface AppErrorPayload {
  code: ErrorCode;
  stage: StageCode | 'APP';
  retryable: boolean;
  userMessage: string;
  action: ErrorAction;
}

// ── 数据对象 ──────────────────────────────────────────────────
export interface AudioStreamInfo {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  language?: string;
  title?: string;
  durationSec: number;
}

export interface MediaInfo {
  path: string;
  durationSec: number;
  fileSizeBytes: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  pixFmt: string;
  sar: string;
  rotation: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  start_time: number;
  vfr: boolean;
  alreadyHevc: boolean;
  audioStreams: AudioStreamInfo[];
}

export interface MediaCapabilities {
  ffmpegPath: string;
  ffprobePath: string;
  libx265: boolean;
  hevcVideotoolbox: boolean;
  hevcNvenc: boolean;
  libx264: boolean;
  h264Videotoolbox: boolean;
  h264Nvenc: boolean;
  libass: boolean;
  hlsMuxer: boolean;
}

export interface LyricsConfig {
  enabled: boolean;
  source: LyricsSource;
  songLink?: string;
  localPath?: string;
  pastedText?: string;
  version: LyricsVersion;
  format: LyricsFormat;
  offsetMs: number;
  burn: boolean;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  outlineColor: string;
  outlineWidth: number;
  position: 'bottom' | 'top';
  bilingualLines: 1 | 2;
}

export interface JobConfig {
  sourcePath: string;
  /** 非单轨输入经用户确认后指定的原唱音轨（全局 stream index）；单轨输入为 undefined。 */
  originalAudioStreamIndex?: number;
  outputDir: string;
  outputName: string;
  /** 输出路径与源文件同名时怎么办：默认加后缀，允许用户显式选择覆盖源文件 */
  outputConflict: OutputConflict;
  /** outputConflict === 'suffix' 时使用的后缀（不含扩展名），默认「-伴奏版」 */
  outputSuffix: string;
  container: OutputContainer;
  extension: string;
  /** 输出视频编码格式；av1 目前只有软件编码（SVT-AV1） */
  videoCodec: VideoCodec;
  /** 视频编码器偏好；hardware 在不可用时自动回落软件编码；videoCodec=av1 时忽略此项 */
  videoEncoder: VideoEncoderPreference;
  compressionPreset: CompressionPreset;
  accompanimentSource: AccompanimentSource;
  accompanimentPath?: string;
  lyrics: LyricsConfig;
  subtitle: SubtitleStyle;
  skipReencodeIfHevc: boolean;
  detailedMode: boolean;
  lyricsExpanded: boolean;
}

export interface JobProgressEvent {
  jobId: string;
  stage: StageCode;
  percent: number;
  message: string;
  timestamp: number;
}

export interface ValidationCheck {
  code: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  severity: 'hard' | 'warn';
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheck[];
  /** 烧录版 V-09 校验所需的 ASS 路径（不烧录时为空） */
  subtitleAssPath?: string;
  sourceSizeBytes: number;
  outputSizeBytes: number;
  compressionRatio: number;
  accompanimentSource: AccompanimentSource;
  backend: Backend;
  compressionPreset: CompressionPreset;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  config: JobConfig;
  progress: number;
  stage?: StageCode;
  outputPath?: string;
  error?: AppErrorPayload;
  report?: ValidationReport;
  mediaInfo?: MediaInfo;
  lyricsStatus: LyricsStatus;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  jobId?: string;
  stage?: StageCode;
  event: string;
  data?: Record<string, unknown>;
}

export interface DomainEvent {
  type: string;
  stage?: StageCode;
  jobId?: string;
  payload?: Record<string, unknown>;
}

export interface PresentationDecision {
  level: PresentationLevel;
  message: string;
  expandable: boolean;
  action: ErrorAction;
}

// ── 硬件与预览 ────────────────────────────────────────────────
export interface BackendDecision {
  platform: NodeJS.Platform;
  arch: string;
  separationBackend: Backend;
  encodeEncoder: string;
  previewEncoder: string;
  reasonCode: string;
  reasonText: string;
  degraded: boolean;
}

export interface PreviewRequest {
  jobId: string;
  source: PreviewSource;
  inputPath: string;
  outputPath?: string;
  audioTracks: AudioTrack[];
}

export interface PreviewSession {
  sessionId: string;
  url: string;
  token: string;
  host: string;
  port: number;
  expiresAt: number;
}

// ── 字幕 / 歌词 ───────────────────────────────────────────────
export interface LyricLine {
  startMs: number;
  endMs?: number;
  text: string;
  translation?: string;
}

export interface LyricsPayload {
  status: 'READY' | 'UNAVAILABLE' | 'EMPTY';
  lines: LyricLine[];
  version: LyricsVersion;
  format: LyricsFormat;
  source: LyricsSource;
  reasonCode?: ErrorCode;
}

// ── 编码输入 ──────────────────────────────────────────────────
export interface EncodeMuxInput {
  sourcePath: string;
  originalWav: string;
  accompanimentWav: string;
  outputPath: string;
  container: OutputContainer;
  crf: number;
  encoder: string;
  /** 输出编码格式，决定 -tag:v（hevc→hvc1 / av1→av01） */
  codec: VideoCodec;
  subtitleAssPath?: string;
  fontsDir?: string;
  durationSec: number;
  colorArgs: string[];
}

// ── 端口接口（适配器实现，编排层只依赖接口） ────────────────────
export interface MediaPort {
  capabilities(): Promise<MediaCapabilities>;
  probe(path: string): Promise<MediaInfo>;
  extractOriginal(sourcePath: string, destWav: string, audioStreamIndex?: number): Promise<void>;
  align(accompanimentWav: string, originalWav: string, durationSec: number, destWav: string): Promise<void>;
  encodeMux(input: EncodeMuxInput): Promise<{ outputPath: string }>;
  validate(outputPath: string, source: MediaInfo, config: JobConfig, reportMeta: Partial<ValidationReport>): Promise<ValidationReport>;
}

export interface AccompanimentPort {
  selfTest(): Promise<{ ok: boolean; reason?: string }>;
  separate(originalWav: string, workDir: string, backend: BackendDecision, model: string): Promise<string>;
  importFile(filePath: string, originalWav: string, workDir: string): Promise<string>;
}

export interface LyricsPort {
  fetchOnline(songIdOrLink: string): Promise<LyricsPayload>;
  fromLocal(filePath: string, format: LyricsFormat): Promise<LyricsPayload>;
  fromPasted(text: string, format: LyricsFormat): Promise<LyricsPayload>;
  /**
   * 界面校对结果：非空时，后续取词与烧录一律以这份 lines 为准（null 表示恢复原始）。
   * 用于「逐句打点 / 删除行」——这些编辑必须进烧录，否则用户改了等于没改。
   */
  setEditedLines(lines: LyricLine[] | null): void;
  /** frame 为视频真实宽高；缺省按 1920×1080 生成（竖屏/非 16:9 必须传） */
  toAss(payload: LyricsPayload, config: JobConfig, durationSec: number, frame?: { width: number; height: number }): Promise<string>;
}

export interface PreviewPort {
  start(request: PreviewRequest, backend: BackendDecision): Promise<PreviewSession>;
  stop(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
}

export interface HardwarePort {
  detect(caps: MediaCapabilities): Promise<BackendDecision>;
  selfTestEncoder(encoder: string): Promise<boolean>;
}

export interface PresentationPort {
  classify(event: DomainEvent): PresentationDecision | null;
  isDetailedMode(): boolean;
  setDetailedMode(enabled: boolean): void;
}

// ── IPC 通道（唯一来源，主进程与渲染层共用） ─────────────────────
export const IPC = {
  invoke: {
    health: 'app:health',
    configGet: 'config:get',
    configSet: 'config:set',
    jobCreate: 'job:create',
    jobStart: 'job:start',
    jobCancel: 'job:cancel',
    jobList: 'job:list',
    jobGet: 'job:get',
    jobConfirmTracks: 'job:confirmTracks',
    jobRetryStage: 'job:retryStage',
    lyricsFetch: 'lyrics:fetch',
    lyricsParse: 'lyrics:parse',
    lyricsApplyEdits: 'lyrics:applyEdits',
    previewStart: 'preview:start',
    previewStop: 'preview:stop',
    selectFile: 'dialog:selectFile',
    openPath: 'shell:openPath',
    showItemInFolder: 'shell:showItemInFolder',
    logExport: 'log:export',
    capabilities: 'media:capabilities',
    /** 读取随包字体二进制（仅限 fonts 目录），供渲染层字幕预览的 libass WASM 使用 */
    readFont: 'asset:readFont',
    /** 编辑/窗口快捷键：不装原生菜单后由渲染层转发（详见 main/index.ts installMenu） */
    editCommand: 'edit:command',
  },
  event: {
    progress: 'job:progress',
    status: 'job:status',
    log: 'log:entry',
    fallback: 'hardware:fallback',
  },
} as const;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Noto Sans CJK SC',
  // ASS 画布固定 1920×1080，72px 在 1080p 上约占画面高度 6.7%（KTV 常见区间 6–8%）
  fontSize: 72,
  primaryColor: '&H00FFFFFF',
  outlineColor: '&H00000000',
  outlineWidth: 3,
  position: 'bottom',
  bilingualLines: 2,
};

/** 所有端口适配器的统一构造参数；由 ConfigService 启动时校验后产出并注入。 */
export interface RuntimePaths {
  ffmpegPath: string;
  ffprobePath: string;
  cacheDir: string;
  fontsDir: string;
  uvrRoot: string;
  uvrPython: string;
  /** 分离后端启动脚本（audio-separator CLI 垫片）；非空时优先于 UVR.py GUI 入口 */
  uvrSeparatorScript: string;
  modelDir: string;
  modelName: string;
  lyricsBaseUrl: string;
  lyricsTimeoutMs: number;
  previewHost: string;
  maxConcurrentJobs: number;
  logLevel: 'info' | 'warn' | 'error';
  platform: NodeJS.Platform;
  arch: string;
}

/**
 * 端口实现约定（各并行模块统一遵守，编排层按此组装）：
 * src/main/media/index.ts          → export class MediaAdapter implements MediaPort
 * src/main/accompaniment/index.ts  → export class AccompanimentAdapter implements AccompanimentPort
 * src/main/lyrics/index.ts         → export class LyricsService implements LyricsPort
 * src/main/preview/index.ts        → export class PreviewService implements PreviewPort
 * src/main/hardware/index.ts       → export class HardwareProbe implements HardwarePort
 * src/main/presentation/index.ts   → export class UiPresentationPolicy implements PresentationPort
 * 每个类的构造函数统一为 constructor(paths: RuntimePaths)。
 */

export function makeDefaultConfig(sourcePath = '', outputDir = ''): JobConfig {
  return {
    sourcePath,
    outputDir,
    outputName: '',
    outputConflict: DEFAULTS.outputConflict,
    outputSuffix: DEFAULTS.outputSuffix,
    container: DEFAULTS.container,
    extension: DEFAULTS.extension,
    videoCodec: DEFAULTS.videoCodec,
    videoEncoder: DEFAULTS.videoEncoder,
    compressionPreset: DEFAULTS.compressionPreset,
    accompanimentSource: 'uvr',
    lyrics: {
      enabled: false,
      source: 'online',
      version: 'bilingual',
      format: 'srt',
      offsetMs: 0,
      burn: false,
    },
    subtitle: { ...DEFAULT_SUBTITLE_STYLE },
    skipReencodeIfHevc: false,
    detailedMode: false,
    lyricsExpanded: false,
  };
}
