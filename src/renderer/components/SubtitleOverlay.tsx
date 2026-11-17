/**
 * 字幕实时预览：用 jassub（libass 的 WebAssembly 版）把 ASS 文本渲染到 <video> 之上。
 *
 * 关键点：烧录走 ffmpeg 的 libass，预览走同一份 libass（WASM），且吃的是同一份 ASS 文本
 * （由 src/shared/ass.ts 生成），因此能做到「预览所见 = 导出所得」。
 *
 * 容错策略：字体缺失、wasm 加载失败、ASS 非法等任何异常都只记日志并静默降级为
 * 「无字幕预览」，绝不影响视频播放本身。
 */
import { useEffect, useRef } from 'react';
import JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import wasmWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url';
import modernWasmWorkerUrl from 'jassub/dist/wasm/jassub-worker-modern.js?url';

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
  /** 完整 ASS 文本；null 表示当前没有可预览的字幕 */
  assText: string | null;
  /** 选中字体族，用于在 ASS 里匹配；缺字时由 libass 回落 */
  fontFileName: string;
}

/** 字体只取一次并常驻：16MB 级二进制过 IPC 有开销，不宜反复取。 */
let fontPromise: Promise<Uint8Array | null> | null = null;

function loadFontOnce(fileName: string): Promise<Uint8Array | null> {
  if (!fontPromise) {
    fontPromise = (async () => {
      const mtv = window.mtv;
      if (!mtv?.readFont) return null;
      try {
        const bytes = await mtv.readFont(fileName);
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
      } catch {
        return null;
      }
    })();
  }
  return fontPromise;
}

export function SubtitleOverlay({ videoRef, assText, fontFileName }: Props) {
  const instRef = useRef<JASSUB | null>(null);
  const assRef = useRef<string | null>(assText);
  assRef.current = assText;

  // 有字幕才创建实例；无字幕时彻底销毁，避免空转占内存
  useEffect(() => {
    if (!assText) return;
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;

    void (async () => {
      const font = await loadFontOnce(fontFileName);
      if (disposed) return;
      try {
        const inst = new JASSUB({
          video,
          subContent: assRef.current ?? '',
          workerUrl,
          wasmUrl,
          modernWasmUrl,
          wasmWorkerUrl,
          modernWasmWorkerUrl,
          ...(font ? { fonts: [font] } : {}),
          defaultFont: 'Noto Sans CJK SC',
          // Electron 里没有本地字体权限，关掉以免触发权限查询
          queryFonts: false,
          prescaleFactor: 1,
        });
        instRef.current = inst;
        // 不挂 catch 会产生 unhandledrejection（ASS 非法 / wasm 缺失时）
        inst.ready.catch(() => undefined);
      } catch {
        instRef.current = null;
      }
    })();

    return () => {
      disposed = true;
      const inst = instRef.current;
      instRef.current = null;
      // destroy() 幂等，但自身可能 reject，必须吞掉
      if (inst) void inst.destroy().catch(() => undefined);
    };
    // assText 从 null → 有值 时才需要新建；内容变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assText ? 'on' : 'off', fontFileName]);

  // 字幕内容或样式变化：只换 track，不重建实例（重建会闪一下并重置渲染状态）
  useEffect(() => {
    const inst = instRef.current;
    if (!inst || !assText) return;
    inst.ready
      .then(() => inst.renderer.setTrack(assText))
      // setStyle 不自动重绘：暂停态下强制出一帧，否则改样式看不到变化
      .then(() => inst.resize(true))
      .catch(() => undefined);
  }, [assText]);

  return null; // canvas 由 jassub 自己插入到 video 之后
}
