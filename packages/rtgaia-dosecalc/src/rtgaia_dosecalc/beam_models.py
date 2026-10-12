"""射束模型：能譜、射源、機頭散射、jaw／MLC 的幾何、MU 校正 —— 引擎依它產生入射粒子與準直器。

v1 只有內建的**示範模型**（`demo-6x`）：參數是文獻與廠商公開資料的典型值，不代表任何一台實機，
用它算的結果一律標示範用。使用者實測擬合的模型（射束資料）之後加；這裡的格式就是之後存使用者模型的格式。

## demo-6x

* **能譜**：Mohan R, Chui C, Lidofsky L. *Energy and angular distributions of photons from medical linear
  accelerators.* Med Phys 1985;12:592–597 的 6 MV（Varian Clinac）；數值取自 EGSnrc 附的 `mohan6.spectrum`
  （24 段、0–6 MeV、每 MeV 的計數）。中心軸的能譜，**沒有**離軸軟化、沒有平坦濾片造成的「角」。
* **原射源**：在靶上的高斯焦點（σ 0.5 mm），往等中心平面的矩形範圍均勻發射（範圍跟著 jaw 開口）。
* **機頭散射**：一個延伸的第二射源（平坦濾片附近、靶下 125 mm、σ 15 mm），佔 7% 的粒子、同一個能譜。
* **準直器**（鎢，實體模擬；圓端、tongue-and-groove 沒有模型）：Y jaw（上）距靶 280 mm、X jaw（下）367 mm、
  MLC 465 mm、厚度 78／78／67 mm。
* **電子污染**：沒有模型（表面 1–2 cm 的劑量會偏低）。
* **MU 校正**：10 × 10 cm²、SSD 100 cm、水中 dmax 處 1 MU ＝ 1 cGy（`calibration`）；引擎第一次用這個模型時
  自己模擬參考條件求出「每 MU 幾個歷史」並快取。監測游離腔的反散射沒有模型。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

DEMO_6X_ID = "demo-6x"

# Mohan 1985 6 MV：每段上界（MeV）、每 MeV 的相對計數
MOHAN_6MV = (
    (0.25, 0.004107824), (0.50, 0.1295177), (0.75, 0.4609022), (1.00, 0.4609022), (1.25, 0.4435880),
    (1.50, 0.4084962), (1.75, 0.4084962), (2.00, 0.2496504), (2.25, 0.2367691), (2.50, 0.1867142),
    (2.75, 0.1382681), (3.00, 0.1304545), (3.25, 0.1484442), (3.50, 0.09496227), (3.75, 0.1246583),
    (4.00, 0.09773248), (4.25, 0.08891984), (4.50, 0.05154921), (4.75, 0.04184013), (5.00, 0.04803306),
    (5.25, 0.01624749), (5.50, 0.02715377), (5.75, 0.01199324), (6.00, 0.01573713),
)  # fmt: skip


def spectrum_lines(table: tuple[tuple[float, float], ...] = MOHAN_6MV) -> tuple[list[float], list[float]]:
    """能譜表 → 離散線（段的中點、這一段的機率；總和 1）。"""
    energies, weights, lo = [], [], 0.0
    for hi, per_mev in table:
        energies.append(round((lo + hi) / 2, 6))
        weights.append(per_mev * (hi - lo))
        lo = hi
    total = sum(weights)
    return energies, [w / total for w in weights]


def demo_6x() -> dict[str, Any]:
    energies, weights = spectrum_lines()
    return {
        "model_id": DEMO_6X_ID,
        "name": "Demo 6X",
        "demo": True,
        "energy_mv": 6.0,
        "fluence_mode": "STANDARD",
        "reference": (
            "Spectrum: Mohan, Chui, Lidofsky, Med Phys 1985;12:592 (6 MV), values as tabulated in EGSnrc "
            "mohan6.spectrum. Source, head-scatter and collimator geometry: typical published values, not a "
            "specific machine."
        ),
        "params": {
            "spectrum_mev": energies,
            "spectrum_weights": weights,
            "focal_spot_sigma_mm": 0.5,
            "extra_focal": {"fraction": 0.07, "distance_below_target_mm": 125.0, "sigma_mm": 15.0},
            "collimators": {
                "jaw_y": {"source_to_upstream_mm": 280.0, "thickness_mm": 78.0, "material": "G4_W"},
                "jaw_x": {"source_to_upstream_mm": 367.0, "thickness_mm": 78.0, "material": "G4_W"},
                "mlc": {
                    "source_to_upstream_mm": 465.0,
                    "thickness_mm": 67.0,
                    "leaf_length_mm": 155.0,
                    "material": "G4_W",
                },
            },
            "field_margin_mm": 10.0,
            "mlc_transmission": 0.015,
            "jaw_transmission": 0.001,
        },
        "calibration": {"field_mm": 100.0, "ssd_mm": 1000.0, "depth": "dmax", "gy_per_mu": 0.01},
    }


BUILTIN = {DEMO_6X_ID: demo_6x}


def model_hash(model: dict[str, Any]) -> str:
    """模型內容的雜湊（MU 校正的快取鍵：參數一改就要重新校正）。"""
    doc = {k: model.get(k) for k in ("model_id", "energy_mv", "fluence_mode", "params", "calibration")}
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def builtin_models() -> list[dict[str, Any]]:
    return [f() for f in BUILTIN.values()]


def model_for(
    beam_energy_mv: float, fluence_mode: str, model_id: str | None = None
) -> tuple[dict[str, Any] | None, str | None]:
    """這個射束用哪個模型；指定的模型能量或模式對不上 → 拒絕並說明。"""
    models = builtin_models()
    if model_id is not None:
        m = next((x for x in models if x["model_id"] == model_id), None)
        if m is None:
            return None, f"沒有射束模型 {model_id}"
    else:
        m = next(
            (x for x in models if abs(x["energy_mv"] - beam_energy_mv) < 0.01 and x["fluence_mode"] == fluence_mode),
            None,
        )
        if m is None:
            return None, f"沒有 {beam_energy_mv:g} MV {fluence_mode} 的射束模型"
    if abs(m["energy_mv"] - beam_energy_mv) >= 0.01 or m["fluence_mode"] != fluence_mode:
        have = f"{m['energy_mv']:g} MV {m['fluence_mode']}"
        return None, f"射束模型 {m['name']} 是 {have}，射束是 {beam_energy_mv:g} MV {fluence_mode}"
    return m, None
