/**
 * 输出命名：歌手（必填、可多位）/ 歌曲名（必填）/ 语言 / 版本。
 * 文件名由结构化字段拼装，歌手之间不允许手打 `&`，避免名字自带的 & 被误拆。
 */
import { useEffect, useRef, useState } from 'react';
import { NAMING_LIMITS, buildOutputStem, namingProblem, normalizeNaming } from '../../shared/contracts';
import type { NamingConfig } from '../../shared/contracts';

interface Props {
  naming: NamingConfig;
  extension: string;
  onChange: (naming: NamingConfig) => void;
}

const LANGUAGES = ['国语', '粤语', '闽南语', '英语', '日语', '韩语'];
const VERSIONS = ['演唱会', 'Live', '现场', '伴奏', '重制'];

export function NamingPanel({ naming: rawNaming, extension, onChange }: Props) {
  const naming = normalizeNaming(rawNaming);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const composingRef = useRef(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    if (focusIndex === null) return;
    inputsRef.current[focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex]);

  const artists = naming.artists.length > 0 ? naming.artists : [''];
  const problem = namingProblem({ ...naming, artists });
  const stem = buildOutputStem({ ...naming, artists });
  const titleMissing = !naming.title.trim();

  const patch = (next: Partial<NamingConfig>) => onChange({ ...naming, artists, ...next });

  const setArtist = (index: number, value: string) => {
    const next = [...artists];
    next[index] = value;
    patch({ artists: next });
  };

  const addArtist = () => {
    if (artists.length >= NAMING_LIMITS.maxArtists) return;
    const at = artists.length;
    patch({ artists: [...artists, ''] });
    setFocusIndex(at);
  };

  const removeArtist = (index: number) => {
    if (artists.length <= 1) return;
    const next = artists.filter((_, i) => i !== index);
    patch({ artists: next });
    setFocusIndex(Math.max(0, index - 1));
  };

  return (
    <section className="naming" aria-label="输出命名">
      <div className="naming__head">
        <span className="naming__title">输出命名</span>
        <span className="naming__required">必填</span>
        <span className="naming__format mono">歌手 - 歌曲名 [语言] [版本]</span>
      </div>

      <div className="naming__body">
        <div className="naming__field">
          <div className="naming__label">
            歌手
            <small>必填 · + 加一位</small>
          </div>
          <div className="naming__singers">
            {artists.map((name, i) => (
              <div className="naming__cell" key={i}>
                <input
                  ref={(el) => { inputsRef.current[i] = el; }}
                  className="input naming__input"
                  value={name}
                  placeholder="歌手名"
                  title="如：费玉清"
                  aria-label={`歌手 ${i + 1}`}
                  aria-invalid={!name.trim() ? true : undefined}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={() => { composingRef.current = false; }}
                  onChange={(e) => setArtist(i, e.target.value)}
                  onKeyDown={(e) => {
                    // 中文输入法组合期按 Enter 只是上屏，不能当成「新增一位」
                    if (composingRef.current) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addArtist();
                    }
                    if (e.key === 'Backspace' && name === '' && artists.length > 1) {
                      e.preventDefault();
                      removeArtist(i);
                    }
                  }}
                />
                {artists.length > 1 && (
                  <button
                    className="naming__del"
                    type="button"
                    aria-label={`删除第 ${i + 1} 位歌手`}
                    title="删除这一位"
                    onClick={() => removeArtist(i)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {artists.length < NAMING_LIMITS.maxArtists && (
              <button
                className="naming__add"
                type="button"
                aria-label="添加歌手"
                title="添加一位歌手"
                onClick={addArtist}
              >
                +
              </button>
            )}
          </div>
        </div>

        <div className="naming__meta">
          <label className="naming__field">
            <span className="naming__label">歌曲名<small>必填</small></span>
            <input
              className="input"
              value={naming.title}
              placeholder="歌名"
              title="如：凤凰于飞"
              aria-label="歌曲名"
              aria-invalid={titleMissing ? true : undefined}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>
          <label className="naming__field">
            <span className="naming__label">语言<small>可选</small></span>
            <input
              className="input"
              list="naming-language-options"
              value={naming.language}
              placeholder="不标注"
              aria-label="语言标签"
              onChange={(e) => patch({ language: e.target.value })}
            />
            <datalist id="naming-language-options">
              {LANGUAGES.map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
          <label className="naming__field">
            <span className="naming__label">版本<small>可选</small></span>
            <input
              className="input"
              list="naming-version-options"
              value={naming.version}
              placeholder="普通版"
              aria-label="版本标签"
              onChange={(e) => patch({ version: e.target.value })}
            />
            <datalist id="naming-version-options">
              {VERSIONS.map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
        </div>

        <div className="naming__preview">
          <span className="naming__preview-label">将保存为</span>
          <span className="naming__preview-name mono">{stem ? `${stem}${extension}` : '（待填写）'}</span>
        </div>

        {problem && <p className="naming__err" role="status">{problem}</p>}
      </div>
    </section>
  );
}
