/**
 * WAV / PCM 分析：解析 + 质量校验（削波 / 直流偏移 / 静音）+ 相关系数。
 * 纯 Node 内置实现，不依赖 ffmpeg 滤镜，便于「与源音轨完全相同」判定。
 */

export interface PcmInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  buffer: Buffer;
}

/** 解析 RIFF/WAVE，定位 fmt 与 data chunk；仅支持 16-bit PCM（audioFormat=1）。 */
export function parseWav(buffer: Buffer): PcmInfo | null {
  if (buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > buffer.length) return null;
      audioFormat = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, Math.max(0, buffer.length - body));
      break;
    }
    // chunk 按偶数字节对齐
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || audioFormat !== 1 || bitsPerSample !== 16 || channels <= 0) {
    return null;
  }
  return { channels, sampleRate, bitsPerSample, dataOffset, dataLength, buffer };
}

export interface QualityReport {
  peak: number;
  peakDb: number;
  rmsDb: number;
  dcOffset: number;
  clipRatio: number;
  clipped: boolean;
  dcShifted: boolean;
  silent: boolean;
}

const FULL_SCALE = 32768;
const CLIP_LEVEL = 0.999;
const CLIP_RATIO_LIMIT = 0.001;
const DC_LIMIT = 0.02;
const SILENCE_DB = -60;

function toDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

/** 遍历 16-bit PCM 样本，计算峰值 / RMS / 直流偏移 / 削波占比。 */
export function analysePcm(info: PcmInfo): QualityReport {
  const total = Math.floor(info.dataLength / 2);
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  let nearFull = 0;
  for (let i = 0; i < total; i++) {
    const s = info.buffer.readInt16LE(info.dataOffset + i * 2);
    sum += s;
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a / FULL_SCALE >= CLIP_LEVEL) nearFull++;
  }
  const mean = total > 0 ? sum / total : 0;
  const rms = total > 0 ? Math.sqrt(sumSq / total) : 0;
  const peakNorm = peak / FULL_SCALE;
  const rmsDb = toDb(rms / FULL_SCALE);
  const dcOffset = mean / FULL_SCALE;
  const clipRatio = total > 0 ? nearFull / total : 0;
  return {
    peak: peakNorm,
    peakDb: toDb(peakNorm),
    rmsDb,
    dcOffset,
    clipRatio,
    clipped: peakNorm >= CLIP_LEVEL && clipRatio >= CLIP_RATIO_LIMIT,
    dcShifted: Math.abs(dcOffset) > DC_LIMIT,
    silent: rmsDb < SILENCE_DB,
  };
}

/** 两段 16-bit PCM 的去均值归一化相关系数；规格不一致或样本过少返回 null。 */
export function correlation(a: PcmInfo, b: PcmInfo): number | null {
  if (a.sampleRate !== b.sampleRate || a.channels !== b.channels) return null;
  const n = Math.min(Math.floor(a.dataLength / 2), Math.floor(b.dataLength / 2));
  if (n < 1024) return null;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a.buffer.readInt16LE(a.dataOffset + i * 2);
    sumB += b.buffer.readInt16LE(b.dataOffset + i * 2);
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const va = a.buffer.readInt16LE(a.dataOffset + i * 2) - meanA;
    const vb = b.buffer.readInt16LE(b.dataOffset + i * 2) - meanB;
    num += va * vb;
    denA += va * va;
    denB += vb * vb;
  }
  if (denA <= 0 || denB <= 0) return null;
  return num / Math.sqrt(denA * denB);
}
