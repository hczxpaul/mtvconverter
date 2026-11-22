#!/usr/bin/env node
/**
 * 外部资源准备脚本（Node 22 ESM，仅内置模块，无第三方依赖）。
 *
 * 依据 resources/manifest.json 与 docs/MTV转换器-设计文档与开发方案.md §10.1：
 *   --check  自检本机 FFmpeg/FFprobe 能力、UVR/Python/模型/字体目录，并按 sha256 校验已下载模型。
 *            结果以可读 JSON 打印到 stdout，并写 release/resource-check.json（目录不存在自动创建）。
 *            【不写项目根目录任何文件】。本机 FFmpeg 8.1 实测缺 libass/subtitles，会如实报 missing。
 *   --fetch  按 manifest 的 url + sha256 联网下载模型/资源；支持 SHA256 校验、断点续传、失败重试。
 *            url 为空时给出可读提示而非静默跳过。结果以 JSON 打印到 stdout。
 *   --fetch-optional  下载可选模型（Roformer 系列，约 610M + 871M）。体积大，与 --fetch 分开；
 *            下载后可在「更多设置 → 分离模型」中选择，需 torch 加速（CUDA / MPS）。
 *
 * 用法：node scripts/prepare-resources.mjs --check | --fetch | --fetch-optional | --setup-uvr | --help
 * 环境变量（与 .env.example / ConfigService 对齐，均可选）：
 *   MTVC_FFMPEG_PATH / MTVC_FFPROBE_PATH / MTVC_UVR_ROOT / MTVC_UVR_PYTHON
 *   MTVC_UVR_MODEL_DIR / MTVC_UVR_MODEL / MTVC_FONTS_DIR / MTVC_MODEL_BASE_URL
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  existsSync, statSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, renameSync, rmSync, createWriteStream,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'resources', 'manifest.json');
const RELEASE_DIR = join(ROOT, 'release');
const CHECK_REPORT = join(RELEASE_DIR, 'resource-check.json');

const env = (name, fallback = '') => process.env[name] || fallback;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── manifest 读取 ─────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`找不到资源清单：${MANIFEST_PATH}（请在项目根目录执行）`);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/** 解析 ffmpeg 的能力列表（-encoders/-filters/-muxers）：取每行「flag 列 + 名字列」中的名字。 */
function parseNames(output) {
  const names = new Set();
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trimStart();
    // flag 列由大写字母与点组成（encoders 6 列、filters 3 列、muxers 单列），其后为名字列
    const m = line.match(/^([A-Z.]{1,8})\s+(\S+)/);
    if (m) names.add(m[2]);
  }
  return names;
}

/** 同步执行外部命令，失败时返回 { ok:false, reason } 而不抛异常。 */
function run(bin, args, timeout = 10000) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `${bin} 无法执行：${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `${bin} 退出码 ${r.status}${r.stderr ? `：${String(r.stderr).trim().slice(0, 200)}` : ''}` };
  return { ok: true, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim())?.trim() || '';
}

function sha256File(path) {
  const h = createHash('sha256');
  const fd = readFileSync(path);
  h.update(fd);
  return h.digest('hex');
}

function resolveFromRoot(rel) {
  return resolve(ROOT, rel);
}

// ── --check ──────────────────────────────────────────────────
/** 应用可写数据目录，与 Electron 的 app.getPath('userData') 对齐。 */
function defaultUserData() {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'mtvconverter');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'mtvconverter');
  return join(home, '.config', 'mtvconverter');
}

function buildPaths(manifest) {
  const userData = resolve(env('MTVC_USER_DATA') || defaultUserData());
  const uvrRoot = resolve(env('MTVC_UVR_ROOT') || env('UVR_ROOT') || resolveFromRoot('resources/uvr'));
  const launcher = resolve(env('MTVC_UVR_SEPARATOR_SCRIPT') || resolveFromRoot(manifest.uvr.launcher || 'resources/uvr/launch_separator.py'));
  const modelDir = resolve(env('MTVC_UVR_MODEL_DIR') || join(userData, manifest.uvr.modelDir || 'models'));
  const fontsDir = resolve(env('MTVC_FONTS_DIR') || resolveFromRoot(manifest.fonts.dir || 'resources/fonts'));

  // 随包 FFmpeg 优先，其次环境变量，最后 PATH
  const binDir = resolveFromRoot(manifest.ffmpeg.bundled?.dir || 'resources/bin');
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const bundledFfmpeg = join(binDir, `ffmpeg${exeSuffix}`);
  const bundledFfprobe = join(binDir, `ffprobe${exeSuffix}`);
  const ffmpegPath = env('MTVC_FFMPEG_PATH') || (existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
  const ffprobePath = env('MTVC_FFPROBE_PATH') || (existsSync(bundledFfprobe) ? bundledFfprobe : 'ffprobe');

  const venvDir = join(userData, 'runtime', 'uvr-venv');
  const venvPython = process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
  const python = env('MTVC_UVR_PYTHON') || env('UVR_PYTHON') || (existsSync(venvPython) ? venvPython : 'python3');

  return { userData, uvrRoot, launcher, modelDir, fontsDir, ffmpegPath, ffprobePath, python, venvDir, venvPython };
}

function doCheck(manifest) {
  const paths = buildPaths(manifest);
  const checks = [];
  const add = (category, name, ok, severity, detail, status) => {
    checks.push({ category, name, ok, severity, status: status || (ok ? 'ok' : 'missing'), detail });
  };

  // FFmpeg / FFprobe 可执行与版本
  const ffVersion = run(paths.ffmpegPath, ['-hide_banner', '-version']);
  const fpVersion = run(paths.ffprobePath, ['-version']);
  add('可执行', 'FFmpeg', ffVersion.ok, 'hard', ffVersion.ok ? firstLine(ffVersion.stdout) : ffVersion.reason);
  add('可执行', 'FFprobe', fpVersion.ok, 'hard', fpVersion.ok ? firstLine(fpVersion.stdout) : fpVersion.reason);

  // 能力列表：ffmpeg -encoders / -filters / -muxers
  const encOut = ffVersion.ok ? run(paths.ffmpegPath, ['-hide_banner', '-encoders']).stdout || '' : '';
  const filOut = ffVersion.ok ? run(paths.ffmpegPath, ['-hide_banner', '-filters']).stdout || '' : '';
  const muxOut = ffVersion.ok ? run(paths.ffmpegPath, ['-hide_banner', '-muxers']).stdout || '' : '';
  const encoders = parseNames(encOut);
  const filters = parseNames(filOut);
  const muxers = parseNames(muxOut);

  const mapCheck = (category, list, set, names) => {
    for (const name of names) {
      const ok = set.has(name);
      add(category, name, ok, category === '编码器' ? 'hard' : 'soft',
        ok ? `已检出（${category}）` : `未检出：本机 FFmpeg 构建缺少 ${name}`);
    }
  };
  mapCheck('编码器', encoders, encoders, manifest.ffmpeg.requiredEncoders);
  mapCheck('滤镜', filters, filters, manifest.ffmpeg.requiredFilters);
  mapCheck('封装器', muxers, muxers, manifest.ffmpeg.requiredMuxers);

  // 平台相关编码器（仅信息项，本机 macOS 没有 nvenc 属正常）
  const platformEnc = manifest.ffmpeg.platformEncoders?.[process.platform] || [];
  for (const name of platformEnc) {
    const ok = encoders.has(name);
    add('平台编码器', name, ok, 'info', ok ? '已检出' : `当前平台未提供 ${name}（可回退 CPU 编码）`, ok ? 'ok' : 'info');
  }

  // 分离后端：audio-separator 垫片模式 / 传统 UVR.py 模式
  const backend = manifest.uvr.backend || 'uvr-gui';
  if (backend === 'audio-separator') {
    const launcherOk = existsSync(paths.launcher);
    add('UVR', '分离启动垫片', launcherOk, 'soft', launcherOk ? paths.launcher : `未找到 ${paths.launcher}`);
  } else {
    const uvrDirOk = existsSync(paths.uvrRoot);
    add('UVR', 'UVR_ROOT 目录', uvrDirOk, 'soft', uvrDirOk ? paths.uvrRoot : `目录不存在：${paths.uvrRoot}`);
    const entryPath = join(paths.uvrRoot, manifest.uvr.entry || 'UVR.py');
    const entryOk = existsSync(entryPath);
    add('UVR', manifest.uvr.entry || 'UVR.py', entryOk, 'soft', entryOk ? entryPath : `未找到 ${entryPath}`);
  }

  const pyVer = run(paths.python, ['--version'], 5000);
  add('UVR', 'Python 运行时', pyVer.ok, 'soft', pyVer.ok ? `${paths.python} → ${firstLine(pyVer.stdout) || firstLine(pyVer.stderr)}` : pyVer.reason);

  // 运行时包可用性（audio-separator + onnxruntime）
  const imp = run(paths.python, ['-c', 'import audio_separator, onnxruntime as o; print(o.__version__, o.get_available_providers())'], 30000);
  add('UVR', '分离运行时（audio-separator）', imp.ok, 'soft',
    imp.ok ? firstLine(imp.stdout) : `未安装或被环境阻断：${firstLine(imp.stderr) || imp.reason}；运行 npm run resources:setup-uvr 准备`);

  const modelDirOk = existsSync(paths.modelDir);
  add('UVR', '模型目录', modelDirOk, 'soft', modelDirOk ? paths.modelDir : `目录不存在：${paths.modelDir}`);
  const fontsDirOk = existsSync(paths.fontsDir);
  add('字体', '字体目录', fontsDirOk, 'soft', fontsDirOk ? paths.fontsDir : `目录不存在：${paths.fontsDir}`);

  // 已下载模型的 sha256 校验（sha256 为空 → 标为未校验并提示）
  const existingFiles = modelDirOk
    ? readdirSync(paths.modelDir).filter((f) => !f.endsWith('.part'))
    : [];
  const models = (manifest.uvr.models || []).map((m) => {
    const file = existingFiles.find((f) => f.startsWith(m.name));
    const provided = Boolean(m.sha256);
    if (!file) {
      return { name: m.name, file: null, sha256Provided: provided, sha256Match: null, status: 'missing', detail: '模型文件未下载' };
    }
    const full = join(paths.modelDir, file);
    if (!provided) {
      return { name: m.name, file: full, sha256Provided: false, sha256Match: null, status: 'unverified', detail: 'manifest 未提供 sha256，已下载但【未校验】，请补全 sha256 后重跑 --check' };
    }
    const digest = sha256File(full);
    const match = digest.toLowerCase() === m.sha256.toLowerCase();
    return {
      name: m.name, file: full, sha256Provided: true, sha256Match: match,
      status: match ? 'verified' : 'mismatch',
      detail: match ? 'SHA256 校验通过' : `SHA256 不匹配：期望 ${m.sha256}，实际 ${digest}`,
      expected: m.sha256, actual: digest,
    };
  });
  // 校验失败（mismatch）计入硬警告
  for (const m of models) {
    if (m.status === 'mismatch') add('模型校验', m.name, false, 'soft', m.detail, 'mismatch');
  }

  const hardFailures = checks.filter((c) => !c.ok && c.severity === 'hard');
  const softIssues = checks.filter((c) => !c.ok && c.severity === 'soft');
  const warnings = checks.filter((c) => !c.ok && c.severity === 'info').length;
  const libassOk = checks.some((c) => c.name === 'subtitles' && c.ok);
  const conclusion = hardFailures.length
    ? `存在 ${hardFailures.length} 项硬依赖缺失（${hardFailures.map((c) => c.name).join('、')}），转码主路径不可用，请安装/更换 FFmpeg 构建。`
    : `核心转码能力就绪；${softIssues.length} 项可选资源缺失/未就绪（${softIssues.map((c) => c.name).join('、') || '无'}）。${
      libassOk
        ? '字幕烧录可用（libass 已启用）。'
        : '未检测到 libass/subtitles，字幕烧录按设计降级为无字幕输出，不阻断主流程。'
    }`;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'check',
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    ffmpeg: { path: paths.ffmpegPath, version: ffVersion.ok ? firstLine(ffVersion.stdout) : null, ok: ffVersion.ok },
    ffprobe: { path: paths.ffprobePath, version: fpVersion.ok ? firstLine(fpVersion.stdout) : null, ok: fpVersion.ok },
    paths,
    capabilityCounts: { encoders: encoders.size, filters: filters.size, muxers: muxers.size },
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.ok).length,
      hardFailures: hardFailures.length,
      softIssues: softIssues.length,
      info: warnings,
      modelsVerified: models.filter((m) => m.status === 'verified').length,
      modelsUnverified: models.filter((m) => m.status === 'unverified').length,
      modelsMissing: models.filter((m) => m.status === 'missing').length,
      modelsMismatch: models.filter((m) => m.status === 'mismatch').length,
    },
    checks,
    models,
    conclusion,
  };
  return report;
}

// ── --fetch：下载 + SHA256 校验 + 断点续传 + 失败重试 ──────────
/** 发起 GET，跟随 3xx 重定向（最多 6 跳），返回原始响应流。 */
function httpGet(url, headers, redirects = 0) {
  return new Promise((resolveP, rejectP) => {
    const lib = url.startsWith('https:') ? https : http;
    let u;
    try { u = new URL(url); } catch (e) { return rejectP(new Error(`非法 URL：${url}`)); }
    const req = lib.get(u, { headers }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 6) return rejectP(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, url).toString();
        return resolveP(httpGet(next, headers, redirects + 1));
      }
      resolveP({ res, code, finalUrl: url });
    });
    req.on('error', rejectP);
    req.setTimeout(30000, () => req.destroy(new Error('下载超时（30s 无响应）')));
  });
}

/** 单个资源下载：断点续传（.part + Range）、最多 3 次重试、完成后 SHA256 校验。 */
async function fetchOne(model, modelDir) {
  if (!model.url) {
    return {
      name: model.name, status: 'skipped',
      detail: `模型「${model.name}」在 manifest 中未配置 url，已跳过（非静默）。请在 resources/manifest.json 填写 url + sha256，或将模型手动放入 ${modelDir} 后用 --check 校验。`,
    };
  }
  mkdirSync(modelDir, { recursive: true });
  let filename;
  try { filename = basename(new URL(model.url).pathname) || `${model.name}.onnx`; }
  catch { filename = `${model.name}.onnx`; }
  const dest = join(modelDir, filename);
  const part = `${dest}.part`;
  const MAX_RETRY = 3;
  let lastErr = '';

  for (let attempt = 1; attempt <= MAX_RETRY; attempt += 1) {
    try {
      const existing = existsSync(part) ? statSync(part).size : 0;
      const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
      const { res, code } = await httpGet(model.url, headers);
      if (code !== 200 && code !== 206) {
        res.resume();
        throw new Error(`HTTP ${code}`);
      }
      const append = code === 206 && existing > 0;
      // 服务器忽略 Range 返回 200 → 丢弃半成品从头写
      if (code === 200 && existsSync(part)) rmSync(part);
      const ws = createWriteStream(part, { flags: append ? 'a' : 'w' });
      let written = 0;
      res.on('data', (chunk) => { written += chunk.length; });
      await pipeline(res, ws);

      const digest = sha256File(part);
      if (model.sha256) {
        if (digest.toLowerCase() !== model.sha256.toLowerCase()) {
          rmSync(part); // 校验失败删除半成品，避免续传叠加错误数据
          throw new Error(`SHA256 不匹配：期望 ${model.sha256}，实际 ${digest}`);
        }
      }
      renameSync(part, dest);
      return {
        name: model.name, status: 'ok', file: dest, bytes: written + (append ? existing : 0),
        resumed: append, attempt, sha256Verified: Boolean(model.sha256),
        detail: model.sha256
          ? `下载完成并通过 SHA256 校验${append ? '（断点续传）' : ''}`
          : `下载完成，但 manifest 未提供 sha256，【未校验】请补全后重跑 --check${append ? '（断点续传）' : ''}`,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRY) {
        process.stderr.write(`  ↻ ${model.name} 第 ${attempt} 次失败（${lastErr}），准备重试…\n`);
        await delay(500 * attempt);
      }
    }
  }
  return { name: model.name, status: 'failed', detail: `下载失败（已重试 ${MAX_RETRY} 次）：${lastErr}`, url: model.url };
}

async function doFetch(manifest) {
  const modelDir = buildPaths(manifest).modelDir;
  const models = manifest.uvr.models || [];
  process.stderr.write(`开始检查 ${models.length} 个模型资源，目标目录：${modelDir}\n`);
  const results = [];
  for (const m of models) {
    process.stderr.write(`· 处理「${m.name}」…\n`);
    // eslint-disable-next-line no-await-in-loop
    results.push(await fetchOne(m, modelDir));
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const conclusion = failed
    ? `${failed} 个资源下载失败，详见 results；可稍后重跑 --fetch（支持断点续传）。`
    : skipped === models.length
      ? 'manifest 中所有模型均未配置 url，未执行任何下载。请补全 resources/manifest.json 的 url 与 sha256 后重跑 --fetch。'
      : `下载完成 ${ok} 个，跳过 ${skipped} 个（未配置 url）。运行 --check 可复核 SHA256 与整体能力。`;
  return {
    generatedAt: new Date().toISOString(), mode: 'fetch', modelDir,
    summary: { total: models.length, ok, skipped, failed },
    results, conclusion,
  };
}

/**
 * 下载可选模型（Roformer 系列，体积大，约 610M + 871M）。
 * 与 --fetch 分开：默认安装只准备 MDX 默认模型，需要更强的伴奏质量时再执行本命令。
 */
async function doFetchOptional(manifest) {
  const modelDir = buildPaths(manifest).modelDir;
  const models = manifest.uvr.optionalModels || [];
  if (!models.length) {
    return {
      generatedAt: new Date().toISOString(), mode: 'fetch-optional', modelDir,
      summary: { total: 0, ok: 0, skipped: 0, failed: 0 },
      results: [], conclusion: 'manifest 未配置 optionalModels，无需下载。',
    };
  }
  process.stderr.write(`开始下载 ${models.length} 个可选模型（Roformer，体积较大），目标目录：${modelDir}\n`);
  const results = [];
  for (const m of models) {
    process.stderr.write(`· 处理「${m.name}」…\n`);
    // eslint-disable-next-line no-await-in-loop
    results.push(await fetchOne(m, modelDir));
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const conclusion = failed
    ? `${failed} 个可选模型下载失败；可稍后重跑 --fetch-optional（支持断点续传）。`
    : `可选模型就绪 ${ok} 个，跳过 ${skipped} 个。在「更多设置 → 分离模型」中即可选择 Roformer。`;
  return {
    generatedAt: new Date().toISOString(), mode: 'fetch-optional', modelDir,
    summary: { total: models.length, ok, skipped, failed },
    results, conclusion,
  };
}

// ── 运行时安装 ────────────────────────────────────────────────
/** 选择可用的 Python 3.10–3.13（audio-separator 的支持区间）。 */
function pickPython() {
  const candidates = process.platform === 'win32'
    ? ['python3.12', 'python3.11', 'python3.10', 'python']
    : ['python3.12', 'python3.11', 'python3.10', 'python3'];
  for (const bin of candidates) {
    const r = run(bin, ['-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], 15000);
    if (!r.ok) continue;
    const v = firstLine(r.stdout);
    const [major, minor] = v.split('.').map(Number);
    if (major === 3 && minor >= 10 && minor <= 13) return { bin, version: v };
  }
  return null;
}

/**
 * 在 userData 下创建独立 venv 并安装分离运行时，再拉取默认模型。
 * 幂等：已存在 venv 时只补装依赖；已存在且校验通过的模型不重复下载。
 *
 * `--gpu`：装 GPU 版分离运行时（Windows: CUDA 版 torch + onnxruntime-gpu）。
 * onnxruntime / onnxruntime-gpu / onnxruntime-directml 共用同一个 `onnxruntime` 顶层模块，
 * 三个变体不能共存，切换时必须先卸干净再装，否则谁的 DLL 生效不确定。
 */
async function doSetupUvr(manifest, options = {}) {
  const paths = buildPaths(manifest);
  const steps = [];
  const runtime = manifest.uvr.runtime;
  const gpuSpec = runtime?.gpu?.[process.platform];
  const wantGpu = Boolean(options.gpu);

  if (!runtime) {
    return { mode: 'setup-uvr', ok: false, conclusion: 'manifest.uvr.runtime 未定义，无法安装运行时。', steps };
  }
  if (wantGpu && !gpuSpec) {
    steps.push({
      step: 'GPU 运行时',
      ok: false,
      detail: `当前平台（${process.platform}）在 manifest.uvr.runtime.gpu 中没有配置：macOS 的 ONNX 加速（CoreML）不被 MDX 模型支持，分离只能 CPU。`,
    });
  }
  const useGpu = wantGpu && Boolean(gpuSpec);

  const py = pickPython();
  if (!py) {
    return {
      mode: 'setup-uvr', ok: false, steps,
      conclusion: '未找到 Python 3.10–3.13。请先安装（macOS: brew install python@3.12；Windows: 从 python.org 安装 3.12）。',
    };
  }
  steps.push({ step: '选择解释器', ok: true, detail: `${py.bin} → ${py.version}` });

  if (!existsSync(paths.venvPython)) {
    mkdirSync(dirname(paths.venvDir), { recursive: true });
    const r = run(py.bin, ['-m', 'venv', paths.venvDir], 300000);
    steps.push({ step: '创建 venv', ok: r.ok, detail: r.ok ? paths.venvDir : r.reason });
    if (!r.ok) return { mode: 'setup-uvr', ok: false, steps, conclusion: '创建 Python 虚拟环境失败。' };
  } else {
    steps.push({ step: '创建 venv', ok: true, detail: `已存在：${paths.venvDir}` });
  }

  const pip = run(paths.venvPython, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'], 300000);
  steps.push({ step: '升级 pip', ok: pip.ok, detail: pip.ok ? '完成' : pip.reason });

  const pkgs = runtime.packagesByPlatform?.[process.platform] || runtime.packages || ['audio-separator[cpu]'];

  // onnxruntime 变体互斥：先看现在装的是哪一种，只有需要切换时才卸载重装
  const probeProviders = run(
    paths.venvPython,
    ['-c', 'import onnxruntime as o; print("|".join(o.get_available_providers()))'],
    60000,
  );
  const providers = probeProviders.ok ? firstLine(probeProviders.stdout) : '';
  const hasGpuProvider = /CUDAExecutionProvider|DmlExecutionProvider/.test(providers);
  const needOrtSwitch = useGpu ? !/CUDAExecutionProvider/.test(providers) : hasGpuProvider;
  if (needOrtSwitch) {
    const un = run(
      paths.venvPython,
      ['-m', 'pip', 'uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu', 'onnxruntime-directml'],
      300000,
    );
    steps.push({ step: '清理 onnxruntime 变体', ok: true, detail: un.ok ? '已卸载旧变体' : `跳过：${un.reason}` });
  }

  if (useGpu) {
    // CUDA 版 torch：分离的 STFT 在 torch 里算，只有 ONNX 上 GPU 而 torch 在 CPU 时收益有限
    const torchSpec = gpuSpec.torch;
    const cudaOk = run(paths.venvPython, ['-c', 'import torch; print(torch.cuda.is_available())'], 120000);
    if (!torchSpec || !/True/.test(firstLine(cudaOk.stdout || ''))) {
      const t = run(
        paths.venvPython,
        ['-m', 'pip', 'install', '-q', ...(torchSpec?.version ? [`torch==${torchSpec.version}`] : ['torch']),
          ...(torchSpec?.indexUrl ? ['--index-url', torchSpec.indexUrl] : [])],
        3600000,
      );
      steps.push({ step: '安装 CUDA 版 torch', ok: t.ok, detail: t.ok ? (torchSpec?.indexUrl ?? '默认源') : t.reason });
    } else {
      steps.push({ step: '安装 CUDA 版 torch', ok: true, detail: '已就绪（torch.cuda.is_available()=True）' });
    }
  } else if (process.platform === 'win32') {
    // Windows 上 PyPI 的 torch 自带 CUDA 运行时（约 2.5GB）；纯 CPU 分离不需要，先装 CPU 版省 2GB
    const torch = run(
      paths.venvPython,
      ['-m', 'pip', 'install', '-q', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu'],
      1800000,
    );
    steps.push({ step: '安装 CPU 版 torch', ok: torch.ok, detail: torch.ok ? 'download.pytorch.org/whl/cpu' : torch.reason });
  }

  // GPU 模式下不能同时装 onnxruntime（CPU 版）和 onnxruntime-gpu：同一个顶层模块会互相覆盖
  const installPkgs = useGpu
    ? [...pkgs.filter((p) => p !== 'onnxruntime'), ...gpuSpec.packages]
    : pkgs;
  const inst = run(paths.venvPython, ['-m', 'pip', 'install', '-q', ...installPkgs], 1800000);
  steps.push({
    step: '安装分离依赖',
    ok: inst.ok,
    detail: inst.ok ? installPkgs.join(' ') : inst.reason,
  });

  const chk = run(
    paths.venvPython,
    ['-c', 'import audio_separator, onnxruntime as o; print(o.__version__, o.get_available_providers())'],
    90000,
  );
  steps.push({ step: '校验导入', ok: chk.ok, detail: chk.ok ? firstLine(chk.stdout) : chk.reason });

  const fetchResult = await doFetch(manifest);
  steps.push({
    step: '拉取模型',
    ok: fetchResult.summary.failed === 0,
    detail: `ok=${fetchResult.summary.ok} skipped=${fetchResult.summary.skipped} failed=${fetchResult.summary.failed}`,
  });

  const ok = steps.every((s) => s.ok);
  const modeText = useGpu
    ? 'GPU 模式（Windows: CUDA 版 torch + onnxruntime-gpu）'
    : process.platform === 'win32'
      ? 'CPU 模式（onnxruntime）'
      : '平台默认模式（macOS: torch MPS + ONNX CPU，CoreML 不支持 MDX 算子）';
  return {
    mode: 'setup-uvr', ok, gpu: useGpu, accelerator: modeText,
    userData: paths.userData, modelDir: paths.modelDir,
    steps, fetch: fetchResult,
    conclusion: ok
      ? `分离运行时已就绪（${modeText}）：可直接使用「自动生成伴奏」。`
      : '部分步骤未成功，详见 steps；「导入官方伴奏」路径不受影响。',
  };
}

// ── 入口 ─────────────────────────────────────────────────────
function usage() {
  process.stdout.write(`MTV Converter 外部资源准备工具

用法：
  node scripts/prepare-resources.mjs --check       自检 FFmpeg/FFprobe 能力 + 分离运行时/模型/字体，写 release/resource-check.json
  node scripts/prepare-resources.mjs --setup-uvr   在 userData 创建 venv、安装分离运行时并下载默认模型（默认 CPU）
  node scripts/prepare-resources.mjs --setup-uvr --gpu
                                                  装 GPU 版分离运行时（Windows: CUDA 版 torch + onnxruntime-gpu；
                                                  macOS 无 GPU 路径——CoreML 不支持 MDX 算子）
  node scripts/prepare-resources.mjs --fetch       按 manifest 的 url+sha256 联网下载模型（SHA256 校验 / 断点续传 / 失败重试）
  node scripts/prepare-resources.mjs --fetch-optional
                                                  下载可选模型（Roformer 系列，约 610M + 871M；需 torch 加速）
  node scripts/prepare-resources.mjs --help        显示本帮助

环境变量（同 .env / ConfigService）：MTVC_USER_DATA / MTVC_UVR_PYTHON / MTVC_FFMPEG_PATH 等。
`);
}

// 用 exitCode 而非 exit()，保证 stdout 重定向到文件/pipe 时也能完整 flush。
async function main() {
  const args = process.argv.slice(2);
  const gpu = args.includes('--gpu');
  const arg = args.find((a) => a.startsWith('--') && a !== '--gpu');
  if (args.includes('--help') || args.includes('-h') || !arg) { usage(); if (!arg) process.exitCode = 1; return; }
  if (arg !== '--check' && arg !== '--fetch' && arg !== '--fetch-optional' && arg !== '--setup-uvr') {
    process.stderr.write(`未知参数：${arg}\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  let manifest;
  try { manifest = loadManifest(); }
  catch (e) { process.stderr.write(`读取清单失败：${e.message}\n`); process.exitCode = 1; return; }

  if (arg === '--check') {
    const report = doCheck(manifest);
    mkdirSync(RELEASE_DIR, { recursive: true });
    writeFileSync(CHECK_REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`\n报告已写入：${CHECK_REPORT}\n${report.conclusion}\n`);
    // 硬依赖缺失才以非零码退出；缺 libass/subtitles/UVR 等可降级项如实上报但不阻断
    process.exitCode = report.summary.hardFailures > 0 ? 1 : 0;
    return;
  }

  if (arg === '--setup-uvr') {
    const report = await doSetupUvr(manifest, { gpu });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`\n${report.conclusion}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const report = arg === '--fetch-optional'
    ? await doFetchOptional(manifest)
    : await doFetch(manifest);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`\n${report.conclusion}\n`);
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`资源准备脚本异常：${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
