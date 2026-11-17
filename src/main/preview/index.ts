/**
 * PreviewPort 适配实现：本地 HLS 多音轨代理 + 降级链。
 * 每个预览会话独占一个 127.0.0.1 随机端口的 HTTP 服务与一次性 token；
 * 切换预览对象 / 关闭页面 / 任务完成或取消 / 空闲 TTL 都会停止 FFmpeg 并清理切片。
 */
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DEFAULTS,
  type AudioTrack,
  type BackendDecision,
  type PreviewPort,
  type PreviewRequest,
  type PreviewSession,
  type RuntimePaths,
} from '../../shared/contracts';
import { LocalPreviewServer } from './LocalPreviewServer';
import { PreviewTranscoder } from './PreviewTranscoder';
import {
  PREVIEW_REASON,
  makeDirectDecision,
  makeSystemDecision,
  openInSystemPlayer,
  isDirectPlayable,
  probeMediaCodecs,
  type FallbackDecision,
} from './fallback';
import { errText, logPreview, setPreviewLogger, type ModuleLogSink } from './log';

/** 降级事件名：编排层可监听它把一行文案推到状态行 / 详情（不弹窗）。 */
export const PREVIEW_FALLBACK_EVENT = 'preview:fallback';
export type { FallbackDecision };

interface SessionEntry {
  session: PreviewSession;
  server: LocalPreviewServer;
  transcoder?: PreviewTranscoder;
  workDir: string;
  jobId: string;
  lastAccessAt: number;
}

export class PreviewService extends EventEmitter implements PreviewPort {
  /** 降级到系统播放器时是否自动调用系统默认播放器；编排层可关闭并改用 Electron shell.openPath。 */
  autoOpenSystemPlayer = true;

  private readonly paths: RuntimePaths;
  private readonly cacheRoot: string;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly jobToSession = new Map<string, string>();
  private readonly fallbacks = new Map<string, FallbackDecision>();
  private readonly ttlTimer: NodeJS.Timeout;

  constructor(paths: RuntimePaths) {
    super();
    this.paths = paths;
    this.cacheRoot = path.join(paths.cacheDir, 'preview');
    // 空闲 TTL 巡检；unref 避免阻止进程退出
    this.ttlTimer = setInterval(() => { void this.sweep(); }, Math.min(30_000, DEFAULTS.previewIdleTtlMs));
    this.ttlTimer.unref?.();
  }

  /** 供编排层注入统一 Logger（日志留痕进 app.log 与 IPC.event.log）。 */
  setLogger(logger: ModuleLogSink | null): void {
    setPreviewLogger(logger);
  }

  /** 查询某会话的降级决策（信息可达：返回值 / 事件 / 本方法三重）。 */
  getFallback(sessionId: string): FallbackDecision | undefined {
    return this.fallbacks.get(sessionId);
  }

  async start(request: PreviewRequest, backend: BackendDecision): Promise<PreviewSession> {
    // 切换预览对象：同一 job 的旧会话先停，避免两份转码争抢资源（与主管线错峰）
    const previous = this.jobToSession.get(request.jobId);
    if (previous) await this.stop(previous);

    const sessionId = randomUUID();
    const workDir = path.join(this.cacheRoot, sessionId);
    const tracks = normalizeTracks(request.audioTracks);
    const targetPath = request.source === 'output'
      ? (request.outputPath ?? request.inputPath)
      : request.inputPath;

    // ── 方案 0：输入预览直接播源 ────────────────────────────────
    // 输入只有原唱一条音轨，不需要 rendition 切换；能直解就直放，
    // 免掉整段 HLS 转码的等待与 CPU 占用。
    if (request.source === 'input' && tracks.length <= 1) {
      const direct = await this.tryDirect(request, sessionId, targetPath, tracks, workDir, false);
      if (direct) {
        logPreview('info', 'preview.direct.started', {
          sessionId, jobId: request.jobId, source: request.source, path: targetPath,
        });
        return direct;
      }
      logPreview('info', 'preview.direct.skipped_fallback_hls', { sessionId, jobId: request.jobId });
    }

    await fsp.mkdir(workDir, { recursive: true });

    // ── 方案 A：HLS 代理 ──────────────────────────────────────
    try {
      const transcoder = new PreviewTranscoder({
        ffmpegPath: this.paths.ffmpegPath,
        inputPath: targetPath,
        workDir,
        audioTracks: tracks,
        backend,
      });
      await transcoder.start();
      const server = new LocalPreviewServer({
        mode: 'hls', sessionId, workDir, audioTracks: tracks,
        onAccess: () => this.touch(sessionId),
      });
      await server.listen();
      const session = this.makeSession(server, false);
      this.register({ session, server, transcoder, workDir, jobId: request.jobId, lastAccessAt: Date.now() });
      logPreview('info', 'preview.proxy.started', {
        sessionId, jobId: request.jobId, source: request.source,
        segmentSec: DEFAULTS.previewSegmentSec, tracks: tracks.join(','),
      });
      return session;
    } catch (proxyErr) {
      logPreview('warn', 'preview.proxy.failed', {
        sessionId, jobId: request.jobId, reasonCode: PREVIEW_REASON.PROXY_FAILED, cause: errText(proxyErr),
      });
      await this.cleanDir(workDir); // 清掉代理残留切片
    }

    // ── 方案 B：直解 ────────────────────────────────────────────
    // 只有输入预览可以接受直放：输出预览要切「原唱/伴奏」，而直放只有容器默认的一条
    // 音轨，静默降级会让用户以为「音轨按钮坏了」。输出预览失败就交给系统播放器。
    if (request.source === 'input') {
      const direct = await this.tryDirect(request, sessionId, targetPath, tracks, workDir);
      if (direct) return direct;
    }

    // ── 兜底：系统播放器 ──────────────────────────────────────
    return this.fallbackToSystem(request, sessionId, targetPath);
  }

  /**
   * 直放会话。asFallback=true 表示「HLS 失败后的降级」，需要记降级决策并告知用户；
   * false 表示「首选直放」（输入预览），属正常路径，不产生降级提示。
   */
  private async tryDirect(
    request: PreviewRequest,
    sessionId: string,
    targetPath: string,
    tracks: AudioTrack[],
    workDir: string,
    asFallback = true,
  ): Promise<PreviewSession | null> {
    try {
      const codecs = await probeMediaCodecs(this.paths.ffprobePath, targetPath);
      if (!isDirectPlayable(codecs, this.directVideoWhitelist())) {
        logPreview('info', 'preview.direct.skipped', { sessionId, video: codecs.video, audio: codecs.audio });
        return null;
      }
      const { server, session } = await this.startDirectServer(sessionId, targetPath, tracks);
      this.register({ session, server, workDir, jobId: request.jobId, lastAccessAt: Date.now() });
      if (asFallback) {
        const decision = makeDirectDecision(sessionId, request.jobId, 'HLS 代理转码失败');
        this.recordFallback(sessionId, decision);
        logPreview('warn', 'preview.degraded', {
          sessionId, jobId: request.jobId, reasonCode: decision.reasonCode,
          level: decision.level, userMessage: decision.userMessage,
        });
      }
      return session;
    } catch (err) {
      logPreview('warn', 'preview.direct.failed', { sessionId, cause: errText(err) });
      return null;
    }
  }

  /**
   * HEVC 直放依赖平台硬解：Apple Silicon 有 VideoToolbox，Chromium 可解；
   * 其他平台保守只用 H.264，避免黑屏无提示。
   */
  private directVideoWhitelist(): Set<string> {
    const set = new Set(['h264', 'avc1']);
    if (this.paths.platform === 'darwin' && this.paths.arch === 'arm64') set.add('hevc');
    return set;
  }

  private fallbackToSystem(
    request: PreviewRequest,
    sessionId: string,
    targetPath: string,
  ): PreviewSession {
    const decision = makeSystemDecision(sessionId, request.jobId, '代理与直解均失败', targetPath);
    this.recordFallback(sessionId, decision);
    logPreview('warn', 'preview.system.fallback', {
      sessionId, jobId: request.jobId, reasonCode: decision.reasonCode,
      userMessage: decision.userMessage,
    });
    // 系统播放器由编排层用 Electron shell.openPath(systemOpenPath) 打开，
    // 或由本模块用 Node spawn 尽力打开（autoOpenSystemPlayer 可关闭）；不弹应用内窗。
    if (this.autoOpenSystemPlayer) openInSystemPlayer(this.paths.platform, targetPath);
    // 应用内不再尝试播放：url 留空让渲染层显示占位，避免把普通文件 URL 交给 HLS.js 误解析。
    // 此级无本地服务 / 子进程 / 切片，无需清理。
    return {
      sessionId, url: '', token: '', host: DEFAULTS.previewBindHost, port: 0,
      expiresAt: Date.now() + DEFAULTS.previewIdleTtlMs,
    };
  }

  private async startDirectServer(
    sessionId: string,
    targetPath: string,
    tracks: AudioTrack[],
  ): Promise<{ server: LocalPreviewServer; session: PreviewSession }> {
    const server = new LocalPreviewServer({
      mode: 'direct', sessionId, audioTracks: tracks, directPath: targetPath,
      onAccess: () => this.touch(sessionId),
    });
    await server.listen();
    return { server, session: this.makeSession(server, true) };
  }

  private recordFallback(sessionId: string, decision: FallbackDecision): void {
    this.fallbacks.set(sessionId, decision);
    // 不弹窗：以事件把一行文案 + 原因码交给编排层（信息可达 + 日志留痕 + 一键展开由 UI 决定）
    this.emit(PREVIEW_FALLBACK_EVENT, decision);
  }

  private makeSession(server: LocalPreviewServer, direct: boolean): PreviewSession {
    return {
      sessionId: server.sessionId,
      url: direct ? server.sourceUrl() : server.masterUrl(),
      token: server.token,
      host: server.host,
      port: server.port,
      expiresAt: Date.now() + DEFAULTS.previewIdleTtlMs,
    };
  }

  private register(entry: SessionEntry): void {
    this.sessions.set(entry.session.sessionId, entry);
    this.jobToSession.set(entry.jobId, entry.session.sessionId);
  }

  private touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.lastAccessAt = Date.now();
    entry.session.expiresAt = Date.now() + DEFAULTS.previewIdleTtlMs;
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    this.fallbacks.delete(sessionId); // 占位会话（系统播放器级）也要能清掉降级记录
    if (!entry) return;
    this.sessions.delete(sessionId);
    if (this.jobToSession.get(entry.jobId) === sessionId) this.jobToSession.delete(entry.jobId);
    if (entry.transcoder) await entry.transcoder.stop();
    await entry.server.close();
    await this.cleanDir(entry.workDir);
    logPreview('info', 'preview.session.stopped', { sessionId });
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastAccessAt >= DEFAULTS.previewIdleTtlMs) {
        logPreview('info', 'preview.idle.reclaimed', { sessionId: id });
        void this.stop(id);
      }
    }
  }

  private async cleanDir(dir: string): Promise<void> {
    if (!dir) return;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 音轨规范化：原唱恒为首条、去重、至少含原唱（对应 a:0）。 */
function normalizeTracks(tracks: AudioTrack[]): AudioTrack[] {
  const set = new Set<AudioTrack>(tracks);
  const out: AudioTrack[] = ['original'];
  if (set.has('accompaniment')) out.push('accompaniment');
  return out;
}
