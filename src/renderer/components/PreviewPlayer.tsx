import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import Hls from 'hls.js';
import type { AudioTrack, PreviewSource } from '../../shared/contracts';
import { formatDuration } from '../api/format';
import { SubtitleOverlay } from './SubtitleOverlay';

interface Props {
  url: string | null;
  source: PreviewSource;
  onSourceChange: (s: PreviewSource) => void;
  track: AudioTrack;
  onTrackChange: (t: AudioTrack) => void;
  outputAvailable: boolean;
  /** 已知的完整时长（源/输出一致）。HLS 边转边播时 video.duration 只反映已转出部分，不能用来画总长。 */
  expectedDurationSec?: number;
  /** 当前样式下的完整 ASS 文本；非空时在画面上叠加字幕预览 */
  subtitleAss?: string | null;
  videoRef: RefObject<HTMLVideoElement>;
  onError?: () => void;
  /** 播放秒数回传，供左栏标记当前歌词句 */
  onTimeUpdate?: (sec: number) => void;
  /** 是否已有源文件：区分「没选文件」与「正在准备预览」两种空态 */
  hasSourceFile?: boolean;
  onRetry?: () => void;
  /** 画面下方的紧凑状态条；数据由编排层提供，无数据时不渲染 */
  viewerInfo?: {
    currentLine: number; totalLines: number; timecode: string;
    offsetMs: number; subtitle: boolean; sourceLabel: string; outputLabel: string;
  };
}

/**
 * 只切换播放器的音频 rendition（hls.audioTrack），不重新 loadSource、不 attachMedia、
 * 不 seek —— 因此视频流不重载、播放进度不跳（NFR-06 / §7.7）。
 */
function applyTrack(hls: Hls, desired: AudioTrack): void {
  const tracks = hls.audioTracks;
  if (tracks.length === 0) return;
  const want = desired === 'original' ? '原唱' : '伴奏';
  let idx = tracks.findIndex((t) => (t.name || '').includes(want));
  if (idx < 0) idx = desired === 'original' ? 0 : Math.min(1, tracks.length - 1);
  if (hls.audioTrack !== idx) hls.audioTrack = idx;
}

/** 代理返回 VOD master playlist；降级「直接播放」返回普通文件字节流 URL。 */
function isHlsUrl(url: string): boolean {
  return url.toLowerCase().includes('.m3u8');
}

/** 控件 3：预览播放器；控件 4：音轨下拉。输入 / 输出切换属于播放器内部。 */
export function PreviewPlayer({
  url,
  source,
  onSourceChange,
  track,
  onTrackChange,
  outputAvailable,
  expectedDurationSec,
  subtitleAss,
  videoRef,
  onError,
  onTimeUpdate,
  hasSourceFile,
  onRetry,
  viewerInfo,
}: Props) {
  const hlsRef = useRef<Hls | null>(null);
  const trackRef = useRef<AudioTrack>(track);
  trackRef.current = track;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;

  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [tracksReady, setTracksReady] = useState(false);
  const [trackCount, setTrackCount] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setPlaying(false);
    setCurrentSec(0);
    setDurationSec(0);
    setTracksReady(false);
    setTrackCount(0);
    setFailed(false);

    const onTime = (): void => {
      setCurrentSec(video.currentTime);
      onTimeUpdateRef.current?.(video.currentTime);
    };
    const onMeta = (): void => setDurationSec(video.duration || 0);
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onVideoError = (): void => {
      // hls.js 路径由 Hls.Events.ERROR 处理；这里只兜底原生文件播放失败。
      if (!hlsRef.current) {
        setFailed(true);
        onErrorRef.current?.();
      }
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onVideoError);

    const hlsUrl = url ? isHlsUrl(url) : false;
    let hls: Hls | null = null;
    if (url && hlsUrl && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, lowLatencyMode: false });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(
        Hls.Events.AUDIO_TRACKS_UPDATED,
        (_event: string, data: { audioTracks: unknown[] }) => {
          setTrackCount(data.audioTracks.length);
          setTracksReady(true);
          applyTrack(hls as Hls, trackRef.current);
        },
      );
      hls.on(Hls.Events.ERROR, (_event: string, data: { fatal?: boolean }) => {
        if (data.fatal) {
          setFailed(true);
          onErrorRef.current?.();
        }
      });
    } else if (url && hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      // 少数原生支持 HLS 的环境，直接交给 video。
      video.src = url;
    } else if (url) {
      // 降级「直接播放」：普通文件字节流（支持 Range），不交给 hls.js 解析。
      // 该路径只有一条音轨，音轨下拉由 trackCount < 2 自动禁用。
      video.src = url;
    }

    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('error', onVideoError);
      if (hls) {
        hls.destroy();
        hlsRef.current = null;
      } else {
        video.removeAttribute('src');
        video.load();
      }
      video.pause();
    };
  }, [url, videoRef]);

  // 音轨下拉切换：只换 rendition，不重载、不跳进度。
  useEffect(() => {
    if (!tracksReady) return;
    const hls = hlsRef.current;
    if (hls) applyTrack(hls, track);
  }, [track, tracksReady]);

  const trackDisabled = source === 'input' || trackCount < 2 || !url;
  // HLS 边转边播时 video.duration 只覆盖「已转出的切片」，会小于播放位置（出现 6/2 这种）。
  // 用已知的完整时长画总长与进度条，video.duration 仅作兜底。
  const totalSec = expectedDurationSec && expectedDurationSec > 0 ? expectedDurationSec : durationSec;

  const togglePlay = (): void => {
    const video = videoRef.current;
    if (!video || !url) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const onSeek = (value: number): void => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentSec(value);
  };

  return (
    <section className="preview" aria-label="预览播放器">
      <div className="preview__head">
        <div className="preview__tabs" role="group" aria-label="预览画面来源">
          <button
            type="button"
            className="preview__tab"
            aria-pressed={source === 'input'}
            onClick={() => onSourceChange('input')}
          >
            输入视频
          </button>
          <button
            type="button"
            className="preview__tab"
            aria-pressed={source === 'output'}
            disabled={!outputAvailable}
            aria-describedby={!outputAvailable ? 'output-tab-help' : undefined}
            onClick={() => onSourceChange('output')}
          >
            输出视频
          </button>
        </div>
        {!outputAvailable && <span className="sr" id="output-tab-help">转换完成后才能看输出视频</span>}
        <span className="preview__badge" aria-live="polite">
          当前：{trackDisabled ? '原唱' : track === 'original' ? '原唱' : '伴奏'}
        </span>
      </div>

      <div className="preview__stage">
        <video
          ref={videoRef}
          className="preview__video"
          playsInline
          preload="metadata"
          aria-label="视频预览画面"
        />
        <SubtitleOverlay videoRef={videoRef} assText={subtitleAss ?? null} fontFileName="NotoSansCJKsc-Regular.otf" />
        {(!url || failed) && (
          <div className="preview__empty">
            {failed ? (
              <>
                <span>预览没起来</span>
                <span>可以重试，或到「详情」里看原因</span>
                {onRetry && <button className="btn btn--ghost btn--sm" type="button" onClick={onRetry}>重试</button>}
              </>
            ) : hasSourceFile ? (
              <>
                <span>正在准备预览…</span>
                <span>画面准备好后这里会显示字幕效果</span>
              </>
            ) : (
              <>
                <span>先选一个 MV</span>
                <span>拖进来，或点左边的「换一个」</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="preview__controls">
        <button
          type="button"
          className="btn btn--ghost preview__play"
          onClick={togglePlay}
          disabled={!url || failed}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? '暂停' : '播放'}
        </button>
        <span className="preview__time" aria-label="播放时间">
          {formatDuration(currentSec)} / {formatDuration(totalSec)}
        </span>
        <input
          className="preview__seek"
          type="range"
          min={0}
          max={totalSec || 0}
          step={0.1}
          value={Math.min(currentSec, totalSec || 0)}
          disabled={!url || failed || totalSec === 0}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="拖动播放进度"
          aria-valuetext={`${formatDuration(currentSec)} / ${formatDuration(totalSec)}`}
        />
        <label className="preview__track">
          <span>音轨</span>
          <select
            className="select"
            value={trackDisabled ? 'original' : track}
            disabled={trackDisabled}
            aria-describedby={trackDisabled ? 'track-help' : undefined}
            onChange={(e) => onTrackChange(e.target.value as AudioTrack)}
            aria-label="预览音轨"
          >
            <option value="original">原唱</option>
            <option value="accompaniment">伴奏</option>
          </select>
          {trackDisabled && <span className="sr" id="track-help">只有输出视频能切换音轨</span>}
        </label>
      </div>
      {viewerInfo && (
        <div className="viewer__meta" aria-label="预览状态">
          <span>当前句 <b>{viewerInfo.currentLine} / {viewerInfo.totalLines}</b></span>
          <span>时间码 <b>{viewerInfo.timecode}</b></span>
          <span>偏移 <b>{viewerInfo.offsetMs} ms</b></span>
          <span>字幕 <b>{viewerInfo.subtitle ? '已叠加' : '未叠加'}</b></span>
          <span>预览源 <b>{viewerInfo.sourceLabel}</b></span>
          <span>成品 <b>{viewerInfo.outputLabel}</b></span>
        </div>
      )}
    </section>
  );
}
