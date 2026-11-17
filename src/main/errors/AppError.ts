import type { AppErrorPayload, ErrorAction, ErrorCode, StageCode } from '../../shared/contracts';

/** 类型化错误：客户端只见规范化结构，堆栈与内部细节只写日志。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly stage: StageCode | 'APP';
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly action: ErrorAction;
  readonly causeDetail?: unknown;

  constructor(payload: AppErrorPayload, causeDetail?: unknown) {
    super(payload.userMessage);
    this.name = 'AppError';
    this.code = payload.code;
    this.stage = payload.stage;
    this.retryable = payload.retryable;
    this.userMessage = payload.userMessage;
    this.action = payload.action;
    this.causeDetail = causeDetail;
  }

  toPayload(): AppErrorPayload {
    return {
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      userMessage: this.userMessage,
      action: this.action,
    };
  }
}

/** 错误码 → 平实、说明「怎么做」的用户文案（UX-054 / UX-056 / UX-085）。 */
const USER_MESSAGES: Record<ErrorCode, { text: string; action: ErrorAction; retryable: boolean }> = {
  E_INPUT_UNSUPPORTED: { text: '这个文件暂时读不了，换一个视频试试。', action: 'choose-track', retryable: false },
  E_INPUT_NO_AUDIO: { text: '这个文件没有声音，无法生成伴奏。', action: 'skip-file', retryable: false },
  E_INPUT_MULTI_TRACK_CONFIRM: { text: '这个文件有多条音轨，请选一条作为原唱。', action: 'choose-track', retryable: false },
  E_PROBE_FAILED: { text: '读取视频信息没成功，点详情看原因。', action: 'open-details', retryable: true },
  E_UVR_MODEL_MISSING: { text: '还缺一个伴奏模型，可在详情里下载或改用导入伴奏。', action: 'import-accompaniment', retryable: false },
  E_UVR_OOM: { text: '显存不够，已换用较慢的 CPU 模式。', action: 'open-details', retryable: true },
  E_UVR_FAILED: { text: '生成伴奏没成功，可以导入官方伴奏继续。', action: 'import-accompaniment', retryable: true },
  E_UVR_NO_OUTPUT: { text: '没找到生成的伴奏文件，可重试或导入官方伴奏。', action: 'import-accompaniment', retryable: true },
  E_ACCOMPANIMENT_IMPORT_INVALID: { text: '这份伴奏不能用，换一个文件试试。', action: 'import-accompaniment', retryable: false },
  E_LYRICS_TIMEOUT: { text: '没拿到歌词，已生成无字幕版本。', action: 'import-lyrics', retryable: true },
  E_LYRICS_INVALID_ID: { text: '链接看起来不是网易云单曲，换一个链接或导入本地歌词。', action: 'import-lyrics', retryable: false },
  E_LYRICS_PARSE: { text: '没拿到歌词，已生成无字幕版本。', action: 'import-lyrics', retryable: true },
  E_LYRICS_EMPTY: { text: '这首歌没有歌词。', action: 'import-lyrics', retryable: false },
  E_LYRICS_CONTRACT_CHANGED: { text: '没拿到歌词，已生成无字幕版本。', action: 'import-lyrics', retryable: true },
  E_SUBTITLE_FONT: { text: '没找到中文字体，这次不烧录字幕。', action: 'disable-burn', retryable: false },
  E_SUBTITLE_LIBASS: { text: '当前 FFmpeg 不支持字幕渲染，这次不烧录字幕。', action: 'disable-burn', retryable: false },
  E_ENCODE_HEVC_FAILED: { text: '视频压缩没成功，点详情看原因。', action: 'rerun-encode', retryable: true },
  E_HEVC_ENCODER_UNAVAILABLE: { text: '硬件压缩不可用，已换用较慢的 CPU 模式。', action: 'open-details', retryable: true },
  E_COMPRESSION_TARGET_MISSED: { text: '体积压缩没达到目标，可在更多设置里换一档。', action: 'rerun-encode', retryable: true },
  E_FFMPEG_MUX: { text: '合成文件没成功，点详情看原因。', action: 'rerun-encode', retryable: true },
  E_DISK_FULL: { text: '磁盘空间不够，换一个输出目录再试。', action: 'check-disk', retryable: false },
  E_PREVIEW_PROXY: { text: '预览加载慢了点，可以点详情重试。', action: 'open-details', retryable: true },
  E_PREVIEW_TRACK_SWITCH: { text: '切换音轨没成功，可以再点一次。', action: 'retry', retryable: true },
  E_GPU_FALLBACK: { text: '使用 CPU 模式。', action: 'open-details', retryable: false },
  E_VALIDATION_TRACK_ORDER: { text: '音轨检查结果不对，点详情看报告。', action: 'open-details', retryable: true },
  E_VALIDATION_AV_DRIFT: { text: '音画同步检查结果不对，点详情看报告。', action: 'open-details', retryable: true },
  E_CANCELLED: { text: '已取消。', action: 'none', retryable: false },
  E_UNKNOWN: { text: '转换变慢了，点详情看原因。', action: 'open-details', retryable: true },
};

export function makeError(code: ErrorCode, stage: StageCode | 'APP' = 'APP', cause?: unknown): AppError {
  const spec = USER_MESSAGES[code] ?? USER_MESSAGES.E_UNKNOWN;
  return new AppError({ code, stage, retryable: spec.retryable, userMessage: spec.text, action: spec.action }, cause);
}

export function toPayload(err: unknown, stage: StageCode | 'APP' = 'APP'): AppErrorPayload {
  if (err instanceof AppError) return err.toPayload();
  // 适配层可能有自己的错误类（如伴奏来源的 AccompanimentError）：只要带合法 code
  // 就保留语义，不要吞成 E_UNKNOWN——否则用户看到的是与原因无关的兜底文案。
  const rawCode = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof rawCode === 'string' && Object.prototype.hasOwnProperty.call(USER_MESSAGES, rawCode)) {
    return makeError(rawCode as ErrorCode, stage, err).toPayload();
  }
  return makeError('E_UNKNOWN', stage, err).toPayload();
}
