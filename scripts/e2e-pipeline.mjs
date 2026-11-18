#!/usr/bin/env node
/**
 * 完整管线端到端验证（走编译产物 + 真实 FFmpeg + 真实 UVR 分离）。
 *
 * 串起 JobService → PipelineController 的 7 个阶段：
 *   PROBE → EXTRACT_ORIGINAL → ACCOMPANIMENT(真实 MDX-Net) → ALIGN → LYRICS(ASS) → ENCODE_MUX(带烧录) → VALIDATE
 *
 * 前置：npm run build、npm run resources:setup-uvr。缺失时给出可读原因并以 exit 1 结束。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'main', 'main');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'resources', 'manifest.json'), 'utf8'));

const load = (rel) => import(pathToFileURL(join(DIST, rel)).href);
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const bundledOr = (name) => {
  const p = join(ROOT, 'resources', 'bin', exe(name));
  return existsSync(p) ? p : name;
};

const ffmpegPath = process.env.MTVC_FFMPEG_PATH || bundledOr('ffmpeg');
const ffprobePath = process.env.MTVC_FFPROBE_PATH || bundledOr('ffprobe');

function userDataDir() {
  if (process.env.MTVC_USER_DATA) return resolve(process.env.MTVC_USER_DATA);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'mtvconverter');
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'mtvconverter');
  return join(homedir(), '.config', 'mtvconverter');
}

const userData = userDataDir();
const result = { generatedAt: new Date().toISOString(), steps: [], checks: [], ok: false };

const step = (name, ok, detail) => {
  result.steps.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`步骤失败【${name}】：${detail}`);
};
const check = (code, passed, actual, expected) => {
  result.checks.push({ code, passed: Boolean(passed), actual, expected });
};
function probe(path) {
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffprobe 失败：${String(r.stderr).slice(0, 300)}`);
  return JSON.parse(r.stdout);
}
const titleOf = (s) => s?.tags?.title ?? s?.tags?.name ?? s?.tags?.handler_name ?? '';

async function main() {
  for (const m of ['jobs/index.js', 'media/index.js', 'accompaniment/index.js', 'lyrics/index.js', 'preview/index.js', 'hardware/index.js', 'presentation/index.js', 'errors/Logger.js']) {
    if (!existsSync(join(DIST, m))) {
      result.conclusion = `缺少编译产物 dist/main/main/${m}，请先执行 npm run build`;
      process.exitCode = 1;
      return;
    }
  }

  const { JobService } = await load('jobs/JobService.js');
  const { PipelineController } = await load('jobs/PipelineController.js');
  const { MediaAdapter } = await load('media/index.js');
  const { AccompanimentAdapter } = await load('accompaniment/index.js');
  const { LyricsService } = await load('lyrics/index.js');
  const { PreviewService } = await load('preview/index.js');
  const { HardwareProbe } = await load('hardware/index.js');
  const { UiPresentationPolicy } = await load('presentation/index.js');
  const { Logger } = await load('errors/Logger.js');
  step('加载编译产物', true, 'JobService / PipelineController / 6 个适配器');

  const cacheDir = join(userData, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const paths = {
    ffmpegPath, ffprobePath, cacheDir,
    fontsDir: join(ROOT, 'resources', 'fonts'),
    uvrRoot: join(ROOT, 'resources', 'uvr'),
    uvrPython: process.env.MTVC_UVR_PYTHON || (process.platform === 'win32'
      ? join(userData, 'runtime', 'uvr-venv', 'Scripts', 'python.exe')
      : join(userData, 'runtime', 'uvr-venv', 'bin', 'python')),
    uvrSeparatorScript: join(ROOT, 'resources', 'uvr', 'launch_separator.py'),
    modelDir: process.env.MTVC_UVR_MODEL_DIR || join(userData, MANIFEST.uvr.modelDir || 'models'),
    modelName: MANIFEST.uvr.defaultModel,
    lyricsBaseUrl: 'https://lyric.photix.cc',
    lyricsTimeoutMs: 8000,
    previewHost: '127.0.0.1',
    maxConcurrentJobs: 1,
    logLevel: 'warn',
    platform: process.platform,
    arch: process.arch,
  };

  const logger = new Logger(cacheDir, 'warn');
  const hardware = new HardwareProbe(paths);
  const media = new MediaAdapter(paths);
  const accompaniment = new AccompanimentAdapter(paths);
  // 与主进程同一口径：注入运行时 provider 探测，detect() 才会给出「实际生效」的分离后端
  hardware.setSeparationProviders(() => accompaniment.onnxProviders());
  const lyrics = new LyricsService(paths);
  const preview = new PreviewService(paths);
  const presentation = new UiPresentationPolicy(paths);
  step('实例化端口', true, '硬件探测 / 媒体 / 伴奏 / 歌词 / 预览 / 提示策略');

  const stageLog = [];
  const events = {
    progress: (e) => {
      result.lastProgress = e;
      // 记录阶段切换时刻，用于验证「分离期间进度文案确实是 ACCOMPANIMENT」
      const last = stageLog[stageLog.length - 1];
      if (!last || last.stage !== e.stage) stageLog.push({ stage: e.stage, ts: Date.now(), percent: e.percent });
    },
    status: (r) => { result.lastStatus = { id: r.id, status: r.status, stage: r.stage }; },
    fallback: (d) => { result.fallback = { backend: d.encodeEncoder, degraded: d.degraded, reasonCode: d.reasonCode }; },
  };
  const jobs = new JobService(paths, logger, events);
  const pipeline = new PipelineController(jobs, { media, accompaniment, lyrics, hardware, preview, presentation, logger, paths });
  step('组装编排层', true, 'JobService + PipelineController(7 阶段)');

  // 输入来源三选一：
  //   --source <video>  直接处理现成 MV（不合成，最贴近真实使用）
  //   --audio  <audio>  用真实歌曲 + 彩条画面合成 MV
  //   默认              全程合成信号
  const argValue = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? resolve(process.argv[i + 1] || '') : '';
  };
  const realSource = argValue('--source');
  const realAudio = argValue('--audio');
  const work = mkdtempSync(join(tmpdir(), 'mtv-e2e-'));
  let srcPath = join(work, 'input_mv.mp4');
  const ff = (args, label) => {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      { encoding: 'utf8', timeout: 1800000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${label} 失败：${String(r.stderr).slice(-400)}`);
  };

  if (realSource && existsSync(realSource)) {
    srcPath = realSource;
    result.audioSource = { mode: 'source', path: realSource };
  } else if (realAudio && existsSync(realAudio)) {
    ff([
      '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24',
      '-i', realAudio,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-shortest', srcPath,
    ], '用真实歌曲合成 MV');
    result.audioSource = { mode: 'real', path: realAudio };
  } else {
    ff([
      '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12,tremolo=f=5:d=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=155:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=233:duration=12',
      '-filter_complex',
      '[1:a]volume=0.5[v];[2:a]volume=0.3[c1];[3:a]volume=0.25[c2];[v][c1][c2]amix=inputs=3:normalize=0,pan=stereo|c0=c0|c1=c0[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', '12', srcPath,
    ], '生成测试 MV');
    result.audioSource = { mode: 'synthetic' };
  }
  const srcProbe = probe(srcPath);
  const srcDurForLrc = Number(srcProbe.format.duration);
  step('生成测试 MV', existsSync(srcPath),
    `${srcDurForLrc.toFixed(1)}s / ${srcProbe.streams.find((s) => s.codec_type === 'video')?.width}x${srcProbe.streams.find((s) => s.codec_type === 'video')?.height} / 单音轨（${result.audioSource.mode}）`);

  const outDir = join(work, 'out');
  mkdirSync(outDir, { recursive: true });
  const lrc = [
    `[00:00.50]这是端到端验证字幕（${result.audioSource.mode === 'source' ? '真实 MV' : result.audioSource.mode === 'real' ? '真实歌曲' : '合成信号'}）`,
    `[00:${String(Math.floor(srcDurForLrc * 0.35)).padStart(2, '0')}.00]第二句：伴奏已自动分离`,
    `[00:${String(Math.floor(srcDurForLrc * 0.7)).padStart(2, '0')}.00]第三句：双音轨并保持同步`,
  ].join('\n');

  const config = {
    sourcePath: srcPath,
    outputDir: outDir,
    outputName: 'e2e.mp4',
    container: 'mp4',
    extension: '.mp4',
    videoCodec: 'av1',
    videoEncoder: 'software',
    compressionPreset: 'balanced',
    accompanimentSource: 'uvr',
    lyrics: { enabled: true, source: 'pasted', pastedText: lrc, version: 'original', format: 'lrc', offsetMs: 0, burn: true },
    subtitle: {
      fontFamily: 'Noto Sans CJK SC', fontSize: 42, primaryColor: '&H00FFFFFF',
      outlineColor: '&H00000000', outlineWidth: 2, position: 'bottom', bilingualLines: 1,
    },
    skipReencodeIfHevc: false,
    detailedMode: false,
    lyricsExpanded: false,
  };

  const job = jobs.create(config);
  step('创建任务', Boolean(job?.id), `jobId=${job?.id}`);
  result.jobId = job.id;

  const t0 = Date.now();
  const rec = await pipeline.run(job.id);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  // 各阶段实际占用时长（毫秒），用于验证阶段推进时机
  result.stageSpans = stageLog.map((x, i) => ({
    stage: x.stage,
    ms: (stageLog[i + 1]?.ts ?? Date.now()) - x.ts,
  }));
  result.jobRecord = {
    status: rec?.status,
    error: rec?.error ?? null,
    reportPassed: rec?.report?.passed ?? null,
    failedChecks: (rec?.report?.checks ?? []).filter((c) => !c.passed).map((c) => `${c.code}:${c.severity}:${c.actual ?? ''}`).slice(0, 8),
  };
  const errBrief = rec?.error ? ` 错误=${JSON.stringify(rec.error).slice(0, 240)}` : '';
  step('pipeline.run（7 阶段）', rec?.status === 'COMPLETED', `status=${rec?.status} 耗时 ${elapsed}s${errBrief}`);
  result.elapsedSec = Number(elapsed);

  const outPath = rec.outputPath || join(outDir, 'e2e.mp4');
  step('输出文件存在', existsSync(outPath), outPath);

  const outProbe = probe(outPath);
  const audios = outProbe.streams.filter((s) => s.codec_type === 'audio');
  const video = outProbe.streams.find((s) => s.codec_type === 'video');
  const [a0, a1] = audios;
  const srcDur = Number(srcProbe.format.duration);
  const outDur = Number(outProbe.format.duration);

  check('E-01 双音轨', audios.length === 2, `${audios.length} 条音频流`, '恰好 2 条');
  check('E-02 音轨顺序', titleOf(a0) === '原唱' && titleOf(a1) === '伴奏',
    `a:0=${titleOf(a0) || '(空)'} / a:1=${titleOf(a1) || '(空)'}`, 'a:0=原唱, a:1=伴奏');
  check('E-03 原唱为默认轨', a0?.disposition?.default === 1 && a1?.disposition?.default === 0,
    `a:0=${a0?.disposition?.default} / a:1=${a1?.disposition?.default}`, 'a:0 default=1');
  // E-04 编码标识：跟随脚本配置的 videoCodec（av1→av01 / hevc→hvc1）
  const expectCodec = config.videoCodec === 'av1' ? 'av1' : 'hevc';
  const expectTag = config.videoCodec === 'av1' ? 'av01' : 'hvc1';
  check(`E-04 ${expectCodec.toUpperCase()} + ${expectTag}`,
    video?.codec_name === expectCodec && video?.codec_tag_string === expectTag,
    `${video?.codec_name}/${video?.codec_tag_string}`, `${expectCodec}/${expectTag}`);
  const srcVideoForCheck = srcProbe.streams.find((s) => s.codec_type === 'video');
  check('E-05 分辨率保持',
    video?.width === srcVideoForCheck?.width && video?.height === srcVideoForCheck?.height,
    `${video?.width}x${video?.height}`, `${srcVideoForCheck?.width}x${srcVideoForCheck?.height}`);
  check('E-06 时长一致', Math.abs(outDur - srcDur) <= 0.04, `源 ${srcDur}s / 出 ${outDur}s`, '差 ≤ 40ms');

  const checks = rec.report?.checks ?? [];
  const v09 = checks.find((c) => c.code === 'V-09');
  check('E-07 字幕烧录（V-09）', v09 ? v09.passed === true : false,
    v09 ? `${v09.code} passed=${v09.passed} ${v09.actual ?? ''}` : '报告中无 V-09');
  check('E-08 校验报告通过', rec.report?.passed === true,
    `passed=${rec.report?.passed} / checks=${checks.length}`, 'passed=true');

  // 与源画面比较：烧录后画面应有可见叠加。
  // 两路都归一到 480x270 再差分，才能适配任意输入分辨率（源与输出同分辨率但不等于 480）。
  const diffAtSec = Math.min(2, Math.max(0.5, srcDur / 10));
  const diff = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(diffAtSec), '-i', srcPath, '-ss', String(diffAtSec), '-i', outPath,
    '-filter_complex', '[0:v]scale=480:270,setpts=PTS-STARTPTS[a];[1:v]scale=480:270,setpts=PTS-STARTPTS[b];[a][b]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-frames:v', '1', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120000 });
  const yavg = Number((/YAVG=([0-9.]+)/.exec(diff.stdout || '') || [])[1] ?? -1);
  check('E-09 画面被字幕改动', yavg > 0.5, `同帧亮度差 YAVG=${yavg}`, '> 0.5');

  result.media = {
    source: { durationSec: srcDur, sizeBytes: Number(srcProbe.format.size) },
    output: { durationSec: outDur, sizeBytes: Number(outProbe.format.size), path: outPath },
    audioTracks: audios.map((s, i) => ({ index: `a:${i}`, codec: s.codec_name, title: titleOf(s), default: s.disposition?.default })),
  };
  result.report = { passed: rec.report?.passed, checksCount: checks.length, failedHard: checks.filter((c) => !c.passed && c.severity === 'hard').map((c) => c.code) };
  result.artifacts = { workDir: work, output: outPath };

  const failed = result.checks.filter((c) => !c.passed);
  result.ok = failed.length === 0;
  const srcMode = result.audioSource?.mode;
  const modeText = srcMode === 'source' ? '真实 MV' : srcMode === 'real' ? '真实歌曲' : '合成信号';
  result.conclusion = result.ok
    ? `完整管线通过：${srcDur.toFixed(0)}s ${modeText} → 真实分离 → ASS 烧录 → 双音轨 ${config.videoCodec === 'av1' ? 'AV1' : 'H.265'}（${elapsed}s，${(Number(outProbe.format.size) / 1024 / 1024).toFixed(2)}MB），E-01~E-09 全绿。`
    : `完整管线未通过：${failed.map((c) => c.code).join('、')}`;
}

main()
  .catch((e) => {
    result.ok = false;
    result.error = e instanceof Error ? (e.stack || e.message) : String(e);
    if (!result.conclusion) result.conclusion = `端到端验证异常：${e instanceof Error ? e.message : String(e)}`;
  })
  .finally(() => {
    const text = JSON.stringify(result, null, 2);
    mkdirSync(join(ROOT, 'release'), { recursive: true });
    writeFileSync(join(ROOT, 'release', 'e2e-pipeline.json'), text + '\n', 'utf8');
    process.stdout.write(text + '\n');
    process.stderr.write(`\n${result.conclusion}\n`);
    process.exitCode = result.ok ? 0 : 1;
  });
