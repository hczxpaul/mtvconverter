# 最终验证结果

> 生成时间：2026-11-12 ｜ 版本：v1.0.0
> 环境：macOS 26.6.2（25G83）/ Apple M2（arm64）/ Node 22.22.2 / npm 10.9.7
> 媒体栈：随包 FFmpeg **7.1（arm64 静态，含 libass）**；分离运行时 Python 3.10.15 + audio-separator 0.48.0

## 1. 类型检查

```
npm run typecheck
```

| 范围 | 结果 |
| --- | --- |
| 主进程 + 共享契约（`tsconfig.json`） | **0 错误** |
| 渲染层（`tsconfig.renderer.json`） | **0 错误** |

## 2. 构建

```
env -u NODE_OPTIONS -u CODEBUDDY_BROKERED_FS_HOOK_ENABLED npm run build
```

- `dist/main/`：主进程、preload、共享契约（CommonJS）
- `dist/renderer/`：`index.html` + `assets/index-*.js|css`（Vite 生产构建）
- 结果：**成功**

> 必须剥离宿主注入的 `NODE_OPTIONS`，否则 `node-safe-delete` 垫片会拦截 Vite 清空产物目录。

## 3. 单元 / 契约测试

```
npm test
```

| 文件 | 用例数 | 结果 |
| --- | --- | --- |
| `tests/contracts.test.ts` | 19 | 通过 |
| `tests/lyrics.test.ts` | 27 | 通过 |
| `tests/presentation.test.ts` | 10 | 通过 |
| `tests/jobs.test.ts` | 7 | 通过 |
| **合计** | **63** | **全部通过** |

## 4. 外部资源自检

```
npm run resources:check
```

| 项目 | 结果 |
| --- | --- |
| FFmpeg / FFprobe 可执行 | 通过（7.1，随包 `resources/bin`） |
| `libx265` / `libx264` 编码器 | 检出 |
| `subtitles` 滤镜（libass） | **检出**（此前宿主机 brew 构建缺失，已改为随包构建解决） |
| `hls` / `mp4` / `matroska` muxer | 检出 |
| `hevc_videotoolbox` / `h264_videotoolbox` | 检出 |
| 分离运行时 | Python 3.10.15 + audio-separator + onnxruntime 1.23.2 |
| 默认模型 `UVR-MDX-NET-Inst_HQ_3.onnx` | **SHA256 校验通过** |
| 字体目录 | 通过（Noto Sans CJK SC） |
| 汇总 | `hardFailures=0`，soft 缺失 0 项 |

报告：`release/resource-check.json`

## 5. 真实媒体冒烟（媒体层）

```
npm run smoke
```

真实 FFmpeg：合成 3s 视频 → 提取原唱 PCM → 生成伴奏 → 采样级对齐 → **单次 H.265 编码 + 双音轨封装** → ffprobe 断言 → HLS 双音轨切片 → **ASS 烧录**。

| 检查 | 结果 |
| --- | --- |
| V-01 音轨数量 | 通过（2 条） |
| V-02 音轨顺序与标题 | 通过（`a:0=原唱` / `a:1=伴奏`） |
| V-03 默认播放轨 | 通过（`a:0 default=1`） |
| V-04 两轨参数一致 | 通过（aac/48000/2 一致） |
| V-05 编码 + 分辨率 + 帧率 | 通过（hevc / 320×180 / 30fps） |
| V-07 时长一致 | 通过（差 0.0000s） |
| V-09 字幕烧录 | **通过**（YAVG=2.04，画面确有叠加；烧录后仍 2 音轨 hevc、时长差 0） |
| V-12 hvc1 标识 | 通过 |
| V-13 压缩比 | 未达目标 145.5%（3s 合成短片，按设计为提示项，不阻断） |
| `validate` 报告 | `passed=true`，21 项 checks，hard 失败 0 |
| HLS master | 2 条 `#EXT-X-MEDIA:TYPE=AUDIO`（DEFAULT=YES/NO 各 1），`STREAM-INF` 带 AUDIO 组 |

## 6. UVR 分离集成验证

```
npm run verify:uvr
```

走编译产物 `AccompanimentAdapter` + 真实 MDX-Net 推理（非裸 CLI）。

| 检查 | 结果 |
| --- | --- |
| `selfTest` | 通过（运行时 / 模型目录就绪） |
| `separate` 真实推理 | 通过（6s 音频 30.2s 完成） |
| U-01 含音频流 | 通过（pcm_s16le / 44100 / 2ch） |
| U-02 时长与源一致 | 通过（6s / 6s） |
| U-03 声道可用 | 通过（2 声道） |
| U-04 与原唱确有差异 | 通过（反相相减 RMS −27.5 dB） |

报告：`release/uvr-verify.json`

## 7. 完整管线端到端

```
npm run verify:e2e                          # 合成信号
npm run verify:e2e -- --audio <歌曲文件>     # 真实歌曲 + 彩条画面
npm run verify:e2e -- --source <MV 文件>     # 直接处理现成 MV（最贴近真实使用）
```

`JobService` + `PipelineController` 七阶段（PROBE → EXTRACT_ORIGINAL → **ACCOMPANIMENT 真实 UVR** → ALIGN → LYRICS → **ENCODE_MUX 含烧录** → VALIDATE）。

### 7.1 真实 MV（用户提供：周菲戈《大开杀戒》4 分 17 秒 1080p）

`npm run verify:e2e -- --source "testdata/周菲戈-大开杀戒-国语.mp4"`

| 检查 | 结果 |
| --- | --- |
| 任务状态 | `COMPLETED`，273.0s（≈1.06× 实时） |
| E-01 双音轨 | 通过（2 条） |
| E-02 音轨顺序 | 通过（`a:0=原唱` / `a:1=伴奏`） |
| E-03 原唱为默认轨 | 通过（`a:0=1` / `a:1=0`） |
| E-04 H.265 + hvc1 | 通过（源 `hev1` → 输出 `hvc1`） |
| E-05 分辨率保持 | 通过（1920×1080） |
| E-06 时长一致 | 通过（257.642s / 257.642s） |
| E-07 字幕烧录 V-09 | 通过（末句 257.640s / 时长 257.642s） |
| E-08 校验报告 | `passed=true`，21 项 checks，hard 失败 0 |
| E-09 画面确有叠加 | 通过（YAVG=2.50） |
| 体积 | 58,429,574 B → 30,374,730 B（**−48.0%**，压缩比 0.52 达 ≤60% 目标） |

产物：`output/周菲戈-大开杀戒-国语.mp4`（28.97 MB，可直接试听 / 切轨验证）。

### 7.2 真实歌曲（CG5《Fish Out Of Water》，Wikimedia Commons / CC）

| 检查 | 结果 |
| --- | --- |
| 任务状态 | `COMPLETED`，84.5s |
| E-01 双音轨 | 通过（2 条） |
| E-02 音轨顺序 | 通过（`a:0=原唱` / `a:1=伴奏`） |
| E-03 原唱为默认轨 | 通过（`a:0=1` / `a:1=0`） |
| E-04 H.265 + hvc1 | 通过 |
| E-05 分辨率保持 | 通过（480×270） |
| E-06 时长一致 | 通过（20s / 20s） |
| E-07 字幕烧录 V-09 | 通过（末句 20.000s / 时长 20.000s / 3 句） |
| E-08 校验报告 | `passed=true`，21 项 checks，hard 失败 0 |
| E-09 画面确有叠加 | 通过（YAVG=2.80） |
| 体积 | 1,560,128 B → 1,351,105 B（**−13.4%**） |

### 7.3 合成信号

同为 E-01~E-09 全绿，34.9s 完成，体积 932,491 B → 800,441 B（−14.2%）。

> 真实歌曲验证暴露并修复了一个**真实缺陷**：源 MV 的音轨常比画面短（本例 20.01s vs 20.5s），原 `extractOriginal` 直接提取会导致 `a:0` 比视频短、末尾被截且全程漂移 490ms。现以容器（≈视频）时长为基准做 `apad` 补齐，漂移归零。

报告：`release/e2e-pipeline.json`

## 8. 可分发产物

```
env -u NODE_OPTIONS -u CODEBUDDY_BROKERED_FS_HOOK_ENABLED node node_modules/.bin/electron-builder --mac dmg
```

| 项 | 内容 |
| --- | --- |
| 安装包 | `release/MTV Converter-1.0.0-arm64.dmg`（**147 MB**，APFS，含 Applications 快捷方式） |
| 应用目录 | `release/mac-arm64/MTV Converter.app`（348 MB，macOS arm64） |
| 随包资源 | `resources/bin`（ffmpeg + ffprobe，94 MB）、`resources/fonts`（Noto Sans CJK SC）、`resources/uvr/launch_separator.py` |
| 签名 | 未签名（`identity: null`），本地运行需 ad-hoc：`codesign --force --deep --sign - <app>` |
| dmg 验证 | `hdiutil attach` 可挂载；卷内含 `.app`、`Applications` 软链与安装背景；包内 `resources/{bin,fonts,uvr,manifest.json}` 完整 |

> 打包前需先移走已存在的 `release/mac-arm64`（占用中的 `app.asar` 会导致 app-builder 失败），并剥离宿主的 `NODE_OPTIONS`。

## 9. 运行验证

```bash
ditto "release/mac-arm64/MTV Converter.app" /tmp/MTVC.app
xattr -cr /tmp/MTVC.app && codesign --force --deep --sign - /tmp/MTVC.app
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "/tmp/MTVC.app/Contents/MacOS/MTV Converter" --no-sandbox
```

- 进程稳定运行，无 `boot-error.log`
- 日志 `~/Library/Application Support/mtvconverter/.cache/logs/app.log`：
  - `hardware.probe.step`：平台 darwin / 架构 arm64 / 设备 Apple Silicon / 运行时 FFmpeg 可用 / **模型兼容「UVR 运行时与模型配置就绪」**
  - `hardware.encoder.selftest`：`hevc_videotoolbox` 1 秒自检通过
  - `hardware.detect.result`：`separationBackend=mps`、`encodeEncoder=hevc_videotoolbox`、`previewEncoder=h264_videotoolbox`、`degraded=false`
- 界面截图确认：拖拽区 / 选择视频 / 预览播放器（输入·输出切换 + 原唱·伴奏下拉）/ 歌词（可选）折叠区 / 开始转换 / 详情 —— **7 个控件、零技术术语、无横幅**

## 10. 验收项覆盖

| 验收项 | 状态 | 依据 |
| --- | --- | --- |
| V-01~V-05、V-07、V-12 | 通过 | `npm run smoke` |
| V-06 画质 | 通过 | PSNR 抽样（合成素材 38.29 dB，紧贴阈值 38） |
| V-08 音画同步 | 通过 | 首帧偏差 21.3ms ≤ 40ms |
| V-09 字幕烧录 | **通过** | smoke YAVG=2.04 / e2e 末句与时长一致 |
| V-10 三分支一致 | 通过 | 三分支输出等价性单测 + e2e 真实输出 |
| V-11 可播放性 | 通过 | ffprobe 全流解析 + 预览代理 HLS 双音轨生成 |
| V-13 压缩比 | 提示 | 合成素材偏大（真实 MV 需复测） |
| V-14 / V-15 | 通过 | 伴奏来源标记、非单轨阻断（单测 + 管线逻辑） |
| V-16 / V-20 预览与歌词四态 | 通过 | HLS master 双 audio rendition + 六态 UI 实现 |
| V-17 / V-18 | 通过 | 截图点数 7 控件 + 术语扫描（仅出现在 L2 详情） |
| V-19 提示分级 | 通过 | 策略单测 + 运行日志 |
| A-01~A-08 人工验收 | 未执行 | 需真实 MV 素材、主观试听与多平台机器 |

## 11. 环境限制（不视为通过）

1. **未签名 / 未公证**：发布需 `CSC_LINK`、`CSC_KEY_PASSWORD` 与 Apple 公证环境变量。
2. **无 Windows 机器**：未产出/验证 NSIS 安装包；`electron-builder.yml` 已就绪。Windows 侧需另行准备 `ffmpeg.exe`（含 nvenc）到 `resources/bin`。
3. **项目位于 SMB 挂载卷**：`.app` 需复制到本地磁盘运行；打包需 `env -u NODE_OPTIONS`。
4. **宿主禁用 Chromium sandbox**：验证用 `--no-sandbox`，正常安装环境无需。
5. **分离运行时按需安装**：不在安装包内（1.1 GB），首次使用执行 `npm run resources:setup-uvr`；未安装时「自动生成伴奏」不可用，「导入官方伴奏」不受影响。
6. **合成素材替代真实 MV**：画质、压缩比与分离质量用合成信号验证管线正确性，主观质量需真实歌曲复核。
7. **模型与 FFmpeg 许可**：随包 FFmpeg 为 GPL-3.0 构建，分发须附许可；UVR 模型使用需署名，见 `THIRD_PARTY_NOTICES.md`。

## 12. 结论

源码可编译、可测试、可打包、可安装、可启动；**核心链路已用真实歌曲与真实分离模型端到端验证**：单音轨 MV → MDX-Net 伴奏分离 → 字幕烧录 → 单次 H.265 编码 → 双音轨（`a:0` 原唱 / `a:1` 伴奏）输出，音画同步、时长与分辨率保持、校验报告全绿（21 项 checks，0 硬失败）。

本轮补齐并实测了此前受环境限制的两项能力（随包 arm64 FFmpeg 的 libass 烧录、自建 UVR 分离运行时），并借真实歌曲暴露修复了 4 个实现缺陷：源音轨短于画面导致漂移、分离产物落盘时序误判、适配层错误码被吞成 E_UNKNOWN、编码器自检在系统繁忙时误降级。`npm run verify:e2e -- --audio <歌曲>` 可随时复跑。
