/**
 * 媒体适配层子进程执行器。
 * - 一律以 argv 数组 spawn，绝不拼接 shell（支持中文 / 空格 / 盘符冒号路径，§5.1 / NFR-08）。
 * - stdout / stderr 限量收集并保留尾部，用于能力列表解析与错误诊断。
 * - 支持 AbortSignal：触发时终止整棵子进程树（POSIX 进程组 / Windows taskkill /T，§8.3）。
 */
import { spawn, type ChildProcess } from 'child_process';
import type { ErrorCode, StageCode } from '../../shared/contracts';
import { makeError } from '../errors/AppError';

export interface RunContext {
  /** 子进程用途（中文，仅写进本地错误细节） */
  label: string;
  stage: StageCode | 'APP';
  errorCode: ErrorCode;
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

interface BufferState {
  len: number;
}

function collect(store: Buffer[], chunk: Buffer, state: BufferState): void {
  store.push(chunk);
  state.len += chunk.length;
  // 超限时丢弃最早的块，始终保留尾部（FFmpeg 报错信息集中在末尾）
  while (state.len > MAX_BUFFER_BYTES && store.length > 1) {
    const dropped = store.shift();
    if (dropped) state.len -= dropped.length;
  }
}

function joinChunks(store: Buffer[], state: BufferState): string {
  return Buffer.concat(store, state.len).toString('utf8');
}

/** 终止整棵子进程树；detached:true 使子进程成为新进程组组长。 */
function terminateChildTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    // 兜底：1.5s 后进程组仍在则强杀，避免残留僵尸进程
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 0);
        process.kill(-pid, 'SIGKILL');
      } catch {
        // 进程组已退出，无需处理
      }
    }, 1500);
    timer.unref();
  } catch {
    child.kill('SIGKILL');
  }
}

export function runProcess(bin: string, args: string[], ctx: RunContext): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(makeError('E_CANCELLED', ctx.stage));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(makeError(ctx.errorCode, ctx.stage, `【${ctx.label}】子进程启动失败：${String(err)}`));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const outState: BufferState = { len: 0 };
    const errState: BufferState = { len: 0 };
    let aborted = false;
    let settled = false;

    const onAbort = (): void => {
      aborted = true;
      terminateChildTree(child);
    };
    const cleanup = (): void => {
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    };
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => collect(outChunks, chunk, outState));
    child.stderr?.on('data', (chunk: Buffer) => collect(errChunks, chunk, errState));

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(makeError(ctx.errorCode, ctx.stage, `【${ctx.label}】子进程异常：${err.message}`));
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = joinChunks(outChunks, outState);
      const stderr = joinChunks(errChunks, errState);
      if (aborted || ctx.signal?.aborted) {
        reject(makeError('E_CANCELLED', ctx.stage));
        return;
      }
      if (code !== 0) {
        reject(makeError(ctx.errorCode, ctx.stage, `【${ctx.label}】退出码 ${String(code)}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/** 解析 ffmpeg -encoders / -filters / -muxers 列表，提取「名称列」集合。 */
const NAME_LINE = /^\s*[.A-Z]{1,8}\s+([A-Za-z0-9_]+)\s/;
export function parseNamedList(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = NAME_LINE.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * 转义 subtitles 滤镜内的文件路径（§6.7 / §10.4）。
 *
 * **必须写两层反斜杠**：`-vf` 的值在 FFmpeg 里被解析两次（先选项值、再滤镜参数值），
 * 单层 `\:` 在第一层就被吃掉，剩下的 `C:` 被当成选项分隔符，结果是
 * `AVFilterGraph: Error parsing a filter description around:` → 整个编码直接失败。
 * 实测（FFmpeg 7.1 Windows）：`C\:/x/a.ass` 失败，`C\\:/x/a.ass` 通过；
 * 含空格/逗号/分号/中文的目录同样只有双层转义能过。
 * POSIX 路径没有盘符冒号，双层转义与否对普通路径完全等价，故统一处理。
 * 空格与中文无需转义——整个 -vf 值作为单个 argv 元素传递，不经过 shell。
 */
export function escapeFilterPath(p: string): string {
  const posix = p.replace(/\\/g, '/');
  // JS 字面量 '\\\\' = 两个反斜杠字符
  const bs = '\\\\';
  return posix
    .replace(/:/g, `${bs}:`)
    .replace(/'/g, `${bs}'`)
    .replace(/\[/g, `${bs}[`)
    .replace(/\]/g, `${bs}]`)
    .replace(/,/g, `${bs},`)
    .replace(/;/g, `${bs};`);
}
