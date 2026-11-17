import { useState } from 'react';
import { COMPRESSION_PRESETS } from '../../shared/contracts';
import type {
  CompressionPreset, JobConfig, OutputConflict, OutputContainer, VideoCodec, VideoEncoderPreference,
} from '../../shared/contracts';

interface Props {
  config: JobConfig;
  onPatch: (patch: Partial<JobConfig>) => void;
  detailedMode: boolean;
  onDetailedModeChange: (v: boolean) => void;
  onSelectAccompaniment: () => void;
}

const PRESETS = Object.keys(COMPRESSION_PRESETS) as CompressionPreset[];

/** L2「更多设置」：伴奏来源、压缩档、容器 / 扩展名、详细模式。默认藏在抽屉里。 */
export function MoreSettings({
  config,
  onPatch,
  detailedMode,
  onDetailedModeChange,
  onSelectAccompaniment,
}: Props) {
  // 「覆盖源文件」的二次确认：非模态，选中后先出确认条，点确认才真正生效
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
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
                : '约省 20% 空间，画质基本无感（实测 VMAF 91.8）。'}
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
          {/* 编码器只对 H.265 有意义：AV1 目前全平台都没有硬件编码器 */}
          <label className="field">
            <span className="field__label">速度</span>
            <select
              className="select"
              value={config.videoCodec === 'av1' ? 'av1' : config.videoEncoder}
              disabled={config.videoCodec === 'av1'}
              title={config.videoCodec === 'av1' ? 'AV1 目前没有硬件编码器，只能用软件编码' : undefined}
              onChange={(e) => onPatch({ videoEncoder: e.target.value as VideoEncoderPreference })}
            >
              {config.videoCodec === 'av1' ? (
                <option value="av1">软件编码</option>
              ) : (
                <>
                  <option value="software">画质优先（慢）</option>
                  <option value="hardware">速度优先（画质略差）</option>
                </>
              )}
            </select>
          </label>
        </div>

        {/* 默认输出目录就是源文件所在目录，扩展名相同必然重名，这里让用户决定怎么处理 */}
        <div className="settings__row">
          <label className="field">
            <span className="field__label">与源文件重名时</span>
            <select
              className="select"
              value={config.outputConflict}
              onChange={(e) => {
                const next = e.target.value as OutputConflict;
                // 覆盖源文件需要在界面上二次确认。这里刻意不用 window.confirm：
                // 同步模态会阻塞渲染线程并进入嵌套 runloop，macOS 下会增加 AppKit 异常的概率。
                if (next === 'overwrite') {
                  setConfirmOverwrite(true);
                  return;
                }
                setConfirmOverwrite(false);
                onPatch({ outputConflict: next });
              }}
            >
              <option value="suffix">另存为（加后缀）</option>
              <option value="overwrite">覆盖源文件</option>
            </select>
          </label>
          {config.outputConflict === 'suffix' ? (
            <label className="field">
              <span className="field__label">后缀</span>
              <input
                className="input"
                type="text"
                maxLength={40}
                value={config.outputSuffix}
                placeholder="-伴奏版"
                onChange={(e) => onPatch({ outputSuffix: e.target.value })}
              />
            </label>
          ) : (
            <p className="field__warn" role="alert">
              转换成功后源 MV 会被替换，建议先备份
            </p>
          )}
        </div>
        {confirmOverwrite && (
          <div className="field__confirm" role="group" aria-live="polite" aria-label="确认覆盖源文件">
            <span>覆盖源文件会把原 MV 直接替换掉，无法恢复。</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                onPatch({ outputConflict: 'overwrite' });
                setConfirmOverwrite(false);
              }}
            >
              确认覆盖
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setConfirmOverwrite(false)}
            >
              取消
            </button>
          </div>
        )}
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
