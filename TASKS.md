# 开发任务分工、模块边界与集成约定

依据 `docs/MTV转换器-设计文档与开发方案.md`（纯净版）拆解。排序规则：阻塞依赖优先、P0 优先、可并行任务编入同一波次。

## 一、排序后的任务分工

| 序 | 任务 | 依赖 | 优先级 | 并行组 | 文件边界（互斥） | 验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 工程骨架与共享契约冻结 | — | P0 | W1 串行（阻塞全部） | `package.json`、`tsconfig*`、`vite.config.ts`、`electron-builder.yml`、`.env.example`、`.gitignore`、`resources/manifest.json`、`src/shared/**` | `npm run typecheck` 可解析契约；端口接口齐全 |
| 2 | 配置 / 类型化错误 / 结构化日志 / 提示策略 | 1 | P0 | W2 | `src/main/config`、`errors`、`presentation` | 启动快速失败、L0–L3 映射、日志脱敏 |
| 3 | 媒体适配层（FFmpeg / 编码 / 对齐 / 校验） | 1 | P0 | W2 | `src/main/media` | V-01~V-16 可自动判定项通过 |
| 4 | 伴奏来源（UVR CLI / 官方伴奏导入） | 1 | P0 | W2 | `src/main/accompaniment` | 二选一来源均可产出伴奏 WAV |
| 5 | 歌词服务与 LRC/SRT→ASS | 1 | P1 | W2 | `src/main/lyrics` | 三分支降级、时间轴裁剪、中文不缺字 |
| 6 | 预览代理（HLS）与硬件探测 | 1 | P1 | W2 | `src/main/preview`、`src/main/hardware` | 127.0.0.1 + token、双音轨切轨、降级一次 |
| 7 | 渲染层极简界面与 preload | 1 | P0 | W2 | `src/renderer`、`src/preload` | 首屏 7 控件、四态歌词区、两类 L3 确认 |
| 8 | 资源脚本、单元/契约/冒烟测试 | 1 | P0 | W2 | `scripts`、`tests` | `npm test` 全绿、`npm run smoke` 通过 |
| 9 | 编排层与 IPC 控制器 | 1、2 | P0 | W3（主 Agent，与 W2 并行） | `src/main/jobs`、`src/main/ipc`、`src/main/index.ts` | 7 阶段、NEEDS_CONFIRMATION、断点续跑、取消 |
| 10 | 集成编译、测试、冒烟、打包与验证结果 | 2–9 | P0 | W4 串行 | `VALIDATION.md`、`release/**` | typecheck / build / test / smoke / 产物 |

并行分组：**W1**（1）→ **W2**（2–8，六组文件互斥，可完全并行）→ **W3**（9，与 W2 并行，仅依赖冻结契约与自身文件）→ **W4**（10，统一集成修复，禁止各组再改他人文件）。

## 二、模块边界与共享接口

所有模块只依赖 `src/shared/contracts.ts` 与 `src/shared/preload-api.ts`，**不得重复定义同名类型、IPC 通道或错误码**。

| 端口接口 | 实现（唯一） | 编排层调用点 |
| --- | --- | --- |
| `MediaPort` | `src/main/media/index.ts` → `MediaAdapter` | PROBE / EXTRACT / ALIGN / ENCODE_MUX / VALIDATE |
| `AccompanimentPort` | `src/main/accompaniment/index.ts` → `AccompanimentAdapter` | ACCOMPANIMENT |
| `LyricsPort` | `src/main/lyrics/index.ts` → `LyricsService` | LYRICS（并行分支）、ENCODE_MUX 前汇合 |
| `PreviewPort` | `src/main/preview/index.ts` → `PreviewService` | 预览播放器 |
| `HardwarePort` | `src/main/hardware/index.ts` → `HardwareProbe` | 启动与每任务开始 |
| `PresentationPort` | `src/main/presentation/index.ts` → `UiPresentationPolicy` | 全部事件呈现判定 |

统一约定：

- 每个适配器构造函数均为 `constructor(paths: RuntimePaths)`；`ConfigService.load()` 启动时集中校验环境变量并产出 `RuntimePaths`，由 `src/main/index.ts` 依赖注入组装，禁止模块自行读取环境变量。
- 主进程 → 渲染层只走 `IPC.invoke`（invoke/handle）与 `IPC.event`（webContents.send）；preload 按 `MtvBridge` 暴露，一一对应，不得新增私有通道。
- 音频流相对序号 `a:0` / `a:1` 由 `EncodeMuxService` 的 `-map` 书写顺序唯一保证；`TRACK_METADATA` 是标题 / 语言 / disposition 的唯一来源。
- 阶段权重 `STAGE_WEIGHTS`、压缩档 `COMPRESSION_PRESETS`、验收阈值 `DEFAULTS`、错误码 `ErrorCode` 全部取自共享契约，禁止在模块内写死。
- 所有子进程一律 `spawn + argv 数组`，禁止 shell 拼接；路径支持中文与空格；取消通过 `JobService.signalFor(jobId)` 与适配器 `cancel()` 终止进程树。
- 中间产物落在 `cacheDir/jobs/<jobId>/`，每阶段写 `<stage>.done`，重跑跳过已完成阶段；配置变化由 `fingerprint()` 生成新 jobId。

## 三、功能覆盖矩阵（防遗漏）

| 设计文档功能 / 约束 | 落点 | 验收项 |
| --- | --- | --- |
| 原分辨率 H.265 压缩、单次编码 | `EncodeMuxService` | V-05 / V-06 / V-12 / V-13 |
| 音轨 0 原唱 / 1 伴奏、切换与元数据 | `EncodeMuxService` + `TRACK_METADATA` | V-01~V-04 / A-01 |
| UVR5.6 生成伴奏 | `AccompanimentAdapter.separate` | C-01 / C-05 |
| 导入官方伴奏（一等输入） | `AccompanimentAdapter.importFile` | C-07 / V-14 |
| 非单轨阻断确认 | `PipelineController` + `JobService` | C-08 / V-15 |
| 歌词联网 / 本地 / 粘贴、三分支降级 | `LyricsService` | C-02~C-04 / V-10 |
| 歌词烧录（同一次编码）、中文样式 | `SubtitleConverter` + `EncodeMuxService` | A-03 / V-09 |
| 预览输入/输出、原唱/伴奏切换 | `PreviewService` | V-16 / A-06 |
| 硬件加速与无加速回退 | `HardwareProbe` | C-06 / A-05 |
| 首页歌词折叠区、极简 7 控件 | `src/renderer` | V-17 / V-18 / V-20 / A-08 |
| 提示分级 L0–L3、详细模式 | `UiPresentationPolicy` | V-19 |
| 错误体系 / 结构化日志 / 配置校验 | `AppError` / `Logger` / `ConfigService` | §8 / §10.1 |
| 阶段进度 / 取消 / 断点续跑 | `JobService` / `PipelineController` | §4.2 / §8.3 |
| 双平台打包与签名配置 | `electron-builder.yml` / `build/entitlements.mac.plist` | §10.1 |
| 外部资源与许可声明 | `resources/manifest.json` / `THIRD_PARTY_NOTICES.md` | §10.1 / §6.5 |

## 四、集成约定

1. 各组只写自己的文件；发现需要改共享契约时，报告主 Agent 统一修改并同步通知，禁止私自改 `src/shared/**`。
2. 禁止各组执行 `npm install` / 构建命令，依赖安装与 `typecheck / build / test / smoke` 统一在 W4 执行。
3. W4 出现接口不一致时，以共享契约为准做一次性修复，然后重跑全部验证；不做反复小补丁。
4. 不引入设计文档范围之外的功能；验证缺失项写入 `VALIDATION.md` 的「环境限制」，不伪造通过。
