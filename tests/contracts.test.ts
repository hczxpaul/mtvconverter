/**
 * 共享契约常量测试（vitest / Node 环境，不触网、不启子进程、不依赖真实 GPU 或模型权重）。
 * 依据 docs/MTV转换器-设计文档与开发方案.md §4.2 / §5.2 / §5.3 / §7.4 与 src/shared/contracts.ts。
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE_WEIGHTS, COMPRESSION_PRESETS, TRACK_METADATA, DEFAULTS,
  DEFAULT_SUBTITLE_STYLE, makeDefaultConfig, IPC, crfFor, SEPARATION_MODELS,
} from '../src/shared/contracts';

describe('§4.2 阶段权重 STAGE_WEIGHTS', () => {
  it('各阶段权重合计恰好 100', () => {
    const sum = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it('7 个阶段齐全且权重均为正数', () => {
    expect(Object.keys(STAGE_WEIGHTS).sort()).toEqual(
      ['PROBE', 'EXTRACT', 'LYRICS', 'ACCOMPANIMENT', 'ALIGN', 'ENCODE_MUX', 'VALIDATE'].sort(),
    );
    for (const w of Object.values(STAGE_WEIGHTS)) expect(w).toBeGreaterThan(0);
  });

  it('ACCOMPANIMENT 与 ENCODE_MUX 为两个耗时主阶段（各 40）', () => {
    expect(STAGE_WEIGHTS.ACCOMPANIMENT).toBe(40);
    expect(STAGE_WEIGHTS.ENCODE_MUX).toBe(40);
    expect(STAGE_WEIGHTS.VALIDATE).toBe(5); // 原子收尾，不可取消
  });
});

describe('§5.3 压缩档 COMPRESSION_PRESETS', () => {
  it('三档 CRF 按真机 VMAF 标定：质量 23–25 / 均衡 27–29 / 体积 30–32', () => {
    expect(COMPRESSION_PRESETS.quality.crf).toBeGreaterThanOrEqual(23);
    expect(COMPRESSION_PRESETS.quality.crf).toBeLessThanOrEqual(25);
    expect(COMPRESSION_PRESETS.balanced.crf).toBeGreaterThanOrEqual(27);
    expect(COMPRESSION_PRESETS.balanced.crf).toBeLessThanOrEqual(29);
    expect(COMPRESSION_PRESETS.size.crf).toBeGreaterThanOrEqual(30);
    expect(COMPRESSION_PRESETS.size.crf).toBeLessThanOrEqual(32);
  });

  it('CRF 单调递增、目标体积比单调递减（质量优先 → 体积优先）', () => {
    expect(COMPRESSION_PRESETS.quality.crf).toBeLessThan(COMPRESSION_PRESETS.balanced.crf);
    expect(COMPRESSION_PRESETS.balanced.crf).toBeLessThan(COMPRESSION_PRESETS.size.crf);
    expect(COMPRESSION_PRESETS.quality.targetRatio).toBeGreaterThan(COMPRESSION_PRESETS.balanced.targetRatio);
    expect(COMPRESSION_PRESETS.balanced.targetRatio).toBeGreaterThan(COMPRESSION_PRESETS.size.targetRatio);
  });

  it('默认档为 balanced（CRF 28），且 targetRatio 与 DEFAULTS 压缩目标一致', () => {
    expect(DEFAULTS.compressionPreset).toBe('balanced');
    expect(COMPRESSION_PRESETS.balanced.crf).toBe(28);
    expect(COMPRESSION_PRESETS.balanced.targetRatio).toBe(DEFAULTS.compressionTargetRatio);
  });

  it('三档均有中文 label', () => {
    for (const p of Object.values(COMPRESSION_PRESETS)) expect(p.label.length).toBeGreaterThan(0);
  });
});

describe('§5.2 音轨元数据 TRACK_METADATA', () => {
  it('a:0 标题=原唱、a:1 标题=伴奏', () => {
    expect(TRACK_METADATA.original.title).toBe('原唱');
    expect(TRACK_METADATA.accompaniment.title).toBe('伴奏');
  });

  it('语言均为 zho', () => {
    expect(TRACK_METADATA.original.language).toBe('zho');
    expect(TRACK_METADATA.accompaniment.language).toBe('zho');
  });

  it('disposition：原唱 default（默认播放轨）、伴奏 0', () => {
    expect(TRACK_METADATA.original.disposition).toBe('default');
    expect(TRACK_METADATA.accompaniment.disposition).toBe('0');
  });
});

describe('DEFAULTS 关键值', () => {
  it('输出容器 / 扩展名 / 视频 tag：MP4 + .mp4 + hvc1', () => {
    expect(DEFAULTS.container).toBe('mp4');
    expect(DEFAULTS.extension).toBe('.mp4');
    expect(DEFAULTS.videoTag).toBe('hvc1');
  });

  it('音频统一规格：AAC-LC 192k / 48kHz / 立体声', () => {
    expect(DEFAULTS.audioCodec).toBe('aac');
    expect(DEFAULTS.audioBitrate).toBe('192k');
    expect(DEFAULTS.audioSampleRate).toBe(48000);
    expect(DEFAULTS.audioChannels).toBe(2);
  });

  it('预览服务显式绑 127.0.0.1（避免 localhost 解析到 ::1 被 RST）', () => {
    expect(DEFAULTS.previewBindHost).toBe('127.0.0.1');
  });

  it('非单轨策略 neq1、默认并发 1、首屏控件上限 7', () => {
    expect(DEFAULTS.multiTrackPolicy).toBe('neq1');
    expect(DEFAULTS.maxConcurrentJobs).toBe(1);
    expect(DEFAULTS.firstScreenMaxControls).toBe(7);
  });

  it('画质与同步阈值：PSNR 38 / VMAF 93 / 压缩目标 0.8 / 同步 40ms / 切轨 200ms', () => {
    expect(DEFAULTS.psnrThresholdDb).toBe(38);
    expect(DEFAULTS.vmafThreshold).toBe(93);
    // 0.8 与默认「均衡」档一致：源本身已高度压缩时，追求 0.6 只会掉画质
    expect(DEFAULTS.compressionTargetRatio).toBe(0.8);
    expect(DEFAULTS.syncToleranceMs).toBe(40);
    expect(DEFAULTS.previewSwitchToleranceMs).toBe(200);
  });
});

describe('makeDefaultConfig / 默认字幕样式 / IPC 通道', () => {
  it('makeDefaultConfig 与 DEFAULTS 默认值一致', () => {
    const c = makeDefaultConfig('/a/MV.mp4', '/out');
    expect(c.sourcePath).toBe('/a/MV.mp4');
    expect(c.outputDir).toBe('/out');
    expect(c.container).toBe(DEFAULTS.container);
    expect(c.extension).toBe(DEFAULTS.extension);
    expect(c.compressionPreset).toBe(DEFAULTS.compressionPreset);
    expect(c.accompanimentSource).toBe('uvr');
    expect(c.separationModel).toBe('');
  });

  it('§5.2.2 分离模型清单：默认 MDX + 两个 Roformer（后者要求 GPU）', () => {
    expect(SEPARATION_MODELS[0].filename).toBe('UVR-MDX-NET-Inst_HQ_3.onnx');
    expect(SEPARATION_MODELS.filter((m) => m.filename.endsWith('.ckpt')).length).toBe(2);
    for (const m of SEPARATION_MODELS) expect(m.label.length).toBeGreaterThan(0);
  });

  it('默认关闭歌词 / 不烧录 / 详细模式关 / 歌词区默认折叠', () => {
    const c = makeDefaultConfig();
    expect(c.lyrics.enabled).toBe(false);
    expect(c.lyrics.burn).toBe(false);
    expect(c.lyrics.offsetMs).toBe(0);
    expect(c.detailedMode).toBe(false);
    expect(c.lyricsExpanded).toBe(false);
  });

  it('默认字幕样式使用中文可商用字体，双语两行', () => {
    expect(DEFAULT_SUBTITLE_STYLE.fontFamily).toBe('Noto Sans CJK SC');
    expect(DEFAULT_SUBTITLE_STYLE.bilingualLines).toBe(2);
    expect(DEFAULT_SUBTITLE_STYLE.position).toBe('bottom');
  });

  it('IPC invoke/event 通道唯一且含关键入口', () => {
    expect(IPC.invoke.jobCreate).toBe('job:create');
    expect(IPC.invoke.jobConfirmTracks).toBe('job:confirmTracks');
    expect(IPC.invoke.capabilities).toBe('media:capabilities');
    expect(IPC.event.progress).toBe('job:progress');
    expect(IPC.event.fallback).toBe('hardware:fallback');
    const all = [...Object.values(IPC.invoke), ...Object.values(IPC.event)];
    expect(new Set(all).size).toBe(all.length); // 无重复通道名
  });

  it('默认硬件优先：HEVC + 硬件编码，探测不到硬件时由编码层自动回落软件', () => {
    // HEVC 在 macOS(Apple Silicon) / Windows(NVIDIA) 均有硬编；AV1 在 Apple Silicon 无硬编，
    // 作为「更省体积」的可选项保留，不设默认。
    expect(DEFAULTS.videoCodec).toBe('hevc');
    expect(DEFAULTS.videoEncoder).toBe('hardware');
    expect(makeDefaultConfig().videoCodec).toBe('hevc');
    expect(makeDefaultConfig().videoEncoder).toBe('hardware');
  });

  it('CRF 按编码格式取：AV1 用 0–63 量纲，不能直接套 x265 的档位', () => {
    expect(crfFor('hevc', 'balanced')).toBe(28);
    expect(crfFor('av1', 'balanced')).toBe(40);
    expect(crfFor('av1', 'quality')).toBe(35);
    expect(crfFor('av1', 'size')).toBe(44);
    // AV1 的 CRF 恒大于同档 HEVC（量纲更宽），否则等于给 AV1 设了过高画质
    for (const preset of ['quality', 'balanced', 'size'] as const) {
      expect(crfFor('av1', preset)).toBeGreaterThan(crfFor('hevc', preset));
    }
  });
});
