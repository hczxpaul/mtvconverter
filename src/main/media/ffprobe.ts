/**
 * ffprobe JSON 解析与归一化（§4.2 / §9.1）。
 * probe() 只如实返回媒体信息；音轨数 ≠ 1 的阻断由编排层负责，本模块不擅自处理。
 */
import type { AudioStreamInfo, MediaInfo } from '../../shared/contracts';
import { makeError } from '../errors/AppError';
import { runProcess, type RunContext } from './runner';

// ── ffprobe -of json 原始结构（只声明本模块读取的字段） ──────────────
export interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number;
  [key: string]: unknown;
}

export interface FfprobeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  pix_fmt?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  start_time?: string | number;
  duration?: string | number;
  sample_rate?: string | number;
  channels?: number;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: FfprobeSideData[];
}

export interface FfprobePacket {
  stream_index?: number;
  pts_time?: string | number;
  duration_time?: string | number;
}

export interface FfprobeFormat {
  duration?: string | number;
  size?: string | number;
  start_time?: string | number;
  format_name?: string;
  tags?: Record<string, string>;
}

export interface FfprobeData {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
  packets?: FfprobePacket[];
  [key: string]: unknown;
}

// ── 数值工具 ──────────────────────────────────────────────────
export function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 解析 "25/1" / "30000/1001" 之类的帧率分数。 */
export function fraction(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const parts = v.split('/');
  const numerator = Number.parseFloat(parts[0] ?? '0');
  const denominator = Number.parseFloat(parts[1] ?? '1');
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * 旋转角读取：优先 side_data_list 的 Display Matrix rotation，
 * 兼容旧容器的 tags.rotate（§5.1 旋转元数据打标）。
 */
function rotationOf(stream: FfprobeStream): number {
  for (const side of stream.side_data_list ?? []) {
    if (typeof side.rotation === 'number' && Number.isFinite(side.rotation)) {
      return side.rotation;
    }
  }
  const tag = stream.tags?.rotate;
  if (tag !== undefined) {
    const n = Number.parseFloat(tag);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * 音轨标题读取：不同 FFmpeg 版本 / 容器把同一语义落到不同字段——
 * MP4 8.x 落 udta/name（读作 tags.name），MP4 7.x 只落 handler_name，MKV 落 title。
 * 三者都视为合法来源，避免因构建版本差异误判音轨标识缺失。
 */
function titleOf(stream: FfprobeStream): string | undefined {
  return stream.tags?.title ?? stream.tags?.name ?? stream.tags?.handler_name;
}

// ── ffprobe 调用 ──────────────────────────────────────────────
export async function ffprobeJson(
  ffprobePath: string,
  args: string[],
  ctx: RunContext,
): Promise<FfprobeData> {
  const result = await runProcess(ffprobePath, ['-v', 'error', '-of', 'json', ...args], ctx);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw makeError(ctx.errorCode, ctx.stage, `ffprobe 输出不是合法 JSON：${detail}\n${result.stdout.slice(0, 2000)}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw makeError(ctx.errorCode, ctx.stage, `ffprobe 输出结构异常\n${result.stdout.slice(0, 2000)}`);
  }
  return parsed as FfprobeData;
}

// ── 源媒体归一化 ──────────────────────────────────────────────
export function parseMediaInfo(filePath: string, data: FfprobeData, statSizeBytes: number): MediaInfo {
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const format = data.format ?? {};

  const durationSec = num(format.duration) || num(video?.duration) || num(audio[0]?.duration);
  const rFps = fraction(video?.r_frame_rate);
  const avgFps = fraction(video?.avg_frame_rate);

  const audioStreams: AudioStreamInfo[] = audio.map((s, i) => ({
    index: num(s.index, i),
    codec: s.codec_name ?? '',
    sampleRate: num(s.sample_rate),
    channels: num(s.channels),
    language: s.tags?.language,
    title: titleOf(s),
    durationSec: num(s.duration) || durationSec,
  }));

  return {
    path: filePath,
    durationSec,
    fileSizeBytes: num(format.size) || statSizeBytes,
    width: num(video?.width),
    height: num(video?.height),
    fps: rFps || avgFps,
    videoCodec: video?.codec_name ?? '',
    pixFmt: video?.pix_fmt ?? '',
    sar: video?.sample_aspect_ratio ?? '',
    rotation: video ? rotationOf(video) : 0,
    colorPrimaries: video?.color_primaries,
    colorTransfer: video?.color_transfer,
    colorSpace: video?.color_space,
    start_time: format.start_time !== undefined ? num(format.start_time) : num(video?.start_time),
    vfr: rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) > 0.01,
    alreadyHevc: (video?.codec_name ?? '').toLowerCase() === 'hevc',
    audioStreams,
  };
}

// ── 输出文件归一化（VALIDATE 用） ──────────────────────────────
export interface OutputStream {
  index: number;
  codecType: string;
  codecName: string;
  codecTag: string;
  width: number;
  height: number;
  sar: string;
  rotation: number;
  fps: number;
  pixFmt: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  title?: string;
  language?: string;
  defaultDisposition: number;
}

export interface OutputInfo {
  streams: OutputStream[];
  /** 按容器 stream index 升序，数组下标即音轨相对序号 a:0 / a:1 */
  audio: OutputStream[];
  video?: OutputStream;
  subtitleCount: number;
  durationSec: number;
  sizeBytes: number;
  formatName: string;
}

export function parseOutputInfo(data: FfprobeData, statSizeBytes: number): OutputInfo {
  const streams: OutputStream[] = (data.streams ?? []).map((s, i) => ({
    index: num(s.index, i),
    codecType: s.codec_type ?? '',
    codecName: s.codec_name ?? '',
    codecTag: s.codec_tag_string ?? '',
    width: num(s.width),
    height: num(s.height),
    sar: s.sample_aspect_ratio ?? '',
    rotation: rotationOf(s),
    fps: fraction(s.r_frame_rate) || fraction(s.avg_frame_rate),
    pixFmt: s.pix_fmt ?? '',
    sampleRate: num(s.sample_rate),
    channels: num(s.channels),
    durationSec: num(s.duration),
    title: titleOf(s),
    language: s.tags?.language,
    defaultDisposition: num(s.disposition?.default),
  }));
  const sorted = [...streams].sort((a, b) => a.index - b.index);
  const audio = sorted.filter((s) => s.codecType === 'audio');
  const video = sorted.find((s) => s.codecType === 'video');
  const format = data.format ?? {};
  return {
    streams: sorted,
    audio,
    video,
    subtitleCount: sorted.filter((s) => s.codecType === 'subtitle').length,
    durationSec: num(format.duration) || num(video?.durationSec),
    sizeBytes: num(format.size) || statSizeBytes,
    formatName: format.format_name ?? '',
  };
}

export interface PacketInfo {
  streamIndex: number;
  ptsTime: number;
  durationTime: number;
}

export function parsePackets(data: FfprobeData): PacketInfo[] {
  const out: PacketInfo[] = [];
  for (const p of data.packets ?? []) {
    if (p.pts_time === undefined) continue;
    const ptsTime = num(p.pts_time, Number.NaN);
    if (!Number.isFinite(ptsTime)) continue;
    out.push({
      streamIndex: num(p.stream_index, -1),
      ptsTime,
      durationTime: num(p.duration_time),
    });
  }
  return out;
}
