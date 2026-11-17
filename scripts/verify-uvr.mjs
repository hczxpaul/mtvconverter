#!/usr/bin/env node
/**
 * 伴奏分离端到端验证（走编译产物 AccompanimentAdapter，不是裸 CLI）。
 *
 * 覆盖：selfTest → separate（真实 MDX-Net 推理）→ 产物时长/规格/声道校验。
 * 需要先 `npm run build` 与 `npm run resources:setup-uvr`；
 * 缺失运行时或模型时以可读原因退出（exit 1），不伪造通过。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_MODULE = join(ROOT, 'dist', 'main', 'main', 'accompaniment', 'index.js');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'resources', 'manifest.json'), 'utf8'));

function userDataDir() {
  if (process.env.MTVC_USER_DATA) return resolve(process.env.MTVC_USER_DATA);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'mtvconverter');
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'mtvconverter');
  return join(homedir(), '.config', 'mtvconverter');
}

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const bundledOr = (name) => {
  const p = join(ROOT, 'resources', 'bin', exe(name));
  return existsSync(p) ? p : name;
};

const ffmpegPath = process.env.MTVC_FFMPEG_PATH || bundledOr('ffmpeg');
const ffprobePath = process.env.MTVC_FFPROBE_PATH || bundledOr('ffprobe');
const userData = userDataDir();
const venvPython = process.platform === 'win32'
  ? join(userData, 'runtime', 'uvr-venv', 'Scripts', 'python.exe')
  : join(userData, 'runtime', 'uvr-venv', 'bin', 'python');

const result = {
  generatedAt: new Date().toISOString(),
  paths: { ffmpegPath, ffprobePath, venvPython },
  steps: [],
  checks: [],
  ok: false,
};

function step(name, ok, detail) {
  result.steps.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`步骤失败【${name}】：${detail}`);
}
function check(code, passed, actual, expected) {
  result.checks.push({ code, passed: Boolean(passed), actual, expected });
}
function probe(path) {
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffprobe 失败：${String(r.stderr).slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

async function main() {
  if (!existsSync(ADAPTER_MODULE)) {
    result.conclusion = `缺少编译产物 ${ADAPTER_MODULE}，请先执行 npm run build`;
    process.exitCode = 1;
    return;
  }

  const paths = {
    ffmpegPath, ffprobePath,
    cacheDir: join(userData, '.cache'),
    fontsDir: join(ROOT, 'resources', 'fonts'),
    uvrRoot: join(ROOT, 'resources', 'uvr'),
    uvrPython: process.env.MTVC_UVR_PYTHON || venvPython,
    uvrSeparatorScript: process.env.MTVC_UVR_SEPARATOR_SCRIPT || join(ROOT, 'resources', 'uvr', 'launch_separator.py'),
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

  const mod = await import(pathToFileURL(ADAPTER_MODULE).href);
  const adapter = new mod.AccompanimentAdapter(paths);
  step('加载 AccompanimentAdapter', true, '已实例化（编译产物）');

  const selfTest = await adapter.selfTest();
  step('adapter.selfTest', selfTest.ok, selfTest.ok ? '运行时与模型目录就绪' : (selfTest.reason || '未通过'));

  // 生成 6 秒测试音频：人声频段 + 和弦 + 底噪
  const work = mkdtempSync(join(tmpdir(), 'mtv-uvr-'));
  const srcWav = join(work, 'song.wav');
  const ff = (args, label) => {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${label} 失败：${String(r.stderr).slice(-300)}`);
  };
  ff([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6,tremolo=f=5:d=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=155:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=233:duration=6',
    '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:a=0.25',
    '-filter_complex', '[0:a]volume=0.50[v];[1:a]volume=0.30[c1];[2:a]volume=0.25[c2];[3:a]volume=0.18[n];[v][c1][c2][n]amix=inputs=4:normalize=0,pan=stereo|c0=c0|c1=c0[out]',
    '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', srcWav,
  ], '生成测试音频');
  const srcProbe = probe(srcWav);
  const srcDur = Number(srcProbe.format.duration);
  step('生成测试音频', existsSync(srcWav), `${srcDur}s / 44100Hz / 2ch`);

  const backend = { separationBackend: 'cpu', videoEncoder: 'libx265', h264Encoder: 'libx264', reasonCode: 'TEST', reasonText: '验证用固定 CPU', degraded: false };
  const t0 = Date.now();
  const outPath = await adapter.separate(srcWav, join(work, 'out'), backend, paths.modelName);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  step('adapter.separate（真实 MDX-Net 推理）', existsSync(outPath), `${outPath}，耗时 ${elapsed}s`);

  const outProbe = probe(outPath);
  const audio = outProbe.streams.find((s) => s.codec_type === 'audio');
  const outDur = Number(outProbe.format.duration);
  check('U-01 含音频流', Boolean(audio), audio ? `${audio.codec_name}/${audio.sample_rate}/${audio.channels}` : '无', '存在音频流');
  check('U-02 时长与源一致', Math.abs(outDur - srcDur) <= 0.5, `源 ${srcDur}s / 伴奏 ${outDur}s`, '差 ≤ 0.5s');
  check('U-03 声道可用', Number(audio?.channels ?? 0) >= 1, `${audio?.channels} 声道`, '≥ 1');

  // 伴奏不应与原唱完全相同（否则等于没分离）。
  // 做法：把伴奏反相后与原唱相加，完全相同时抵消为静音，用整体 RMS 电平判断差异。
  const subtract = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', srcWav, '-i', outPath,
    '-filter_complex',
    '[1:a]volume=-1.0[inv];[0:a][inv]amix=inputs=2:normalize=0:duration=shortest,astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const rmsRaw = (/RMS_level=(-?[0-9.]+|-inf)/.exec(subtract.stdout || '') || [])[1];
  const rmsDb = rmsRaw === 'inf' ? -Infinity : Number(rmsRaw ?? -Infinity);
  const distinct = Number.isFinite(rmsDb) ? rmsDb > -60 : false;
  check('U-04 与原唱存在实质差异', distinct,
    `反相相减后 RMS ${Number.isFinite(rmsDb) ? rmsDb.toFixed(1) : '-inf'} dB`, '> -60 dB 视为确有分离');

  result.artifacts = { workDir: work, source: srcWav, accompaniment: outPath };
  result.separation = { elapsedSec: Number(elapsed), outputDurationSec: outDur, sourceDurationSec: srcDur };

  const failed = result.checks.filter((c) => !c.passed);
  result.ok = failed.length === 0;
  result.conclusion = result.ok
    ? `分离验证通过：${elapsed}s 内产出合法伴奏（${outDur.toFixed(2)}s），U-01~U-04 全绿。产物保留在 ${work}`
    : `分离验证未通过：${failed.map((c) => c.code).join('、')}`;
  if (result.ok) {
    // 通过时清理临时目录，避免堆占空间
    try { rmSync(work, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
    result.cleaned = true;
  }
}

main()
  .catch((e) => {
    result.ok = false;
    result.error = e instanceof Error ? (e.stack || e.message) : String(e);
    if (!result.conclusion) result.conclusion = `分离验证异常：${e instanceof Error ? e.message : String(e)}`;
  })
  .finally(() => {
    const text = JSON.stringify(result, null, 2);
    const releaseDir = join(ROOT, 'release');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'uvr-verify.json'), text + '\n', 'utf8');
    process.stdout.write(text + '\n');
    process.stderr.write(`\n${result.conclusion}\n`);
    process.exitCode = result.ok ? 0 : 1;
  });
