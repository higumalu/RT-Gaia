"""計算封包：引擎行程的輸入與輸出都是一個目錄（不經網路、不共用記憶體）。

輸入（API 行程寫）：

```
input.json   版本、引擎、Delivery、CT 與劑量網格、CT 校正曲線、射束模型、選項
ct_hu.npy    CT（HU，float32，(k, j, i)，跟 ct_grid 同形狀）
```

輸出（引擎行程寫）：

```
progress.json  {phase, percent, message}（原子寫入：先寫暫存檔再改名）
result.json    引擎、版本、秒數、歷史數、每個射束、說明
dose.npy       整份計畫（全部分次）的劑量，Gy，float32，(k, j, i)，劑量網格
uncertainty.npy 每個體素的相對統計不確定度（1σ，0–1；沒有劑量的 NaN）
beam_<n>.npy   每個射束的劑量（同單位）
```
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from rtgaia_geom import Grid

from .delivery import Delivery

FORMAT_VERSION = 1


@dataclass
class CalcInput:
    engine: str
    delivery: Delivery
    ct_hu: np.ndarray
    ct_grid: Grid
    dose_grid: Grid
    calibration: dict[str, Any]
    beam_model: dict[str, Any]
    options: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    def write(self, directory: str | Path) -> None:
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        np.save(d / "ct_hu.npy", np.ascontiguousarray(self.ct_hu, dtype=np.float32))
        doc = {
            "format_version": FORMAT_VERSION,
            "engine": self.engine,
            "delivery": self.delivery.to_wire(),
            "ct_grid": self.ct_grid.to_wire(),
            "dose_grid": self.dose_grid.to_wire(),
            "calibration": self.calibration,
            "beam_model": self.beam_model,
            "options": self.options,
            "meta": self.meta,
        }
        _atomic_json(d / "input.json", doc)

    @classmethod
    def read(cls, directory: str | Path) -> CalcInput:
        d = Path(directory)
        doc = json.loads((d / "input.json").read_text(encoding="utf-8"))
        if doc.get("format_version") != FORMAT_VERSION:
            raise ValueError(f"計算封包版本 {doc.get('format_version')}，這個引擎只認 {FORMAT_VERSION}")
        ct_grid = Grid.from_wire(doc["ct_grid"])
        ct = np.load(d / "ct_hu.npy")
        if tuple(ct.shape) != tuple(reversed(ct_grid.size)):
            raise ValueError("ct_hu.npy 的形狀跟 ct_grid 不合")
        return cls(
            engine=doc["engine"],
            delivery=Delivery.from_wire(doc["delivery"]),
            ct_hu=ct,
            ct_grid=ct_grid,
            dose_grid=Grid.from_wire(doc["dose_grid"]),
            calibration=doc["calibration"],
            beam_model=doc["beam_model"],
            options=dict(doc.get("options") or {}),
            meta=dict(doc.get("meta") or {}),
        )


@dataclass
class CalcResult:
    dose_gy: np.ndarray
    uncertainty: np.ndarray
    per_beam_gy: dict[int, np.ndarray]
    info: dict[str, Any]

    def write(self, directory: str | Path) -> None:
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        np.save(d / "dose.npy", np.ascontiguousarray(self.dose_gy, dtype=np.float32))
        np.save(d / "uncertainty.npy", np.ascontiguousarray(self.uncertainty, dtype=np.float32))
        for n, v in self.per_beam_gy.items():
            np.save(d / f"beam_{int(n)}.npy", np.ascontiguousarray(v, dtype=np.float32))
        _atomic_json(d / "result.json", {**self.info, "beams": sorted(int(n) for n in self.per_beam_gy)})

    @classmethod
    def read(cls, directory: str | Path) -> CalcResult:
        d = Path(directory)
        info = json.loads((d / "result.json").read_text(encoding="utf-8"))
        per_beam = {int(n): np.load(d / f"beam_{int(n)}.npy") for n in info.get("beams") or []}
        return cls(
            dose_gy=np.load(d / "dose.npy"), uncertainty=np.load(d / "uncertainty.npy"), per_beam_gy=per_beam, info=info
        )


def write_progress(directory: str | Path, phase: str, percent: float, message: str = "") -> None:
    _atomic_json(
        Path(directory) / "progress.json", {"phase": phase, "percent": round(float(percent), 1), "message": message}
    )


def read_progress(directory: str | Path) -> dict[str, Any] | None:
    p = Path(directory) / "progress.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _atomic_json(path: Path, doc: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)
