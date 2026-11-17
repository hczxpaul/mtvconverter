/**
 * 预加载桥（contextIsolation: true / nodeIntegration: false）。
 *
 * 职责：把冻结的 MtvBridge 完整暴露到 window.mtv，仅做 invoke 转发与事件订阅转发，
 * 不含业务逻辑、不把 ipcRenderer / event 本体泄漏到渲染层。所有通道名一律取自
 * src/shared/contracts.ts 的 IPC 常量，杜绝手写字符串漂移。
 *
 * 参数约定（与主进程 ipc/handlers.ts 对齐）：
 *   invoke 的第二个参数起即 handler 收到的参数列表；事件负载为单个对象。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/contracts';
import type { MtvBridge } from '../shared/preload-api';

/** 订阅主进程事件：回调只收到负载对象，不暴露 IpcRendererEvent。返回反订阅函数。 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: MtvBridge = {
  health: () => ipcRenderer.invoke(IPC.invoke.health),
  configGet: () => ipcRenderer.invoke(IPC.invoke.configGet),
  configSet: (patch) => ipcRenderer.invoke(IPC.invoke.configSet, patch),
  capabilities: () => ipcRenderer.invoke(IPC.invoke.capabilities),
  jobCreate: (config) => ipcRenderer.invoke(IPC.invoke.jobCreate, config),
  jobStart: (jobId) => ipcRenderer.invoke(IPC.invoke.jobStart, jobId),
  jobCancel: (jobId) => ipcRenderer.invoke(IPC.invoke.jobCancel, jobId),
  jobList: () => ipcRenderer.invoke(IPC.invoke.jobList),
  jobGet: (jobId) => ipcRenderer.invoke(IPC.invoke.jobGet, jobId),
  jobConfirmTracks: (jobId, audioStreamIndex) =>
    ipcRenderer.invoke(IPC.invoke.jobConfirmTracks, jobId, audioStreamIndex),
  jobRetryStage: (jobId, stage) =>
    ipcRenderer.invoke(IPC.invoke.jobRetryStage, jobId, stage),
  lyricsFetch: (input) => ipcRenderer.invoke(IPC.invoke.lyricsFetch, input),
  lyricsApplyEdits: (lines) => ipcRenderer.invoke(IPC.invoke.lyricsApplyEdits, lines),
  previewStart: (request) => ipcRenderer.invoke(IPC.invoke.previewStart, request),
  previewStop: (sessionId) => ipcRenderer.invoke(IPC.invoke.previewStop, sessionId),
  selectFile: (kind) => ipcRenderer.invoke(IPC.invoke.selectFile, kind),
  readFont: (fontFileName) => ipcRenderer.invoke(IPC.invoke.readFont, fontFileName),
  editCommand: (command) => ipcRenderer.invoke(IPC.invoke.editCommand, command),
  openPath: (path) => ipcRenderer.invoke(IPC.invoke.openPath, path),
  showItemInFolder: (path) => ipcRenderer.invoke(IPC.invoke.showItemInFolder, path),
  logExport: () => ipcRenderer.invoke(IPC.invoke.logExport),

  onProgress: (cb) => subscribe(IPC.event.progress, cb),
  onStatus: (cb) => subscribe(IPC.event.status, cb),
  onLog: (cb) => subscribe(IPC.event.log, cb),
  onFallback: (cb) => subscribe(IPC.event.fallback, cb),
};

contextBridge.exposeInMainWorld('mtv', bridge);

/**
 * 拖拽文件路径解析（冻结 MtvBridge 之外的一处补充）。
 * 拖拽拿到的 File 对象在 contextIsolation 下没有 path 属性，需经 Electron 官方
 * webUtils.getPathForFile 解析；渲染层只在 window.mtvDroppedPath 存在时调用，
 * 缺失时回退到「选择视频」对话框，功能不因此崩溃。
 */
contextBridge.exposeInMainWorld('mtvDroppedPath', (file: File): string =>
  webUtils.getPathForFile(file),
);
