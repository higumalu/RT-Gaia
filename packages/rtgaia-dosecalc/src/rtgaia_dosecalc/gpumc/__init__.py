"""自己寫的 GPU Monte Carlo（光子＋電子／正子耦合輸運）—— 跟 OpenTOPAS（參考引擎）逐項比對後取代日常計算。

## 組成

* `tables.py`：物理資料表。用 OpenTOPAS 映像裡的 Geant4（同一版、同一套資料與物理列表）替 Schneider 25 段材質算
  截面與阻擋本領，快取在資料目錄。
* `transport.cu`：CUDA kernel（CuPy 的 NVRTC 編譯，不需要系統的 nvcc）。
* `transport.py`：把體素病人、表、射源交給 kernel；回每個體素的沉積能量與批次不確定度。
* `engine.py`：劑量計算引擎 `gpu`（跟 OpenTOPAS 引擎同一個射源模型與病人模型）。

## 物理（class II 濃縮歷史，跟 DPM／gDPM 同一類做法）

* 光子：Woodcock 追蹤；光電（能量全給電子、方向沿光子、不做螢光）、康普頓（Klein–Nishina，不含束縛效應）、
  成對（動能由電子與正子均分的近似）。**不做雷利散射**（MV 光子的劑量影響很小）。
* 電子／正子：受限阻擋本領的連續損失，加 Bohr 漲落（Gamma 分佈）；δ 射線（> 0.1 MeV）與制動輻射光子（> 0.05 MeV）
  是離散事件。彈性散射用混合式（PENELOPE 的做法）：大角度碰撞（平均自由程 max(λ_el, 0.05 λ1)）逐次模擬，
  屏蔽 Rutherford（Molière 屏蔽）× Mott 修正（McKinley–Feshbach）；小角度的在 random hinge 一次偏轉。
  總 λ1 對齊 Geant4 表（opt4 的 Goudsmit–Saunderson）。每一步最多損失 5% 動能、最長半個體素、停在體素邊界。
  正子停下才互毀。
* 截止：光子 10 keV、電子 50 keV 以下就地沉積。

## 跟 OpenTOPAS 的比對（`test_gpumc.py`；2026-10-13）

* 計畫：合成 6X 計畫三個射束的高劑量區 GPU／TOPAS 1.014–1.017、50% 範圍 Dice 0.95；科部 Halcyon 計畫（30 億歷史、
  30 秒）對 TPS γ 3%/3 mm 98.9%、3%/2 mm 97.3%；PROTEAS SRS（20 億、58 秒）99.9%／99.7%。

* 光子 2 MeV 平行光束、均勻水（0.5 mm 分格）：7 mm 以下各深度差 ≤ 0.4%，0.25 mm 深 +7%；總沉積能量差 0.02%；
  表面 KERMA 跟 Klein–Nishina 理論值差 ≤ 1.3%。
* 6 MV 能譜、水中肺板／骨板：建成區之後多數點 ±1%；**肺裡 GPU 高 1–3%**。
* 電子：2 MeV 筆形束（均勻水）R50 差 0.0–0.1 mm；1 MeV 45° 斜入射 R50 相同；均勻密度 0.5、2.0 都吻合。
* **已知限制**：電子從真空射入時，第一毫米的沉積比 TOPAS 多約 5%（TOPAS opt0 與 opt4 之間也差 2–4%）；
  均勻水的光子建成區從 3 mm 起差 ≤ 1.5%（之前看到的「建成區低 3–4%」是比對假體表面那層部分體積的密度造成的）。
* 機頭：準直器只算鎢的衰減，沒有準直器散射與電子污染 → 跟 OpenTOPAS 的機頭模擬比，MU 校正差約 2%
  （GPU 的劑量約高 1.5%）。
* 速度：2.5 mm 網格每秒 6–10 千萬個歷史（RTX 5090）；OpenTOPAS 在 24 核 CPU 約每秒 20–30 萬。

## 數值

輸運用 FP32；計分用 64 位元整數（定點），加總跟執行順序無關 → 同一個種子結果逐位元相同。
不確定度用批次法（預設 10 批）。

需要 CuPy（`uv sync --all-packages --extra gpu`）與 NVIDIA GPU；沒有就 `status()` 說明原因。
"""

from __future__ import annotations

from typing import Any


def status() -> dict[str, Any]:
    """GPU 引擎能不能用：CuPy 裝了沒、有沒有 GPU。"""
    try:
        import cupy as cp
    except ImportError:
        return {"ready": False, "reason": "沒有安裝 CuPy（uv sync --all-packages --extra gpu）"}
    try:
        n = cp.cuda.runtime.getDeviceCount()
        if n < 1:
            return {"ready": False, "reason": "沒有 NVIDIA GPU"}
        props = cp.cuda.runtime.getDeviceProperties(0)
        name = props["name"].decode() if isinstance(props["name"], bytes) else str(props["name"])
        return {"ready": True, "reason": "", "device": name, "compute_capability": f"{props['major']}.{props['minor']}"}
    except Exception as exc:  # noqa: BLE001 - 驅動、函式庫不符等都只是「不能用」的原因
        return {"ready": False, "reason": f"GPU 不能用：{exc}"}
