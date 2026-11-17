#!/usr/bin/env python3
"""以 CPU 执行后端启动 audio-separator。

原因：audio-separator 在 Apple Silicon 上硬编码优先使用 CoreMLExecutionProvider，
而 MDX-Net 系列 ONNX 模型含 CoreML 不支持的算子，运行期报
`Unable to compute the prediction using a neural network model (error code: -1)`。
该库未提供关闭 CoreML 的命令行开关，故在 CLI 之前替换设备选择方法，
固定为 CPUExecutionProvider，保证分离结果确定可用。

命令行参数与 audio-separator 完全一致，本脚本只是启动垫片。
"""
import sys


def _install_cpu_only_device() -> None:
    from audio_separator.separator.separator import Separator
    import torch

    def setup_cpu_device(self, system_info):  # noqa: ANN001, ARG001
        self.torch_device_cpu = torch.device("cpu")
        self.torch_device = self.torch_device_cpu
        self.torch_device_mps = None
        self.onnx_execution_provider = ["CPUExecutionProvider"]

    Separator.setup_torch_device = setup_cpu_device


def main() -> int:
    _install_cpu_only_device()
    from audio_separator.utils.cli import main as cli_main

    return cli_main()


if __name__ == "__main__":
    sys.exit(main() or 0)
