/**
 * 伴奏来源层的子进程与媒体工具封装。
 * 全部以 argv 数组 spawn（不启用 shell），路径支持中文 / 空格 / UNC。
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** ffprobe / ffmpeg 短命令超时（毫秒） */
export const PROBE_TIMEOUT_MS = 15_000;
export const DECODE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ProcHandle {
  readonly pid: number | undefined;
  /** 终止整个子进程树（POSIX 进程组 / Windows taskkill /T） */
  terminate(): void;
  /** 等待进程结束并取回完整输出 */
  wait(): Promise<ProcResult>;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** 显式环境变量；不传则继承当前进程。子工具若用裸命令名探测（如 ffmpeg），必须在此补 PATH。 */
  env?: NodeJS.ProcessEnv;
  /** 超时后自动终止进程树；<=0 或不传表示不超时 */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** 终止进程树：POSIX 用负 pid 杀进程组，Windows 用 taskkill /T /F。 */
function terminateTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try { child.kill(); } catch { /* 进程已退出 */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try { child.kill(); } catch { /* 进程已退出 */ }
      });
    } catch {
      try { child.kill(); } catch { /* 进程已退出 */ }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* 进程已退出 */ }
  }
  // 给 2 秒优雅退出，再强杀整个进程组，避免残留孙进程
  const force = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程已退出 */ }
  }, 2000);
  force.unref();
}

/** 启动子进程；返回句柄，可 terminate() 取消、wait() 取结果。 */
export function runProcess(opts: RunOptions): ProcHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 独立进程组是「终止整个子进程树」的前提
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let resolveWait!: (r: ProcResult) => void;
  const done = new Promise<ProcResult>((resolve) => { resolveWait = resolve; });

  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stdout += s;
    opts.onStdout?.(s);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stderr += s;
    opts.onStderr?.(s);
  });

  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
    }, opts.timeoutMs);
    timer.unref();
  }

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveWait({ code, signal, stdout, stderr, timedOut, cancelled });
  };

  // spawn 失败（可执行不存在 / cwd 不存在等）以 -1 退出码结束；close 与 error 可能都触发，finish 幂等
  child.on('error', (e: Error) => {
    stderr += `\n[进程启动失败] ${e.message}`;
    finish(-1, null);
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

  return {
    pid: child.pid,
    wait: () => done,
    terminate: () => {
      cancelled = true;
      terminateTree(child);
    },
  };
}

export interface AudioProbe {
  /** ffprobe 是否成功解析出 JSON */
  ok: boolean;
  /** 是否含音频流 */
  hasAudio: boolean;
  durationSec: number;
  sampleRate: number;
  channels: number;
  errors: string;
}

/** ffprobe -of json 解析；失败 / 超时 / 无音频都返回结构化结果，不抛异常。 */
export async function probeAudio(ffprobePath: string, filePath: string): Promise<AudioProbe> {
  const handle = runProcess({
    command: ffprobePath,
    args: [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels',
      '-of', 'json',
      filePath,
    ],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const r = await handle.wait();
  const base: AudioProbe = {
    ok: false,
    hasAudio: false,
    durationSec: 0,
    sampleRate: 0,
    channels: 0,
    errors: r.stderr,
  };
  if (r.cancelled || r.timedOut || r.code !== 0) return base;
  try {
    const parsed = JSON.parse(r.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; sample_rate?: string | number; channels?: number }>;
    };
    const dur = Number(parsed.format?.duration ?? '');
    const durationSec = Number.isFinite(dur) && dur > 0 ? dur : 0;
    const audio = (parsed.streams ?? []).filter((s) => s.codec_type === 'audio');
    const first = audio[0];
    if (!first) return { ...base, ok: true, durationSec };
    const sampleRate = Number(first.sample_rate ?? '') || 0;
    const channels = Number(first.channels ?? '') || 0;
    return {
      ok: true,
      hasAudio: true,
      durationSec,
      sampleRate,
      channels,
      errors: r.stderr,
    };
  } catch {
    // JSON 解析失败视为探测失败
    return base;
  }
}

export interface DecodeOptions {
  ffmpegPath: string;
  input: string;
  output: string;
  sampleRate: number;
  channels: number;
  timeoutMs?: number;
}

/** 启动「ffmpeg 解码为 PCM WAV」；返回句柄供调用方接入取消。 */
export function startDecode(opts: DecodeOptions): ProcHandle {
  const args: string[] = [
    '-y', '-v', 'error',
    '-i', opts.input,
    '-vn',
    '-map', '0:a:0',
  ];
  if (opts.sampleRate > 0) args.push('-ar', String(opts.sampleRate));
  if (opts.channels > 0) args.push('-ac', String(opts.channels));
  // 固定 16-bit PCM；不做变速 / 拉伸（禁止 atempo）
  args.push('-c:a', 'pcm_s16le', opts.output);
  return runProcess({
    command: opts.ffmpegPath,
    args,
    timeoutMs: opts.timeoutMs ?? DECODE_TIMEOUT_MS,
  });
}
