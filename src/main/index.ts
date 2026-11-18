import { app, BrowserWindow, dialog, Menu } from 'electron';
// 预览里会「自动 seek + 播放」做字幕对齐试听，需要免手势自动播放；
// 否则 play() 被 autoplay policy 拒绝，表现为「跳到那句但不动」。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { IPC, type JobRecord, type JobProgressEvent, type LogEntry, type BackendDecision } from '../shared/contracts';
import { ConfigService, ConfigError } from './config/ConfigService';
import { Logger } from './errors/Logger';
import { MediaAdapter } from './media/index';
import { AccompanimentAdapter } from './accompaniment/index';
import { LyricsService } from './lyrics/index';
import { PreviewService } from './preview/index';
import { HardwareProbe } from './hardware/index';
import { UiPresentationPolicy } from './presentation/index';
import { JobService, PipelineController, type PipelinePorts } from './jobs/index';
import { registerIpc } from './ipc/handlers';

const VERSION = app.getVersion();

/**
 * 不安装任何原生应用菜单。
 *
 * 原因（有崩溃报告支撑）：macOS 对**每个键盘事件**都会走 `NSMenu performKeyEquivalent`
 * 遍历菜单项；Electron 会随输入状态动态改写菜单项（撤销/重做标题、复制/粘贴可用性），
 * 后台改写与主线程遍历同一批 NSString 会抛 `mutateError`，直接把整个进程打崩
 * （实测：EXC_BREAKPOINT / SIGTRAP，栈顶 `NSApplication _crashOnException:`）。
 *
 * 代价是 Cmd+C/V/X/A/Z/Q/W 等系统快捷键不再由菜单提供，改由渲染层拦截后走 IPC
 * 调 webContents 对应方法补齐（见 installEditShortcuts / IPC.invoke.editCommand）。
 */
function installMenu(): void {
  Menu.setApplicationMenu(null);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  installMenu();

  // JS 层未捕获异常也要留痕：GUI 应用看不到 stderr，闪退前至少要能查到原因
  process.on('uncaughtException', (err) => {
    try {
      writeFileSync(
        join(app.getPath('userData'), 'crash-js.log'),
        `[${new Date().toISOString()}]\n${err?.stack ?? String(err)}\n\n`,
        { encoding: 'utf8', flag: 'a' },
      );
    } catch { /* 忽略写入失败 */ }
  });
  let config: ConfigService;
  try {
    // 打包后 app.asar 只读：配置 / 缓存必须落到 userData；资源从 Resources 读取
    const baseDir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    const resourcesRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
    config = ConfigService.load(baseDir, resourcesRoot);
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems : [String(err)];
    // 启动失败也要留痕：GUI 应用看不到 stderr，写入 userData 便于诊断
    try {
      writeFileSync(join(app.getPath('userData'), 'boot-error.log'), `[${new Date().toISOString()}]\n${problems.join('\n')}\n`, 'utf8');
    } catch { /* 忽略写入失败 */ }
    dialog.showErrorBox('配置校验失败', problems.join('\n'));
    app.quit();
    return;
  }

  const logger = new Logger(config.paths.cacheDir, config.paths.logLevel);
  let win: BrowserWindow | null = null;
  const send = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const media = new MediaAdapter(config.paths);
  const accompaniment = new AccompanimentAdapter(config.paths);
  const lyrics = new LyricsService(config.paths);
  const preview = new PreviewService(config.paths);
  const hardware = new HardwareProbe(config.paths);
  const presentation = new UiPresentationPolicy(config.paths);
  // 预览 / 硬件的降级原因码必须经统一 Logger 留痕，才能到 L2 详情与诊断包
  preview.setLogger(logger);
  hardware.setLogger(logger);
  // 分离后端只能按平台/显卡推断，注入运行时 provider 探测后由 detect() 校正为实际生效值
  hardware.setSeparationProviders(() => accompaniment.onnxProviders());

  const ports: PipelinePorts = { media, accompaniment, lyrics, hardware, preview, presentation, logger, paths: config.paths };

  const jobs = new JobService(config.paths, logger, {
    progress: (e: JobProgressEvent) => send(IPC.event.progress, e),
    status: (r: JobRecord) => send(IPC.event.status, r),
    fallback: (d: BackendDecision) => send(IPC.event.fallback, d),
  });
  logger.onEntry((e: LogEntry) => send(IPC.event.log, e));

  const pipeline = new PipelineController(jobs, ports);
  registerIpc({ config, logger, jobs, pipeline, ports, version: VERSION });

  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: 'MTV Converter',
    backgroundColor: '#F7F6F2',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.MTVC_DEV_RENDERER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  }
  win.on('closed', () => { win = null; });
  logger.info('app.ready', { version: VERSION, platform: config.paths.platform });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void bootstrap().catch((err) => {
  dialog.showErrorBox('启动失败', String(err));
  app.quit();
});
