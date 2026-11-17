import { existsSync, readFileSync, mkdirSync, accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { RuntimePaths } from '../../shared/contracts';
import { DEFAULTS } from '../../shared/contracts';

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`配置校验失败：${problems.join('；')}`);
    this.name = 'ConfigError';
  }
}

function readDotEnv(baseDir: string): Record<string, string> {
  const file = join(baseDir, '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (value) out[key] = value;
  }
  return out;
}

function executableOnPath(name: string): string {
  const probe = spawnSync('which', [name], { encoding: 'utf8' });
  return probe.status === 0 ? probe.stdout.trim() : '';
}

/**
 * 解析外部可执行文件：显式配置 > 随包 sidecar > 各平台常见安装位置 > PATH。
 * 打包后的 GUI 应用 PATH 通常不含 /opt/homebrew/bin，必须显式探测常见位置。
 */
function resolveBinary(name: string, explicit: string | undefined, resourcesRoot: string): string {
  if (explicit) return explicit;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    join(resourcesRoot, 'resources', 'bin', exe),
    ...(process.platform === 'darwin' ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`] : []),
    ...(process.platform === 'win32' ? [join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'ffmpeg', 'bin', exe)] : []),
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return executableOnPath(name);
}

/**
 * 分离后端启动垫片（audio-separator CLI）。随包提供，用户无需手改。
 * 找不到时返回空串，适配器回退到 UVR.py 入口。
 */
function resolveSeparatorScript(explicit: string | undefined, resourcesRoot: string, baseDir: string): string {
  if (explicit) return explicit;
  const candidates = [
    join(resourcesRoot, 'resources', 'uvr', 'launch_separator.py'),
    join(baseDir, 'resources', 'uvr', 'launch_separator.py'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 分离用 Python 解释器：显式配置 > userData 内的本地运行时 > PATH。
 * 运行时由 prepare-resources 安装到 userData，避免写入只读的 app.asar。
 */
function resolveUvrPython(explicit: string | undefined, baseDir: string): string {
  if (explicit) return explicit;
  const bin = process.platform === 'win32' ? 'python.exe' : 'python';
  const candidates = [
    join(baseDir, 'runtime', 'uvr-venv', 'bin', bin),
    join(baseDir, 'runtime', 'uvr-venv', 'Scripts', bin),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 配置集中校验、启动快速失败；只提交 .env.example，真实 .env 不入库。 */
export class ConfigService {
  private constructor(public readonly paths: RuntimePaths) {}

  /**
   * @param baseDir        配置与缓存根目录（打包后必须是可写的 userData，不能是只读的 app.asar）
   * @param resourcesRoot  外部资源根目录（开发为项目根；打包后为 process.resourcesPath）
   */
  static load(baseDir: string = process.cwd(), resourcesRoot: string = baseDir): ConfigService {
    const env = { ...readDotEnv(baseDir), ...process.env } as Record<string, string>;
    const problems: string[] = [];

    const ffmpegPath = resolveBinary('ffmpeg', env.MTVC_FFMPEG_PATH, resourcesRoot);
    const ffprobePath = resolveBinary('ffprobe', env.MTVC_FFPROBE_PATH, resourcesRoot);
    for (const [label, bin] of [['FFmpeg', ffmpegPath], ['FFprobe', ffprobePath]] as const) {
      if (!bin) { problems.push(`${label} 未找到`); continue; }
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) problems.push(`${label} 无法执行：${bin}`);
    }

    const cacheDir = resolve(env.MTVC_CACHE_DIR || join(baseDir, '.cache'));
    try {
      mkdirSync(cacheDir, { recursive: true });
      accessSync(cacheDir, constants.W_OK);
    } catch {
      problems.push(`缓存目录不可写：${cacheDir}`);
    }

    const lyricsBaseUrl = env.MTVC_LYRICS_BASE_URL || 'https://lyric.photix.cc';
    try { new URL(lyricsBaseUrl); } catch { problems.push(`MTVC_LYRICS_BASE_URL 不是合法 URL：${lyricsBaseUrl}`); }

    const logLevel = (env.MTVC_LOG_LEVEL || 'info') as RuntimePaths['logLevel'];
    if (!['info', 'warn', 'error'].includes(logLevel)) problems.push(`MTVC_LOG_LEVEL 非法：${logLevel}`);

    const maxConcurrentJobs = Number(env.MTVC_MAX_CONCURRENT_JOBS || DEFAULTS.maxConcurrentJobs);
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) problems.push('MTVC_MAX_CONCURRENT_JOBS 必须为正整数');

    const lyricsTimeoutMs = Number(env.MTVC_LYRICS_TIMEOUT_MS || DEFAULTS.lyricsTimeoutMs);
    if (!Number.isFinite(lyricsTimeoutMs) || lyricsTimeoutMs < 1000) problems.push('MTVC_LYRICS_TIMEOUT_MS 必须 ≥ 1000');

    if (problems.length) throw new ConfigError(problems);

    return new ConfigService({
      ffmpegPath,
      ffprobePath,
      cacheDir,
      fontsDir: resolve(env.MTVC_FONTS_DIR || join(resourcesRoot, 'resources', 'fonts')),
      uvrRoot: resolve(env.MTVC_UVR_ROOT || join(resourcesRoot, 'resources', 'uvr')),
      uvrPython: resolveUvrPython(env.MTVC_UVR_PYTHON, baseDir),
      uvrSeparatorScript: resolveSeparatorScript(env.MTVC_UVR_SEPARATOR_SCRIPT, resourcesRoot, baseDir),
      // 模型需可写下载：放 userData，不进只读的 app 包
      modelDir: resolve(env.MTVC_UVR_MODEL_DIR || join(baseDir, 'models')),
      modelName: env.MTVC_UVR_MODEL || 'UVR-MDX-NET-Inst_HQ_3',
      lyricsBaseUrl,
      lyricsTimeoutMs,
      previewHost: env.MTVC_PREVIEW_HOST || DEFAULTS.previewBindHost,
      maxConcurrentJobs,
      logLevel,
      platform: process.platform,
      arch: process.arch,
    });
  }
}
