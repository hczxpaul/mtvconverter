/**
 * 输出命名拼装（纯函数，不触磁盘）。
 * 依据 docs §5.2.1：歌手 - 歌曲名 [语言] [版本]，空标签整段省略。
 */
import { describe, it, expect } from 'vitest';
import {
  buildOutputStem, namingProblem, normalizeNaming, pruneNaming, sanitizeFileNamePart,
} from '../src/shared/contracts';

const base = { artists: ['费玉清'], title: '凤凰于飞', language: '', version: '' };

describe('§5.2.1 buildOutputStem', () => {
  it('普通版：只有语言标签', () => {
    expect(buildOutputStem({ ...base, language: '国语' })).toBe('费玉清 - 凤凰于飞 [国语]');
  });

  it('演唱会版：语言 + 版本两个标签', () => {
    expect(buildOutputStem({ ...base, language: '国语', version: '演唱会' }))
      .toBe('费玉清 - 凤凰于飞 [国语] [演唱会]');
  });

  it('多歌手按输入顺序用 & 连接', () => {
    expect(buildOutputStem({ artists: ['刘德华', '舒淇'], title: 'I DO', language: '国语', version: '' }))
      .toBe('刘德华 & 舒淇 - I DO [国语]');
  });

  it('标签留空时整段省略，不留空方括号或双空格', () => {
    expect(buildOutputStem(base)).toBe('费玉清 - 凤凰于飞');
    expect(buildOutputStem({ ...base, language: '  ', version: '  ' })).toBe('费玉清 - 凤凰于飞');
  });

  it('版本写「普通版」等同于不标注', () => {
    expect(buildOutputStem({ ...base, language: '国语', version: '普通版' }))
      .toBe('费玉清 - 凤凰于飞 [国语]');
  });

  it('空白歌手与首尾空格被清理，空项不参与拼接', () => {
    expect(buildOutputStem({ artists: [' 费玉清 ', '', '  '], title: ' 凤凰于飞 ', language: '', version: '' }))
      .toBe('费玉清 - 凤凰于飞');
  });

  it('必填缺失时返回空串，交给调用方回退源文件名', () => {
    expect(buildOutputStem({ artists: [''], title: '凤凰于飞', language: '国语', version: '' })).toBe('');
    expect(buildOutputStem({ artists: ['费玉清'], title: '   ', language: '国语', version: '' })).toBe('');
  });

  it('非法字符替换为空格并折叠，结尾点号去掉', () => {
    expect(buildOutputStem({ ...base, title: 'a/b:c*?', language: '', version: '' }))
      .toBe('费玉清 - a b c');
    expect(buildOutputStem({ ...base, title: '歌...', language: '', version: '' }))
      .toBe('费玉清 - 歌');
  });
});

describe('§5.2.1 sanitizeFileNamePart', () => {
  it('去掉路径分隔符与控制字符，不允许目录穿越', () => {
    expect(sanitizeFileNamePart('../x/y')).toBe('x y');
    expect(sanitizeFileNamePart('a\r\nb')).toBe('a b');
  });
});

describe('§5.2.1 namingProblem', () => {
  it('两项都缺、只缺一项时分别说清', () => {
    expect(namingProblem({ artists: [''], title: '', language: '', version: '' })).toBe('还差歌手、歌曲名');
    expect(namingProblem({ artists: [' '], title: '歌', language: '', version: '' })).toBe('还差歌手');
    expect(namingProblem({ artists: ['人'], title: '', language: '', version: '' })).toBe('还差歌曲名');
  });

  it('填写完整返回 null', () => {
    expect(namingProblem({ ...base, language: '国语', version: '演唱会' })).toBeNull();
  });

  it('不设人为字数上限：长歌手名、长歌名照常通过', () => {
    expect(namingProblem({ ...base, artists: ['x'.repeat(60)] })).toBeNull();
    expect(namingProblem({ ...base, title: '歌'.repeat(120) })).toBeNull();
    expect(namingProblem({ ...base, language: '超长的语言标签名称' })).toBeNull();
  });

  it('歌手人数上限 6 位', () => {
    const artists = Array.from({ length: 7 }, (_, i) => `歌手${i}`);
    expect(namingProblem({ artists, title: '歌', language: '', version: '' })).toBe('歌手最多 6 位');
  });
});

describe('§5.2.1 pruneNaming（启动 / 提交前折掉空行）', () => {
  it('尾部空歌手格被折掉，中间空行保留', () => {
    expect(pruneNaming({ artists: ['费玉清', '', ''], title: '歌', language: '', version: '' }).artists)
      .toEqual(['费玉清']);
    expect(pruneNaming({ artists: ['费玉清', '', '刘德华'], title: '歌', language: '', version: '' }).artists)
      .toEqual(['费玉清', '', '刘德华']);
  });

  it('全空时回到 1 格，不是 0 格', () => {
    expect(pruneNaming({ artists: ['', '', ''], title: '', language: '', version: '' }).artists).toEqual(['']);
    expect(pruneNaming(undefined).artists).toEqual(['']);
  });
});

describe('§5.2.1 normalizeNaming（旧配置兼容）', () => {
  it('undefined / 半截对象补齐为完整形状并至少保留一个空歌手格', () => {
    expect(normalizeNaming(undefined)).toEqual({ artists: [''], title: '', language: '', version: '' });
    expect(normalizeNaming({ title: '歌' })).toEqual({ artists: [''], title: '歌', language: '', version: '' });
    expect(normalizeNaming({ artists: [] })).toEqual({ artists: [''], title: '', language: '', version: '' });
  });
});
