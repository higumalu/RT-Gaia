"""3D γ 交叉比對：我們的 `rtgaia_core.gamma` vs pymedphys（Apache-2.0，獨立的實作）。

pymedphys 不是專案的相依套件，跑的時候臨時裝：

    uv run --with pymedphys==0.41.0 --with numba==0.68.0 python scripts/crosscheck-gamma-pymedphys.py

案例都是合成的（同一個軸對齊網格；pymedphys 只吃軸對齊）：平移的線性梯度、整片偏高、高斯劑量團加雜訊與平移、
局部正規化。兩邊都是格點化搜尋、都只會**高估** γ，比較低的那邊比較接近連續的最小值，所以比的是單向的：
我們比 pymedphys 高的不能超過 `MAX_OURS_HIGHER`（比它低沒關係），通過率差不能超過 `MAX_RATE_DIFF`；
線性梯度另外對解析解 γ ＝ δ／√(DTA² ＋ (ΔD／斜率)²)。任一案例超過 → 退出碼 1。
"""

from __future__ import annotations

import sys
import time

import numpy as np
import pymedphys
from rtgaia_core import gamma as gm
from rtgaia_geom import Grid

SIZE = (40, 36, 30)  # i, j, k
SPACING = 2.0
MAX_OURS_HIGHER = 0.1
"""我們的 γ 最多比 pymedphys 高多少（細找之後剩下的格點誤差）。"""
MAX_ANALYTIC_ERR = 0.002
MAX_RATE_DIFF = 0.005


def grid() -> Grid:
    return Grid(
        size=SIZE,
        spacing=(SPACING,) * 3,
        origin=(0.0, 0.0, 0.0),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid="x",
    )


def axes() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ni, nj, nk = SIZE
    return tuple(np.arange(n, dtype=np.float64) * SPACING for n in (nk, nj, ni))  # type: ignore[return-value]


def world() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    z, y, x = np.meshgrid(*axes(), indexing="ij")
    return x, y, z


def cases() -> list[tuple[str, np.ndarray, np.ndarray, dict]]:
    x, y, z = world()
    rng = np.random.default_rng(1)
    ramp = 5 + 0.3 * x
    blob = 60 * np.exp(-((x - 40) ** 2 + (y - 36) ** 2 + (z - 30) ** 2) / (2 * 18**2))
    blob_e = 60 * 1.01 * np.exp(-((x - 41.2) ** 2 + (y - 36) ** 2 + (z - 30) ** 2) / (2 * 18**2)) + rng.normal(
        0, 0.4, x.shape
    )
    blob_far = 60 * 1.04 * np.exp(-((x - 42.5) ** 2 + (y - 36) ** 2 + (z - 30) ** 2) / (2 * 18**2))
    return [
        (
            "線性梯度平移 1.5 mm",
            ramp,
            5 + 0.3 * (x - 1.5),
            {"analytic": 1.5 / np.sqrt(2**2 + (0.03 * ramp.max() / 0.3) ** 2)},
        ),
        ("整片偏高 4%", np.full(x.shape, 50.0), np.full(x.shape, 52.0), {}),
        ("高斯團 ＋1% ＋ 1.2 mm ＋ 雜訊", blob, blob_e, {}),
        ("高斯團 局部 3%/2 mm", blob, blob_e, {"local": True}),
        ("高斯團 ＋4% ＋ 2.5 mm（通過率在中間）", blob, blob_far, {}),
    ]


def main() -> int:
    g = grid()
    failed = False
    for name, ref, ev, opt in cases():
        local = bool(opt.get("local"))
        c = gm.GammaCriteria(
            dose_pct=3,
            dta_mm=2,
            threshold_pct=10,
            normalization="local" if local else "global",
            resolution=10,
            max_gamma=2,
        )
        t0 = time.time()
        ours = gm.gamma_3d(ref.astype(np.float32), g, ev.astype(np.float32), g, np.eye(4), c)
        t1 = time.time()
        theirs = pymedphys.gamma(
            axes(), ref, axes(), ev, 3, 2, lower_percent_dose_cutoff=10, interp_fraction=10, max_gamma=2,
            local_gamma=local, global_normalisation=float(ref.max()), quiet=True,
        )  # fmt: skip
        t2 = time.time()
        a = ours.gamma_kji.astype(np.float64)
        b = np.minimum(np.asarray(theirs, dtype=np.float64), 2.0)
        both = np.isfinite(a) & np.isfinite(b)
        # 邊緣兩格：pymedphys 在網格外不取樣、我們也不取 → 兩邊對邊界的處理不同，不比
        inner = np.zeros_like(both)
        inner[2:-2, 2:-2, 2:-2] = True
        m = both & inner
        diff = a[m] - b[m]
        rate_a = float((a[m] <= 1).mean())
        rate_b = float((b[m] <= 1).mean())
        ok = diff.max() <= MAX_OURS_HIGHER and abs(rate_a - rate_b) <= MAX_RATE_DIFF
        extra = ""
        if "analytic" in opt:
            exact = opt["analytic"]
            err = float(np.abs(a[m] - exact).max())
            err_b = float(np.abs(b[m] - exact).max())
            ok &= err <= MAX_ANALYTIC_ERR
            extra = f"、對解析解 {exact:.4f} 最大誤差 {err:.4f}（pymedphys {err_b:.4f}）"
        failed |= not ok
        lower = (diff < -1e-3).mean() * 100
        print(
            f"{'✓' if ok else '✗'} {name}：{m.sum()} 點、我們 − pymedphys 最大 {diff.max():+.3f} "
            f"最小 {diff.min():+.3f}、我們較低的點 {lower:.0f}%、"
            f"通過率 我們 {rate_a * 100:.2f}% vs pymedphys {rate_b * 100:.2f}%"
            f"（{t1 - t0:.1f} s vs {t2 - t1:.1f} s）{extra}"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
