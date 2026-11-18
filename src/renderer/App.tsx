import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { makeDefaultConfig } from '../shared/contracts';
import { toAssText } from '../shared/ass';
import type {
  AppErrorPayload, AudioTrack, BackendDecision, EditCommand, JobConfig, JobProgressEvent,
  JobRecord, LogEntry, LyricsConfig, LyricsPayload, LyricsStatus, MediaCapabilities,
  LyricLine,
  PreviewSession, PreviewSource, StageCode, SubtitleStyle, ValidationReport,
} from '../shared/contracts';
import type { HealthResult, LyricsFetchInput, MtvBridge } from '../shared/preload-api';
import { getBridge } from './api/bridge';
import { formatBytes } from './api/format';
import { ConfirmDialog } from './components/ConfirmDialog';
import type { ConfirmState } from './components/ConfirmDialog';
import { DetailsDrawer } from './components/DetailsDrawer';
import { DropZone } from './components/DropZone';
import { LyricsPanel } from './components/LyricsPanel';
import { LyricsTimeline } from './components/LyricsTimeline';
import { useLyricsColumnWidth } from './hooks/useLyricsColumnWidth';
import { ColumnResizer } from './components/ColumnResizer';
import { COL_GAP_PX, COL_MIN_PX, maxLyricsWidth, maxSideWidth } from './components/columnWidth';
import { OutputSummary } from './components/OutputSummary';
import { PreviewPlayer } from './components/PreviewPlayer';
import { StatusRow } from './components/StatusRow';

/** 状态行只说人话：阶段代号 / 百分比 / 预计剩余 / 后端一律不出现（详细模式除外）。 */
const STAGE_TEXT: Record<StageCode, string> = {
  PROBE: '正在读取视频…',
  EXTRACT: '正在准备声音…',
  LYRICS: '正在整理歌词…',
  ACCOMPANIMENT: '正在生成伴奏…',
  ALIGN: '正在对齐声音…',
  ENCODE_MUX: '正在压缩视频…',
  VALIDATE: '正在检查成品…',
};

function failureText(err?: AppErrorPayload): string {
  if (!err) return '没转好，点详情看原因';
  const m = err.userMessage?.trim();
  if (m && !/E_[A-Z_]+/.test(m)) return m;
  return '没转好，点详情看原因';
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function App() {
  const mtv = useMemo<MtvBridge | null>(() => getBridge(), []);
  const ready = mtv !== null;
  const jobIdRef = useRef<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  const [config, setConfig] = useState<JobConfig>(() => makeDefaultConfig());
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [backend, setBackend] = useState<BackendDecision | null>(null);
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  jobIdRef.current = job?.id ?? null;
  const [progress, setProgress] = useState<JobProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [fallback, setFallback] = useState<BackendDecision | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<'details' | 'logs' | 'settings'>('details');
  const [currentSec, setCurrentSec] = useState(0);
  /** 界面校对后的歌词（打点 / 删行）；null 表示用原始取词结果 */
  const [editedLines, setEditedLines] = useState<LyricLine[] | null>(null);
  const [previewRetryKey, setPreviewRetryKey] = useState(0);
  const [detailedMode, setDetailedMode] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [notice, setNotice] = useState('');
  const [lyricsStatus, setLyricsStatus] = useState<LyricsStatus>('OFF');
  const [lyricsPayload, setLyricsPayload] = useState<LyricsPayload | null>(null);
  const [lyricsBusy, setLyricsBusy] = useState(false);
  const [burnConfirmDone, setBurnConfirmDone] = useState(false);
  const [previewSource, setPreviewSource] = useState<PreviewSource>('input');
  const [audioTrack, setAudioTrack] = useState<AudioTrack>('original');
  const [previewSession, setPreviewSession] = useState<PreviewSession | null>(null);
  /** 本次选的文件读不到（被移动/删除/格式不支持），此时禁用开始转换 */
  const [sourceUnreadable, setSourceUnreadable] = useState(false);

  // 启动即取配置 / 健康 / 能力；失败也保留默认配置，不让界面空掉。
  useEffect(() => {
    if (!mtv) return;
    let alive = true;
    void (async () => {
      try {
        const [cfg, h, caps] = await Promise.all([
          mtv.configGet(),
          mtv.health(),
          mtv.capabilities(),
        ]);
        if (!alive) return;
        setConfig(cfg);
        setHealth(h);
        setBackend(h.backend);
        setCapabilities(caps);
        setDetailedMode(cfg.detailedMode);
        if (cfg.lyrics.enabled) setLyricsStatus('READY');

      } catch {
        // 保持 makeDefaultConfig() 的结果
      }
    })();
    return () => {
      alive = false;
    };
  }, [mtv]);

  // 订阅只用稳定依赖；进度用 jobIdRef 过滤，避免每次状态更新都重订阅。
  useEffect(() => {
    if (!mtv) return;
    const offs = [
      mtv.onProgress((e) => {
        if (!jobIdRef.current || e.jobId === jobIdRef.current) setProgress(e);
      }),
      mtv.onStatus((r) => {
        setJob(r);
        if (r.report) setReport(r.report);
        if (r.status === 'NEEDS_CONFIRMATION') {
          setConfirm({
            kind: 'tracks',
            jobId: r.id,
            streams: r.mediaInfo?.audioStreams ?? [],
          });
        } else {
          setConfirm((c) => (c?.kind === 'tracks' ? null : c));
        }
      }),
      mtv.onLog((e) => setLogs((prev) => [...prev.slice(-499), e])),
      mtv.onFallback((d) => {
        setFallback(d);
        setBackend(d);
      }),
    ];
    return () => {
      offs.forEach((off) => off());
    };
  }, [mtv]);

  // 轻量提示不是持久横幅：几秒后自动消失。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 预览会话：切「输入 / 输出」或任务产物变化才重建；切音轨只由 hls.js 换 rendition。
  useEffect(() => {
    if (!mtv || !job || !config.sourcePath) return;
    let cancelled = false;
    let sessionId: string | null = null;
    void (async () => {
      try {
        const session = await mtv.previewStart({
          jobId: job.id,
          source: previewSource,
          inputPath: config.sourcePath,
          outputPath: job.outputPath,
          audioTracks:
            previewSource === 'output' ? ['original', 'accompaniment'] : ['original'],
        });
        sessionId = session.sessionId;
        if (cancelled) {
          await mtv.previewStop(session.sessionId);
          return;
        }
        setPreviewSession(session);
      } catch {
        if (!cancelled) setNotice('预览没能开始，点详情看原因');
      }
    })();
    return () => {
      cancelled = true;
      if (sessionId) void mtv.previewStop(sessionId);
      setPreviewSession(null);
    };
  }, [mtv, job?.id, job?.outputPath, previewSource, config.sourcePath, previewRetryKey]);

  // ── 配置写入 ────────────────────────────────────────────────
  const patchConfig = useCallback(
    (patch: Partial<JobConfig>) => {
      setConfig((prev) => ({ ...prev, ...patch }));
      if (mtv) void mtv.configSet(patch).catch(() => {});
    },
    [mtv],
  );

  const handleLyricsChange = useCallback(
    (patch: Partial<LyricsConfig>) => {
      patchConfig({ lyrics: { ...config.lyrics, ...patch } });
    },
    [patchConfig, config.lyrics],
  );

  const handleSubtitleChange = useCallback(
    (patch: Partial<SubtitleStyle>) => {
      patchConfig({ subtitle: { ...config.subtitle, ...patch } });
    },
    [patchConfig, config.subtitle],
  );

  const handleLyricsToggle = useCallback(() => {
    patchConfig({ lyricsExpanded: !config.lyricsExpanded });
  }, [config.lyricsExpanded, patchConfig]);

  const handleDetailedModeChange = useCallback(
    (v: boolean) => {
      setDetailedMode(v);
      patchConfig({ detailedMode: v });
    },
    [patchConfig],
  );

  // ── 导入与主流程 ────────────────────────────────────────────
  const handleVideoPath = useCallback(
    async (path: string) => {
      const next: JobConfig = { ...config, sourcePath: path };
      setConfig(next);
      setSourceUnreadable(false);
      setNotice('');
      setReport(null);
      if (!mtv) return;
      try {
        void mtv.configSet({ sourcePath: path }).catch(() => {});
        const created = await mtv.jobCreate(next);
        setJob(created);
        setProgress(null);
        setPreviewSource('input');
        setAudioTrack('original');
      } catch {
        // 读不到就明说，并挡住「开始转换」——别让用户点了才发现
        setSourceUnreadable(true);
        setNotice('这个视频读不了，换一个试试');
      }
    },
    [mtv, config],
  );

  const handleSelectVideo = useCallback(async () => {
    if (!mtv) return;
    try {
      const path = await mtv.selectFile('video');
      if (path) await handleVideoPath(path);
    } catch {
      setNotice('没能打开选择窗口，再试一次');
    }
  }, [mtv, handleVideoPath]);

  const handleStart = useCallback(async () => {
    if (!mtv || !config.sourcePath) return;
    setNotice('正在准备…');
    setProgress(null);
    setReport(null);
    try {
      const created = await mtv.jobCreate(config);
      setJob(created);
      await mtv.jobStart(created.id);
      setNotice('');
    } catch {
      setNotice('没能开始转换，点详情看原因');
    }
  }, [mtv, config]);

  const handleCancel = useCallback(() => {
    if (mtv && job) void mtv.jobCancel(job.id).catch(() => {});
  }, [mtv, job]);

  const handleOpenFolder = useCallback(() => {
    if (mtv && job?.outputPath) {
      void mtv.showItemInFolder(job.outputPath).catch(() => {});
    }
  }, [mtv, job]);

  const handlePreviewOutput = useCallback(() => {
    setPreviewSource('output');
    setDetailsOpen(false);
  }, []);

  const handleExportLog = useCallback(() => {
    if (!mtv) return;
    void mtv
      .logExport()
      .then(() => setNotice('日志已导出'))
      .catch(() => setNotice('日志导出没成功'));
  }, [mtv]);

  const handleSelectAccompaniment = useCallback(async () => {
    if (!mtv) return;
    try {
      const path = await mtv.selectFile('audio');
      if (path) patchConfig({ accompanimentSource: 'imported', accompanimentPath: path });
    } catch {
      setNotice('没能打开选择窗口，再试一次');
    }
  }, [mtv, patchConfig]);

  const handleRetryStage = useCallback(
    (stage: StageCode) => {
      if (mtv && job) void mtv.jobRetryStage(job.id, stage).catch(() => {});
    },
    [mtv, job],
  );

  // ── 歌词 ────────────────────────────────────────────────────
  const handleLyricsFetch = useCallback(
    async (input: LyricsFetchInput) => {
      if (!mtv) return;
      setLyricsBusy(true);
      setLyricsStatus('FETCHING');
      try {
        const payload = await mtv.lyricsFetch(input);
        setLyricsPayload(payload);
        // 重新取词 = 丢弃上一轮的校对结果，避免张冠李戴
        setEditedLines(null);
        void mtv.lyricsApplyEdits(null).catch(() => {});
        setLyricsStatus(
          payload.status === 'READY'
            ? 'READY'
            : payload.status === 'EMPTY'
              ? 'EMPTY'
              : 'UNAVAILABLE',
        );
      } catch {
        setLyricsPayload(null);
        setLyricsStatus('UNAVAILABLE');
      } finally {
        setLyricsBusy(false);
      }
    },
    [mtv],
  );

  const handleSelectLyricsFile = useCallback(async () => {
    if (!mtv) return;
    try {
      const path = await mtv.selectFile('lyrics');
      if (!path) return;
      const format: LyricsConfig['format'] = path.toLowerCase().endsWith('.srt')
        ? 'srt'
        : 'lrc';
      patchConfig({
        lyrics: { ...config.lyrics, source: 'local', localPath: path, format },
      });
      await handleLyricsFetch({
        source: 'local',
        localPath: path,
        songLink: config.lyrics.songLink,
        pastedText: config.lyrics.pastedText,
        version: config.lyrics.version,
        format,
        offsetMs: config.lyrics.offsetMs,
      });
    } catch {
      setNotice('没能打开选择窗口，再试一次');
    }
  }, [mtv, patchConfig, config.lyrics, handleLyricsFetch]);

  const handleBurnRequest = useCallback(() => {
    if (burnConfirmDone) {
      patchConfig({ lyrics: { ...config.lyrics, burn: true } });
      return;
    }
    setConfirm({ kind: 'burn' });
  }, [burnConfirmDone, patchConfig, config.lyrics]);

  const handleBurnConfirm = useCallback(() => {
    setBurnConfirmDone(true);
    setConfirm(null);
    patchConfig({ lyrics: { ...config.lyrics, burn: true } });
  }, [patchConfig, config.lyrics]);

  const handleBurnCancel = useCallback(() => setConfirm(null), []);

  const handleSeekTo = useCallback((ms: number) => {
    const video = previewVideoRef.current;
    if (video) video.currentTime = Math.max(0, ms / 1000);
  }, []);

  const handleTracksContinue = useCallback(
    (index: number) => {
      if (mtv && confirm?.kind === 'tracks') {
        void mtv.jobConfirmTracks(confirm.jobId, index).catch(() => {});
      }
      setConfirm(null);
    },
    [mtv, confirm],
  );

  const handleTracksSkip = useCallback(() => {
    if (mtv && confirm?.kind === 'tracks') {
      void mtv.jobConfirmTracks(confirm.jobId, null).catch(() => {});
    }
    setConfirm(null);
  }, [mtv, confirm]);

  const handleDetails = useCallback(() => setDetailsOpen(true), []);
  const handleDetailsClose = useCallback(() => setDetailsOpen(false), []);
  const handlePreviewError = useCallback(
    () => setNotice('预览没能播放，点详情看原因'),
    [],
  );

  // ── 派生展示 ────────────────────────────────────────────────
  const shownLyricsStatus: LyricsStatus =
    config.lyrics.burn && lyricsStatus === 'READY' ? 'BURN_CONFIRMED' : lyricsStatus;

  const statusText = useMemo(() => {
    // notice 走底部独立提示条，不再覆盖主状态
    if (!job) {
      return config.sourcePath ? '准备好了，点「开始转换」' : '先把一个 MV 拖进来';
    }
    switch (job.status) {
      case 'DRAFT':
        return '准备好了，点「开始转换」';
      case 'QUEUED':
        return '正在排队…';
      case 'RUNNING':
        return STAGE_TEXT[job.stage ?? progress?.stage ?? 'PROBE'];
      case 'NEEDS_CONFIRMATION':
        return '这个文件不止一条音轨，等你选一下';
      case 'CANCELLED':
        return '已取消';
      case 'FAILED':
        return failureText(job.error);
      case 'COMPLETED': {
        if (job.lyricsStatus === 'UNAVAILABLE') return '未找到歌词，已生成无字幕版本';
        if (job.lyricsStatus === 'EMPTY') return '这首歌没有歌词';
        const size = report?.outputSizeBytes ?? job.report?.outputSizeBytes ?? 0;
        return size > 0 ? `完成 · ${formatBytes(size)}` : '完成';
      }
      default:
        return '';
    }
  }, [job, config.sourcePath, progress?.stage, report]);

  const percent = useMemo(() => {
    if (!job) return null;
    if (job.status === 'RUNNING' || job.status === 'QUEUED') {
      return progress?.percent ?? job.progress ?? 0;
    }
    return null;
  }, [job, progress?.percent]);

  /**
   * 不装原生应用菜单（macOS 下 NSMenu 的快捷键遍历曾导致闪退），因此 Cmd/Ctrl 系列
   * 快捷键在这里手动接管：编辑类命令转发给 webContents，窗口/退出命令发给主进程。
   */
  useEffect(() => {
    if (!mtv) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const el = document.activeElement as HTMLElement | null;
      const editable = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      let command: EditCommand | null = null;
      if (key === 'z') command = e.shiftKey ? 'redo' : 'undo';
      else if (key === 'x') command = 'cut';
      else if (key === 'c') command = 'copy';
      else if (key === 'v') command = 'paste';
      else if (key === 'a') command = 'selectAll';
      else if (key === 'q') command = 'quit';
      else if (key === 'w') command = 'close';
      else if (key === 'm') command = 'minimize';
      if (!command) return;

      // 编辑类命令只在输入类元素上接管，别抢页面的默认行为
      const isEdit = command === 'cut' || command === 'copy' || command === 'paste'
        || command === 'undo' || command === 'redo';
      if (isEdit && !editable) return;

      e.preventDefault();
      void mtv.editCommand(command).catch(() => undefined);
    };
    // 用捕获阶段，确保先于组件自身的按键处理
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [mtv]);

  const busy = job?.status === 'RUNNING' || job?.status === 'QUEUED';
  const completed = job?.status === 'COMPLETED';

  // ── 对齐试听：改偏移 / 换歌词后，自动跳到「当前所在句」播一小段，然后回到原位 ──
  const alignRestoreRef = useRef<{ time: number; playing: boolean } | null>(null);
  const [alignStopAt, setAlignStopAt] = useState<number | null>(null);

  /** 在当前播放位置附近找到所属歌词句，并算出试听区间（句首前留 0.3s 预卷）。 */
  const computeAlignWindow = useCallback((): { startSec: number; stopAt: number; index: number } | null => {
    const video = previewVideoRef.current;
    const lines = lyricsPayload?.lines;
    if (!video || !lines || lines.length === 0) return null;
    const offset = config.lyrics.offsetMs ?? 0;
    const nowMs = video.currentTime * 1000;

    let idx = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startMs + offset <= nowMs + 60) idx = i;
      else break;
    }
    const line = lines[idx];
    const lineStart = Math.max(0, (line.startMs + offset) / 1000);
    // 预卷 0.3s：能看到字幕「出现」的那一帧，才判断得出早了还是晚了
    const startSec = Math.max(0, lineStart - 0.3);
    const nextStart = lines[idx + 1] ? (lines[idx + 1].startMs + offset) / 1000 : undefined;
    const lineEnd = nextStart ?? (line.endMs !== undefined ? (line.endMs + offset) / 1000 : lineStart + 3);
    const stopAt = Math.max(startSec + 1.2, Math.min(lineEnd, startSec + 3.2));
    return { startSec, stopAt, index: idx };
  }, [config.lyrics.offsetMs, lyricsPayload, previewVideoRef]);

  /** 结束试听：回到进来前的位置，并恢复原来的播放/暂停状态。 */
  const finishAlignPreview = useCallback((): void => {
    const video = previewVideoRef.current;
    const restore = alignRestoreRef.current;
    alignRestoreRef.current = null;
    setAlignStopAt(null);
    if (!video || !restore) return;
    try {
      video.currentTime = restore.time;
    } catch { /* 源已失效时忽略 */ }
    if (restore.playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [previewVideoRef]);

  const alignPreviewOnce = useCallback((): void => {
    const video = previewVideoRef.current;
    if (!video) return;
    // 输出预览的画面里是上一版烧录结果，对齐没有意义
    if (previewSource !== 'input') return;
    const win = computeAlignWindow();
    if (!win) return;

    if (!alignRestoreRef.current) {
      alignRestoreRef.current = { time: video.currentTime, playing: !video.paused };
    }
    try {
      video.currentTime = win.startSec;
    } catch {
      return;
    }
    setAlignStopAt(win.stopAt);
    setNotice(`正在试听第 ${win.index + 1} 句，结束后回到原位`);
    // 播放被拒（无手势 / 策略限制）时立刻回位，避免停在别处让人以为卡住
    void video.play().catch(() => finishAlignPreview());
  }, [computeAlignWindow, finishAlignPreview, previewSource, previewVideoRef]);

  // 试听结束 → 回到进来前的位置
  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video || alignStopAt === null) return;
    const onTime = (): void => {
      // 播到句末，或视频比 stopAt 短直接播完，都算结束
      if (video.ended || video.currentTime >= alignStopAt) finishAlignPreview();
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', finishAlignPreview);
    // 兜底：某些源 timeupdate 稀疏，6 秒还没结束就强制收尾
    const guard = window.setTimeout(finishAlignPreview, 6000);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('ended', finishAlignPreview);
      window.clearTimeout(guard);
    };
  }, [alignStopAt, finishAlignPreview, previewVideoRef]);

  // 触发 1：时间偏移变化（含手动输入与 ± 按钮），防抖到停手后再试听一次
  const lastOffsetRef = useRef(config.lyrics.offsetMs);
  useEffect(() => {
    if (lastOffsetRef.current === config.lyrics.offsetMs) return;
    lastOffsetRef.current = config.lyrics.offsetMs;
    if (!config.lyrics.enabled || !lyricsPayload?.lines?.length) return;
    const timer = window.setTimeout(alignPreviewOnce, 400);
    return () => window.clearTimeout(timer);
  }, [config.lyrics.offsetMs, config.lyrics.enabled, lyricsPayload, alignPreviewOnce]);

  // 触发 2：歌词内容变化（重新获取 / 换版本 / 导入本地）。用签名比较，首次不触发。
  const lyricsSig = `${config.lyrics.version}:${lyricsPayload?.lines?.length ?? 0}:${lyricsPayload?.lines?.[0]?.startMs ?? -1}`;
  const lastLyricsSigRef = useRef(lyricsSig);
  useEffect(() => {
    if (lastLyricsSigRef.current === lyricsSig) return;
    lastLyricsSigRef.current = lyricsSig;
    if (!config.lyrics.enabled || !lyricsPayload?.lines?.length) return;
    const timer = window.setTimeout(alignPreviewOnce, 400);
    return () => window.clearTimeout(timer);
  }, [lyricsSig, config.lyrics.enabled, lyricsPayload, alignPreviewOnce]);

  /**
   * 预览用 ASS：与烧录共用 shared/ass.ts，保证「看到的」就是「烧进去的」。
   * 仅在「已有歌词 + 开了烧录 + 已知时长」时生成；样式改动会立即重算并推给 libass。
   */
  // 校对后的歌词优先；null 时回落到原始取词结果
  const lyricLines = editedLines ?? lyricsPayload?.lines ?? [];

  // 歌词列按最长一句的真实宽度定宽（clamp 在 250–360），多余空间让给预览
  const lyricsColWidth = useLyricsColumnWidth(lyricLines, config.lyrics.version);

  /* ── 列宽拖拽 ────────────────────────────────────────────────
     未拖过时各列用 CSS 默认（设置栏 minmax(290,360)、歌词列按最长句实测、预览吃剩余）；
     拖过之后变成固定像素，并把值写进 CSS 变量。双击把手恢复自动。 */
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const sideRef = useRef<HTMLDivElement | null>(null);
  const lyricsColRef = useRef<HTMLElement | null>(null);
  const [sideW, setSideW] = useState<number | null>(null);
  const [lyricsW, setLyricsW] = useState<number | null>(null);
  const [colMetrics, setColMetrics] = useState({ total: 0, side: 0, lyrics: 0 });

  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    const measure = () => {
      setColMetrics({
        total: ws.clientWidth,
        side: sideRef.current?.offsetWidth ?? 0,
        lyrics: lyricsColRef.current?.offsetWidth ?? 0,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ws);
    if (sideRef.current) ro.observe(sideRef.current);
    if (lyricsColRef.current) ro.observe(lyricsColRef.current);
    return () => ro.disconnect();
  }, [lyricLines.length]);

  // 歌词内容变了（重新取词 / 删行）就回到「按最长句自动」，避免列宽僵在一个旧值
  useEffect(() => {
    setLyricsW(null);
  }, [lyricsColWidth, lyricLines.length]);

  const wantLyricsCol = lyricLines.length > 0;
  const effectiveLyricsW = lyricsW ?? lyricsColWidth;

  /* 歌词列进出场：四态驱动，避免「有/无」两态导致列要么瞬间出现、要么瞬间消失。
       hidden   不渲染
       entering 列宽 0 → 目标宽（220ms ease-out），配合卡片淡入
       visible  正常，可拖拽
       leaving  列宽 当前 → 0（180ms ease-in），卡片淡出，播完才卸载
     补间值放 state 而不是直接改 DOM：列宽变化会触发 ResizeObserver → 重渲染，
     React 的 style 会把 CSS 变量打回终值，直接改 DOM 动画只跑一帧。 */
  const [colPhase, setColPhase] = useState<'hidden' | 'entering' | 'visible' | 'leaving'>(
    lyricLines.length > 0 ? 'visible' : 'hidden',
  );
  const [colWidthOverride, setColWidthOverride] = useState<number | null>(null);
  const lyricsTargetRef = useRef(330);
  lyricsTargetRef.current = effectiveLyricsW || 330;
  const lastColWidthRef = useRef(330);
  if (colPhase === 'visible') lastColWidthRef.current = lyricsTargetRef.current;

  const colVisible = colPhase !== 'hidden';

  // 歌词有无 → 推进到目标阶段
  useEffect(() => {
    setColPhase((prev) => {
      if (wantLyricsCol) {
        return prev === 'hidden' || prev === 'leaving' ? 'entering' : prev;
      }
      return prev === 'hidden' ? 'hidden' : 'leaving';
    });
  }, [wantLyricsCol]);

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (colPhase === 'entering') {
      if (reduceMotion) {
        setColPhase('visible');
        return;
      }
      const target = lyricsTargetRef.current;
      const DURATION = 220;
      setColWidthOverride(0);
      const startedAt = performance.now();
      let frame = 0;
      const tick = (now: number) => {
        const t = Math.min(1, (now - startedAt) / DURATION);
        if (t < 1) {
          setColWidthOverride(Math.round(target * (1 - (1 - t) ** 3)));
          frame = requestAnimationFrame(tick);
        } else {
          setColWidthOverride(null);
          setColPhase('visible');
        }
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }

    if (colPhase === 'leaving') {
      if (reduceMotion) {
        setColPhase('hidden');
        return;
      }
      const from = lastColWidthRef.current;
      const DURATION = 180;
      setColWidthOverride(from);
      const startedAt = performance.now();
      let frame = 0;
      const tick = (now: number) => {
        const t = Math.min(1, (now - startedAt) / DURATION);
        if (t < 1) {
          // ease-in：先慢后快，收得干脆，不像慢慢挤牙膏
          setColWidthOverride(Math.round(from * (1 - t) ** 2));
          frame = requestAnimationFrame(tick);
        } else {
          setColWidthOverride(null);
          setColPhase('hidden');
        }
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }

    setColWidthOverride(null);
    return undefined;
  }, [colPhase]);

  /* 窗口被拉小时，拖过的固定像素列会把容器撑破（grid 不会自动回收固定值），
     所以在度量变化时按当前上限回收到位，保住预览下限。 */
  useEffect(() => {
    if (sideW === null || colMetrics.total === 0) return;
    const limit = maxSideWidth(colMetrics.total, colMetrics.lyrics, colVisible);
    if (sideW > limit) setSideW(Math.max(COL_MIN_PX.side, limit));
  }, [sideW, colMetrics.total, colMetrics.lyrics, colVisible]);

  useEffect(() => {
    if (lyricsW === null || colMetrics.total === 0 || !colVisible) return;
    const limit = maxLyricsWidth(colMetrics.total, colMetrics.side);
    if (lyricsW > limit) setLyricsW(Math.max(COL_MIN_PX.lyrics, limit));
  }, [lyricsW, colMetrics.total, colMetrics.side, colVisible]);

  /** 打点 / 删行 / 恢复：同时写前端状态与主进程，保证预览和烧录用的是同一份 */
  const applyLyricLines = useCallback(
    (next: LyricLine[] | null) => {
      setEditedLines(next);
      if (!mtv) return;
      // 同步失败必须让用户看见：否则界面改了、烧录仍是原歌词
      void mtv.lyricsApplyEdits(next).catch(() => {
        setNotice('歌词校对没能同步给转换，请重开应用后再试');
      });
    },
    [mtv],
  );

  const previewAss = useMemo(() => {
    const lines = lyricLines;
    if (!lines || lines.length === 0) return null;
    if (!config.lyrics.burn) return null;
    const info = job?.mediaInfo;
    const dur = info?.durationSec ?? 0;
    if (!(dur > 0)) return null;
    const frame = info && info.width > 0 && info.height > 0
      ? { width: info.width, height: info.height }
      : undefined;
    return toAssText(lines, config, dur, frame);
  }, [lyricLines, config, job?.mediaInfo]);
  const hasOutput = Boolean(job?.outputPath);

  // 左栏「当前句」与预览下方信息条的数据源：只取校对后的歌词行与播放秒数
  const currentLineIndex = useMemo(() => {
    if (lyricLines.length === 0) return 0;
    const t = currentSec * 1000;
    let idx = 0;
    for (let i = 0; i < lyricLines.length; i += 1) {
      if (lyricLines[i].startMs + (config.lyrics.offsetMs ?? 0) <= t) idx = i;
      else break;
    }
    return idx + 1;
  }, [lyricLines, currentSec, config.lyrics.offsetMs]);

  const viewerInfo = useMemo(() => {
    if (!job && lyricLines.length === 0) return undefined;
    const line = lyricLines[Math.max(0, currentLineIndex - 1)];
    const ms = line ? line.startMs + (config.lyrics.offsetMs ?? 0) : 0;
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor(ms / 1000) % 60;
    const cc = Math.floor(ms / 10) % 100;
    const size = report?.outputSizeBytes ?? job?.report?.outputSizeBytes ?? 0;
    return {
      currentLine: currentLineIndex,
      totalLines: lyricLines.length,
      timecode: `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`,
      offsetMs: config.lyrics.offsetMs ?? 0,
      subtitle: previewAss !== null,
      sourceLabel: previewSource === 'input' ? '输入 · 直放' : '输出 · 预览',
      outputLabel: size > 0 ? formatBytes(size) : '转换后显示',
    };
  }, [job, lyricLines, currentLineIndex, config.lyrics.offsetMs, previewAss, previewSource, report]);

  const outputMeta = job?.outputPath
    ? `输出：${job.outputPath.split(/[\\/]/).pop()}`
    : undefined;

  const detailLine =
    detailedMode && job
      ? `${job.stage ?? '-'} · ${Math.round(progress?.percent ?? job.progress)}% · ${backend?.encodeEncoder ?? '-'}`
      : undefined;

  return (
    <div className="app">
      <header className="app__head">
        <h1 className="app__title">MTV Converter</h1>
        {!ready && <span className="app__state" role="status">正在连接…</span>}
        <span className="spacer" />
        {editedLines && (
          <button className="btn btn--ghost btn--sm" type="button" onClick={() => applyLyricLines(null)}>
            恢复原歌词
          </button>
        )}
        <button className="btn btn--ghost btn--sm" type="button" onClick={handleDetails}>详情</button>
      </header>

      <main className="app__main">
        <div
          ref={workspaceRef}
          className={`workspace${lyricLines.length > 0 ? ' has-lyrics' : ''}`}
          style={
            {
              ...(sideW !== null ? { '--side-w': `${sideW}px` } : {}),
              ...(colVisible ? { '--lyrics-w': `${colWidthOverride ?? effectiveLyricsW}px` } : {}),
            } as CSSProperties
          }
        >
          {/* 左栏：所有配置与信息；中栏：歌词列表（有歌词才出现）；右栏：预览固定 */}
          <div className="side" ref={sideRef}>
            <DropZone
              fileName={config.sourcePath ? fileNameOf(config.sourcePath) : undefined}
              durationSec={job?.mediaInfo?.durationSec}
              mediaInfo={job?.mediaInfo}
              unreadable={sourceUnreadable}
              ready={ready}
              onSelect={handleSelectVideo}
              onDropPath={handleVideoPath}
            />
            <LyricsPanel
              expanded={config.lyricsExpanded}
              onToggle={handleLyricsToggle}
              lyrics={config.lyrics}
              subtitle={config.subtitle}
              onLyricsChange={handleLyricsChange}
              onSubtitleChange={handleSubtitleChange}
              status={shownLyricsStatus}
              payload={lyricsPayload}
              busy={lyricsBusy}
              onFetch={handleLyricsFetch}
              onSelectLocal={handleSelectLyricsFile}
              onBurnRequest={handleBurnRequest}
              onSeekTo={handleSeekTo}
              capabilities={capabilities}
              currentSec={currentSec}
            />
          </div>
          {/* 歌词列：拿到歌词后推入；收起时先播完动画再卸载 */}
          {colVisible && (
            <aside
              className="lyrics-col"
              aria-label="歌词列表"
              ref={lyricsColRef}
              data-leaving={colPhase === 'leaving' ? 'true' : undefined}
            >
              <LyricsTimeline
                payload={lyricsPayload}
                lines={lyricLines}
                version={config.lyrics.version}
                offsetMs={config.lyrics.offsetMs}
                currentSec={currentSec}
                onSeekTo={handleSeekTo}
                onLinesChange={applyLyricLines}
              />
            </aside>
          )}
          <div className="viewer">
            <PreviewPlayer
              url={previewSession?.url ?? null}
              source={previewSource}
              onSourceChange={setPreviewSource}
              track={audioTrack}
              onTrackChange={setAudioTrack}
              outputAvailable={hasOutput}
              expectedDurationSec={job?.mediaInfo?.durationSec}
              // 输出预览的画面里已经烧进字幕，再叠一层会重影；只有输入预览需要叠加
              subtitleAss={previewSource === 'input' ? previewAss : null}
              videoRef={previewVideoRef}
              onError={handlePreviewError}
              hasSourceFile={Boolean(config.sourcePath)}
              onRetry={() => setPreviewRetryKey((k) => k + 1)}
              onTimeUpdate={setCurrentSec}
              viewerInfo={viewerInfo}
            />
            {/* 输出摘要放在预览下方：与「看成品」同视线，左栏只留输入与歌词 */}
            <OutputSummary
              config={config}
              report={report}
              backend={backend}
              onOpenSettings={() => {
                setDetailsTab('settings');
                setDetailsOpen(true);
              }}
            />
          </div>

          {/* 列宽把手：贴在两列之间，拖动改前一列宽度；双击恢复自动 */}
          {colMetrics.total > 0 && (
            <ColumnResizer
              left={colMetrics.side + COL_GAP_PX / 2}
              width={colMetrics.side}
              min={COL_MIN_PX.side}
              max={maxSideWidth(colMetrics.total, colMetrics.lyrics, colVisible)}
              label="调整设置栏宽度，双击恢复自动"
              onResize={setSideW}
              onReset={() => setSideW(null)}
            />
          )}
          {colMetrics.total > 0 && colVisible && (
            <ColumnResizer
              left={colMetrics.side + COL_GAP_PX + colMetrics.lyrics + COL_GAP_PX / 2}
              width={colMetrics.lyrics}
              min={COL_MIN_PX.lyrics}
              max={maxLyricsWidth(colMetrics.total, colMetrics.side)}
              label="调整歌词列宽度，双击恢复按最长句自动"
              onResize={setLyricsW}
              onReset={() => setLyricsW(null)}
            />
          )}
        </div>
      </main>

      <footer className="dock">
        <StatusRow
          text={statusText}
          percent={percent}
          busy={Boolean(busy)}
          completed={Boolean(completed)}
          hasOutput={hasOutput}
          stageCode={job?.stage ?? progress?.stage ?? null}
          outputMeta={outputMeta}
          notice={notice || undefined}
          canStart={ready && Boolean(config.sourcePath) && !busy && !sourceUnreadable}
          onStart={handleStart}
          onCancel={handleCancel}
          onDetails={handleDetails}
          onOpenFolder={handleOpenFolder}
          onPreviewOutput={handlePreviewOutput}
          fallback={fallback}
          detailLine={detailLine}
        />
      </footer>

      <DetailsDrawer
        open={detailsOpen}
        tab={detailsTab}
        onTabChange={setDetailsTab}
        onClose={handleDetailsClose}
        job={job}
        progress={progress}
        logs={logs}
        report={report}
        backend={backend}
        fallback={fallback}
        health={health}
        config={config}
        detailedMode={detailedMode}
        onDetailedModeChange={handleDetailedModeChange}
        onPatch={patchConfig}
        onSelectAccompaniment={handleSelectAccompaniment}
        onExportLog={handleExportLog}
        onRetryStage={handleRetryStage}
      />

      <ConfirmDialog
        state={confirm}
        onTracksContinue={handleTracksContinue}
        onTracksSkip={handleTracksSkip}
        onBurnConfirm={handleBurnConfirm}
        onBurnCancel={handleBurnCancel}
      />
    </div>
  );
}
