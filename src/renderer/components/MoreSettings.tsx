import { COMPRESSION_PRESETS, SEPARATION_MODELS, separationModelLabel } from '../../shared/contracts';
import type {
  BackendDecision, CompressionPreset, JobConfig, OutputContainer,
  VideoCodec, VideoEncoderPreference,
} from '../../shared/contracts';

interface Props {
  config: JobConfig;
  onPatch: (patch: Partial<JobConfig>) => void;
  detailedMode: boolean;
  onDetailedModeChange: (v: boolean) => void;
  onSelectAccompaniment: () => void;
  /** 启动时探测出的编码后端；用于判断「速度优先」在本机是否真的可用 */
  backend?: BackendDecision | null;
}

const PRESETS = Object.keys(COMPRESSION_PRESETS) as CompressionPreset[];

/** L2「更多设置」：伴奏来源、压缩档、容器 / 扩展名、详细模式。默认藏在抽屉里。 */
export function MoreSettings({
  config,
  onPatch,
  detailedMode,
  onDetailedModeChange,
  onSelectAccompaniment,
  backend = null,
}: Props) {
  // 「覆盖源文件」的二次确认：非模态，选中后先出确认条，点确认才真正生效
  // 探测未完成时 backend 为 null：此时不臆断，保持可选；探测完成后按真实能力禁用
  const hwKnown = backend !== null;
  const hevcHwAvailable = hwKnown && backend.encodeEncoder !== '' && backend.encodeEncoder !== 'libx265';
  // AV1 只在 av1_nvenc 自检通过时才算「有硬件编码器」；macOS 没有 AV1 硬编，必然回落 CPU
  const av1HwAvailable = hwKnown && backend.av1Encoder === 'av1_nvenc';
  const hwAvailable = config.videoCodec === 'av1' ? av1HwAvailable : hevcHwAvailable;
  const hwFallenBack = hwKnown && !hwAvailable && config.videoEncoder === 'hardware';
  // Roformer 走 torch，可用性看 torchBackend（macOS 上 ONNX 是 CPU 但 torch 是 MPS，仍可用）；
  // 探测未完成时不臆断，保持可选
  const sepGpuReady = backend === null || backend.roformerReady !== false;
  const torchLabel = backend?.torchBackend === 'mps' ? 'MPS'
    : backend?.torchBackend === 'cuda' ? 'CUDA' : '';
  return (
    <div className="settings">
      <section className="settings__section">
        <h3 className="section-title">伴奏来源</h3>
        <div className="settings__radios">
          <label>
            <input
              type="radio"
              name="accompaniment-source"
              checked={config.accompanimentSource === 'uvr'}
              onChange={() => onPatch({ accompanimentSource: 'uvr' })}
            />
            自动从视频里分离伴奏
          </label>
          <label>
            <input
              type="radio"
              name="accompaniment-source"
              checked={config.accompanimentSource === 'imported'}
              onChange={() => onPatch({ accompanimentSource: 'imported' })}
            />
            导入官方伴奏文件
          </label>
        </div>
        {config.accompanimentSource === 'uvr' && (
          <label className="field">
            <span className="field__label">分离模型</span>
            <select
              className="select"
              value={config.separationModel}
              onChange={(e) => onPatch({ separationModel: e.target.value })}
            >
              <option value="">
                {torchLabel ? `自动（Karaoke 优先 · ${torchLabel} 加速）` : '自动（优先硬件加速，不可用则 MDX/CPU）'}
              </option>
              {SEPARATION_MODELS.filter((m) => m.filename !== 'UVR-MDX-NET-Inst_HQ_3.onnx').map((m) => (
                <option key={m.filename} value={m.filename} disabled={m.gpu && !sepGpuReady}>
                  {m.label}{m.gpu && !sepGpuReady ? '（需 GPU / MPS 运行时）' : ''}
                </option>
              ))}
            </select>
            <span className="unit">
              {!sepGpuReady
                ? '未检测到可用的 torch 加速设备（CUDA / MPS）；自动模式将使用 MDX-NET（CPU）'
                : config.separationModel
                  ? (SEPARATION_MODELS.find((m) => m.filename === config.separationModel)?.note
                    ?? 'CPU 就能跑，最快；质量一般')
                  : (backend?.autoSeparationModel
                    ? `自动：用 ${separationModelLabel(backend.autoSeparationModel)} 走 ${torchLabel}（Karaoke 优先，缺失时回落 BS-Roformer / MDX）`
                    : '自动：未找到 Roformer 模型，将用 MDX（CPU）；可用 `npm run resources:fetch-optional` 下载')}
            </span>
          </label>
        )}
        {config.accompanimentSource === 'imported' && (
          <div className="settings__row">
            <button className="btn btn--ghost btn--sm" type="button" onClick={onSelectAccompaniment}>
              选择伴奏文件
            </button>
            {config.accompanimentPath && (
              <span className="settings__path" title={config.accompanimentPath}>
                {config.accompanimentPath.split(/[\\/]/).pop()}
              </span>
            )}
          </div>
        )}
      </section>

      <section className="settings__section">
        <h3 className="section-title">压缩档</h3>
        <label className="field">
          <span className="field__label">画质与体积的取舍</span>
          <select
            className="select"
            value={config.compressionPreset}
            onChange={(e) =>
              onPatch({ compressionPreset: e.target.value as CompressionPreset })
            }
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {COMPRESSION_PRESETS[p].label} · CRF {COMPRESSION_PRESETS[p].crf}
              </option>
            ))}
          </select>
          <p className="note-inline">
            {config.compressionPreset === 'quality'
              ? '几乎无损，体积与源持平或略大。'
              : config.compressionPreset === 'size'
                ? '约省 40% 空间，快速运动画面能看出差别。'
                : '约省 20% 空间，画质基本无感。'}
          </p>
        </label>
      </section>

      <section className="settings__section">
        <h3 className="section-title">输出文件</h3>
        <div className="settings__row">
          {/* 编码格式比容器更影响「占多少空间」，排在最前 */}
          <label className="field">
            <span className="field__label">编码</span>
            <select
              className="select"
              value={config.videoCodec}
              onChange={(e) => onPatch({ videoCodec: e.target.value as VideoCodec })}
            >
              <option value="av1">AV1 · 同画质省约 36%</option>
              <option value="hevc">H.265 · 兼容性最广</option>
            </select>
          </label>
          {/* 容器与扩展名是同一个决定的两种表达：容器决定封装格式，扩展名只是文件名后缀。
              对用户而言只有一个问题——要 MP4 还是 MKV。拆成两个下拉既多一个无意义决策，
              又能组合出「MP4 容器 + .mkv 后缀」这种骗人的文件，所以合并成一个。 */}
          <label className="field">
            <span className="field__label">格式</span>
            <select
              className="select"
              value={config.container}
              onChange={(e) => {
                const container = e.target.value as OutputContainer;
                onPatch({ container, extension: container === 'mkv' ? '.mkv' : '.mp4' });
              }}
            >
              <option value="mp4">MP4 · 点歌系统通用</option>
              <option value="mkv">MKV · 多轨道，兼容性差</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">速度</span>
            <select
              className="select"
              value={config.videoEncoder}
              onChange={(e) => onPatch({ videoEncoder: e.target.value as VideoEncoderPreference })}
            >
              <option value="software">
                {config.videoCodec === 'av1' ? '软件编码 · SVT-AV1（慢）' : '画质优先 · 软件编码（慢）'}
              </option>
              <option value="hardware" disabled={hwKnown && !hwAvailable}>
                {hwKnown && !hwAvailable
                  ? '硬件编码 · 本机不可用'
                  : config.videoCodec === 'av1'
                    ? '硬件编码 · NVENC（快）'
                    : '速度优先 · 硬件编码（快，画质略差）'}
              </option>
            </select>
            {hwFallenBack && (
              <p className="note-inline" role="status">
                {config.videoCodec === 'av1'
                  ? '本机没有可用的 AV1 硬件编码器，转换时会回落 SVT-AV1 软件编码。'
                  : `本机没有可用的 HEVC 硬件编码器（${backend?.reasonText ?? '探测未通过'}），转换时会回落软件编码。`}
              </p>
            )}
          </label>
        </div>

        {/* 命名已显式化，不再暴露「同名冲突 / 后缀」；内部仍保留「加 -伴奏版、绝不覆盖源」兜底 */}
      </section>

      <section className="settings__section">
        <h3 className="section-title">详细模式</h3>
        <label className="switch">
          <input
            type="checkbox"
            checked={detailedMode}
            onChange={(e) => {
              onDetailedModeChange(e.target.checked);
              onPatch({ detailedMode: e.target.checked });
            }}
          />
          <span>显示阶段、编码后端、压缩比等细节（可随时关掉）</span>
        </label>
      </section>
    </div>
  );
}
