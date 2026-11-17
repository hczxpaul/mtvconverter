/**
 * 伴奏对齐产物的 PCM 质量检查（§4.2 ALIGN / §6.2）。
 * 只读 WAV、不修改内容：计算峰值 / 削波比例 / 直流偏移 / RMS，据此判定静音。
 * 仅使用 Node 内置模块，不依赖任何第三方解码库。
 */
import { promises as fs } from 'fs';
import { makeError } from '../errors/AppError';

export interface PcmAnalysis {
  /** 归一化峰值 0..1 */
  peak: number;
  /** 接近满幅（|s| ≥ 32760）的样本比例 */
  clippedRatio: number;
  /** 归一化直流偏移 -1..1 */
  dcOffset: number;
  /** 均方根电平（dBFS） */
  rmsDb: number;
  /** 整段是否接近静音 */
  silent: boolean;
  /** 参与统计的 16bit 样本总数 */
  totalSamples: number;
}

const FULL_SCALE = 32768;

/** 解析标准 PCM s16le WAV，定位 fmt / data chunk 并逐样本统计。 */
export async function analyzePcm16Wav(wavPath: string): Promise<PcmAnalysis> {
  const buf = await fs.readFile(wavPath);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw makeError('E_UNKNOWN', 'ALIGN', `伴奏对齐产物不是合法 RIFF/WAVE：${wavPath}`);
  }

  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  let bitsPerSample = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, buf.length - body);
      break;
    }
    // chunk 按偶数字节对齐
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || bitsPerSample !== 16) {
    throw makeError('E_UNKNOWN', 'ALIGN', `伴奏对齐产物不是 16bit PCM WAV：${wavPath}`);
  }

  const total = Math.floor(dataSize / 2);
  let peak = 0;
  let clipped = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < total; i++) {
    const sample = buf.readInt16LE(dataOffset + i * 2);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    if (abs >= 32760) clipped++;
    sum += sample;
    sumSq += sample * sample;
  }

  const rms = total > 0 ? Math.sqrt(sumSq / total) / FULL_SCALE : 0;
  return {
    peak: peak / FULL_SCALE,
    clippedRatio: total > 0 ? clipped / total : 0,
    dcOffset: total > 0 ? sum / total / FULL_SCALE : 0,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    silent: rms < 0.001 || peak < 0.002,
    totalSamples: total,
  };
}
