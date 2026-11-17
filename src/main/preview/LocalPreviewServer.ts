/**
 * 本地预览 HTTP 服务：仅绑 127.0.0.1、随机端口、一次性 token、URL 不含绝对路径。
 * HLS 模式动态生成含两条 audio rendition 的 master playlist，并代理经 token 校验的切片；
 * direct 模式以字节流（支持 Range）提供源文件，供 Chromium 直接解码。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { DEFAULTS, type AudioTrack } from '../../shared/contracts';
import { errText, logPreview } from './log';

export interface LocalPreviewServerOptions {
  mode: 'hls' | 'direct';
  sessionId?: string; // 与 PreviewSession 共用，避免日志里出现两个会话号
  audioTracks: AudioTrack[];
  workDir?: string;       // hls：FFmpeg 切片目录
  directPath?: string;    // direct：源文件绝对路径（仅内存，不出现在 URL / 日志）
  onAccess: () => void;   // 合法请求 → 刷新空闲 TTL
}

const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

export class LocalPreviewServer {
  readonly sessionId: string;
  readonly token = randomBytes(24).toString('hex');
  readonly host = DEFAULTS.previewBindHost;
  port = 0;
  private server: http.Server | null = null;
  private readonly opts: LocalPreviewServerOptions;

  constructor(opts: LocalPreviewServerOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId ?? randomUUID();
  }

  /** 端口传 0 由系统分配随机端口；显式绑定 IPv4 回环，绝不绑定 0.0.0.0。 */
  async listen(): Promise<number> {
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      server.listen(0, DEFAULTS.previewBindHost, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('无法获取本地监听端口');
    this.port = addr.port;
    logPreview('info', 'preview.server.listening', {
      sessionId: this.sessionId, host: this.host, port: this.port, mode: this.opts.mode,
    });
    return this.port;
  }

  /** 对外 URL：仅 host:port + 相对资源 + token，绝不含文件系统绝对路径。 */
  urlFor(resource: string): string {
    return `http://${this.host}:${this.port}/${resource}?token=${this.token}`;
  }

  masterUrl(): string {
    return this.urlFor('master.m3u8');
  }

  sourceUrl(): string {
    const ext = path.extname(this.opts.directPath ?? '').toLowerCase();
    return this.urlFor(`source${ext in MIME ? ext : '.mp4'}`);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private tokenValid(given: string | null): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let resource = '';
    try {
      const u = new URL(req.url ?? '/', `http://${this.host}`);
      if (!this.tokenValid(u.searchParams.get('token'))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        logPreview('warn', 'preview.server.unauthorized', { sessionId: this.sessionId });
        return;
      }
      this.opts.onAccess();
      resource = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      if (this.opts.mode === 'hls') await this.serveHls(resource, res);
      else await this.serveDirect(resource, req, res);
    } catch (err) {
      logPreview('error', 'preview.server.error', { sessionId: this.sessionId, resource, cause: errText(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  private async serveHls(resource: string, res: http.ServerResponse): Promise<void> {
    if (resource === 'master.m3u8') {
      res.writeHead(200, { 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' });
      res.end(this.buildMasterPlaylist());
      return;
    }
    const playlistMap: Record<string, string> = {
      'video.m3u8': 'pl_0.m3u8',
      'audio-original.m3u8': 'pl_1.m3u8',
      'audio-accompaniment.m3u8': 'pl_2.m3u8',
    };
    const mapped: string | undefined = playlistMap[resource];
    const isPlaylist = mapped !== undefined;
    let diskName = mapped ?? '';
    if (!isPlaylist) {
      // 切片：仅允许工作目录内、文件名白名单，杜绝目录穿越
      if (!/^seg_\d+_\d+\.(ts|m4s)$/.test(resource)) {
        res.writeHead(404); res.end(); return;
      }
      diskName = resource;
    }
    const filePath = path.join(this.opts.workDir ?? '', diskName);
    const data = await fs.promises.readFile(filePath).catch(() => null);
    if (!data) {
      res.writeHead(404); res.end(); return;
    }
    if (isPlaylist) {
      res.writeHead(200, { 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' });
      res.end(this.appendTokenToPlaylist(data.toString('utf8')));
    } else {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resource)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    }
  }

  /**
   * 给 FFmpeg media playlist 的每个 URI 行追加 token，保证切片请求同样鉴权。
   * FFmpeg 在 -hls_segment_filename 为绝对路径时可能把绝对路径写进 playlist，
   * 这里统一压成纯文件名：既避免 URL 暴露文件系统路径，也保证命中切片白名单路由。
   */
  private appendTokenToPlaylist(text: string): string {
    return text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const name = t.split(/[?#]/)[0].split(/[\\/]/).pop() ?? t;
      return `${name}?token=${this.token}`;
    }).join('\n');
  }

  /** master playlist：一条视频 variant + 两条 audio rendition；切轨只换音频、不重载视频。 */
  private buildMasterPlaylist(): string {
    const q = `token=${this.token}`;
    const hasAccomp = this.opts.audioTracks.includes('accompaniment');
    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="原唱",LANGUAGE="zho",DEFAULT=YES,AUTOSELECT=YES,URI="audio-original.m3u8?${q}"`,
    ];
    if (hasAccomp) {
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="伴奏",LANGUAGE="zho",DEFAULT=NO,AUTOSELECT=NO,URI="audio-accompaniment.m3u8?${q}"`);
    }
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42E01E,mp4a.40.2",AUDIO="aud"');
    lines.push(`video.m3u8?${q}`);
    return `${lines.join('\n')}\n`;
  }

  private async serveDirect(resource: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const src = this.opts.directPath;
    const ext = path.extname(resource).toLowerCase();
    if (!src || !/^source\.[a-z0-9]+$/.test(resource)) {
      res.writeHead(404); res.end(); return;
    }
    const stat = await fs.promises.stat(src).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const mime = MIME[ext] ?? 'application/octet-stream';
    const rangeHeader = req.headers.range;
    const match = rangeHeader ? /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(src, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(src).pipe(res);
  }
}
