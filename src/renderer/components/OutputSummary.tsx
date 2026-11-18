/**
 * 输出摘要：把原本只藏在「更多设置」抽屉里的关键决策提到左栏常驻。
 * 只读 config / report，不写状态；所有数值都来自真实数据，没有则显示占位。
 */
import { COMPRESSION_PRESETS, crfFor } from '../../shared/contracts';
import type { BackendDecision, JobConfig, ValidationReport } from '../../shared/contracts';

interface Props {
  config: JobConfig;
  report: ValidationReport | null;
  onOpenSettings: () => void;
  /** 启动探测结果：用来避免「选了硬件加速但这台机器没有」时摘要还说硬件 */
  backend?: BackendDecision | null;
}

const VERSION_LABEL: Record<string, string> = {
  original: '原文', translation: '翻译', bilingual: '双语',
};

const CHECK_LABEL: Record<string, string> = {
  'V-01': '容器', 'V-02': '时长', 'V-03': '分辨率', 'V-04': '帧率',
  'V-05': '音视频同步', 'V-06': '画质', 'V-07': '轨道数', 'V-08': '轨道顺序',
  'V-09': '音轨切换', 'V-10': '元数据', 'V-11': '封装', 'V-12': '可播放',
  'V-13': '体积', 'V-14': '字幕', 'V-15': '幂等',
};

export function OutputSummary({ config, report, onOpenSettings, backend = null }: Props) {
  const preset = COMPRESSION_PRESETS[config.compressionPreset];
  const crf = crfFor(config.videoCodec, config.compressionPreset);
  // 摘要必须写「实际会用哪个编码器」：选了硬件但本机没有时，说硬件就是撒谎
  const hwUsable = backend !== null && backend.encodeEncoder !== '' && backend.encodeEncoder !== 'libx265';
  const encoderLabel = config.videoCodec === 'av1'
    ? 'AV1 · SVT-AV1' // AV1 只有软件编码，不必再说一遍
    : config.videoEncoder === 'hardware'
      ? (hwUsable ? `H.265 · 硬件（${backend?.encodeEncoder}）` : 'H.265 · 硬件不可用，走软件')
      : 'H.265 · 软件';
  const naming = config.outputConflict === 'overwrite'
    ? '同名时覆盖源文件'
    : `同名时加「${config.outputSuffix?.trim() || '-伴奏版'}」`;
  const subtitle = config.lyrics.enabled
    ? `${VERSION_LABEL[config.lyrics.version] ?? config.lyrics.version} · ${config.subtitle.bilingualLines} 行 · ${config.subtitle.fontSize}px${config.lyrics.burn ? ' · 烧录' : ' · 不烧录'}`
    : '未启用';
  const ratio = report && report.compressionRatio > 0
    ? `约为源的 ${Math.round(report.compressionRatio * 100)}%`
    : '转换后显示';

  const checks = report?.checks.slice(0, 3) ?? [];

  return (
    <section className="card card--output" aria-label="输出设置摘要">
      <div className="card__head">
        <h2 className="card__title">输出</h2>
        <button className="linkbtn" type="button" onClick={onOpenSettings}>更多设置</button>
      </div>
      <dl className="kv kv--tight">
        <dt>格式</dt><dd>{config.extension} · {preset.label} CRF {crf}</dd>
        <dt>编码</dt><dd>{encoderLabel}</dd>
        <dt>命名</dt><dd>{naming}</dd>
        <dt>字幕</dt><dd>{subtitle}</dd>
        <dt>音轨</dt><dd>原唱（默认）+ 伴奏</dd>
        <dt>体积</dt><dd>{ratio}</dd>
      </dl>
      {checks.length > 0 && (
        <div className="viewer__meta" aria-label="校验摘要">
          {checks.map((c) => (
            <span
              key={c.code}
              className={`badge badge--sm ${c.passed ? 'badge--ok' : c.severity === 'warn' ? 'badge--warn' : 'badge--err'}`}
            >
              {CHECK_LABEL[c.code] ?? c.code} {c.passed ? '通过' : '未通过'}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
