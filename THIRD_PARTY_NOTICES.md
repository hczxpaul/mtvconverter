# 第三方声明

- **Ultimate Vocal Remover（UVR）模型**（Anjok07 / aufr33 训练）：模型权重 MIT。本工具使用其 MDX-Net 伴奏分离模型，按官方 README 要求署名 UVR 及开发者。模型权重不内置，联网按需下载并做 SHA256 校验。
- **audio-separator**（Nomad Karaoke，MIT）：作为可脚本化的分离后端被调用（`resources/uvr/launch_separator.py` 为启动垫片，固定 CPU 执行后端以规避 CoreML 对 MDX 模型算子不支持）。分离运行时安装在用户数据目录，不随安装包分发。
- **FFmpeg / FFprobe**：本工具以子进程 argv 数组调用。随包的 `resources/bin` 为 **GPL-3.0 构建**（`--enable-gpl` + `libx264`/`libx265`），并启用 `libass`、`fontconfig`、`freetype`、`harfbuzz`、VideoToolbox 与 HLS muxer；分发该二进制须一并保留 GPL 许可与对应源码获取方式（<https://ffmpeg.org/download.html>）。用户也可通过 `MTVC_FFMPEG_PATH` 指向自有构建。
- **Noto Sans CJK SC**（Adobe / Google，SIL Open Font License 1.1）：随包字幕字体，位于 `resources/fonts`。
- **Electron / React / hls.js / zod / Vite / TypeScript / Vitest**：见 `package.json` 与 `package-lock.json` 中各自许可。
- **歌词服务** `https://lyric.photix.cc/`：其页面声明「不可以商用，仅供个人学习交流」。本工具为个人自用，仅发送用户主动提供的歌曲 ID，不上传媒体文件；不内置任何歌词内容。
- **HEVC / H.265**：存在专利池。个人自用场景下随包分发编解码器须保留第三方许可文件。

本文件不构成法律意见。
