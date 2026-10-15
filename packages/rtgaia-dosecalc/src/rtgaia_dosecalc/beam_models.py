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
  MLC 465 mm、厚度 78／78／67 mm。葉片長度 `leaf_length_mm` 是**投影到等中心平面**的長度（TOPAS `TsDivergingMLC`
  的定義，跟開口一樣）：320 mm —— 葉片在射野任何位置關起來，身後都還擋得到對側射野邊緣（± 140 mm）；
  太短的話，偏離中心關起來的葉片後面會漏光（沒有 jaw 的雙層 MLC 直接打進病人）。
* **電子污染**：沒有模型（表面 1–2 cm 的劑量會偏低）。
* **MU 校正**：10 × 10 cm²、SSD 100 cm、水中 dmax 處 1 MU ＝ 1 cGy（`calibration`）；引擎第一次用這個模型時
  自己模擬參考條件求出「每 MU 幾個歷史」並快取。監測游離腔的反散射沒有模型。

## 擬合用的成分（射束資料擬合出來的模型才有；示範模型沒有這些鍵，行為跟以前一樣）

* `electron_contamination`：`fraction`（佔發射粒子的比例，約 1e-4–1e-3）、`mean_energy_mev`（能譜 exp(−E／平均)，
  切在標稱能量）、`sigma_mm`（射源的高斯大小 → 在病人表面抹開的寬度：小射野中心軸分到的少）、
  `distance_below_target_mm`。方向只往開口；不過準直器，直接放到網格表面。**只有 GPU 引擎發射**
  （OpenTOPAS 用實體機頭與空氣，結果的備註會寫）。
* `monitor_backscatter`：`per_mm_x`、`per_mm_y` —— 監測游離腔訊號 s ＝ 1 ＋ b_x（X_ref − X）＋ b_y（Y_ref − Y）
  （jaw 開口，參考射野 ＝ MU 校正的射野）；每 MU 的粒子數 ∝ 1／s。沒有 jaw 的機型不用。
* 準直器的 `density_factor`：有效密度比（葉間漏射、鎢合金）；GPU 乘在路徑長上、OpenTOPAS 用同組成的自訂材質。
* `focal_spot_sigma_mm`、`extra_focal`、`angular_sigma_deg`、能譜本來就有，擬合會調。

## demo-6xfff、demo-6xfff-dual（無整平濾片）

* **能譜**：上面的 Mohan 6 MV **扣回 1.5 cm 銅的衰減**（拿掉整平濾片 → 低能多、能譜變軟）：
  w_FFF(E) ∝ w(E) · exp(μ/ρ_Cu(E) · 8.96 g/cm³ · 1.5 cm)；μ/ρ 取自 NIST XCOM 的銅（`NIST_CU_MU_RHO`）。
  平均能量 1.90 → 1.64 MeV。濾片厚度是**假設**（廠商不公開）。
* **離軸**：FFF 的通量往外掉 —— 原射源用高斯角分佈，σ 7.6°（假設在等中心平面 10 cm 處降到 75%）。
* **機頭散射**：3%（沒有濾片，比有濾片少）。
* `demo-6xfff`：單層 MLCX（Millennium 120 類）＋ X／Y jaw，同 demo-6x 的位置。
* `demo-6xfff-dual`：**雙層 MLC**（Halcyon 類：下層 MLCX1、上層 MLCX2 錯開半片）、**沒有 jaw**（DICOM 裡的 X／Y 是
  固定的虛擬值）；上面一組**固定的主準直器**（`fixed_y`、`fixed_x`，開口 ± 140 mm 不動）擋住 MLC 總寬度以外 ——
  發射錐角是包住開口的橢圓，會超出 MLC 的範圍，沒有它那裡的粒子直接打進病人。高度與厚度都是假設的典型值。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

DEMO_6X_ID = "demo-6x"
COMMON_LIMITATIONS = (
    "示範模型：參數是文獻與公開資料的典型值，不代表任何一台實機",
    "沒有電子污染的模型（表面 1–2 cm 的劑量偏低）",
    "葉片圓端與 tongue-and-groove 沒有模型",
    "監測游離腔的反散射沒有模型（MU 跟射野大小的關係只來自幾何）",
)
"""每個示範模型都有的限制（管理頁「射束模型」列出來；不進模型雜湊）。"""
LEAF_LENGTH_MM = 320.0
"""葉片長度（投影到等中心平面）：≥ 射野寬（280 mm）＋ 餘裕。"""

# Mohan 1985 6 MV：每段上界（MeV）、每 MeV 的相對計數
MOHAN_6MV = (
    (0.25, 0.004107824), (0.50, 0.1295177), (0.75, 0.4609022), (1.00, 0.4609022), (1.25, 0.4435880),
    (1.50, 0.4084962), (1.75, 0.4084962), (2.00, 0.2496504), (2.25, 0.2367691), (2.50, 0.1867142),
    (2.75, 0.1382681), (3.00, 0.1304545), (3.25, 0.1484442), (3.50, 0.09496227), (3.75, 0.1246583),
    (4.00, 0.09773248), (4.25, 0.08891984), (4.50, 0.05154921), (4.75, 0.04184013), (5.00, 0.04803306),
    (5.25, 0.01624749), (5.50, 0.02715377), (5.75, 0.01199324), (6.00, 0.01573713),
)  # fmt: skip


# NIST XCOM 銅的質量衰減係數（MeV、cm²/g；https://physics.nist.gov/PhysRefData/XrayMassCoef/ElemTab/z29.html）
NIST_CU_MU_RHO = (
    (0.1, 0.4584), (0.15, 0.2217), (0.2, 0.1559), (0.3, 0.1119), (0.4, 0.09413), (0.5, 0.08362), (0.6, 0.07625),
    (0.8, 0.06605), (1.0, 0.05901), (1.25, 0.05261), (1.5, 0.04803), (2.0, 0.04205), (3.0, 0.03599), (4.0, 0.03318),
    (5.0, 0.03177), (6.0, 0.03108), (8.0, 0.03074), (10.0, 0.03103),
)  # fmt: skip
CU_DENSITY = 8.96
FFF_FILTER_CU_CM = 1.5
FFF_ANGULAR_SIGMA_DEG = 7.6


def fff_lines(filter_cm: float = FFF_FILTER_CU_CM) -> tuple[list[float], list[float]]:
    """Mohan 6 MV 扣回 `filter_cm` 銅的衰減（對數內插 NIST 的 μ/ρ）。"""
    import math

    energies, weights = spectrum_lines()
    xs = [math.log(e) for e, _ in NIST_CU_MU_RHO]
    ys = [math.log(m) for _, m in NIST_CU_MU_RHO]

    def mu_rho(e: float) -> float:
        x = math.log(max(e, NIST_CU_MU_RHO[0][0]))
        for i in range(len(xs) - 1):
            if x <= xs[i + 1]:
                t = (x - xs[i]) / (xs[i + 1] - xs[i])
                return math.exp(ys[i] + t * (ys[i + 1] - ys[i]))
        return math.exp(ys[-1])

    w = [wi * math.exp(mu_rho(e) * CU_DENSITY * filter_cm) for e, wi in zip(energies, weights, strict=True)]
    total = sum(w)
    return energies, [x / total for x in w]


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
                "MLCX": {
                    "source_to_upstream_mm": 465.0,
                    "thickness_mm": 67.0,
                    "leaf_length_mm": LEAF_LENGTH_MM,
                    "material": "G4_W",
                },
            },
            "field_margin_mm": 10.0,
            "mlc_transmission": 0.015,
            "jaw_transmission": 0.001,
        },
        "calibration": {"field_mm": 100.0, "ssd_mm": 1000.0, "depth": "dmax", "gy_per_mu": 0.01},
        "mlc_devices": ["MLCX"],
        "limitations": [*COMMON_LIMITATIONS, "能譜沒有離軸軟化（中心軸的能譜用在整個射野）"],
    }


DEMO_6XFFF_ID = "demo-6xfff"
DEMO_6XFFF_DUAL_ID = "demo-6xfff-dual"


def demo_6xfff() -> dict[str, Any]:
    m = demo_6x()
    energies, weights = fff_lines()
    m.update(
        model_id=DEMO_6XFFF_ID,
        name="Demo 6X FFF",
        fluence_mode="FFF",
        reference=(
            "Spectrum: Mohan 6 MV (Med Phys 1985;12:592) with the attenuation of an assumed 1.5 cm copper flattening "
            "filter removed (NIST XCOM mu/rho of copper). Off-axis fall-off, head scatter and collimator geometry: "
            "assumed typical values, not a specific machine."
        ),
    )
    m["params"] = {
        **m["params"],
        "spectrum_mev": energies,
        "spectrum_weights": weights,
        "angular_sigma_deg": FFF_ANGULAR_SIGMA_DEG,
        "extra_focal": {"fraction": 0.03, "distance_below_target_mm": 125.0, "sigma_mm": 15.0},
    }
    m["limitations"] = [*COMMON_LIMITATIONS, "整平濾片的厚度（1.5 cm 銅）與離軸的角分佈（σ 7.6°）是假設"]
    return m


def demo_6xfff_dual() -> dict[str, Any]:
    m = demo_6xfff()
    m.update(model_id=DEMO_6XFFF_DUAL_ID, name="Demo 6X FFF (dual-layer MLC)", mlc_devices=["MLCX1", "MLCX2"])
    m["params"] = {
        **m["params"],
        "collimators": {
            # 固定的主準直器：最大射野 280 × 280 mm（等中心平面）；MLC 的總寬度外面靠它擋
            "fixed_y": {
                "source_to_upstream_mm": 250.0,
                "thickness_mm": 70.0,
                "material": "G4_W",
                "half_field_mm": 140.0,
            },
            "fixed_x": {
                "source_to_upstream_mm": 330.0,
                "thickness_mm": 70.0,
                "material": "G4_W",
                "half_field_mm": 140.0,
            },
            "MLCX1": {
                "source_to_upstream_mm": 500.0,
                "thickness_mm": 77.0,
                "leaf_length_mm": LEAF_LENGTH_MM,
                "material": "G4_W",
            },
            "MLCX2": {
                "source_to_upstream_mm": 410.0,
                "thickness_mm": 77.0,
                "leaf_length_mm": LEAF_LENGTH_MM,
                "material": "G4_W",
            },
        },
        # MU 校正的參考射野用 MLC 開：下層 28 對 10 mm（−140…140）、上層 29 對錯開半片（−145…145）
        "calibration_leaves": {
            "MLCX1": [float(v) for v in range(-140, 141, 10)],
            "MLCX2": [float(v) for v in range(-145, 146, 10)],
        },
    }
    m["limitations"] = [*m["limitations"], "雙層 MLC 與固定主準直器的高度、厚度是假設的典型值"]
    return m


def _describe(energy_mv: float, fluence_mode: str, mlc_devices: list[str]) -> str:
    """「6 MV FFF (MLCX1/MLCX2)」：錯誤訊息裡說模型或射束是哪一種。"""
    return f"{energy_mv:g} MV {fluence_mode} ({'/'.join(mlc_devices) or 'no MLC'})"


BUILTIN = {DEMO_6X_ID: demo_6x, DEMO_6XFFF_ID: demo_6xfff, DEMO_6XFFF_DUAL_ID: demo_6xfff_dual}


def model_hash(model: dict[str, Any]) -> str:
    """模型內容的雜湊（MU 校正的快取鍵：參數一改就要重新校正）。"""
    doc = {k: model.get(k) for k in ("model_id", "energy_mv", "fluence_mode", "params", "calibration", "mlc_devices")}
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def builtin_models() -> list[dict[str, Any]]:
    return [f() for f in BUILTIN.values()]


def _fits(m: dict[str, Any], energy: float, mode: str, mlc: list[str]) -> bool:
    return (
        abs(m["energy_mv"] - energy) < 0.01 and m["fluence_mode"] == mode and (not mlc or mlc == m.get("mlc_devices"))
    )


def model_for(
    beam_energy_mv: float,
    fluence_mode: str,
    model_id: str | None = None,
    mlc_devices: list[str] | None = None,
    *,
    user_models: list[dict[str, Any]] | None = None,
    machine: str = "",
) -> tuple[dict[str, Any] | None, str | None]:
    """這個射束用哪個模型（能量、模式、MLC 種類都要對得上）；對不上 → 拒絕並說明。

    `user_models`：使用者的模型（擬合出來的），每個是 `{"model": …, "status": …, "machines": [...]}`。
    沒指定 `model_id` 時：**啟用中**的使用者模型優先（有寫機器名稱的，要跟射束的 TreatmentMachineName 一樣才算；
    寫了的比沒寫的優先），都沒有才用內建的示範模型。指定 `model_id` 時：內建、啟用中或草稿都可以（草稿是給管理者
    啟用前試算用；停用的不行）。"""
    mlc = list(mlc_devices or [])
    users = list(user_models or [])
    builtin = builtin_models()
    if model_id is not None:
        m = next((x for x in builtin if x["model_id"] == model_id), None)
        if m is None:
            rec = next((u for u in users if u["model"]["model_id"] == model_id), None)
            if rec is None:
                return None, f"沒有射束模型 {model_id}"
            if rec.get("status") == "retired":
                return None, f"射束模型 {model_id} 已停用"
            m = rec["model"]
    else:
        name = (machine or "").strip().lower()
        active = [
            u for u in users if u.get("status") == "active" and _fits(u["model"], beam_energy_mv, fluence_mode, mlc)
        ]
        named = [u for u in active if name and name in [str(x).strip().lower() for x in u.get("machines") or []]]
        anyone = [u for u in active if not u.get("machines")]
        pick = (named or anyone or [None])[0]
        m = pick["model"] if pick else next((x for x in builtin if _fits(x, beam_energy_mv, fluence_mode, mlc)), None)
        if m is None:
            return None, f"沒有 {_describe(beam_energy_mv, fluence_mode, mlc)} 的射束模型"
    if not _fits(m, beam_energy_mv, fluence_mode, mlc):
        have = _describe(m["energy_mv"], m["fluence_mode"], list(m.get("mlc_devices") or []))
        want = _describe(beam_energy_mv, fluence_mode, mlc)
        return None, f"射束模型 {m['name']} 是 {have}，射束是 {want}"
    return m, None
