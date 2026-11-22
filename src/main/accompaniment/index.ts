/**
 * 伴奏来源层适配器：UVR5.6 分离（CLI 唯一集成面）与官方伴奏导入（一等输入）。
 * 只依赖 Node 内置模块与共享契约；路径一律 argv 数组传参，支持中文 / 空格 / UNC。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS } from '../../shared/contracts';
import type {
  AccompanimentPort,
  BackendDecision,
  RuntimePaths,
} from '../../shared/contracts';
import { AccompanimentError } from './errors';
import {
  runProcess,
  probeAudio,
  startDecode,
  type ProcHandle,
  type ProcResult,
} from './proc';
import { parseWav, analysePcm, correlation } from './wav';

/** UVR 分离超时：覆盖首次模型加载 5–10 分钟（§6.1）与长曲分离；随包实测后校准。 */
export const UVR_SEPARATE_TIMEOUT_MS = 30 * 60 * 1000;

/** stderr / stdout 中判定显存 / 内存不足的特征（§8.2 E_UVR_OOM）。 */
export const UVR_OOM_PATTERNS: readonly RegExp[] = [
  /cuda out of memory/i,
  /out of memory/i,
  /cannot allocate memory/i,
  /not enough memory/i,
  /memoryerror/i,
  /defaultcpuallocator/i,
  /cuda.*(alloc|memory)/i,
  /\boom\b/i,
];

const AUDIO_FILE_EXTENSIONS = new Set([
  '.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus',
  '.aiff', '.aif', '.wma', '.alac', '.mp2',
]);
// -i_stem / -v 由本层指定，用其 stem 名做启发式识别，并非硬编码某个具体输出文件名
const INSTRUMENTAL_HINT = /instrumental|kara|\binst\b|_inst|inst_/i;
const VOCAL_HINT = /vocal/i;
const IMPORTED_WAV_NAME = 'instrumental.raw.wav';
const SAME_AUDIO_CORRELATION = 0.99; // 与 §9.1 V-02 的互相关口径一致
const DURATION_MATCH_TOL_SEC = 3;
const MAX_SCAN_DEPTH = 3;
/** 分离 CLI 退出与文件落盘可能有时序差（写盘 / 缓冲刷新），最多再等 5 秒。 */
const OUTPUT_WAIT_ATTEMPTS = 5;
const OUTPUT_WAIT_INTERVAL_MS = 1000;

function hasOom(text: string): boolean {
  return UVR_OOM_PATTERNS.some((re) => re.test(text));
}

function trimLog(text: string): string {
  const t = text.trim();
  return t.length > 4000 ? `${t.slice(0, 4000)}…（已截断）` : t;
}

/** 仅解析输出中明确出现的百分比；解析不到返回 null，绝不按时间推测进度。 */
function parseProgress(chunk: string): number | null {
  const m = chunk.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** 分离 CLI 需要带后缀的模型文件名；配置里允许只写模型名。 */
function toModelFile(name: string): string {
  const n = name.trim();
  if (n === '') return n;
  return /\.(onnx|pth|yaml|ckpt)$/i.test(n) ? n : `${n}.onnx`;
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; }
}
async function isFile(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isFile(); } catch { return false; }
}
async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 递归列出文件（限深度），兼容 UVR 把产物写进子目录的情况。 */
async function listFiles(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  };
  await walk(root, 0);
  return out;
}

interface Candidate {
  p: string;
  mtime: number;
  durationSec: number;
  instrumental: boolean;
  vocal: boolean;
}

export class AccompanimentAdapter implements AccompanimentPort {
  private readonly paths: RuntimePaths;
  private active?: ProcHandle;
  private readonly notices: string[] = [];
  private providersCache?: string[];
  private torchDeviceCache?: 'cuda' | 'mps' | 'cpu';

  /** 可选进度回调：仅在 stdout 解析出真实百分比时调用；解析不到不伪造、不调用。 */
  onProgress?: (percent: number, message: string) => void;

  constructor(paths: RuntimePaths) {
    this.paths = paths;
  }

  /**
   * 分离运行时真实可用的 ONNX provider（结果缓存，只探一次）。
   * 探测失败返回空数组——调用方按 CPU 处理，不臆测 GPU 可用。
   */
  async onnxProviders(): Promise<string[]> {
    if (this.providersCache) return this.providersCache;
    try {
      const handle = runProcess({
        command: this.paths.uvrPython,
        args: ['-c', 'import onnxruntime as o; print("|".join(o.get_available_providers()))'],
        timeoutMs: 60_000,
      });
      const r = await handle.wait();
      if (r.code === 0) {
        this.providersCache = r.stdout.trim().split('|').map((s) => s.trim()).filter(Boolean);
        return this.providersCache;
      }
    } catch {
      // 运行时缺失 / Python 不可执行：交给 selfTest 报错，这里只返回空
    }
    return [];
  }

  /**
   * 分离运行时 torch 侧真实可用设备（结果缓存，只探一次）。
   * Roformer / Demucs 走 torch，与 ONNX provider 无关：macOS 上 ONNX 固定 CPU，
   * 但 torch 是 MPS，Roformer 仍可硬件加速。探测失败按 cpu 处理，不臆测。
   */
  async torchDevice(): Promise<'cuda' | 'mps' | 'cpu'> {
    if (this.torchDeviceCache) return this.torchDeviceCache;
    try {
      const handle = runProcess({
        command: this.paths.uvrPython,
        args: ['-c',
          'import torch\n'
          + 'if torch.cuda.is_available():\n'
          + '    print("cuda")\n'
          + 'elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():\n'
          + '    print("mps")\n'
          + 'else:\n'
          + '    print("cpu")\n'],
        timeoutMs: 60_000,
      });
      const r = await handle.wait();
      if (r.code === 0) {
        const out = r.stdout.trim().toLowerCase();
        this.torchDeviceCache = out === 'cuda' ? 'cuda' : out === 'mps' ? 'mps' : 'cpu';
        return this.torchDeviceCache;
      }
    } catch {
      // 运行时缺失 / Python 不可执行：按 CPU 处理
    }
    return 'cpu';
  }

  /** 终止当前活动子进程树（UVR 分离 / 伴奏解码）。编排层取消任务时调用。 */
  cancel(): void {
    this.active?.terminate();
  }

  /** 取出并清空 importFile 累积的可读提示；不调用则零影响。 */
  drainNotices(): string[] {
    const out = this.notices.slice();
    this.notices.length = 0;
    return out;
  }

  private pushNotice(msg: string): void {
    this.notices.push(msg);
    if (this.paths.logLevel === 'info' || this.paths.logLevel === 'warn') {
      console.warn(`[伴奏来源] ${msg}`);
    }
  }

  /**
   * 启动前自检：只做存在性 / 可执行性检查，不启动 UVR 推理
   * （首次模型加载可能 5–10 分钟，不应在自检阶段阻塞）。
   */
  async selfTest(): Promise<{ ok: boolean; reason?: string }> {
    const problems: string[] = [];
    const separatorScript = this.paths.uvrSeparatorScript;
    const hasSeparator = separatorScript !== '' && (await isFile(separatorScript));

    if (hasSeparator) {
      // 可脚本化后端：只需 Python 解释器 + 启动垫片 + 模型目录
      if (!(await isExecutable(this.paths.uvrPython))) {
        problems.push(`Python 解释器不可执行（${this.paths.uvrPython}）`);
      }
      if (!(await isDirectory(this.paths.modelDir))) {
        problems.push(`模型目录不存在（${this.paths.modelDir}）`);
      }
    } else {
      if (!(await isDirectory(this.paths.uvrRoot))) {
        problems.push(`UVR 根目录不存在（${this.paths.uvrRoot}）`);
      }
      const uvrScript = path.join(this.paths.uvrRoot, 'UVR.py');
      if (!(await isFile(uvrScript))) {
        problems.push(`未找到 UVR.py（${uvrScript}）`);
      }
      // uvrPython 期望为 Python 解释器的绝对路径（由 ConfigService 启动时校验）
      if (!(await isExecutable(this.paths.uvrPython))) {
        problems.push(`Python 解释器不可执行（${this.paths.uvrPython}）`);
      }
      if (!(await isDirectory(this.paths.modelDir))) {
        problems.push(`模型目录不存在（${this.paths.modelDir}）`);
      }
    }

    if (problems.length > 0) {
      return {
        ok: false,
        reason: `UVR 自检未通过：${problems.join('；')}。可改用「导入官方伴奏」继续。`,
      };
    }
    return { ok: true };
  }

  /**
   * UVR 分离：以 CLI 为唯一集成面，禁止 import UVR 内部模块。
   * 产物文件名不硬编码，扫描 workDir 后按音频探测定位 Instrumental 产物。
   */
  async separate(
    originalWav: string,
    workDir: string,
    backend: BackendDecision,
    model: string,
  ): Promise<string> {
    const refProbe = await probeAudio(this.paths.ffprobePath, originalWav);
    const inputAbs = path.resolve(originalWav);
    // 输出目录必须先存在：分离 CLI 会直接写入该目录，且进程 cwd 也指向它
    await fs.promises.mkdir(workDir, { recursive: true });

    // -g：CPU 用 -1；cuda / mps / directml 用 0（§10.2）
    const gpuFlag = backend.separationBackend === 'cpu' ? '-1' : '0';
    // 模型名由编排层传入（用户可选），为空则回退随包默认模型；不硬编码具体模型
    const modelName = model.trim() !== '' ? model : this.paths.modelName;

    // 分离后端二选一：随包 CLI 垫片（audio-separator，可脚本化）优先；
    // 未配置时回退 UVR.py 图形入口的 CLI 参数（保留兼容，不做 import 耦合）。
    const separatorScript = this.paths.uvrSeparatorScript;
    const useSeparatorCli = separatorScript !== '' && (await isFile(separatorScript));

    const args = useSeparatorCli
      ? [
          separatorScript,
          originalWav,
          '-m', toModelFile(modelName),
          '--output_dir', workDir,
          '--single_stem', 'Instrumental',
          '--output_format', 'WAV',
          '--model_file_dir', this.paths.modelDir,
        ]
      : [
          path.join(this.paths.uvrRoot, 'UVR.py'),
          '-i', originalWav,
          '-o', workDir,
          '-m', modelName,
          '-v', 'Vocals',
          '-i_stem', 'Instrumental',
          '-g', gpuFlag,
        ];

    let lastPercent: number | null = null;
    const report = (s: string): void => {
      const pct = parseProgress(s);
      if (pct !== null && (lastPercent === null || pct >= lastPercent)) {
        lastPercent = pct;
        this.onProgress?.(pct, '正在生成伴奏');
      }
    };

    // 分离 CLI 启动时会用裸命令 `ffmpeg -version` 探测依赖；GUI 应用由 LaunchServices
    // 启动，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，随包 ffmpeg 不在其中，会直接 exit 1。
    // 因此显式把随包 ffmpeg 目录前置到 PATH，并给 pydub 指定 FFMPEG_BINARY。
    const ffmpegDir = path.dirname(this.paths.ffmpegPath);
    const separatorEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [ffmpegDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      FFMPEG_BINARY: this.paths.ffmpegPath,
      FFPROBE_BINARY: this.paths.ffprobePath,
    };

    const handle = runProcess({
      command: this.paths.uvrPython,
      args,
      cwd: useSeparatorCli ? workDir : this.paths.uvrRoot,
      env: useSeparatorCli ? separatorEnv : undefined,
      timeoutMs: UVR_SEPARATE_TIMEOUT_MS,
      onStdout: report,
      // audio-separator 的 tqdm 进度条输出在 stderr
      onStderr: useSeparatorCli ? report : undefined,
    });
    this.active = handle;
    let result: ProcResult;
    try {
      result = await handle.wait();
    } finally {
      if (this.active === handle) this.active = undefined;
    }

    const logs = trimLog(`${result.stderr}\n${result.stdout}`);

    // 分类优先级：取消 → OOM（stderr 特征）→ 超时 / 非零退出 / 启动失败 → 无产物
    if (result.cancelled) {
      throw new AccompanimentError({ code: 'E_CANCELLED', message: '伴奏分离已取消' });
    }
    if (hasOom(logs)) {
      throw new AccompanimentError({
        code: 'E_UVR_OOM',
        message: '显存或内存不足导致 UVR 分离失败；可改用 CPU 模式或导入官方伴奏',
        cause: logs,
      });
    }
    if (result.timedOut || result.code !== 0) {
      throw new AccompanimentError({
        code: 'E_UVR_FAILED',
        message: result.timedOut
          ? 'UVR 分离超时，请重试或导入官方伴奏'
          : `UVR 分离进程异常退出（退出码 ${result.code ?? '未知'}）`,
        cause: logs,
      });
    }

    let found = await this.locateInstrumental(workDir, inputAbs, refProbe.durationSec);
    if (found === null) {
      // 进程退出不代表文件已完全落盘：短暂轮询，避免把「正在写」误判成「未产出」
      for (let attempt = 0; attempt < OUTPUT_WAIT_ATTEMPTS && found === null; attempt += 1) {
        await new Promise((r) => setTimeout(r, OUTPUT_WAIT_INTERVAL_MS));
        found = await this.locateInstrumental(workDir, inputAbs, refProbe.durationSec);
      }
    }
    if (found === null) {
      throw new AccompanimentError({
        code: 'E_UVR_NO_OUTPUT',
        message: 'UVR 未产出伴奏文件，请重试或导入官方伴奏',
        cause: logs,
      });
    }
    return found;
  }

  /** 扫描 workDir，按音频扩展名 + ffprobe 探测 + stem 名称提示定位 Instrumental 产物。 */
  private async locateInstrumental(
    workDir: string,
    inputAbs: string,
    refDurationSec: number,
  ): Promise<string | null> {
    const files = await listFiles(workDir, MAX_SCAN_DEPTH);
    const cands: Candidate[] = [];
    for (const p of files) {
      const abs = path.resolve(p);
      if (abs === inputAbs) continue; // 排除输入 original.wav
      if (!AUDIO_FILE_EXTENSIONS.has(path.extname(p).toLowerCase())) continue;
      const probe = await probeAudio(this.paths.ffprobePath, p);
      if (!probe.ok || !probe.hasAudio || probe.durationSec <= 0) continue;
      let mtime = 0;
      try { mtime = (await fs.promises.stat(p)).mtimeMs; } catch { /* 忽略取时间失败 */ }
      const name = path.basename(p);
      const inst = INSTRUMENTAL_HINT.test(name);
      const vocal = VOCAL_HINT.test(name);
      cands.push({
        p,
        mtime,
        durationSec: probe.durationSec,
        instrumental: inst && !vocal,
        vocal: vocal && !inst,
      });
    }
    if (cands.length === 0) return null;

    const dist = (c: Candidate): number =>
      refDurationSec > 0 ? Math.abs(c.durationSec - refDurationSec) : Number.MAX_SAFE_INTEGER;
    const prefer = (a: Candidate, b: Candidate): number =>
      dist(a) - dist(b) || b.mtime - a.mtime || a.p.localeCompare(b.p);

    // 优先取带 Instrumental stem 提示的产物（-i_stem 由本层指定，非硬编码具体文件名）
    const inst = cands.filter((c) => c.instrumental).sort(prefer);
    if (inst.length > 0) {
      if (refDurationSec > 0 && dist(inst[0]) > DURATION_MATCH_TOL_SEC) {
        this.pushNotice('UVR 伴奏产物时长与原唱差异较大，建议试听确认');
      }
      return inst[0].p;
    }

    // 名称无 stem 提示：排除人声产物后，按音频探测（时长接近 + 较新）选取
    const neutral = cands.filter((c) => !c.vocal).sort(prefer);
    if (neutral.length > 0) {
      this.pushNotice('UVR 产物名称未标明伴奏，已按音频探测（时长 / 文件时间）选取，建议试听确认');
      return neutral[0].p;
    }
    // 只剩人声产物，视为无伴奏产物
    return null;
  }

  /**
   * 导入官方伴奏（一等输入）：ffprobe 校验 → 解码 PCM → 质量校验 → 与源比对。
   * 禁止自动变速对齐（由 ALIGN 阶段统一规格）；时长差异只给可读提示，由编排层决定是否确认。
   */
  async importFile(filePath: string, originalWav: string, workDir: string): Promise<string> {
    const warnings: string[] = [];

    const srcProbe = await probeAudio(this.paths.ffprobePath, filePath);
    if (!srcProbe.ok || !srcProbe.hasAudio) {
      throw new AccompanimentError({
        code: 'E_ACCOMPANIMENT_IMPORT_INVALID',
        message: '导入的伴奏文件无法解析或不含音频，请更换文件，或改用 UVR 生成伴奏',
        cause: srcProbe.errors,
      });
    }

    const refProbe = await probeAudio(this.paths.ffprobePath, originalWav);
    const targetRate = refProbe.sampleRate > 0 ? refProbe.sampleRate : DEFAULTS.audioSampleRate;
    const targetChannels = refProbe.channels > 0 ? refProbe.channels : DEFAULTS.audioChannels;
    const outPath = path.join(workDir, IMPORTED_WAV_NAME);

    // 解码为统一规格 PCM WAV；不依赖扩展名，不做变速 / 拉伸
    const handle = startDecode({
      ffmpegPath: this.paths.ffmpegPath,
      input: filePath,
      output: outPath,
      sampleRate: targetRate,
      channels: targetChannels,
    });
    this.active = handle;
    let dec: ProcResult;
    try {
      dec = await handle.wait();
    } finally {
      if (this.active === handle) this.active = undefined;
    }
    if (dec.cancelled) {
      throw new AccompanimentError({ code: 'E_CANCELLED', message: '伴奏导入已取消' });
    }
    if (dec.timedOut || dec.code !== 0) {
      throw new AccompanimentError({
        code: 'E_ACCOMPANIMENT_IMPORT_INVALID',
        message: '无法把导入的伴奏解码为 PCM，请确认文件未损坏、未加密后重试',
        cause: trimLog(dec.stderr),
      });
    }

    // 质量校验：削波 / 直流偏移 / 静音检测
    let importBuf: Buffer;
    try {
      importBuf = await fs.promises.readFile(outPath);
    } catch {
      throw new AccompanimentError({
        code: 'E_ACCOMPANIMENT_IMPORT_INVALID',
        message: '伴奏解码结果缺失，请重试或改用 UVR 生成伴奏',
      });
    }
    const impPcm = parseWav(importBuf);
    if (impPcm === null) {
      warnings.push('解码后的 PCM 无法解析，已跳过削波 / 直流偏移 / 静音检测');
    } else {
      const q = analysePcm(impPcm);
      if (q.silent) warnings.push('导入的伴奏整体接近静音，请确认文件是否正确');
      if (q.clipped) {
        warnings.push(`导入的伴奏疑似削波（峰值 ${q.peakDb.toFixed(1)} dBFS，满幅样本占比 ${(q.clipRatio * 100).toFixed(2)}%），可能影响听感`);
      }
      if (q.dcShifted) {
        warnings.push(`导入的伴奏存在明显直流偏移（${(q.dcOffset * 100).toFixed(2)}%）`);
      }
    }

    // 与源音轨完全相同（误导入原唱）→ 告警并拒绝导入
    const refBuf = await fs.promises.readFile(originalWav).catch(() => null as Buffer | null);
    const refPcm = refBuf !== null ? parseWav(refBuf) : null;
    if (impPcm !== null && refPcm !== null) {
      const a = impPcm.buffer.subarray(impPcm.dataOffset, impPcm.dataOffset + impPcm.dataLength);
      const b = refPcm.buffer.subarray(refPcm.dataOffset, refPcm.dataOffset + refPcm.dataLength);
      let same = a.length === b.length && a.equals(b);
      if (!same) {
        const corr = correlation(impPcm, refPcm);
        same = corr !== null && corr >= SAME_AUDIO_CORRELATION;
      }
      if (same) {
        throw new AccompanimentError({
          code: 'E_ACCOMPANIMENT_IMPORT_INVALID',
          message: '导入的文件与源原唱音轨内容相同（可能误选了原唱文件），已拒绝导入；请更换伴奏文件或改用 UVR 生成伴奏',
        });
      }
    }

    // 时长差异超过阈值：给出「可能不是同一版本」的可读提示，由编排层决定是否等待确认
    let durationMismatch = false;
    if (refProbe.durationSec > 0 && srcProbe.durationSec > 0) {
      const diff = Math.abs(srcProbe.durationSec - refProbe.durationSec);
      if (diff > DEFAULTS.accompanimentDurationDiffSec) {
        durationMismatch = true;
        warnings.push(`伴奏与视频时长差异较大（约 ${diff.toFixed(1)} 秒），可能不是同一版本，请确认`);
      }
    } else {
      warnings.push('无法取得源或伴奏的时长，已跳过时长一致性提示');
    }

    for (const w of warnings) this.pushNotice(w);

    if (durationMismatch) {
      // notice 型异常：不是硬失败；产物已生成在 outputPath，编排层可决定是否等待用户确认
      throw new AccompanimentError({
        notice: true,
        message: '伴奏与视频时长差异较大，可能不是同一版本，请确认是否继续',
        outputPath: outPath,
        warnings,
      });
    }
    return outPath;
  }
}

export { AccompanimentError } from './errors';
