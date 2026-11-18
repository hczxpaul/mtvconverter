# MTV Converter

把仅含原唱音轨的音乐 MV / 现场 live 视频，转换为**标准双音轨视频**（`a:0` 原唱 / `a:1` 伴奏）的桌面工具，点歌系统可按内容自动识别。可选从歌词服务取词并烧录字幕，提供应用内预览播放器与音轨切换。

- **视频编码**：默认 **AV1**（同画质比 H.265 省约 36% 码率），可选 **H.265**；单次编码完成画面 + 字幕烧录
- **容器 / 扩展名**：MP4（AV1 → `av01`，H.265 → `hvc1`），输出 `.mp4`
- **伴奏来源**：UVR MDX-Net 模型本地分离，或直接导入官方伴奏
- **字幕**：在线 / 本地 LRC / 粘贴三种来源，渲染为 ASS 所见即所得预览，烧录进画面
- **界面**：三列高密度布局，左侧配置 + 右侧固定预览 + 底部常驻操作带，支持歌词逐句校对

> 功能范围、接口契约与验收标准以 `docs/MTV转换器-设计文档与开发方案.md` 为权威基线。设计与实现有出入时以设计文档为准，并同步更新之。

## 快速上手

### 环境要求

| 项 | 版本 |
| --- | --- |
| Node.js | >= 20（开发验证于 22.22.2） |
| npm | >= 10 |
| Python | 3.10+（仅伴奏分离运行时需要） |
| 操作系统 | macOS arm64 / Windows x64（两端均已实测跑通，见 `VALIDATION-WINDOWS.md`） |

### 安装与运行

```bash
npm ci                      # 安装依赖
npm run typecheck           # 类型检查（主进程 + 渲染层）
npm run build               # 构建：tsc 编译主进程 + Vite 构建渲染层
npm run dev:renderer        # 渲染层开发服务（仅绑 127.0.0.1）
npm run dev:app             # 启动 Electron（需先 build）
```

首次使用「自动生成伴奏」前需准备本地运行时（Python venv + audio-separator + 模型权重，装在 userData 目录，约 1.1 GB，不随安装包分发）：

```bash
npm run resources:check     # 自检：FFmpeg 能力 / libass / 运行时 / 模型 SHA256 / 字体
npm run resources:setup-uvr # 首次准备分离运行时（默认 CPU）
npm run resources:setup-uvr:gpu  # 可选：GPU 分离（Windows：CUDA torch + onnxruntime-gpu，约 +5GB）
```

> **GPU 分离要不要开**：`resources/uvr/launch_separator.py` 已按平台自适应选 ONNX provider
> （Windows `CUDA → DirectML → CPU`；macOS torch 走 MPS、ONNX 固定 CPU，因为 CoreML 不支持 MDX 算子），
> 但实测 MDX-NET 系列模型把 ONNX 放上 CUDA 几乎不提速（60s 素材 27s vs 27s，瓶颈在 numpy/STFT/落盘），
> DirectML 还会直接报错。所以默认装 CPU；只有换 demucs 这类 torch 系模型时才值得开 GPU。
> `MTVC_UVR_FORCE_CPU=1` 可任何平台强制 CPU。

未准备运行时不影响「导入官方伴奏」路径。随包 FFmpeg 7.1 位于 `resources/bin`，按 `resources/manifest.json` 校验：
macOS 是 arm64 静态构建（libass / libx265 / videotoolbox），Windows 是 gyan `7.1-full_build`（libass / libx265 / libsvtav1 / nvenc / libvmaf）。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 主进程 + 渲染层类型检查 |
| `npm test` | 单元 / 契约测试（103 项） |
| `npm run smoke` | 真实 FFmpeg 冒烟：双音轨 + 字幕烧录 + HLS 切轨 |
| `npm run verify:uvr` | 真实 MDX-Net 分离（走编译产物） |
| `npm run verify:e2e` | 完整管线端到端（七阶段） |
| `npm run verify:e2e -- --source <MV文件>` | 直接处理现成 MV（最贴近真实使用） |
| `npm run resources:check` | 外部资源能力自检 |
| `npm run dist:mac` / `npm run dist:win` | 生成平台 unpacked 产物 |
| `npm run dist:mac:dmg` / `npm run dist:win:nsis` | 生成签名安装包 |

> **WorkBuddy / 带 `node-safe-delete` 垫片的环境**：`npm run build` 与打包需前置
> `env -u NODE_OPTIONS -u CODEBUDDY_BROKERED_FS_HOOK_ENABLED`，否则 Vite 清空产物目录会被拦截。

macOS 签名公证需配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 与 Apple 公证环境变量（见 `.env.example`）；未提供证书时按 `electron-builder.yml` 的 `identity: null` 生成未签名本地产物。

Windows 打包（2026-11-18 实测）：

```bash
# GitHub 直连不通时用镜像；winCodeSign 含 macOS 符号链接，非管理员 / 未开开发者模式会解压失败
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win nsis
```

- 无图标资源时 electron-builder 用默认 Electron 图标；未配证书则不签名。
- 解压失败（`Cannot create symbolic link ... libcrypto.dylib`）的绕过方式与正式发布需要的前置条件见 `VALIDATION-WINDOWS.md` §4。
- 打包配置已按平台过滤 `extraResources`，Windows 包只带 `ffmpeg.exe` / `ffprobe.exe`，macOS 包只带 arm64 二进制。

## 项目结构

```
src/
├── shared/       # 冻结契约：DTO / 端口 / IPC / 错误码 / 常量 / RuntimePaths
├── preload/      # MtvBridge 预加载桥（契约一一对应）
├── main/         # 主进程
│   ├── config/ errors/ presentation/   # 配置校验 / 类型化错误 / 提示分级
│   ├── media/    # FFmpeg 探测 / 编码 / 对齐 / 校验
│   ├── accompaniment/                # UVR 分离 / 官方伴奏导入
│   ├── lyrics/   # 在线 / 本地 / 粘贴取词，LRC·SRT → ASS
│   ├── preview/  # 输入直放 + 输出 HLS 双音轨本地预览服务
│   ├── hardware/ # 硬件加速探测与一次性降级
│   ├── jobs/     # JobService 状态机 + PipelineController 七阶段编排
│   └── ipc/      # IPC 控制器（zod 边界校验）
└── renderer/     # React 界面（三列布局 + 歌词校对 + 详情抽屉）
scripts/          # 资源准备 / 冒烟 / UVR 验证 / E2E 管线
tests/            # 单元与契约测试（7 个文件）
docs/             # 设计文档与可视化评审稿
resources/        # 随包资源清单与启动垫片（二进制按需下载，见 .gitignore）
build/            # macOS 签名 entitlements
release/          # 打包产物（不入库）
```

所有模块只依赖 `src/shared/contracts.ts` 与 `src/shared/preload-api.ts`，不得重复定义同名类型、IPC 通道或错误码。

## 文档索引

| 文档 | 性质 | 说明 |
| --- | --- | --- |
| `AGENTS.md` | 规则 | 项目级协作规则，接手必读 |
| `handoff.md` | 活页 | 当前进展、下一步、关键决策与踩坑记录 |
| `docs/MTV转换器-设计文档与开发方案.md` | **权威** | 设计、接口契约与开发方案（v1.3） |
| `docs/MTV转换器-设计概览.html` | 评审稿 | 设计可视化，与 MD 冲突时以 MD 为准 |
| `VALIDATION-WINDOWS.md` | 实测记录 | 2026-11-18 Windows 端：环境、修复清单、打包限制、已知问题 |
| `THIRD_PARTY_NOTICES.md` | 声明 | 第三方许可与用途声明 |

## 验证

完整构建、测试、冒烟与真实素材端到端结果见 `handoff.md` 与 `VALIDATION-WINDOWS.md`。核心链路已用真实 MV 与真实分离模型验证：单音轨 MV → MDX-Net 伴奏分离 → 字幕烧录 → 单次编码 → 双音轨输出。

```bash
npm run typecheck && npm test        # 0 错误 / 103 项单测
npm run smoke                        # 双音轨 + 字幕烧录 + HLS 切轨（真 FFmpeg）
npm run verify:uvr                   # 真实 MDX-Net 分离（U-01~U-04）
npm run verify:e2e -- --source <MV>  # 完整管线（E-01~E-09）
```

## 许可与声明

个人自用项目（`"license": "UNLICENSED"`）。随包 FFmpeg 为 GPL-3.0 构建，UVR / audio-separator 模型、Noto Sans CJK SC 字体各有其许可，详见 `THIRD_PARTY_NOTICES.md`。歌词服务声明不可商用，工具仅发送用户主动提供的歌曲 ID，不上传媒体文件。
