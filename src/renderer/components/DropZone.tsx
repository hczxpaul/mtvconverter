import { useRef, useState } from 'react';
import { resolveDroppedPath } from '../api/bridge';
import { formatDuration } from '../api/format';
import type { MediaInfo } from '../../shared/contracts';

interface Props {
  fileName?: string;
  durationSec?: number;
  mediaInfo?: MediaInfo | null;
  /** 当前文件读不到（被移动/删除/格式不支持） */
  unreadable?: boolean;
  ready: boolean;
  onSelect: () => void;
  onDropPath: (path: string) => void;
}

function megabytes(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '—';
}

/** 导入区：信息量最小，只占一条紧凑信息条；拖拽激活态用文字而不只是颜色提示。 */
export function DropZone({
  fileName,
  durationSec,
  mediaInfo,
  unreadable,
  ready,
  onSelect,
  onDropPath,
}: Props) {
  const [active, setActive] = useState(false);
  const [dragText, setDragText] = useState(false);
  const dragDepth = useRef(0);

  const duration = durationSec && durationSec > 0 ? durationSec : mediaInfo?.durationSec;
  /* 四种状态要分清，之前只有「有元数据 / 读取中」两态，
     导致上次会话的残留文件读不到时也一直显示「读取中」——那是假状态。 */
  const metaLine = !fileName
    ? '也可以点下面的按钮选'
    : unreadable
      ? '读不到这个文件，请重新选择'
      : mediaInfo
        ? // 有元数据时下面还有一整块 metagrid，副行不重复规格
          `已读取 · ${duration ? formatDuration(duration) : mediaInfo.videoCodec}`
        : '正在读取…';

  return (
    <section className="card card--import" aria-label="导入视频">
      <div className="card__head">
        <h2 className="card__title">导入</h2>
        {/* 空态时选择入口放在拖放区里（更大的目标），这里就不再重复一个 */}
        {fileName && (
          <button className="linkbtn" type="button" disabled={!ready} onClick={onSelect}>
            换一个
          </button>
        )}
      </div>
      <div
        className={`dropzone${active ? ' dropzone--active' : ''}`}
        role="group"
        aria-label="放置视频的区域，也可以用按钮选择"
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setActive(true);
          setDragText(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setActive(false);
            setDragText(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setActive(false);
          setDragText(false);
          const file = e.dataTransfer.files?.[0];
          if (!file) return;
          const path = resolveDroppedPath(file);
          if (path) onDropPath(path);
          else onSelect();
        }}
      >
        <div className="import__row">
          <span className="dropzone__icon" aria-hidden="true">
            {/* 真图标：屏幕轮廓 + 播放三角。之前用的是 `▣` 字符，
                既不像视频也不像文件，纯装饰还占位。 */}
            <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
              {/* 16px 下三角必须画大才看得清，边框相应收细 */}
              <rect x="1.2" y="3" width="13.6" height="10" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.15" />
              <path d="M6.3 5.8 11.1 8 6.3 10.2Z" fill="currentColor" />
            </svg>
          </span>
          <div className="import__meta">
            <span className="dropzone__name" title={fileName} aria-label={fileName}>
              {dragText ? '松手就导入这个文件' : (fileName ?? '把 MV 拖到这里')}
            </span>
            <span className="import__sub" data-warn={unreadable ? 'true' : undefined}>
              {dragText ? '松开鼠标即可' : metaLine}
            </span>
          </div>
        </div>
        {!fileName && (
          <button className="btn btn--primary btn--sm" type="button" disabled={!ready} onClick={onSelect}>
            选择视频…
          </button>
        )}
        {mediaInfo && (
          <div className="metagrid" aria-label="源文件信息">
            <span>时长 <b>{formatDuration(mediaInfo.durationSec)}</b></span>
            <span>大小 <b>{megabytes(mediaInfo.fileSizeBytes)}</b></span>
            <span>画面 <b>{mediaInfo.width}×{mediaInfo.height} · {Math.round(mediaInfo.fps)}fps</b></span>
            <span>视频 <b>{mediaInfo.videoCodec} · {(mediaInfo.fileSizeBytes * 8 / mediaInfo.durationSec / 1e6).toFixed(2)} Mbps</b></span>
            <span>音轨 <b>{mediaInfo.audioStreams.length} · {mediaInfo.audioStreams[0]?.codec ?? '—'}</b></span>
            <span>色彩 <b>{mediaInfo.pixFmt} · {mediaInfo.colorSpace ?? '—'}</b></span>
          </div>
        )}
      </div>
      <p className="note-inline">拖入即替换 · MP4 / MKV / MOV / AVI</p>
    </section>
  );
}
