# MTV Converter

把只有原唱音轨的音乐 MV / 现场视频，一键转换成点歌系统可直接识别的**双音轨 MTV 文件**（`a:0` 原唱 / `a:1` 伴奏），可选把歌词烧录进画面。

## 它解决什么问题

点歌系统要认一份 MV，通常要求视频里同时有「原唱」和「伴奏」两条音轨，并带可同步的歌词字幕。手工做这件事要分音轨、找伴奏、对齐、压视频、烧字幕，步骤繁琐且容易出错。

MTV Converter 把这些步骤串成一条流水线：拖入视频 → 自动生成或导入伴奏 → 取词校对 → 一次编码输出双音轨成品。全程本地处理，原分辨率、音画对齐，输出为通用的 MP4。

## 主要功能

- **伴奏**：UVR MDX-Net 模型本地分离，或直接导入现成官方伴奏
- **编码**：默认 AV1（同画质比 H.265 省约 36% 码率），可选 H.265；画面与字幕在同一次编码中完成，无二次损失
- **双音轨**：固定 `a:0` 原唱、`a:1` 伴奏，写清音轨标题，点歌系统按内容自动识别
- **歌词字幕**：在线 / 本地 LRC / 手工粘贴三种取词方式，ASS 实时预览、逐句打点校对，烧录进画面所见即所得
- **播放预览**：输入视频直接播放，输出成品可在应用内切换原唱 / 伴奏试听
- **可靠输出**：音画对齐、时长一致、21 项自动校验；支持取消与断点续跑

## 开始使用

### 安装

下载对应平台的安装包（`release/`）：

| 平台 | 安装包 |
| --- | --- |
| macOS 13+（Apple Silicon） | `MTV Converter-1.0.0-arm64.dmg` |
| Windows 10/11（x64） | `MTV Converter-Setup-1.0.0.exe` |

macOS 首次打开若被 Gatekeeper 拦截，右键「打开」或在「系统设置 → 隐私与安全性」放行。

### 首次准备（可选）

「自动生成伴奏」依赖本地 Python 运行时（约 1.1 GB，不随安装包分发），首次使用时让程序自动准备即可；也可以直接「导入官方伴奏」，无需这一步。FFmpeg 与字体已随包，无需单独安装。

### 使用流程

1. 拖入或选择一段只有原唱的 MV
2. 选择伴奏来源：自动生成，或导入官方伴奏文件
3. （可选）取歌词、校对时间轴、设置字幕样式
4. 点「开始转换」，完成后在预览里切换音轨试听

## 关于

基于 Electron + React + TypeScript 构建，支持 macOS（Apple Silicon）与 Windows（x64）。源码采用 [MIT 许可证](LICENSE)，第三方组件的许可与用途说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 致谢

本工具站在以下开源项目与服务的肩膀上，特此致谢：

- **Ultimate Vocal Remover（UVR）** — Anjok07 / aufr33 训练的 MDX-Net 伴奏分离模型（MIT）
- **audio-separator** — Nomad Karaoke 提供的可脚本化分离后端（MIT）
- **FFmpeg / FFprobe** — GPL-3.0 构建，承担探测、编码与字幕烧录
- **Noto Sans CJK SC** — Adobe / Google 的开源中文字体（SIL OFL 1.1）
- **歌词服务** `lyric.photix.cc` — 提供在线歌词查询（不可商用，本工具仅作个人学习交流用途）
- **Electron / React / hls.js / zod / Vite / TypeScript / Vitest** — 构建与运行的基础设施

各组件完整许可与用途说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
