/**
 * 输出自动校验（§9.1 VALIDATE 阶段）。
 * 纯逻辑层：接收已解析的 ffprobe 数据，逐项断言 V-01~V-16 中可自动判定的项。
 * 任一硬断言失败 → report.passed=false；无法自动判定的项一律标 warn，绝不伪造通过。
 */
import {
  DEFAULTS, TRACK_METADATA,
  type AccompanimentSource, type Backend, type CompressionPreset,
  type JobConfig, type MediaInfo, type ValidationCheck, type ValidationReport,
} from '../../shared/contracts';
import type { OutputInfo, PacketInfo } from './ffprobe';

/** 画质抽样结果；available=false 时 V-06 标「需人工复核」的 warn。 */
export interface QualitySample {
  available: boolean;
  kind: 'psnr' | 'vmaf';
  value: number;
  reason?: string;
}

/** 烧录时 ASS 时间轴检查结果。 */
export interface AssCheck {
  found: boolean;
  lastEndSec: number;
  lineCount: number;
}

export interface ValidateInputs {
  output: OutputInfo;
  packets: PacketInfo[];
  source: MediaInfo;
  config: JobConfig;
  reportMeta: Partial<ValidationReport>;
  sourceSizeBytes: number;
  outputSizeBytes: number;
  quality: QualitySample;
  /** 未烧录时为 undefined（V-09 不适用） */
  ass?: AssCheck;
}

interface AvSync {
  startDeltaMs: number;
  driftMs: number;
}

/**
 * 音画同步（V-08）：
 * - 首帧偏差 = |首视频 pts - 首音频 pts|（AAC priming 的负 pts 一并纳入）
 * - 全程 drift = 端点时长差 与「每个视频时刻到最近音频包偏差」的最大值
 */
function computeAvSync(packets: PacketInfo[], videoIndex: number, audioIndex: number): AvSync {
  const vPts: number[] = [];
  const aPts: number[] = [];
  let vEnd = -Infinity;
  let aEnd = -Infinity;
  for (const p of packets) {
    const end = p.ptsTime + p.durationTime;
    if (p.streamIndex === videoIndex) {
      vPts.push(p.ptsTime);
      if (end > vEnd) vEnd = end;
    } else if (p.streamIndex === audioIndex) {
      aPts.push(p.ptsTime);
      if (end > aEnd) aEnd = end;
    }
  }
  if (vPts.length === 0 || aPts.length === 0) {
    return { startDeltaMs: Number.POSITIVE_INFINITY, driftMs: Number.POSITIVE_INFINITY };
  }
  vPts.sort((x, y) => x - y);
  aPts.sort((x, y) => x - y);
  const startDeltaMs = Math.abs(vPts[0] - aPts[0]) * 1000;
  const endDeltaMs = Number.isFinite(vEnd) && Number.isFinite(aEnd) ? Math.abs(vEnd - aEnd) * 1000 : 0;

  let maxNearestMs = 0;
  let j = 0;
  for (const v of vPts) {
    while (j + 1 < aPts.length && Math.abs(aPts[j + 1] - v) < Math.abs(aPts[j] - v)) j++;
    const d = Math.abs(aPts[j] - v) * 1000;
    if (d > maxNearestMs) maxNearestMs = d;
  }
  return { startDeltaMs, driftMs: Math.max(startDeltaMs, endDeltaMs, maxNearestMs) };
}

function fpsClose(actual: number, expected: number): boolean {
  if (expected <= 0) return actual <= 0.01;
  return Math.abs(actual - expected) / expected <= 0.02;
}

function fmtMs(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)}ms` : '无法计算（缺少时间戳）';
}

export function buildValidationReport(inputs: ValidateInputs): ValidationReport {
  const { output, source, config, reportMeta } = inputs;
  const checks: ValidationCheck[] = [];
  const toleranceMs = DEFAULTS.syncToleranceMs;
  const targetRatio = DEFAULTS.compressionTargetRatio;
  const audio = output.audio;
  const video = output.video;
  const a0 = audio[0];
  const a1 = audio[1];

  const add = (
    code: string,
    passed: boolean,
    expected: string,
    actual: string,
    severity: 'hard' | 'warn' = 'hard',
  ): void => {
    checks.push({ code, passed, expected, actual, severity });
  };

  // V-01 音轨数量
  add('V-01', audio.length === 2, '恰好 2 条音轨', `${audio.length} 条`);

  // V-02 音轨顺序与元数据（MP4 下 title 存为 name，parseOutputInfo 已兼容）
  const orderOk = !!a0 && !!a1 &&
    a0.title === TRACK_METADATA.original.title &&
    a1.title === TRACK_METADATA.accompaniment.title &&
    a0.language === TRACK_METADATA.original.language &&
    a1.language === TRACK_METADATA.accompaniment.language;
  add('V-02', orderOk,
    `a:0=${TRACK_METADATA.original.title}/${TRACK_METADATA.original.language}，a:1=${TRACK_METADATA.accompaniment.title}/${TRACK_METADATA.accompaniment.language}`,
    `a:0=${a0?.title ?? '缺失'}/${a0?.language ?? '缺失'}，a:1=${a1?.title ?? '缺失'}/${a1?.language ?? '缺失'}`);
  // 波形互相关无法由 ffprobe 判定，不伪造通过
  add('V-02-PCM', false, 'a:0 与源波形互相关 ≥ 0.99、a:1 与源不同',
    '需 PCM 比对 / 人工复核', 'warn');

  // V-03 默认播放轨
  const dispositionOk = !!a0 && !!a1 && a0.defaultDisposition === 1 && a1.defaultDisposition === 0;
  add('V-03', dispositionOk, 'a:0 default=1，a:1 default=0',
    `a:0=${a0?.defaultDisposition ?? '缺失'}，a:1=${a1?.defaultDisposition ?? '缺失'}`);

  // V-04 两轨编码参数一致
  const encOk = !!a0 && !!a1 &&
    a0.codecName === a1.codecName &&
    a0.sampleRate === a1.sampleRate &&
    a0.channels === a1.channels;
  add('V-04', encOk, '两轨 codec / 采样率 / 声道一致',
    a0 && a1
      ? `${a0.codecName}/${a0.sampleRate}/${a0.channels} vs ${a1.codecName}/${a1.sampleRate}/${a1.channels}`
      : '音轨不足');

  // V-05 编码格式与原分辨率（格式跟随用户选择：av1 / hevc）
  const expectCodec = config.videoCodec === 'av1' ? 'av1' : 'hevc';
  const expectTag = config.videoCodec === 'av1' ? 'av01' : DEFAULTS.videoTag;
  const codecOk = (video?.codecName ?? '').toLowerCase() === expectCodec;
  const sizeOk = !!video && video.width === source.width && video.height === source.height;
  add('V-05', codecOk && sizeOk, `codec_name=${expectCodec} 且 ${source.width}×${source.height}`,
    `codec=${video?.codecName ?? '缺失'}，${video?.width ?? 0}×${video?.height ?? 0}`);

  // V-05 附加：SAR / 旋转 / 帧率（§6.3 元数据保留）
  const sarOk = !video || !source.sar || !video.sar || video.sar === source.sar;
  add('V-05-SAR', sarOk, `SAR=${source.sar || '(未声明)'}`, `SAR=${video?.sar || '(未声明)'}`);
  add('V-05-ROT', Math.abs((video?.rotation ?? 0) - source.rotation) < 0.5,
    `旋转=${source.rotation}°`, `旋转=${video?.rotation ?? 0}°`);
  add('V-05-FPS', fpsClose(video?.fps ?? 0, source.fps),
    `帧率≈${source.fps.toFixed(3)}`, `帧率≈${(video?.fps ?? 0).toFixed(3)}`);

  // V-06 画质（PSNR / VMAF 抽样；不可用时不伪造通过）
  if (inputs.quality.available) {
    const pass = inputs.quality.kind === 'psnr'
      ? inputs.quality.value >= DEFAULTS.psnrThresholdDb
      : inputs.quality.value >= DEFAULTS.vmafThreshold;
    add('V-06', pass,
      inputs.quality.kind === 'psnr'
        ? `PSNR ≥ ${DEFAULTS.psnrThresholdDb} dB`
        : `VMAF ≥ ${DEFAULTS.vmafThreshold}`,
      `${inputs.quality.kind.toUpperCase()}=${inputs.quality.value.toFixed(2)}`);
  } else {
    add('V-06', false,
      `PSNR ≥ ${DEFAULTS.psnrThresholdDb} dB 或 VMAF ≥ ${DEFAULTS.vmafThreshold}`,
      `未自动验证（${inputs.quality.reason ?? '本机不具备抽样条件'}），需人工复核`, 'warn');
  }

  // V-07 时长
  const durationOk = Math.abs(output.durationSec - source.durationSec) * 1000 <= toleranceMs;
  add('V-07', durationOk, `与源时长差 ≤ ${toleranceMs}ms`,
    `源 ${source.durationSec.toFixed(3)}s / 输出 ${output.durationSec.toFixed(3)}s`);

  // V-08 音画同步
  const sync = computeAvSync(inputs.packets, video?.index ?? -1, a0?.index ?? -1);
  add('V-08-START', Number.isFinite(sync.startDeltaMs) && sync.startDeltaMs <= toleranceMs,
    `首视频帧与首音频 pts 偏差 ≤ ${toleranceMs}ms`, fmtMs(sync.startDeltaMs));
  add('V-08-DRIFT', Number.isFinite(sync.driftMs) && sync.driftMs <= toleranceMs,
    `全程 drift ≤ ${toleranceMs}ms`, fmtMs(sync.driftMs));

  // V-09 字幕时间轴（烧录时）
  if (config.lyrics.burn) {
    if (inputs.ass?.found) {
      const ok = inputs.ass.lineCount >= 1 && inputs.ass.lastEndSec <= source.durationSec + 0.001;
      add('V-09', ok, 'ASS 末句结束 ≤ 视频时长且句数 ≥ 1',
        `末句 ${inputs.ass.lastEndSec.toFixed(3)}s / 时长 ${source.durationSec.toFixed(3)}s / ${inputs.ass.lineCount} 句`);
    } else {
      add('V-09', false, 'ASS 末句结束 ≤ 视频时长且句数 ≥ 1',
        'ASS 文件不可达，需人工复核', 'warn');
    }
  } else {
    add('V-09', true, '未烧录（不适用）', '未烧录', 'warn');
  }

  // V-10 三分支一致性：输出不得有软字幕轨（烧录为画面像素）
  add('V-10', output.subtitleCount === 0, '输出无软字幕轨', `字幕轨 ${output.subtitleCount} 条`);

  // V-12 编码标识（MP4 需 hvc1 / av01，播放器按 sample entry 认编码）
  const tagOk = config.container === 'mp4'
    ? (video?.codecTag ?? '').toLowerCase() === expectTag
    : true;
  add('V-12', codecOk && tagOk,
    `codec_name=${expectCodec}${config.container === 'mp4' ? ` 且 codec_tag=${expectTag}` : ''}`,
    `codec=${video?.codecName ?? '缺失'}，tag=${video?.codecTag ?? '缺失'}`);

  // V-13 压缩率（未达标仅提示，不判失败，§9.1 注）
  const ratio = inputs.sourceSizeBytes > 0 ? inputs.outputSizeBytes / inputs.sourceSizeBytes : 0;
  add('V-13', ratio <= targetRatio, `输出体积 ≤ 源 ${Math.round(targetRatio * 100)}%`,
    `压缩比 ${(ratio * 100).toFixed(1)}%（源 ${inputs.sourceSizeBytes} / 输出 ${inputs.outputSizeBytes} 字节）`,
    'warn');

  // V-14 伴奏来源标记
  const accSource: AccompanimentSource = reportMeta.accompanimentSource ?? config.accompanimentSource;
  const sourceConsistent =
    (accSource === 'uvr' || accSource === 'imported') &&
    accSource === config.accompanimentSource &&
    (accSource === 'imported' ? !!config.accompanimentPath : true);
  add('V-14', sourceConsistent, `报告来源与配置一致（${config.accompanimentSource}）`, `报告=${accSource}`);

  // V-15 多轨阻断：非单轨必须经用户确认指定原唱轨后才允许产出（§5.1 / §9.1 状态机用例）
  const multiTrackConfirmed = source.audioStreams.length === 1 ||
    (config.originalAudioStreamIndex !== undefined &&
      source.audioStreams.some((s) => s.index === config.originalAudioStreamIndex));
  add('V-15', multiTrackConfirmed, '非单轨输入需经用户确认指定原唱轨后才产出',
    `源音轨 ${source.audioStreams.length} 条，指定=${config.originalAudioStreamIndex ?? '无'}`);

  // V-16 预览音轨切换：ffprobe 可列 a:0 / a:1，切换行为需预览专项验证
  add('V-16', audio.length === 2, '输出可列 a:0 / a:1 且切换 10 次不中断',
    audio.length === 2 ? '音轨可列；切换行为需预览专项 / 人工复核' : '音轨不足', 'warn');

  // 报告字段齐全
  const backend: Backend = reportMeta.backend ?? 'cpu';
  const preset: CompressionPreset = reportMeta.compressionPreset ?? config.compressionPreset;
  const backendOk = backend === 'cpu' || backend === 'cuda' || backend === 'mps' || backend === 'directml';
  const presetOk = preset === 'quality' || preset === 'balanced' || preset === 'size';
  const fieldsOk = inputs.sourceSizeBytes > 0 && inputs.outputSizeBytes > 0 &&
    Number.isFinite(ratio) && backendOk && presetOk;
  add('V-RPT', fieldsOk, '报告字段齐全（体积 / 压缩比 / 后端 / 来源 / 压缩档）',
    `source=${inputs.sourceSizeBytes} output=${inputs.outputSizeBytes} ratio=${ratio.toFixed(3)} backend=${backend} preset=${preset}`);

  const passed = checks.every((c) => c.severity !== 'hard' || c.passed);
  return {
    passed,
    checks,
    sourceSizeBytes: inputs.sourceSizeBytes,
    outputSizeBytes: inputs.outputSizeBytes,
    compressionRatio: ratio,
    accompanimentSource: accSource,
    backend,
    compressionPreset: preset,
  };
}
