"""推論引擎：`totalseg`（預設，TotalSegmentator 權重）、`nnunet`（自訓練的 nnUNetv2_predict）、`fake`（契約測試）。

三者的介面相同：`labels()` 回 {value: {name, color, tg263}}；
`predict(in_nifti, out_dir, roi_subset, progress)` 回 labelmap 路徑。
輸出**必須**回到輸入網格（宿主 B3）；TotalSegmentator 會自己採回原解析度，這裡再核對一次，不同就以最近鄰採回。

🔴 授權：TotalSegmentator 程式碼 Apache-2.0，**權重 CC BY-NC-SA 4.0（非商業）**——只適合開發與驗證，
商品化前要換成自己的權重（`RTGAIA_SEG_ENGINE=nnunet`）。manifest 的 `soup` 會把這件事寫出來。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk

Progress = Callable[[float, str], None]

ENGINE = os.environ.get("RTGAIA_SEG_ENGINE", "totalseg")
DEVICE = os.environ.get("RTGAIA_SEG_DEVICE", "gpu")  # totalseg: gpu|cpu|mps；nnunet: cuda|cpu
FAST = os.environ.get("RTGAIA_TOTALSEG_FAST", "1") == "1"
TOTALSEG_TASK = os.environ.get("RTGAIA_TOTALSEG_TASK", "total")
NNUNET_DATASET = os.environ.get("RTGAIA_NNUNET_DATASET", "Dataset501_HN_OAR")
NNUNET_CONFIG = os.environ.get("RTGAIA_NNUNET_CONFIG", "3d_fullres")
NNUNET_FOLDS = os.environ.get("RTGAIA_NNUNET_FOLDS", "all")

# TotalSegmentator 名稱 → TG-263（只列常見 OAR；沒有對應就 None，使用者可在 ROI 面板改名）
TG263: dict[str, str] = {
    "brain": "Brain",
    "spinal_cord": "SpinalCord",
    "esophagus": "Esophagus",
    "trachea": "Trachea",
    "heart": "Heart",
    "aorta": "A_Aorta",
    "liver": "Liver",
    "stomach": "Stomach",
    "spleen": "Spleen",
    "pancreas": "Pancreas",
    "gallbladder": "Gallbladder",
    "kidney_left": "Kidney_L",
    "kidney_right": "Kidney_R",
    "urinary_bladder": "Bladder",
    "prostate": "Prostate",
    "small_bowel": "Bowel_Small",
    "colon": "Colon",
    "duodenum": "Duodenum",
    "thyroid_gland": "Thyroid",
    "lung_upper_lobe_left": "Lung_L",
    "lung_upper_lobe_right": "Lung_R",
    "femur_left": "Femur_Head_L",
    "femur_right": "Femur_Head_R",
    "sternum": "Sternum",
}


def _color(name: str) -> list[int]:
    h = hashlib.sha1(name.encode()).digest()
    return [64 + h[0] % 192, 64 + h[1] % 192, 64 + h[2] % 192]


def _entry(name: str) -> dict[str, Any]:
    return {"name": name, "color": _color(name), "tg263": TG263.get(name)}


def resample_labelmap_to(seg: sitk.Image, ref: sitk.Image) -> sitk.Image:
    """最近鄰採回參考網格（只給 labelmap 用）。"""
    same = (
        seg.GetSize() == ref.GetSize()
        and np.allclose(seg.GetSpacing(), ref.GetSpacing(), atol=1e-3)
        and np.allclose(seg.GetOrigin(), ref.GetOrigin(), atol=1e-3)
        and np.allclose(seg.GetDirection(), ref.GetDirection(), atol=1e-6)
    )
    if same:
        return seg
    return sitk.Resample(seg, ref, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())


class Engine:
    id: str = "base"
    soup: list[dict[str, Any]] = []

    def labels(self) -> dict[int, dict[str, Any]]:
        raise NotImplementedError

    def predict(self, in_nifti: Path, out_dir: Path, roi_subset: list[str] | None, progress: Progress) -> Path:
        raise NotImplementedError

    def health(self) -> dict[str, Any]:
        return {"engine": self.id}


class FakeEngine(Engine):
    """HU > 0 → label 1。只為了不需要權重就能跑契約測試。"""

    id = "fake"
    soup = []

    def labels(self) -> dict[int, dict[str, Any]]:
        return {
            1: {"name": "Fake_Body", "color": [255, 200, 0], "tg263": None},
            2: {"name": "Fake_Core", "color": [0, 160, 255], "tg263": None},
        }

    def predict(self, in_nifti: Path, out_dir: Path, roi_subset: list[str] | None, progress: Progress) -> Path:
        img = sitk.ReadImage(str(in_nifti))
        arr = sitk.GetArrayFromImage(img)
        seg = np.zeros(arr.shape, dtype=np.uint8)
        wanted = set(roi_subset or [n["name"] for n in self.labels().values()])
        if "Fake_Body" in wanted:
            seg[arr > 0] = 1
        if "Fake_Core" in wanted:
            seg[arr > 100] = 2
        progress(60, "fake inference")
        out = sitk.GetImageFromArray(seg)
        out.CopyInformation(img)
        p = out_dir / "seg.nii.gz"
        sitk.WriteImage(out, str(p), useCompression=True)
        return p


class TotalSegEngine(Engine):
    id = "totalseg"
    soup = [
        {
            "name": "TotalSegmentator",
            "version": "2.x",
            "license": "Apache-2.0",
            "kind": "library",
            "url": "https://github.com/wasserth/TotalSegmentator",
        },
        {
            "name": "TotalSegmentator weights (task total)",
            "version": "2.x",
            "license": "CC-BY-NC-SA-4.0",
            "kind": "model-weights",
            "url": "https://github.com/wasserth/TotalSegmentator#license",
        },
        {"name": "nnunetv2", "version": "2.x", "license": "Apache-2.0", "kind": "library"},
        {"name": "torch", "version": "2.x", "license": "BSD-3-Clause", "kind": "library"},
    ]

    def labels(self) -> dict[int, dict[str, Any]]:
        from totalsegmentator.map_to_binary import class_map  # type: ignore

        return {int(v): _entry(name) for v, name in class_map[TOTALSEG_TASK].items()}

    def predict(self, in_nifti: Path, out_dir: Path, roi_subset: list[str] | None, progress: Progress) -> Path:
        from totalsegmentator.python_api import totalsegmentator  # type: ignore

        progress(15, f"TotalSegmentator {TOTALSEG_TASK}{' fast' if FAST else ''} on {DEVICE}")
        out = out_dir / "seg.nii.gz"
        kwargs: dict[str, Any] = {"ml": True, "fast": FAST, "device": DEVICE, "quiet": True, "task": TOTALSEG_TASK}
        if roi_subset:
            kwargs["roi_subset"] = roi_subset
        totalsegmentator(str(in_nifti), str(out), **kwargs)
        progress(75, "postprocess")
        seg = sitk.ReadImage(str(out))
        ref = sitk.ReadImage(str(in_nifti))
        fixed = resample_labelmap_to(seg, ref)
        if fixed is not seg:
            sitk.WriteImage(fixed, str(out), useCompression=True)
        return out

    def health(self) -> dict[str, Any]:
        try:
            import totalsegmentator  # type: ignore

            return {
                "engine": self.id,
                "totalsegmentator": getattr(totalsegmentator, "__version__", "?"),
                "task": TOTALSEG_TASK,
                "fast": FAST,
                "device": DEVICE,
            }
        except ImportError as exc:
            return {"engine": self.id, "error": f"TotalSegmentator is not installed: {exc}"}


class NnUNetEngine(Engine):
    id = "nnunet"
    soup = [
        {
            "name": "nnunetv2",
            "version": "2.x",
            "license": "Apache-2.0",
            "kind": "library",
            "url": "https://github.com/MIC-DKFZ/nnUNet",
        },
        {"name": "torch", "version": "2.x", "license": "BSD-3-Clause", "kind": "library"},
        {
            "name": os.environ.get("RTGAIA_NNUNET_WEIGHTS_NAME", f"{NNUNET_DATASET} weights (deployer-provided)"),
            "version": os.environ.get("RTGAIA_NNUNET_WEIGHTS_VERSION", "unknown"),
            "license": os.environ.get("RTGAIA_NNUNET_WEIGHTS_LICENSE", "unknown"),
            "kind": "model-weights",
        },
    ]

    def _dataset_json(self) -> Path:
        return (
            Path(os.environ["NNUNET_RESULTS"])
            / NNUNET_DATASET
            / f"nnUNetTrainer__nnUNetPlans__{NNUNET_CONFIG}"
            / "dataset.json"
        )

    def labels(self) -> dict[int, dict[str, Any]]:
        raw = os.environ.get("RTGAIA_NNUNET_LABELS_JSON")
        if raw:
            return {int(k): v for k, v in json.loads(raw).items()}
        labels = json.loads(self._dataset_json().read_text(encoding="utf-8"))["labels"]
        out: dict[int, dict[str, Any]] = {}
        for name, value in labels.items():
            if name == "background":
                continue
            out[int(value if not isinstance(value, list) else value[0])] = _entry(name)
        return out

    def predict(self, in_nifti: Path, out_dir: Path, roi_subset: list[str] | None, progress: Progress) -> Path:
        if shutil.which("nnUNetv2_predict") is None:
            raise RuntimeError("nnUNetv2_predict not found; install nnunetv2 (extra: inference)")
        in_dir = out_dir / "in"
        in_dir.mkdir(exist_ok=True)
        shutil.copy(in_nifti, in_dir / "case_0000.nii.gz")
        progress(15, f"nnUNetv2_predict {NNUNET_DATASET}/{NNUNET_CONFIG}")
        cmd = ["nnUNetv2_predict", "-i", str(in_dir), "-o", str(out_dir), "-d", NNUNET_DATASET, "-c", NNUNET_CONFIG]
        cmd += ["-f", *NNUNET_FOLDS.split(","), "-device", "cuda" if DEVICE == "gpu" else DEVICE]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"nnUNetv2_predict failed: {proc.stderr[-2000:]}")
        out = out_dir / "case.nii.gz"
        seg = sitk.ReadImage(str(out))
        fixed = resample_labelmap_to(seg, sitk.ReadImage(str(in_nifti)))
        if fixed is not seg:
            sitk.WriteImage(fixed, str(out), useCompression=True)
        return out  # roi_subset 由呼叫端過濾（nnU-Net 一律全部輸出）

    def health(self) -> dict[str, Any]:
        ok = (
            shutil.which("nnUNetv2_predict") is not None and self._dataset_json().is_file()
            if os.environ.get("NNUNET_RESULTS")
            else False
        )
        return {"engine": self.id, "dataset": NNUNET_DATASET, "config": NNUNET_CONFIG, "ready": ok}


def make_engine(name: str | None = None) -> Engine:
    name = name or ENGINE
    if name == "fake":
        return FakeEngine()
    if name == "totalseg":
        return TotalSegEngine()
    if name == "nnunet":
        return NnUNetEngine()
    raise ValueError(f"unknown engine {name!r} (totalseg | nnunet | fake)")
