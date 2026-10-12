"""射束模型：能譜、射源、機頭散射、穿透、MU 校正 —— 引擎依它產生入射粒子。

v1 只有內建的**示範模型**（`demo-6x`）：參數取自文獻的典型值，不代表任何一台實機，用它算的結果一律標示範用。
使用者實測擬合的模型（射束資料）之後加；這裡的格式就是之後存使用者模型的格式。
"""

from __future__ import annotations

from typing import Any

DEMO_6X_ID = "demo-6x"


def demo_6x() -> dict[str, Any]:
    return {
        "model_id": DEMO_6X_ID,
        "name": "Demo 6X",
        "demo": True,
        "energy_mv": 6.0,
        "fluence_mode": "STANDARD",
        "reference": "",
        "params": {
            # 之後的批次補上能譜、射源大小、機頭散射與 MU 校正；穿透係數現在就用得到（流程測試引擎）
            "mlc_transmission": 0.015,
            "jaw_transmission": 0.001,
        },
    }


BUILTIN = {DEMO_6X_ID: demo_6x}


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
