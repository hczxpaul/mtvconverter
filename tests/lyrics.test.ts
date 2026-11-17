/**
 * 歌词解析测试（vitest / Node 环境，不触网、不启子进程、不依赖模型权重）。
 * import ../src/main/lyrics/index 导出的纯函数，按 §6.5 / §6.7 / §7.9 断言正常与边界：
 *   空、哨兵、超长时间轴、双语、±ms 偏移、元信息行、SRT 时间轴。
 *
 * 实现签名（与 lyrics-dev 落盘代码对齐）：
 *   parseSongId(input) / isLyricsEmpty(raw) / parseLrc(text) / parseSrt(text)
 *   toAssText(lines, config: JobConfig, durationSec) —— 偏移取自 config.lyrics.offsetMs，裁剪到 durationSec。
 */
import { describe, it, expect } from 'vitest';
import {
  parseSongId, isLyricsEmpty, parseLrc, parseSrt, toAssText,
} from '../src/main/lyrics/index';
import { mergeTranslation } from '../src/main/lyrics/parse';
import { makeDefaultConfig } from '../src/shared/contracts';
import type { JobConfig, LyricsVersion } from '../src/shared/contracts';

/** 构造测试用 JobConfig：默认原文版本、双语两行，便于断言文本。 */
function config(patch: { offsetMs?: number; version?: LyricsVersion; bilingualLines?: 1 | 2 } = {}): JobConfig {
  const c = makeDefaultConfig();
  c.lyrics.offsetMs = patch.offsetMs ?? 0;
  c.lyrics.version = patch.version ?? 'original';
  if (patch.bilingualLines) c.subtitle.bilingualLines = patch.bilingualLines;
  return c;
}

function countDialogues(ass: string): number {
  return ass.split('\n').filter((l) => /^\s*Dialogue:/i.test(l)).length;
}

describe('parseSongId（§6.5 / §7.9：仅网易云单曲链接或纯数字 ID）', () => {
  it('纯数字 ID 原样返回', () => {
    expect(parseSongId('1903172569')).toBe('1903172569');
    expect(parseSongId('  1903172569  ')).toBe('1903172569');
    expect(parseSongId('0')).toBe('0');
  });

  it('网易云单曲链接（含 hash 路由）提取数字 ID', () => {
    expect(parseSongId('https://music.163.com/#/song?id=1903172569')).toBe('1903172569');
    expect(parseSongId('music.163.com/#/song?id=12345&other=x')).toBe('12345');
    expect(parseSongId('https://music.163.com/song?id=999')).toBe('999');
  });

  it('其它平台 / 非法 / 空 / 非字符串一律返回 null（不误判为 ID）', () => {
    expect(parseSongId('')).toBeNull();
    expect(parseSongId('   ')).toBeNull();
    expect(parseSongId('not-a-number')).toBeNull();
    expect(parseSongId('https://open.spotify.com/track/abc')).toBeNull();
    expect(parseSongId('https://music.163.com/#/song?id=abc')).toBeNull();
    expect(parseSongId('https://music.163.com/#/song')).toBeNull();
    expect(parseSongId('https://163.com.evil.com/song?id=1')).toBeNull(); // 域名伪造
    expect(parseSongId(null as unknown as string)).toBeNull();
  });
});

describe('isLyricsEmpty（§6.5 / §6.6 空歌词哨兵判定）', () => {
  it('空串 / 纯空白 / 纯换行 → true', () => {
    expect(isLyricsEmpty('')).toBe(true);
    expect(isLyricsEmpty('   \n\n  ')).toBe(true);
  });

  it('哨兵文本「暂无歌词」/「纯音乐」/ uncollected=true → true', () => {
    expect(isLyricsEmpty('[00:00.00]暂无歌词')).toBe(true);
    expect(isLyricsEmpty('纯音乐，请欣赏')).toBe(true);
    expect(isLyricsEmpty('uncollected=true')).toBe(true);
    expect(isLyricsEmpty('[00:00.00]暂无文本')).toBe(true);
  });

  it('仅元信息行 / 纯时间戳行 → true', () => {
    expect(isLyricsEmpty('[ar:歌手]\n[ti:标题]\n[al:专辑]\n[offset:0]')).toBe(true);
    expect(isLyricsEmpty('[00:00.00]\n[00:01.00]')).toBe(true);
  });

  it('含有效歌词文本 → false（元信息行不影响判定）', () => {
    expect(isLyricsEmpty('[00:05.65]无人知晓')).toBe(false);
    expect(isLyricsEmpty('[ti:标题]\n[00:05.65]无人知晓')).toBe(false);
    expect(isLyricsEmpty('[00:00.00]作词 : 某某\n[00:11.93]无数面孔闪回脑海')).toBe(false);
  });

  it('非字符串输入 → true（防御）', () => {
    expect(isLyricsEmpty(null as unknown as string)).toBe(true);
  });
});

describe('parseLrc（§6.7 LRC 解析）', () => {
  it('正常两行：时间戳换算毫秒、文本正确、前句 endMs 由下句推导', () => {
    const lines = parseLrc('[00:05.65]无人知晓\n[00:11.93]无数面孔闪回脑海');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ startMs: 5650, endMs: 11930, text: '无人知晓' });
    expect(lines[1].startMs).toBe(11930);
    expect(lines[1].text).toBe('无数面孔闪回脑海');
    expect(lines[1].endMs).toBeUndefined(); // 末句留给 ASS 裁剪
  });

  it('3 位小数与分进位正确', () => {
    const lines = parseLrc('[00:01.234]甲\n[01:02.003]乙');
    expect(lines[0].startMs).toBe(1234);
    expect(lines[1].startMs).toBe(62003);
  });

  it('过滤元信息行、纯时间戳行、空行', () => {
    const lines = parseLrc('[ar:歌手]\n[ti:标题]\n[offset:0]\n[00:01.00]\n\n[00:02.00]你好');
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('你好');
  });

  it('同一行多个时间标签展开为多句', () => {
    const lines = parseLrc('[00:01.00][00:31.00]副歌');
    expect(lines.map((l) => l.startMs)).toEqual([1000, 31000]);
    expect(lines.every((l) => l.text === '副歌')).toBe(true);
  });

  it('同时间戳双语合并：原文在上、翻译在下', () => {
    const lines = parseLrc('[00:01.00]原文\n[00:01.00]译文');
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('原文');
    expect(lines[0].translation).toBe('译文');
  });

  it('乱序行按时间戳升序排列', () => {
    const lines = parseLrc('[00:09.00]后\n[00:01.00]先');
    expect(lines.map((l) => l.text)).toEqual(['先', '后']);
  });

  it('空 / 非字符串 / 超长时间轴边界', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc('无时间戳的纯文本')).toEqual([]);
    expect(parseLrc(null as unknown as string)).toEqual([]);
    const long = parseLrc('[99:59.99]晚于视频时长');
    expect(long).toHaveLength(1);
    expect(long[0].startMs).toBeGreaterThan(3 * 60 * 1000); // 解析层不裁剪，裁剪在 toAssText
  });
});

describe('parseSrt（§6.7 SRT 解析）', () => {
  it('正常块：序号、`,mmm` 时间轴、文本', () => {
    const srt = '1\n00:00:05,648 --> 00:00:11,930\n无人知晓';
    const lines = parseSrt(srt);
    expect(lines).toHaveLength(1);
    expect(lines[0].startMs).toBe(5648);
    expect(lines[0].endMs).toBe(11930);
    expect(lines[0].text).toBe('无人知晓');
  });

  it('毫秒分隔符支持 `.`；多块按时间排序', () => {
    const srt = [
      '2', '00:00:10.000 --> 00:00:12.000', '第二句', '',
      '1', '00:00:01,500 --> 00:00:02,500', '第一句',
    ].join('\n');
    const lines = parseSrt(srt);
    expect(lines.map((l) => l.text)).toEqual(['第一句', '第二句']);
    expect(lines[0].startMs).toBe(1500);
  });

  it('块内双行文本 → 原文 + translation', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n原文\n译文';
    const lines = parseSrt(srt);
    expect(lines[0].text).toBe('原文');
    expect(lines[0].translation).toBe('译文');
  });

  it('空 / 无时间轴 / 非字符串 → []', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseSrt('没有时间轴的文本')).toEqual([]);
    expect(parseSrt(null as unknown as string)).toEqual([]);
  });
});

describe('mergeTranslation（在线原文 + tlyric 按时间戳合并）', () => {
  it('同时间戳补翻译，不同时间戳不误合，空翻译数组原样返回', () => {
    const original = parseLrc('[00:01.00]甲\n[00:02.00]乙');
    const translated = parseLrc('[00:01.00]甲译\n[00:09.00]无关');
    const merged = mergeTranslation(original, translated);
    expect(merged[0].translation).toBe('甲译');
    expect(merged[1].translation).toBeUndefined();
    expect(mergeTranslation(original, [])).toBe(original);
  });
});

describe('toAssText（§6.7 / §7.9 / V-09：ASS 生成、偏移、时长裁剪、双语、空等价）', () => {
  it('lines 为空仍返回合法 ASS 骨架（0 个 Dialogue），保证三种「无字幕」结果等价', () => {
    const ass = toAssText([], config(), 3);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('[Events]');
    expect(ass).toContain('Format: Layer, Start, End, Style');
    expect(countDialogues(ass)).toBe(0);
  });

  it('正常歌词生成 Dialogue，中文原样写入不缺字', () => {
    const lines = parseLrc('[00:01.00]无人知晓\n[00:02.00]无数面孔闪回脑海');
    const ass = toAssText(lines, config(), 3);
    expect(countDialogues(ass)).toBe(2);
    expect(ass).toContain('无人知晓');
    expect(ass).toContain('无数面孔闪回脑海');
  });

  it('±ms 全局偏移：offsetMs=+500 时起点后移，负偏移起点夹到 0', () => {
    const lines = [{ startMs: 1000, endMs: 2000, text: '甲' }];
    const plus = toAssText(lines, config({ offsetMs: 500 }), 3);
    expect(plus).toMatch(/Dialogue: 0,0:00:01\.50,0:00:02\.50/);
    const minus = toAssText(lines, config({ offsetMs: -2000 }), 3);
    // rawStart=-1000 / rawEnd=0 → clamp 后 end<=start，整句落在视频外被丢弃
    expect(countDialogues(minus)).toBe(0);
    expect(minus).toContain('[Events]'); // 仍返回合法 ASS 骨架，保证「无字幕」等价
  });

  it('负偏移仅截断句首：句尾仍在视频内时 Start 夹到 0:00:00.00、End 保持偏移后值', () => {
    // start 1000 + (-2000) = -1000 < 0；end 5000 + (-2000) = 3000 仍在 3s 视频内
    // → 生成 1 条 Dialogue，头部截断显示，不出现负时间、不整句丢弃
    const lines = [{ startMs: 1000, endMs: 5000, text: '甲' }];
    const ass = toAssText(lines, config({ offsetMs: -2000 }), 3);
    expect(countDialogues(ass)).toBe(1);
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,甲');
  });

  it('超长时间轴裁剪到视频时长：视频外的句子丢弃、末句结束不超过 durationSec', () => {
    const lines = [
      { startMs: 1000, endMs: 10000, text: '甲' }, // 末句结束应裁到 3.00
      { startMs: 5000, endMs: 6000, text: '乙' },  // 完全在视频外 → 丢弃
    ];
    const ass = toAssText(lines, config(), 3);
    expect(countDialogues(ass)).toBe(1);
    expect(ass).toContain('0:00:03.00');
    expect(ass).not.toContain('乙');
  });

  it('双语：bilingual/2 行为「原文\\N译文」，translation 版本只显示译文', () => {
    const lines = [{ startMs: 1000, endMs: 2000, text: '原文', translation: '译文' }];
    const bi = toAssText(lines, config({ version: 'bilingual', bilingualLines: 2 }), 3);
    expect(bi).toContain('原文\\N译文');
    const tr = toAssText(lines, config({ version: 'translation' }), 3);
    expect(tr).toContain(',,译文');
    expect(tr).not.toContain('原文\\N译文');
  });

  it('bilingualLines=1 压成单行；花括号被移除避免 override tag 注入', () => {
    const lines = [{ startMs: 1000, endMs: 2000, text: '原{文}', translation: '译文' }];
    const one = toAssText(lines, config({ version: 'bilingual', bilingualLines: 1 }), 3);
    expect(one).toContain('原文 译文'); // 花括号已清理、两行压成一行
    expect(one).not.toContain('{');
  });
});
