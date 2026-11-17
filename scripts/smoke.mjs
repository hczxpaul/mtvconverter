#!/usr/bin/env node
/**
 * 真实 FFmpeg 端到端冒烟（Node 22 ESM，仅内置模块）。
 *
 * 依据 docs/MTV转换器-设计文档与开发方案.md §9.1 / §13 P0 验收门：
 *   lavfi 造 3 秒 320x180 含 1 条 AAC 音轨的测试视频 → 正弦波伴奏 WAV
 *   → MediaAdapter.probe → extractOriginal → align → encodeMux(libx265, balanced CRF 27) → validate
 *   → 独立 ffprobe 复核 V-01~V-05 / V-07 / V-12 / V-13
 *   → ffmpeg 生成 HLS 双音轨 master playlist，断言含两条 audio rendition。
 *
 * 【铁律】编码命令不在此重复拼接：encodeMux 必须走编译产物导出的 MediaAdapter，
 *   避免与真实实现产生第二份实现。本脚本只负责造素材、编排调用、独立复核产物。
 * 【本地服务语义】预览代理地址统一用 127.0.0.1（不用 localhost，避免 ::1 被 RST）。
 *
 * 前置：先执行 `npm run build` 产出 dist/main/main/media/index.js。
 * 用法：node scripts/smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_MODULE = join(ROOT, 'dist', 'main', 'main', 'media', 'index.js');
const PREVIEW_HOST = '127.0.0.1';

/** 随包二进制优先（resources/bin），保证与服务端实际运行环境一致。 */
function pickBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = join(ROOT, 'resources', 'bin', exe);
  return existsSync(bundled) ? bundled : name;
}
const FFMPEG = process.env.MTVC_FFMPEG_PATH || pickBinary('ffmpeg');
const FFPROBE = process.env.MTVC_FFPROBE_PATH || pickBinary('ffprobe');
// contracts.ts COMPRESSION_PRESETS.balanced.crf = 27
const BALANCED_CRF = 27;

const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  previewHost: PREVIEW_HOST,
  mode: 'smoke',
  steps: [],
  checks: [],
  hls: null,
  validateReport: null,
  artifacts: {},
  environment: {},
  conclusion: '',
};

function step(name, ok, detail, extra = {}) {
  result.steps.push({ name, ok: Boolean(ok), detail, ...extra });
  if (!ok) throw new Error(`步骤失败【${name}】：${detail}`);
}

/** 同步跑外部命令；失败抛带中文上下文的异常。 */
function run(bin, args, label) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`${label} 无法执行：${r.error.message}`);
  if (r.status !== 0) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-6).join(' | ');
    throw new Error(`${label} 退出码 ${r.status}：${tail}`);
  }
  return { stdout: r.stdout || '', stderr: r.stderr || '' };
}

const ff = (args, label) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], label);
const probeJson = (path) => JSON.parse(run(FFPROBE, ['-hide_banner', '-loglevel', 'error', '-show_streams', '-show_format', '-of', 'json', path], `ffprobe ${path}`).stdout);

/** 收集一条 V-xx 断言。severity=hard 失败计入总体失败；warn 仅提示不阻断。 */
function assertCheck(code, passed, severity, expected, actual, detail) {
  result.checks.push({ code, passed: Boolean(passed), severity, expected, actual, detail });
}

function parseDuration(fmt) { return Number.parseFloat(fmt?.duration ?? '0'); }
function trackTitle(stream) { return stream?.tags?.title ?? stream?.tags?.name ?? stream?.tags?.handler_name ?? ''; }

/** ASS 时间戳：H:MM:SS.cc */
function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** 生成覆盖整段时长的最小 ASS，用于验证 libass 烧录链路。 */
function buildAss(durationSec) {
  const end = Math.max(0.4, Math.min(durationSec, durationSec));
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 320',
    'PlayResY: 180',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Alignment',
    'Style: Default,Noto Sans CJK SC,26,&H00FFFFFF,&H00000000,2',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
    `Dialogue: 0,${assTime(0)},${assTime(end)},Default,烧录验证字幕`,
    '',
  ].join('\n');
}

/**
 * 同一时刻两段视频的画面平均亮度差（YAVG）。
 * 用于证明字幕真的叠加进画面，而不是只产出了合法文件。
 */
function frameDiffYAvg(pathA, pathB, atSec) {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(atSec), '-i', pathA,
    '-ss', String(atSec), '-i', pathB,
    '-filter_complex', '[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-frames:v', '1', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const m = /YAVG=([0-9.]+)/.exec(r.stdout || '');
  return m ? Number(m[1]) : -1;
}

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  // 0. 前置：dist 产物 + FFmpeg
  if (!existsSync(MEDIA_MODULE)) {
    result.conclusion = `请先 npm run build：未找到编译产物 ${MEDIA_MODULE}。smoke 必须动态引入真实的 MediaAdapter，不能在脚本内重复实现 encodeMux。`;
    return;
  }
  const ffVer = run(FFMPEG, ['-hide_banner', '-version'], 'FFmpeg');
  const fpVer = run(FFPROBE, ['-version'], 'FFprobe');
  result.environment = {
    node: process.version, platform: process.platform, arch: process.arch,
    ffmpeg: ffVer.stdout.split('\n')[0]?.trim(), ffprobe: fpVer.stdout.split('\n')[0]?.trim(),
  };

  const work = mkdtempSync(join(tmpdir(), 'mtv-smoke-'));
  const fontsDir = join(work, 'fonts');
  mkdirSync(fontsDir, { recursive: true });
  const srcPath = join(work, 'source.mp4');
  const originalWav = join(work, 'original.wav');
  const accompRawWav = join(work, 'instrumental.raw.wav');
  const alignedWav = join(work, 'instrumental.wav');
  const outPath = join(work, 'out.mp4');
  const hlsDir = join(work, 'hls');
  mkdirSync(hlsDir, { recursive: true });
  result.artifacts = { workDir: work, source: srcPath, originalWav, accompRawWav, alignedWav, output: outPath, hlsDir };

  // 1. 动态引入真实 MediaAdapter（CJS 编译产物：兼容 named export 与 default export 两种取法）
  const mod = await import(pathToFileURL(MEDIA_MODULE).href);
  const MediaAdapter = mod.MediaAdapter ?? mod.default?.MediaAdapter ?? mod.default;
  if (typeof MediaAdapter !== 'function') {
    throw new Error(`${MEDIA_MODULE} 未导出 MediaAdapter 类（请确认 media 模块已实现并按 contracts.ts 约定导出）`);
  }
  const paths = {
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
    cacheDir: work, fontsDir,
    uvrRoot: join(work, 'uvr'), uvrPython: 'python3',
    modelDir: join(work, 'models'), modelName: 'UVR-MDX-NET-Inst_HQ_3',
    lyricsBaseUrl: 'https://lyric.photix.cc', lyricsTimeoutMs: 8000,
    previewHost: PREVIEW_HOST, maxConcurrentJobs: 1,
    logLevel: 'info', platform: process.platform, arch: process.arch,
  };
  const adapter = new MediaAdapter(paths);
  step('动态引入 MediaAdapter', true, `已加载 ${MEDIA_MODULE} 并实例化（paths.ffmpegPath=${FFMPEG}）`);

  // 2. 造素材：3 秒 320x180 H.264 视频 + 1 条 AAC 原唱音轨
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', '-shortest', srcPath,
  ], '生成测试源视频');
  const srcProbe = probeJson(srcPath);
  const srcAudios = srcProbe.streams.filter((s) => s.codec_type === 'audio');
  step('生成测试源视频', srcAudios.length === 1, `3 秒 320x180 / 30fps，音轨数=${srcAudios.length}（期望 1）`, { duration: parseDuration(srcProbe.format) });

  // 3. 造正弦波伴奏 WAV
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3:sample_rate=48000',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', accompRawWav], '生成正弦波伴奏 WAV');
  step('生成正弦波伴奏 WAV', existsSync(accompRawWav), `220Hz / 48kHz 立体声 PCM，大小=${statSync(accompRawWav).size} 字节`);

  // 4. MediaPort 主链路（编码命令全部由 adapter.encodeMux 负责）
  const media = await adapter.probe(srcPath);
  step('adapter.probe', !!media, `归一化媒体描述：${media?.width}x${media?.height} / ${media?.durationSec}s / 音轨 ${media?.audioStreams?.length}`);

  await adapter.extractOriginal(srcPath, originalWav);
  step('adapter.extractOriginal', existsSync(originalWav), `输出 ${originalWav}`);

  await adapter.align(accompRawWav, originalWav, media.durationSec, alignedWav);
  step('adapter.align', existsSync(alignedWav), `对齐至源时长 ${media.durationSec}s，输出 ${alignedWav}`);

  // 构造最小 JobConfig（按 contracts.ts 全字段），供 validate 使用
  const config = {
    sourcePath: srcPath, outputDir: work, outputName: 'out.mp4',
    container: 'mp4', extension: '.mp4', compressionPreset: 'balanced',
    accompanimentSource: 'imported', accompanimentPath: accompRawWav,
    lyrics: { enabled: false, source: 'online', version: 'bilingual', format: 'srt', offsetMs: 0, burn: false },
    subtitle: {
      fontFamily: 'Noto Sans CJK SC', fontSize: 48, primaryColor: '&H00FFFFFF',
      outlineColor: '&H00000000', outlineWidth: 2, position: 'bottom', bilingualLines: 2,
    },
    skipReencodeIfHevc: false, detailedMode: false, lyricsExpanded: false,
  };

  await adapter.encodeMux({
    sourcePath: srcPath,
    originalWav,
    accompanimentWav: alignedWav,
    outputPath: outPath,
    container: 'mp4',
    crf: BALANCED_CRF,
    encoder: 'libx265',
    durationSec: media.durationSec,
    colorArgs: [],
    fontsDir,
  });
  step('adapter.encodeMux (libx265 / balanced CRF 27)', existsSync(outPath),
    `单次 H.265 编码 + 双音轨封装，输出 ${outPath}（${statSync(outPath).size} 字节）`);

  const report = await adapter.validate(outPath, media, config, {
    accompanimentSource: 'imported', backend: 'cpu', compressionPreset: 'balanced',
  });
  const failedHardInReport = (report?.checks || []).filter((c) => !c.passed && c.severity === 'hard');
  result.validateReport = {
    passed: report?.passed,
    checksCount: report?.checks?.length ?? 0,
    // 记录 expected/actual，便于定位 V-06(PSNR) / V-08(音画同步) 这类边界失败的真实数值
    failedHard: failedHardInReport.map((c) => ({ code: c.code, expected: c.expected, actual: c.actual })),
  };
  const failedBrief = failedHardInReport
    .map((c) => `${c.code}(期望 ${c.expected ?? '-'} / 实际 ${c.actual ?? '-'})`).join('、');
  step('adapter.validate', report?.passed === true,
    `报告 passed=${report?.passed}，checks=${report?.checks?.length ?? 0}，硬断言失败=${failedHardInReport.length}${failedBrief ? `：${failedBrief}` : ''}`);

  // 5. 独立 ffprobe 复核（真实产物为准，不依赖 validate 内部 check 命名）
  const outProbe = probeJson(outPath);
  const video = outProbe.streams.find((s) => s.codec_type === 'video');
  const audios = outProbe.streams.filter((s) => s.codec_type === 'audio');
  const [a0, a1] = audios;
  const srcVideo = srcProbe.streams.find((s) => s.codec_type === 'video');
  const outDur = parseDuration(outProbe.format);
  const srcDur = parseDuration(srcProbe.format);
  const outSize = Number(outProbe.format?.size ?? 0);
  const srcSize = Number(srcProbe.format?.size ?? 0);
  const ratio = srcSize > 0 ? outSize / srcSize : 1;
  result.compressionRatio = Number(ratio.toFixed(4));

  assertCheck('V-01', audios.length === 2, 'hard', '2 条音频流', `${audios.length} 条`, `输出音轨数量：期望恰好 2 条（原唱 + 伴奏）`);
  assertCheck('V-02', trackTitle(a0) === '原唱' && trackTitle(a1) === '伴奏', 'hard',
    'a:0=原唱 / a:1=伴奏', `a:0=${trackTitle(a0) || '(空)'} / a:1=${trackTitle(a1) || '(空)'}`,
    '音轨顺序与标题。注意 MP4 中 title 经 ffprobe 读作 tags.name，验收时两者兼容');
  assertCheck('V-03', a0?.disposition?.default === 1 && a1?.disposition?.default === 0, 'hard',
    'a:0 default=1 / a:1 default=0', `a:0=${a0?.disposition?.default} / a:1=${a1?.disposition?.default}`,
    '默认播放轨应为原唱 a:0');
  assertCheck('V-04', !!a0 && !!a1 && a0.codec_name === a1.codec_name && a0.sample_rate === a1.sample_rate && a0.channels === a1.channels, 'hard',
    '两轨 codec/sample_rate/channels 一致',
    `a:0=${a0?.codec_name}/${a0?.sample_rate}/${a0?.channels} · a:1=${a1?.codec_name}/${a1?.sample_rate}/${a1?.channels}`,
    '编码一致性，保证切轨不重新初始化解码器');
  assertCheck('V-05', video?.codec_name === 'hevc' && video?.width === srcVideo?.width && video?.height === srcVideo?.height && video?.r_frame_rate === srcVideo?.r_frame_rate, 'hard',
    `hevc / ${srcVideo?.width}x${srcVideo?.height} / ${srcVideo?.r_frame_rate}`,
    `${video?.codec_name} / ${video?.width}x${video?.height} / ${video?.r_frame_rate}`,
    'H.265 与原分辨率 / 帧率不变');
  assertCheck('V-07', Math.abs(outDur - srcDur) <= 0.04, 'hard', '时长差 ≤ 1 帧(40ms@30fps)',
    `源 ${srcDur}s / 输出 ${outDur}s / 差 ${Math.abs(outDur - srcDur).toFixed(4)}s`,
    '输出时长与源一致');
  assertCheck('V-12', video?.codec_name === 'hevc' && video?.codec_tag_string === 'hvc1', 'hard',
    'codec_name=hevc / codec_tag_string=hvc1', `${video?.codec_name} / ${video?.codec_tag_string}`,
    '编码标识：MP4 写 hvc1 tag');
  // V-13 按设计文档为「提示而非失败」：3 秒合成源经 libx265 双音轨后体积可能大于源，记为 warn 不阻断。
  assertCheck('V-13', ratio <= 0.6, 'warn', '输出 ≤ 源 60%', `${(ratio * 100).toFixed(1)}%（源 ${srcSize} / 输出 ${outSize} 字节）`,
    '压缩率：合成短片不达标属预期，按 §9.1 记为提示，不标记失败');
  assertCheck('VALIDATE.report', report?.passed === true && failedHardInReport.length === 0, 'hard',
    'passed=true 且无 hard 失败', `passed=${report?.passed} / hard 失败=${failedHardInReport.length}`,
    'MediaAdapter.validate 返回的报告需通过全部硬断言');

  // 6. HLS 双音轨 master playlist（预览代理方案 A 的能力验证）
  //    用 agroup 生成真正的 audio rendition group；普通 -var_stream_map 只产出 2 条 STREAM-INF 变体。
  const hlsMaster = join(hlsDir, 'master.m3u8');
  ff([
    '-i', outPath,
    '-map', '0:v:0', '-map', '0:a:0', '-map', '0:a:1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,name:original,language:zho,default:yes a:1,agroup:aud,name:accompaniment,language:zho,default:no',
    '-master_pl_name', 'master.m3u8',
    join(hlsDir, 's_%v.m3u8'),
  ], '生成 HLS 双音轨 master playlist');
  const master = readFileSync(hlsMaster, 'utf8');
  const mediaLines = master.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));
  const defaultYes = mediaLines.filter((l) => /DEFAULT=YES/.test(l)).length;
  const defaultNo = mediaLines.filter((l) => /DEFAULT=NO/.test(l)).length;
  const streamWithAudio = /#EXT-X-STREAM-INF:[^\n]*AUDIO="[^"]+"/.test(master);
  const hlsPassed = mediaLines.length >= 2 && defaultYes >= 1 && defaultNo >= 1 && streamWithAudio;
  result.hls = {
    masterPath: hlsMaster,
    audioRenditions: mediaLines.length,
    defaultYes, defaultNo,
    streamInfWithAudioGroup: streamWithAudio,
    passed: hlsPassed,
    detail: `供 http://${PREVIEW_HOST}:<随机端口> 本地预览代理使用（不用 localhost，避免 ::1 被 RST）`,
  };
  result.artifacts.hlsMaster = hlsMaster;
  step('HLS 双音轨 master playlist', hlsPassed,
    `#EXT-X-MEDIA:TYPE=AUDIO 共 ${mediaLines.length} 条（DEFAULT=YES ${defaultYes} / NO ${defaultNo}），STREAM-INF 带 AUDIO 组=${streamWithAudio}`);

  // 7. 字幕烧录（libass）：验证烧录路径真实可用，且画面确实被改动
  const caps = await adapter.capabilities();
  result.libass = { available: caps.libass };
  if (caps.libass) {
    const assPath = join(work, 'lyrics.ass');
    writeFileSync(assPath, buildAss(media.durationSec), 'utf8');
    const burnPath = join(work, 'out_burn.mp4');
    await adapter.encodeMux({
      sourcePath: srcPath,
      originalWav,
      accompanimentWav: alignedWav,
      outputPath: burnPath,
      container: 'mp4',
      crf: BALANCED_CRF,
      encoder: 'libx265',
      durationSec: media.durationSec,
      colorArgs: [],
      fontsDir,
      subtitleAssPath: assPath,
    });
    const burnProbe = probeJson(burnPath);
    const burnAudios = burnProbe.streams.filter((s) => s.codec_type === 'audio');
    const burnVideo = burnProbe.streams.find((s) => s.codec_type === 'video');
    const burnDur = parseDuration(burnProbe.format);
    const yavg = frameDiffYAvg(outPath, burnPath, Math.min(1, media.durationSec / 2));
    const burnPassed = existsSync(burnPath)
      && burnAudios.length === 2
      && burnVideo?.codec_name === 'hevc'
      && Math.abs(burnDur - srcDur) <= 0.04
      && yavg > 0.5;
    result.burn = {
      assPath,
      outputPath: burnPath,
      audioStreams: burnAudios.length,
      durationDelta: Number(Math.abs(burnDur - srcDur).toFixed(4)),
      frameDiffYAvg: yavg,
      passed: burnPassed,
    };
    result.artifacts.burnOutput = burnPath;
    assertCheck('V-09', burnPassed, 'hard',
      '烧录后仍为 2 音轨 hevc、时长差 ≤ 40ms、同帧画面亮度差 > 0.5',
      `音轨=${burnAudios.length} / 视频=${burnVideo?.codec_name} / 时长差=${Math.abs(burnDur - srcDur).toFixed(4)}s / YAVG=${yavg}`,
      'libass 字幕并入同一次 H.265 编码，画面必须真实被改动且封装契约不变');
    step('字幕烧录（libass 并入单次编码）', burnPassed,
      `ASS ${assPath} → ${burnPath}，YAVG=${yavg}（> 0.5 表示画面确有叠加）`);
  } else {
    result.burn = { available: false };
    assertCheck('V-09', true, 'info', 'FFmpeg 构建含 libass', '当前构建未启用 libass',
      '按设计降级为无字幕输出，不阻断主流程');
    step('字幕烧录（libass）', true, '当前 FFmpeg 未启用 libass，按设计降级为无字幕输出（记 info，不计失败）');
  }

  // 8. 汇总
  const failedHard = result.checks.filter((c) => !c.passed && c.severity === 'hard');
  const warns = result.checks.filter((c) => !c.passed && c.severity === 'warn');
  result.ok = failedHard.length === 0;
  result.conclusion = result.ok
    ? `冒烟通过：V-01~V-05 / V-07 / V-12 / V-13 及 validate 报告均符合契约，HLS master 含 ${mediaLines.length} 条 audio rendition。${warns.length ? `（${warns.map((w) => w.code).join('、')} 为提示项未达标，不影响通过）` : ''}产物保留在 ${work} 供复核。`
    : `冒烟失败：${failedHard.length} 项硬断言未通过（${failedHard.map((c) => c.code).join('、')}）。产物保留在 ${work} 供排查。`;
}

main()
  .catch((e) => {
    result.ok = false;
    result.error = e instanceof Error ? (e.stack || e.message) : String(e);
    if (!result.conclusion) result.conclusion = `冒烟异常：${e instanceof Error ? e.message : String(e)}`;
    const codes = (result.validateReport?.failedHard ?? []).map((c) => c.code);
    if (codes.includes('V-06')) {
      result.conclusion += ' 【诊断】V-06 为画质抽样阈值（PSNR ≥ 38dB），合成源实测紧贴阈值，跨 FFmpeg 版本/内容可能下探；请核对报告中 PSNR 实际值，不要改动编码参数，判据是否调整由 team-lead 定夺。';
    }
  })
  .finally(() => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(`\n${result.conclusion}\n`);
    process.exitCode = result.ok ? 0 : 1;
  });
