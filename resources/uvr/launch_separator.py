"""按平台选择分离后端（ONNX provider）的启动垫片。

背景（都是实测出来的，不是推测）：
1. macOS：audio-separator 在 Apple Silicon 上会同时把 torch 和 ONNX 都切到 MPS / CoreML，
   而 **CoreML 不支持 MDX-Net 系列 ONNX 的算子**，运行期报
   `Unable to compute the prediction using a neural network model (error code: -1)`。
   MDX 系列（默认模型 UVR-MDX-NET-Inst_HQ_3）只走 ONNX、不碰 torch，所以：
   torch 保持库原生的 MPS（demucs / VR 系模型吃得到），ONNX 侧默认仍用 CPU；
   想试 CoreML 用 `MTVC_UVR_ONNX=coreml` 显式开启。
2. Windows：DirectML 在 audio-separator 里是**显式 opt-in**（`use_directml=True` + `torch_directml`），
   但 MDX 推理根本不经过 torch，没必要为它把 torch 换成 DirectML 版（版本耦合很紧）。
   因此这里直接按可用的 ONNX provider 选：CUDA → DirectML → CPU。
   前置：随包运行时在 Windows 上装的是 `onnxruntime-directml`（见 resources/manifest.json）。
3. 环境变量 `MTVC_UVR_FORCE_CPU=1`：任何平台强制 CPU，用于排障或驱动异常时降级。

命令行参数与 audio-separator 完全一致，本脚本只是启动垫片。
"""
import os
import sys

PROVIDER_ENV = "MTVC_UVR_ONNX"
FORCE_CPU_ENV = "MTVC_UVR_FORCE_CPU"


def _install_provider_policy() -> None:
    from audio_separator.separator.separator import Separator
    import onnxruntime as ort

    original_setup = Separator.setup_torch_device

    def setup_with_policy(self, system_info):  # noqa: ANN001
        # 先走库的原生逻辑：mac 上会设 MPS（torch），Windows 上看 CUDA，其余 CPU
        original_setup(self, system_info)
        available = list(ort.get_available_providers())

        if os.environ.get(FORCE_CPU_ENV):
            self.onnx_execution_provider = ["CPUExecutionProvider"]
            return

        if sys.platform == "darwin":
            wanted = os.environ.get(PROVIDER_ENV, "").strip().lower()
            if wanted == "coreml" and "CoreMLExecutionProvider" in available:
                self.onnx_execution_provider = ["CoreMLExecutionProvider"]
            else:
                # 默认：torch 留在 MPS，ONNX 走 CPU（CoreML 跑不了 MDX 算子）
                self.onnx_execution_provider = ["CPUExecutionProvider"]
            return

        # Windows / Linux：ONNX 侧取第一个可用加速后端，都没有就 CPU
        for name in ("CUDAExecutionProvider", "DmlExecutionProvider"):
            if name in available:
                self.onnx_execution_provider = [name]
                if name == "CUDAExecutionProvider":
                    try:
                        import torch
                        if torch.cuda.is_available():
                            self.torch_device = torch.device("cuda")
                    except Exception:  # noqa: BLE001 - torch 缺失/异常都不该阻断分离
                        pass
                return
        self.onnx_execution_provider = ["CPUExecutionProvider"]

    def setup_with_log(self, system_info):  # noqa: ANN001
        setup_with_policy(self, system_info)
        # 显式把实际生效的 provider 打到 stderr：出问题时一眼能看出是 GPU 还是 CPU 在跑
        providers = getattr(self, "onnx_execution_provider", None)
        print(f"[mtvc] ONNX execution provider = {providers}", file=sys.stderr, flush=True)

    Separator.setup_torch_device = setup_with_log


def main() -> int:
    _install_provider_policy()
    from audio_separator.utils.cli import main as cli_main

    return cli_main()


if __name__ == "__main__":
    sys.exit(main() or 0)
