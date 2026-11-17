/**
 * 预览降级链与降级决策（设计文档 §5.5 / §7.7）。
 * 代理转码失败 → 直解（本地字节流）→ 系统播放器；每一级都写原因码、留日志、不弹窗。
 */
import { spawn } from 'node:child_process';
import { logPreview } from './log';

export const PREVIEW_REASON = {
  PROXY_FAILED: 'E_PREVIEW_PROXY',
  DIRECT: 'E_PREVIEW_PROXY_DIRECT',
  SYSTEM: 'E_PREVIEW_PROXY_SYSTEM',
} as const;

export type FallbackLevel = 'direct' | 'system';

export interface FallbackDecision {
  sessionId: string;
  jobId: string;
  level: FallbackLevel;
  reasonCode: string;
  reasonText: string;     // 日志 / 详情（中文，含技术原因）
  userMessage: string;    // 状态行一行文案（中文，平实无术语）
  action: 'retry-proxy' | 'open-system-player';
  systemOpenPath?: string; // 供编排层用 Electron shell.openPath；不出现在 URL / 日志
}

export function makeDirectDecision(sessionId: string, jobId: string, cause: string): FallbackDecision {
  return {
    sessionId, jobId, level: 'direct',
    reasonCode: PREVIEW_REASON.DIRECT,
    reasonText: `HLS 代理转码失败（${cause}），源文件为 H.264 + 可直解音频，已改用本地字节流原生播放；音轨切换能力受限`,
    userMessage: '预览已改用简化模式',
    action: 'retry-proxy',
  };
}

export function makeSystemDecision(sessionId: string, jobId: string, cause: string, systemOpenPath: string): FallbackDecision {
  return {
    sessionId, jobId, level: 'system',
    reasonCode: PREVIEW_REASON.SYSTEM,
    reasonText: `HLS 代理与直解均不可用（${cause}），已改用系统播放器打开原文件`,
    userMessage: '预览已改用系统播放器',
    action: 'open-system-player',
    systemOpenPath,
  };
}

/**
 * 直解（原生 <video>）依赖 Chromium 自带解码能力。
 * H.264 各平台通用；HEVC 依赖平台硬解（Apple Silicon / 部分 Windows GPU），
 * 由调用方按运行环境扩展白名单，不能一律假设可用。
 */
const DIRECT_VIDEO = new Set(['h264', 'avc1']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le']);

export interface MediaCodecs {
  video: string;
  audio: string;
}

/**
 * 仅当视频 H.264 且音频为 Chromium 可解编码时才允许直解；
 * HEVC / DTS / AC3 等一律返回 false，让降级链继续走系统播放器，避免「播不了或有画面没声音」。
 */
export function isDirectPlayable(
  c: MediaCodecs,
  allowVideo: ReadonlySet<string> = DIRECT_VIDEO,
): boolean {
  const video = c.video.toLowerCase();
  const audio = c.audio.toLowerCase();
  return allowVideo.has(video) && (audio === '' || DIRECT_AUDIO.has(audio));
}

/** 一次 ffprobe 读出首个视频流与首个音频流的编码名。 */
export function probeMediaCodecs(ffprobePath: string, filePath: string): Promise<MediaCodecs> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json', filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('ffprobe 超时')));
    }, 5000);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      finish(() => reject(new Error('ffprobe 无法启动')));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(() => reject(new Error(err.trim() || `ffprobe 退出码 ${code}`)));
        return;
      }
      finish(() => {
        try {
          const parsed = JSON.parse(out) as {
            streams?: Array<{ codec_type?: string; codec_name?: string }>;
          };
          const codecs: MediaCodecs = { video: '', audio: '' };
          for (const s of parsed.streams ?? []) {
            if (s.codec_type === 'video' && !codecs.video) codecs.video = s.codec_name ?? '';
            else if (s.codec_type === 'audio' && !codecs.audio) codecs.audio = s.codec_name ?? '';
          }
          resolve(codecs);
        } catch {
          reject(new Error('ffprobe 输出无法解析'));
        }
      });
    });
  });
}

/** 尽力调用系统播放器打开原文件（argv 数组，无 shell 字符串拼接）；失败只记日志。 */
export function openInSystemPlayer(platform: NodeJS.Platform, filePath: string): void {
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open'; args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', filePath];
  } else {
    cmd = 'xdg-open'; args = [filePath];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      logPreview('warn', 'preview.system.open.failed', { reasonCode: PREVIEW_REASON.SYSTEM });
    });
    child.unref();
  } catch {
    logPreview('warn', 'preview.system.open.failed', { reasonCode: PREVIEW_REASON.SYSTEM });
  }
}
