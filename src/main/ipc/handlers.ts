import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync, existsSync, accessSync, mkdirSync, constants as fsConstants } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { z } from 'zod';
import {
  IPC, makeDefaultConfig, normalizeNaming, pruneNaming, type JobConfig, type StageCode,
  type LyricsPayload, type PreviewRequest, type MediaCapabilities,
} from '../../shared/contracts';
import type { HealthResult, LyricsFetchInput } from '../../shared/preload-api';
import type { JobService } from '../jobs/JobService';
import type { PipelineController } from '../jobs/PipelineController';
import type { PipelinePorts } from '../jobs/PipelineController';
import type { Logger } from '../errors/Logger';
import type { ConfigService } from '../config/ConfigService';
import { makeError, toPayload } from '../errors/AppError';

const StageSchema = z.enum(['PROBE', 'EXTRACT', 'LYRICS', 'ACCOMPANIMENT', 'ALIGN', 'ENCODE_MUX', 'VALIDATE']);
const LyricsSchema = z.object({
  enabled: z.boolean(),
  source: z.enum(['online', 'local', 'paste']),
  songLink: z.string().optional(),
  localPath: z.string().optional(),
  pastedText: z.string().optional(),
  version: z.enum(['original', 'translation', 'bilingual']),
  format: z.enum(['lrc', 'srt']),
  offsetMs: z.number().int(),
  burn: z.boolean(),
});
const SubtitleSchema = z.object({
  fontFamily: z.string(), fontSize: z.number(), primaryColor: z.string(),
  outlineColor: z.string(), outlineWidth: z.number(),
  position: z.enum(['bottom', 'top']), bilingualLines: z.union([z.literal(1), z.literal(2)]),
});
const NamingSchema = z.object({
  // 上限放宽到 12：界面限制 6 位，这里只挡异常输入，避免用户多写一格就整单失败
  artists: z.array(z.string().max(200)).max(12),
  title: z.string().max(200),
  language: z.string().max(40),
  version: z.string().max(40),
});
const ConfigSchema = z.object({
  sourcePath: z.string().min(1),
  originalAudioStreamIndex: z.number().int().optional(),
  // 允许为空：渲染层首次导入时还没有输出目录，由主进程按「源文件同目录」兜底
  outputDir: z.string(),
  outputName: z.string(),
  naming: NamingSchema,
  outputConflict: z.enum(['suffix', 'overwrite']),
  outputSuffix: z.string().max(40),
  container: z.enum(['mp4', 'mkv']),
  extension: z.string(),
  videoCodec: z.enum(['av1', 'hevc']),
  videoEncoder: z.enum(['software', 'hardware']),
  compressionPreset: z.enum(['quality', 'balanced', 'size']),
  accompanimentSource: z.enum(['uvr', 'imported']),
  accompanimentPath: z.string().optional(),
  separationModel: z.string().max(200),
  lyrics: LyricsSchema,
  subtitle: SubtitleSchema,
  skipReencodeIfHevc: z.boolean(),
  detailedMode: z.boolean(),
  lyricsExpanded: z.boolean(),
});

const LyricsEditSchema = z.array(
  z.object({
    startMs: z.number(),
    endMs: z.number().optional(),
    text: z.string(),
    translation: z.string().optional(),
  }).strict(),
).nullable();

const LyricsFetchSchema = z.object({
  source: z.enum(['online', 'local', 'paste']),
  songLink: z.string().optional(),
  localPath: z.string().optional(),
  pastedText: z.string().optional(),
  version: z.enum(['original', 'translation', 'bilingual']),
  format: z.enum(['lrc', 'srt']),
  offsetMs: z.number().int(),
});

const PreviewSchema = z.object({
  jobId: z.string().min(1),
  source: z.enum(['input', 'output']),
  inputPath: z.string().min(1),
  outputPath: z.string().optional(),
  audioTracks: z.array(z.enum(['original', 'accompaniment'])).min(1),
});

export interface AppContext {
  config: ConfigService;
  logger: Logger;
  jobs: JobService;
  pipeline: PipelineController;
  ports: PipelinePorts;
  version: string;
}

/**
 * 输出目录兜底：优先源文件所在目录（用户最容易找到产物），
 * 源目录只读时退回 userData/outputs。
 * 渲染层首次导入还没选目录，不能让空值把整条导入流程拒掉。
 */
function resolveOutputDir(cfg: JobConfig, cacheDir: string): string {
  const given = (cfg.outputDir || '').trim();
  if (given) return given;
  const srcDir = cfg.sourcePath ? dirname(cfg.sourcePath) : '';
  if (srcDir) {
    try {
      accessSync(srcDir, fsConstants.W_OK);
      return srcDir;
    } catch { /* 只读卷 / 光盘：落到用户目录 */ }
  }
  const fallback = join(dirname(cacheDir), 'outputs');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** 控制器层：解析请求、调用服务、格式化响应，不写业务逻辑。入参一律边界校验。 */
export function registerIpc(ctx: AppContext): void {
  const configFile = join(ctx.config.paths.cacheDir, 'config.json');
  const migratedFlag = join(ctx.config.paths.cacheDir, 'config.migrated');

  /**
   * 一次性迁移历史默认值。
   * 解决的问题：context 配置在磁盘上是持久化的，改了默认值对老用户不生效
   * （配置文件里的旧值每次都会覆盖代码里的新默认值）。
   *
   * 只迁移一次（靠标记文件），因此用户之后主动调回旧值不会被再次改写；
   * 只改「仍然等于旧默认」的字段，用户手动改过的不动。
   */
  const migrateOnce = (cfg: JobConfig): JobConfig => {
    if (existsSync(migratedFlag)) return cfg;
    const next: JobConfig = { ...cfg, subtitle: { ...cfg.subtitle }, lyrics: { ...cfg.lyrics } };
    // `.mtv` 已从可选扩展名中移除，旧值会让下拉框显示空白，必须迁移
    if (next.extension === '.mtv') next.extension = '.mp4';
    // 旧默认 48 在 1080p 上只占画面 4.4%，偏小；新默认 72（约 6.7%）
    if (next.subtitle.fontSize === 48) next.subtitle.fontSize = 72;
    if (next.subtitle.outlineWidth === 2) next.subtitle.outlineWidth = 3;
    try {
      writeFileSync(configFile, JSON.stringify(next, null, 2), 'utf8');
      writeFileSync(migratedFlag, String(Date.now()), 'utf8');
      ctx.logger.info('config.migrated', { from: cfg.extension, to: next.extension }, undefined);
    } catch { /* 写失败不阻断：下次启动会再尝试 */ }
    return next;
  };

  /**
   * 容器与扩展名必须一致：扩展名只是文件名后缀，容器才是真正的封装格式。
   * 旧版把两者拆成两个下拉，用户能存出「container=mp4 + extension=.mkv」这种
   * 后缀骗人的组合；现在 UI 已合并成一个「格式」，这里再兜一道，防止历史配置带毒。
   */
  const alignExtension = (cfg: JobConfig): JobConfig => {
    const expected = cfg.container === 'mkv' ? '.mkv' : '.mp4';
    return cfg.extension === expected ? cfg : { ...cfg, extension: expected };
  };

  /**
   * 源文件不跨会话保留：每次启动都是干净的空态，由用户自己选。
   * 理由——启动就带出上次的视频会让用户困惑「我没导入过啊」，而且那个文件
   * 很可能已经被移动或删除；转换是「选一个、转一个」的节奏，恢复上次没有价值。
   * 其余偏好（输出目录、压缩档、歌词/字幕样式、窗口偏好）照常保留。
   */
  const readConfig = (): JobConfig => {
    try {
      if (existsSync(configFile)) {
        const raw = JSON.parse(readFileSync(configFile, 'utf8')) as Partial<JobConfig>;
        // naming 要单独深合并：浅合并会把半截对象（缺 language / version）整块替换掉
        const merged: JobConfig = {
          ...makeDefaultConfig(), ...raw,
          // 启动时折掉上次留下的空歌手格：默认就该只有 1 格
          naming: pruneNaming(raw.naming),
        } as JobConfig;
        return { ...alignExtension(migrateOnce(merged)), sourcePath: '' };
      }
    } catch { /* 损坏时回退默认值 */ }
    return makeDefaultConfig();
  };
  const saveConfig = (cfg: JobConfig): void => {
    writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
  };

  const handle = <T>(channel: string, schema: z.ZodType<T> | null, fn: (input: T) => Promise<unknown> | unknown): void => {
    ipcMain.handle(channel, async (_event, raw: unknown) => {
      try {
        const input = schema ? schema.parse(raw) : (raw as T);
        return await fn(input);
      } catch (err) {
        ctx.logger.error('ipc.error', { channel, detail: String(err) });
        if (err instanceof z.ZodError) {
          return { __error: makeError('E_INPUT_UNSUPPORTED', 'APP', err).toPayload() };
        }
        return { __error: makeError('E_UNKNOWN', 'APP', err).toPayload() };
      }
    });
  };

  handle(IPC.invoke.health, null, async (): Promise<HealthResult> => {
    const caps: MediaCapabilities = await ctx.ports.media.capabilities();
    // detect() 内部已按运行时 provider 校正分离后端，这里直接取结论
    const backend = await ctx.ports.hardware.detect(caps);
    const missing: string[] = [];
    if (!caps.libx265 && !caps.hevcVideotoolbox && !caps.hevcNvenc) missing.push('HEVC 编码器');
    if (!caps.libass) missing.push('libass（字幕渲染）');
    if (!caps.hlsMuxer) missing.push('HLS muxer');
    return { ok: missing.length === 0, version: ctx.version, capabilities: caps, backend, missing };
  });

  handle(IPC.invoke.capabilities, null, () => ctx.ports.media.capabilities());
  // 无原生菜单时的快捷键通道：编辑命令交给 webContents，窗口/退出命令自己处理
  handle(
    IPC.invoke.editCommand,
    z.enum(['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo', 'quit', 'close', 'minimize']),
    (command) => {
      if (command === 'quit') { app.quit(); return; }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return;
      switch (command) {
        case 'cut': win.webContents.cut(); break;
        case 'copy': win.webContents.copy(); break;
        case 'paste': win.webContents.paste(); break;
        case 'selectAll': win.webContents.selectAll(); break;
        case 'undo': win.webContents.undo(); break;
        case 'redo': win.webContents.redo(); break;
        case 'close': win.close(); break;
        case 'minimize': win.minimize(); break;
        default: break;
      }
    },
  );
  // 字体字节供渲染层 libass WASM 使用：只允许 fonts 目录下的纯文件名，杜绝路径穿越
  handle(IPC.invoke.readFont, z.string().min(1).max(128), (fontFileName) => {
    const base = basename(fontFileName);
    if (base !== fontFileName || base.startsWith('.')) {
      throw makeError('E_UNKNOWN', 'APP', '非法字体文件名');
    }
    const full = join(ctx.config.paths.fontsDir, base);
    if (!existsSync(full)) throw makeError('E_SUBTITLE_FONT', 'APP', `字体不存在：${base}`);
    return readFileSync(full);
  });
  handle(IPC.invoke.configGet, null, () => readConfig());
  handle(IPC.invoke.configSet, ConfigSchema.partial(), (patch) => {
    const current = readConfig();
    const next: JobConfig = {
      ...current,
      ...patch,
      naming: normalizeNaming(patch.naming ?? current.naming),
      lyrics: { ...current.lyrics, ...(patch.lyrics ?? {}) },
      subtitle: { ...current.subtitle, ...(patch.subtitle ?? {}) },
    };
    saveConfig(next);
    ctx.ports.presentation.setDetailedMode(next.detailedMode);
    return next;
  });

  handle(IPC.invoke.jobCreate, ConfigSchema, async (cfg) => {
    const resolved: JobConfig = { ...cfg, outputDir: resolveOutputDir(cfg, ctx.config.paths.cacheDir) };
    const job = ctx.jobs.create(resolved);
    // 导入即探测：卡片立刻显示真实时长 / 规格；探测失败不阻断导入，PROBE 阶段会再试
    try {
      const info = await ctx.ports.media.probe(resolved.sourcePath);
      const rec = ctx.jobs.get(job.id);
      if (rec) rec.mediaInfo = info;
    } catch { /* 留空即可 */ }
    return ctx.jobs.get(job.id) ?? job;
  });
  handle(IPC.invoke.jobStart, z.string().min(1), async (jobId) => { void ctx.pipeline.run(jobId); return ctx.jobs.get(jobId); });
  handle(IPC.invoke.jobCancel, z.string().min(1), async (jobId) => { await ctx.pipeline.cancelAll(jobId); return ctx.jobs.get(jobId); });
  handle(IPC.invoke.jobList, null, () => ctx.jobs.list());
  handle(IPC.invoke.jobGet, z.string().min(1), (jobId) => ctx.jobs.get(jobId));

  // 双参通道：preload 以 (jobId, value) 形式转发，与 MtvBridge 签名一致
  ipcMain.handle(IPC.invoke.jobConfirmTracks, async (_event, jobIdRaw: unknown, indexRaw: unknown) => {
    try {
      const jobId = z.string().min(1).parse(jobIdRaw);
      const audioStreamIndex = z.number().int().nullable().parse(indexRaw);
      const job = ctx.jobs.get(jobId);
      if (!job) throw makeError('E_UNKNOWN', 'APP');
      if (audioStreamIndex === null) return ctx.jobs.setStatus(jobId, 'CANCELLED');
      job.config.originalAudioStreamIndex = audioStreamIndex;
      ctx.jobs.setStatus(jobId, 'QUEUED');
      void ctx.pipeline.run(jobId);
      return ctx.jobs.get(jobId);
    } catch (err) {
      ctx.logger.error('ipc.error', { channel: IPC.invoke.jobConfirmTracks, detail: String(err) });
      return { __error: toPayload(err) };
    }
  });

  ipcMain.handle(IPC.invoke.jobRetryStage, async (_event, jobIdRaw: unknown, stageRaw: unknown) => {
    try {
      const jobId = z.string().min(1).parse(jobIdRaw);
      const stage = StageSchema.parse(stageRaw) as StageCode;
      if (stage === 'ENCODE_MUX') ctx.jobs.clearStageDone(jobId, ['ENCODE_MUX']);
      void ctx.pipeline.run(jobId);
      return ctx.jobs.get(jobId);
    } catch (err) {
      ctx.logger.error('ipc.error', { channel: IPC.invoke.jobRetryStage, detail: String(err) });
      return { __error: toPayload(err) };
    }
  });

  handle(IPC.invoke.lyricsApplyEdits, LyricsEditSchema, (lines) => {
    ctx.ports.lyrics.setEditedLines(lines);
  });

  handle(IPC.invoke.lyricsFetch, LyricsFetchSchema, async (input: LyricsFetchInput): Promise<LyricsPayload> => {
    const port = ctx.ports.lyrics;
    if (input.source === 'online') return port.fetchOnline(input.songLink ?? '');
    if (input.source === 'local') return port.fromLocal(input.localPath ?? '', input.format);
    return port.fromPasted(input.pastedText ?? '', input.format);
  });

  handle(IPC.invoke.previewStart, PreviewSchema, async (req: PreviewRequest) => {
    const caps = await ctx.ports.media.capabilities();
    const backend = await ctx.ports.hardware.detect(caps);
    return ctx.ports.preview.start(req, backend);
  });
  handle(IPC.invoke.previewStop, z.string().min(1), (sessionId) => ctx.ports.preview.stop(sessionId));

  const filtersFor = (kind: 'video' | 'audio' | 'lyrics') => {
    if (kind === 'video') return [{ name: '视频', extensions: ['mp4', 'mkv', 'mov', 'mpg', 'ts', 'avi', 'flv'] }];
    if (kind === 'audio') return [{ name: '音频', extensions: ['wav', 'flac', 'mp3', 'm4a', 'aac'] }];
    return [{ name: '歌词', extensions: ['lrc', 'srt', 'txt'] }];
  };
  handle(IPC.invoke.selectFile, z.enum(['video', 'audio', 'lyrics']), async (kind) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: filtersFor(kind) });
    return r.canceled ? undefined : r.filePaths[0];
  });
  handle(IPC.invoke.openPath, z.string().min(1), (p) => shell.openPath(p));
  handle(IPC.invoke.showItemInFolder, z.string().min(1), (p) => { shell.showItemInFolder(p); return true; });
  handle(IPC.invoke.logExport, null, () => ctx.logger.exportText());

  // 优雅停机：停止预览代理与所有任务
  app.on('before-quit', () => {
    void ctx.ports.preview.stopAll();
    for (const job of ctx.jobs.list()) {
      if (job.status === 'RUNNING') void ctx.pipeline.cancelAll(job.id);
    }
  });
}
