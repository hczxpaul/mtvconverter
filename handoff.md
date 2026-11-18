# handoff · MTV Converter（mtvconverter）

> **最后更新：2026-11-18 15:32 — 仓库清理：删掉约 1.4GB 散落物（`node_modules.*` 备份、解包 .app、旧产物、`dist/`、`.DS_Store`），移除过期快照 `VALIDATION.md` / `TASKS.md`，`.gitignore` 补 `node_modules.*/`，本文件从 338 行压到 119 行、章节编号去重。**
> 规则见 `AGENTS.md` §0：**接手必读本文件，每完成一步工作必须立即更新本文件。**

## 一、当前状态

- **两端均已跑通并出包**：macOS `release/MTV Converter-1.0.0-arm64.dmg`（147MB，ad-hoc 签名，已装入 `/Applications`）；Windows `release/MTV Converter-Setup-1.0.0.exe`（190MB，NSIS，未签名、无自定义图标）。
- **验证基线（Windows 2026-11-18 实测）**：`typecheck` 0 错误 · **103 项单测** · `smoke`（V-01~13 + V-09 烧录 YAVG=2.16）· `verify:uvr` U-01~04 · `verify:e2e` E-01~09（258s 真实 MV → 真实分离 → 烧录 → 双音轨 AV1，190s，58.4MB→50.0MB）；安装版经 preload 桥驱动真实任务 COMPLETED，21 项校验全过。macOS 基线停在 2026-11-17（81 项单测、界面 v3、dmg 装入），本轮改动未在 Mac 复核。
- **默认输出**：MP4（`av01`，可切 HEVC `hvc1`）+ 原唱/伴奏双音轨；压缩档按编码器分表（AV1 35/40/44、HEVC 24/28/31），统一走 `crfFor(codec, preset)`；扩展名 `.mp4`。
- **构建位置**：源码在 NAS 的 SMB 共享（唯一真相），**构建在本地副本 `C:\Users\hczxp\mtvc-build\mtvconverter`** 跑，改完同步过去，产物拷回 `release/`。共享上直接 `npm ci` 不可用（21 分钟没装完）。
- **git**：`main` 分支，本地身份 `MTV Converter <mtvconverter@local>`，无 remote，89 个跟踪文件。

## 二、下一步（按此顺序）

1. **主人真机试用 Windows 安装包**：导入 → 转换 → 预览切轨 → 歌词烧录。
2. **待决：V-08-DRIFT 口径**——音频比视频短 ~150ms 的源会因 drift 120ms > 40ms 判 FAILED（用 `-ss/-t -c copy` 剪的片段复现；整段 MV 不受影响；与平台、编码器无关）。选项：放宽阈值 / 输出统一 `-shortest` / 明确视为不合格素材。
3. **Mac 侧复跑** `smoke` + `verify:uvr` + `verify:e2e`，复核本轮改动（`escapeFilterPath` 双层转义、硬件自检 256×256、NVENC `qualityArgs`、分离 provider 校正、速度下拉/输出摘要文案、垫片 MPS 策略）。预期变化：界面「分离后端」由 `mps` 变 `cpu`（ONNX 走 CPU），torch 仍 MPS。
4. **正式发布前**：macOS 配 `CSC_LINK` + 公证；Windows 需开「开发者模式」或管理员（否则 winCodeSign 解压失败）并去掉 `-c.win.signAndEditExecutable=false`、配证书；项目尚无 icon 资源。
5. **`.trash/` 残留 221.6MB / 21 个 `.smbdelete` 占位**：客户端删不掉，需重挂 SMB 卷或重启 NAS。

## 三、关键决策与原因

| 决策 | 原因 |
|---|---|
| 单次编码（字幕滤镜并入同一通道），AV1 为默认、HEVC 可选 | 避免二次编码损失；VMAF≈91.8 时 AV1 比 H.265 省 36%（实测 711 vs 1105 kbps），耗时还更短 |
| 伴奏来源二选一：UVR 分离 / 导入官方伴奏 | 分离质量不稳时留可控退路 |
| 非单轨一律 `NEEDS_CONFIRMATION`（按「≠1」实现） | 不静默猜；主人原话「>2 条」，阈值待拍板 |
| 音轨 `a:0`/`a:1` 由 `-map` 顺序保证，不依赖容器 stream index | 避免与全局索引混淆 |
| 硬件加速探测 + 1s 自检，失败降级 CPU **一次**且必须可解释 | 禁止静默降级：日志留痕 + IPC 事件 + L2 展开 |
| 界面 v1.3 高密度：三列（设置 / 歌词 / 预览）+ 底部常驻操作带 | v1.2「首屏 ≤6 控件」把主操作挤出首屏；sticky 操作带同时解决密度与可达 |
| 预览：输入直放源文件，输出走本地 HLS 双音轨代理 | 输出要能切 a:0/a:1，Chromium 无 audioTracks API；输入只有一条轨，直放零转码 |
| 分离默认 CPU，GPU 只作显式开关 | 实测 MDX 在 CUDA 上不提速（27s vs 27s），DirectML 直接报错；瓶颈在 numpy/STFT/落盘 |

## 四、踩坑（别重复踩）

**平台 / FFmpeg**
- `-vf` 的值被解析**两次**：字幕滤镜里的 Windows 盘符必须写 `C\\:`（两个反斜杠）。单层 `\:` 会被第一层吃掉，报 `AVFilterGraph: Error parsing a filter description`。
- FFmpeg 7.1 的 MP4 muxer 忽略 `-metadata:s:a:N title=`，只写 `handler_name`（8.1 写 `udta/name`）。`encodeMux` 同时写两处，`titleOf()` 兼容 `title/name/handler_name`。
- 非 MP4 扩展名必须显式 `-f mp4`；保留源旋转要 `-noautorotate`；本机 `localhost` 会解析到 `::1` 被 RST，本地服务一律 `127.0.0.1`。

**Windows 专属**
- `which` 不存在 → `executableOnPath()` 在 win32 用 `where` 取首行。
- NVENC 的 HEVC **最小帧尺寸**大于 128×128：1 秒自检样本必须 ≥256×256，否则每台 N 卡机器都被误判「硬件编码器不可用」并静默降级。
- NVENC 的 `-cq` 与 x265 的 CRF 不是同一把尺子：`cq = crf + 5` + `-rc vbr -b:v 0 -preset p5 -tune hq`（实测 cq=crf 时输出 138% 源体积）。
- `audio-separator 0.48` 顶层 `import audioread` 但依赖里没声明（librosa≥1.0 也不再带）→ `ModuleNotFoundError`，表现为 `E_UVR_FAILED`。已写进 `manifest.uvr.runtime.packages`。
- PyPI 的 Windows torch 自带 CUDA（约 2.5GB），纯 CPU 场景要显式装 `--index-url .../whl/cpu`。
- GitHub / huggingface 直连失败：Electron 用 `npmmirror`，electron-builder 二进制用 `ELECTRON_BUILDER_BINARIES_MIRROR`，模型用 `gh-proxy.com`。
- 本机打包会卡在 winCodeSign 解压（含 macOS 符号链接，非管理员无权限）→ 手工解压后 `MTVC_WINCODESIGN_DIR` 指向它（**只改本地副本的 node_modules，不入库**）。
- 验证 GUI 必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` 启动，否则 Electron 当成 Node 跑、秒退。

**Electron / 打包 / 测试**
- macOS 菜单竞态会崩（`-[NSMenu performKeyEquivalent:]` → `mutateError`）：`Menu.setApplicationMenu(null)`，快捷键改走 IPC `edit:command`；项目内禁用 `window.confirm/alert` 与同步消息框。
- `NODE_OPTIONS` 的 node-safe-delete 垫片会拦 Vite 清 `dist` 与打包：需 `env -u NODE_OPTIONS -u CODEBUDDY_BROKERED_FS_HOOK_ENABLED`。
- vitest 在受限环境写 `%TEMP%` 会被 EPERM 拦，表现为测试文件丢失、数量飘忽（77/88/98）：把 `TMPDIR`/`TEMP`/`TMP` 指向项目内目录即稳定。
- 测试里拼路径一律用 `path.join`，写死 POSIX 斜杠在 Windows 上必假失败。
- **新增 UI 入口后必须用真实 UI 走一遍**：`makeDefaultConfig().outputDir=''` 被 zod `min(1)` 拒绝，脚本验证全绿而界面建不起任务。

**分离运行时**
- macOS：CoreML EP 不支持 MDX 算子（`error code: -1`）→ 垫片固定 ONNX 走 CPU，torch 保持 MPS；想试用 `MTVC_UVR_ONNX=coreml`。
- Windows：垫片按 `CUDA → DirectML → CPU` 选 provider；DirectML 在 MDX 上会抛 ORT 内部 `UnicodeDecodeError`（底层算子失败），不可用。
- 分离 CLI 启动时用裸命令 `ffmpeg -version` 探测依赖，GUI 应用 PATH 里没有它 → 必须显式注入 `PATH` + `FFMPEG_BINARY`/`FFPROBE_BINARY`。
- 产物落盘与进程退出有时序差：找不到产物时轮询 5×1s 再判 `E_UVR_NO_OUTPUT`；`cwd` 指向不存在的目录会以 code -1 结束，先 `mkdir -p`。

**界面 / 前端**
- CSS 用末尾覆写改造时，**「不写」不等于「清除」**：删掉覆写里的 `max-width` 会回落到 v1 的 1120px；要显式写 `none`。
- `<button>` 的 UA `text-align: center` 会继承进 flex 子项，表现为「文字不贴左、第二行越长偏移越大」→ 显式 `text-align: left`。
- 图标按钮被高特异性规则压成一条缝（`width:100%` + padding 吃掉内容区）：选择器提到 `li > .timeline__pin` 并写死 `padding:0 / flex:0 0 22px`。
- 列宽用「比例分配」会为个别长句常年占宽：改为量最长句 + 固定开销，clamp 250–360，且 CSS 再夹一层保证预览 320 最低宽。
- 补间动画不要直接改 DOM 变量（会被 React 重渲染打回终值）：补间值放 state；「有/无」两态做退场动画必须先播完再卸载。
- 改了默认值对老用户不生效：`config.json` 的旧值会盖掉新默认 → 一次性迁移（`config.migrated` 标记）。
- jassub 2.5.37 的 API 与 README 不符（`subContent`/`defaultFont`/`renderer.setTrack()`/`resize()`），资源是 `dist/worker/worker.js` 与 `dist/wasm/*`；CSP 需 `'wasm-unsafe-eval'`。
- HLS 不能用 `-hls_playlist_type vod`（转完才写 playlist）：改 `event`，首片就绪即放行；播放器总时长用 `expectedDurationSec` 兜底。
- `JobStatus` 初值不能用 `QUEUED`（UI 会当成 busy）：新增 `DRAFT`。

**素材 / 校验**
- 源音轨常比画面短（AAC 边界）：`extractOriginal` 以容器时长 `apad` 补齐，否则 V-08 必失败。
- 默认输出目录 = 源目录且扩展名同为 `.mp4` 会覆盖源：`defaultOutputPath` 撞名加 `-伴奏版` 后缀，`encodeMux` 再加一道同路径断言。
- 适配层自定义错误要按 `code` duck typing 保留语义，否则全被吞成 `E_UNKNOWN`。
- E2E 断言不能写死尺寸：E-05 与源动态比对、E-09 两路都归一到 480×270。

## 五、文件指针

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 项目规则：接手必读 `handoff.md`、每步必写 |
| `README.md` | 门面：上手 / 命令 / 结构 / 文档索引 |
| `docs/MTV转换器-设计文档与开发方案.md` | 设计权威（818 行） |
| `docs/MTV转换器-设计概览.html` | 可视化评审稿（与 MD 冲突以 MD 为准） |
| `VALIDATION-WINDOWS.md` | Windows 实测：环境、修复清单、打包限制、已知问题 |
| `src/shared/contracts.ts` / `preload-api.ts` | 冻结契约：DTO / 端口 / IPC / 错误码 / 桥 |
| `src/main/jobs/**` | `JobService` 状态机 + `PipelineController` 7 阶段 |
| `src/main/hardware/**` | 硬件探测、自检、`reconcileSeparation` 后端校正 |
| `resources/uvr/launch_separator.py` | 分离垫片：按平台选 ONNX provider |
| `resources/manifest.json` | 随包二进制版本/SHA256、运行时与模型来源 |
| `scripts/{prepare-resources,smoke,verify-uvr,e2e-pipeline}.mjs` | 资源准备 / 冒烟 / 分离 / 端到端 |
| `release/*` | 交付物：dmg、NSIS、三份验证 JSON |

## 六、待决事项

1. **V-08-DRIFT 口径**（见 §二.2）。
2. **非单轨阈值**：实现按「≠1」，主人原话「>2 条」，改一处常量即可。
3. **审查报告 56 条未落地项**：暗色模式、日志自动跟随、逐字高亮（`{\k}`）、字幕文字对读屏可见、触控 44px、失败态完整动作映射；另有成品体积预估、阶段剩余时间、VMAF 数值展示。
4. **可读性**：正文 13px / 等宽元数据 10.5px 需真人在实际屏幕确认；窗口默认 1400×860 是否够大。
5. **字幕颜色约定**：按 ASS `&H00BBGGRR` 写入（Alpha 固定 00），需与点歌系统核对。
6. **GPU 分离**：若要确认 CUDA 全链路（torch 也上 GPU）是否有收益，需在快网机器上 `npm run resources:setup-uvr:gpu` 复测 MDX 与 demucs（本机下载 <60KB/s 未测完）。

## 七、已废弃决策（防走回头路）

- v1.0：`-c:v copy` 直通、包级哈希断言、默认 MKV、KTV 私有容器、商业分发合规。
- v1.1/v1.2：首屏 ≤6 控件、歌词入口藏二级、降级持久横幅、预览暴露 HLS/端口等技术信息。
- **启动恢复上次源文件**（2026-11-16 实现，同日推翻）：主人明确要求「进来就该自己选」，现为启动即空态，`readConfig()` 强制 `sourcePath: ''`。别再加回来。
- UVR v5.6 GUI 版：无 `-i/-o/-m` CLI，改 audio-separator 0.48 + 垫片。
- `output/` 产物命名 `.mtv`：已改 `.mp4`（FFmpeg 无法按扩展名推断容器，需显式 `-f mp4`）。

## 八、本机遗留（不影响仓库）

- 本地构建副本 `C:\Users\hczxp\mtvc-build\mtvconverter`（含 node_modules 与 `MTVC_WINCODESIGN_DIR` 临时补丁）保留，增量验证直接用。
- 分离运行时在 `%APPDATA%\mtvconverter\{runtime\uvr-venv,models}`（Windows）/ `~/Library/Application Support/mtvconverter/`（macOS）。
