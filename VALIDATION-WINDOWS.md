# Windows 端验证报告（2026-11-18）

> 目标：在 Windows 机器上复现 macOS 已跑通的完整能力（转码 / 分离 / 字幕烧录 / 双音轨封装 / 打包），
> 并交付可分发的 NSIS 安装包。本文件是**本次实测记录**，不是设计文档；设计权威仍是
> `docs/MTV转换器-设计文档与开发方案.md`。当前进展活页见 `handoff.md`。

## 1. 验证环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 10.0.26300（x64） |
| CPU / GPU | NVIDIA GeForce RTX 4070 Ti SUPER 16GB / 驱动 617.42（NVENC 可用） |
| Node / npm | v22.22.2 / 10.9.7 |
| Python | 3.12.6（`%LOCALAPPDATA%\Programs\Python\Python312`，用于分离运行时） |
| FFmpeg（随包） | gyan `ffmpeg-7.1-full_build`：libass / libx265 / libx264 / libsvtav1 / nvenc / libvmaf |
| 构建位置 | `C:\Users\hczxp\mtvc-build\mtvconverter`（项目在 NAS SMB 共享上，直接在共享里 `npm ci` 慢到不可用） |

## 2. 结果总览

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 0 错误（主进程 + 渲染层双工程） |
| 单元测试 | `npm test` | **103 项 / 7 文件全过**（含 5 项分离后端校正用例） |
| 构建 | `npm run build` | 成功（renderer JS 814.9 kB / CSS 25.5 kB） |
| 资源自检 | `npm run resources:check` | 核心转码就绪，**0 项可选资源缺失**，libass 检出，模型 SHA256 通过 |
| 媒体冒烟 | `npm run smoke` | V-01~V-05 / V-07 / V-12 / V-13 + validate 21 项全过；HLS master 2 条 audio rendition；**V-09 字幕烧录 YAVG=2.16** |
| 分离验证 | `npm run verify:uvr` | **U-01~U-04 全绿**，MDX-Net 真实推理 6s → 14.8s（CPU） |
| 管线端到端 | `npm run verify:e2e -- --source <真实MV>` | **E-01~E-09 全绿**：258s 1080p MV → 真实分离 → ASS 烧录 → 双音轨 **AV1**，194.8s，58.4MB → 50.0MB（−14.4%） |
| 安装包 | `electron-builder --win nsis` | `release/MTV Converter-Setup-1.0.0.exe`（190 MB），静默安装 → 启动 → 界面渲染正常 |
| 安装版实跑 | 在安装版里经 preload 桥驱动真实任务 | **COMPLETED**，21 项校验 passed=true，HEVC 硬件档 258s MV → 150s（含 CPU 分离），61.99MB |

## 3. 本轮修复的 Windows 缺陷（都有实测证据）

1. **字幕滤镜在 Windows 上必然失败**（`src/main/media/runner.ts`）
   `-vf` 的值在 FFmpeg 内部被解析两次（选项值 → 滤镜参数），单层 `\:` 在第一层就被吃掉，
   剩下的 `C:` 被当成选项分隔符 → `AVFilterGraph: Error parsing a filter description`。
   实测：`subtitles=C\:/x/a.ass` 失败，`C\\:/x/a.ass` 成功；含空格 / 逗号 / 分号 / 中文的目录同样只有双层转义能过。
   修法：`escapeFilterPath()` 所有特殊字符一律写两个反斜杠（POSIX 普通路径无差异）。

2. **HEVC 硬件编码器自检必失败**（`src/main/hardware/index.ts`）
   1 秒自检用 `128x128` 样本，低于 NVENC 的 HEVC 最小帧尺寸 →
   `InitializeEncoder failed: invalid param (8): Frame dimensions are less than the minimum supported value`。
   结果：**每台 N 卡 Windows 机器都被误判成「硬件编码器不可用」并静默降级 CPU**（实测降级日志
   `HW_HEVC_SELFTEST_FAILED`）。修法：样本改 `256x256`，修复后探测返回 `HW_CUDA_OK` /
   `hevc_nvenc` / `h264_nvenc`，1080p NVENC 实际编码成功。

3. **NVENC 质量参数映射错误，输出体积约 1.4 倍源**（`src/main/media/index.ts`）
   原实现把 x265 的 CRF 直接当 NVENC 的 `-cq`。实测（1080p / 60s）：
   `cq=28` → **138%** 源体积；`cq=33` → 84%（≈ x265 crf28 的 85%，VMAF 94.7 vs 93.0）；
   `-cq` 不加 `-rc vbr -b:v 0` 同样是 138%。
   修法：`cq = crf + 5` + `-rc vbr -b:v 0 -preset p5 -tune hq`。安装版实跑：V-13 由 161% → **106%**。

4. **测试写死 POSIX 路径**（`tests/jobs.test.ts`）
   7 项输出路径断言硬编码 `/tmp/歌曲/歌-伴奏版.mp4`，Windows 上 `path.join` 产反斜杠 → 全假失败。
   修法：期望值一律用 `path.join()` 拼。

5. **PATH 兜底在 Windows 上形同虚设**（`src/main/config/ConfigService.ts`）
   `executableOnPath()` 调 `which`（Windows 没有）→ spawn ENOENT → 永远返回空。
   修法：win32 改用 `where`，取首行。

6. **分离后端标注与实际不符（两端都有）**（`hardware/*`、`accompaniment/index.ts`）
   探测阶段按「有 N 卡 ⇒ CUDA」推断，但随包装的是 `onnxruntime`（CPU 版，provider 只有
   `AzureExecutionProvider` / `CPUExecutionProvider`），实测 258s MV 的分离全程 CPU，
   界面/日志却写 `cuda`（macOS 侧同理写 `mps`，而 MDX 走 CPU）。
   修法：`AccompanimentPort.onnxProviders?()` 读运行时真实 provider；`HardwareProbe.setSeparationProviders()`
   由组装层注入，`detect()` 内部用 `reconcileSeparation()` 校正 `separationBackend` 与 `reasonText`。
   实测现为：`separationBackend=cpu / separationProvider=CPUExecutionProvider / encodeEncoder=hevc_nvenc`，
   文案「已启用 NVIDIA CUDA 分离 + HEVC / NVENC 硬件编码；分离实际走 CPU（…未安装 GPU 版 onnxruntime）」。

7. **「速度优先」不感知本机有没有硬件编码器**（渲染层）
   没有 NVENC / VideoToolbox 的机器也能选，选了在编排层静默回落 libx265，用户看不出区别。
   修法：`health()` 的 `backend` 透传到「更多设置」与「输出摘要」——
   无硬件编码器时该选项禁用并改文案为「速度优先 · 本机无硬件编码器」，
   已选硬件却不可用时补一行说明；摘要显示 `H.265 · 硬件（hevc_nvenc）` 或 `H.265 · 硬件不可用，走软件`。

另外两处配套改动（非代码缺陷）：
- `resources/uvr/launch_separator.py`：CPU-only 垫片**只在 darwin 生效**（Windows 上默认选择即可，强钉 CPU 会白丢 GPU 机会）。
- `resources/manifest.json` / `scripts/prepare-resources.mjs`：补 `audioread` 依赖、Windows 优先装 CPU 版 torch（详见 §5）。

## 4. 打包与交付

- 配置：`electron-builder.yml` 的 `mac.extraResources` / `win.extraResources` **按平台只带本平台二进制**
  （否则 win 包白塞 98MB mac 二进制、mac 包白塞 296MB exe）。已核对 `resources/resources/bin/` 只有 `ffmpeg.exe` / `ffprobe.exe`。
- 产物：`release/MTV Converter-Setup-1.0.0.exe`（190 MB，NSIS，可选安装目录、建桌面快捷方式）。
- **本机打包的两个限制（不影响运行，但要知情）**：
  1. `winCodeSign` 包里含 macOS 符号链接，非管理员 / 未开「开发者模式」时 7-Zip 解压失败
     （`Cannot create symbolic link ... libcrypto.dylib`），electron-builder 直接中断。
     本次用「手工解压 + `MTVC_WINCODESIGN_DIR` 指向已解压目录」绕过（该环境变量是本地临时补丁，
     `node_modules` 里的改动**不入库**，见 handoff）。
  2. 因此本次加 `-c.win.signAndEditExecutable=false`：**exe 不带自定义图标与版本信息**（项目本来也没有 icon 资源，
     electron-builder 提示 `application icon is not set`），签名本来也没有证书。需要正式发布时：
     开开发者模式 / 管理员权限 + 配置 `CSC_LINK` 后去掉该开关。

## 5. Windows 环境特有的坑

- **SMB 共享上 `npm ci` 不可用**：实测 21 分钟仍有半数包未落地。改为源码留共享、构建在本地盘做，产物拷回 `release/`。
- **`github.com` / `huggingface.co` 直连失败**：Electron 用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；
  electron-builder 二进制用 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`；
  UVR 模型用 `https://gh-proxy.com/https://github.com/...` 代理（实测 25MB/s）。
- **`audio-separator 0.48` 少声明 `audioread`**：`uvr_lib_v5.spec_utils` 顶层 `import audioread`，但包元数据没有，
  librosa≥1.0 也不再带 → `ModuleNotFoundError`，表现为 `E_UVR_FAILED`（退出码 1）。
  已写进 `manifest.uvr.runtime.packages`，`resources:setup-uvr` 会一起装。
- **PyPI 的 Windows torch 自带 CUDA（约 2.5GB）**，而分离固定 CPU，装 CUDA 版纯浪费；
  `prepare-resources` 现在在 Windows 上先装 `--index-url https://download.pytorch.org/whl/cpu` 的 CPU 版（本次 3.5 分钟装完）。
- **agent/CI 环境注入的 `ELECTRON_RUN_AS_NODE=1` 会让 GUI 应用当成 Node 跑**（`app` 为 undefined，进程秒退）。
  验证 GUI 时必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` 启动；用户正常双击不受影响。
- **vitest 在受限环境会因写 `%TEMP%` 被拦（EPERM）而丢测试文件**，表现为「77 / 88 项」飘忽。
  把 `TMPDIR` / `TEMP` / `TMP` 指到项目内可写目录即稳定 98 项。与项目代码无关。

## 6. 已知问题 / 待决

1. **音频比视频短约 150ms 的源会硬失败**：用 `-ss/-t -c copy` 剪出的 60s 片段（视频 60.16s / 音频 60.006s）
   在 V-08-DRIFT 上报 **120ms > 40ms** 而 FAILED；同一片段在 AV1 与 HEVC 下都复现，说明与编码器无关，
   是「源音轨本身短于画面」这条路径上 `apad` 补齐没覆盖到输出最后一个音频包。整段真实 MV（257.64s / 257.6423s）不受影响。
   与平台无关，Mac 侧应同样会失败，需要单独定口径（放宽阈值 / 输出前统一 `-shortest` / 明确视为不合格素材）。
2. **硬件档体积仍略大于源**：NVENC cq33 在 1080p 已压过的源上 106%，软件 AV1 为 86%。
   属「源已高效压缩 + 硬件编码效率低」的已知取舍；`targetRatio` 本就是提示值，V-13 记 warn 不阻断。
3. **分离 GPU 结论：能做到自适应，但 MDX 模型上不划算**（`resources/uvr/launch_separator.py` + `manifest.uvr.runtime.gpu`）
   - 垫片已改成按平台选 ONNX provider：**win32** `CUDA → DirectML → CPU`，**darwin** torch 保持 MPS、ONNX 固定 CPU（CoreML 不支持 MDX 算子），`MTVC_UVR_FORCE_CPU=1` 可全局强制 CPU。
   - 实测（RTX 4070 Ti SUPER / 60s 素材 / `UVR-MDX-NET-Inst_HQ_3`）：
     | 配置 | 分离耗时 |
     | --- | --- |
     | CPU（onnxruntime） | 27s / 30s |
     | ONNX 走 CUDA（onnxruntime-gpu，torch 仍 CPU） | 27s / 28s |
     | ONNX 走 DirectML（onnxruntime-directml） | 6s 素材直接报错（ORT 内部 UnicodeDecodeError，底层是 DML 算子失败） |
   - 原因：MDX 的耗时在 numpy/STFT/落盘，不在卷积网络，把 ONNX 放上 GPU 基本无感。
   - 完整 CUDA 链路（torch 也装 cu126）本机**未验证完**：nvidia 依赖约 2.5GB，本机从 download.pytorch.org 只有 <60KB/s，44 分钟没下完，已放弃并回滚 CPU。
   - 因此默认仍是 CPU 运行时；GPU 是显式开关：`npm run resources:setup-uvr:gpu`（会卸掉 CPU 变体、装 CUDA torch + onnxruntime-gpu）。
     `onnxruntime` / `-gpu` / `-directml` 共用同一个顶层模块，脚本已做互斥处理（切换前先卸载）。
4. **exe 无图标 / 无版本信息 / 未签名**（见 §4）。
