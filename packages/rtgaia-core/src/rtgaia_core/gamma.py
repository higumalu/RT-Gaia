"""3D gamma 分析 —— 純 numpy／scipy，零 FastAPI。

> 參考劑量 R 的每個體素中心，在被評估劑量 E 裡找最接近的一點：

    γ(r) = min over r'  sqrt( |r' − r|² / DTA²  +  (E(r') − R(r))² / ΔD² )

* **ΔD**：全域（global）＝ `dose_pct`% × 正規化劑量（預設 R 的最大值）；局部（local）＝ `dose_pct`% × R(r)。
* **低劑量門檻**：R(r) < `threshold_pct`% × 正規化劑量 的點不評估（NaN）。
* **搜尋**：r' 取在以 r 為中心、半徑 `max_gamma` × DTA 的球裡，間距 DTA ÷ `resolution` 的格點
  （世界座標，沿參考網格的軸），E 在 r' 用三線性內插。
  依距離由近到遠搜；一個點目前最好的 γ ≤ 下一圈的距離項（|r' − r| ÷ DTA）就停 ——
  距離項只會變大，更遠的格點不可能更好，所以這個提早停止**不改變結果**。
* **上限**：搜到半徑還找不到 ≤ `max_gamma` 的點 → γ 記成 `max_gamma`（顯示與統計都當「≥ max_gamma」）。
* **沒資料**：E 在參考點本身（零位移）是網格外或 NaN → 那個點不評估（NaN），另外計數（`no_data`），不當成失敗；
  不拿搜尋球裡遠處的值來湊（貼著 E 邊界的點會因此變成「只在遠處找到相同劑量」的假失敗或假通過）。
  搜尋途中遇到網格外或 NaN 的格點只是略過。

## 準確度

格點化的搜尋只會**高估** γ（真正的最小值可能落在格點之間）。誤差**不只**是距離項的 ½ 格距 ÷ DTA：
最近的格點離真正的最佳位置最多 √3／2 格距，劑量陡、ΔD 小的地方（局部正規化、雜訊）劑量項因此可以差很多
（pymedphys 交叉比對時查到：局部 3%/2 mm、加雜訊的高斯團差到 0.15）。所以格點搜完之後在最佳位置附近
**再細找 `REFINE_ROUNDS` 輪**（每輪格距 ÷ 3、試周圍 26 點，不超出搜尋半徑），結果貼近連續的最小值。
TG-218 建議被評估劑量的取樣間距 ≤ DTA ÷ 3；這裡預設 5。三線性內插對線性劑量場是精確的
（測試用線性梯度的解析解核對）。

## 失敗點的說明

γ > 1 的點依參考劑量的局部梯度分兩類 ——

* **高梯度區**：|∇R| × DTA ≥ ΔD（在這裡移動 DTA 的劑量變化就超過 ΔD）→ γ 主要反映**位置**對不上（射野邊緣、MLC、對位）；
* **平坦區**：其餘 → γ 主要反映**劑量值**不同；再依 E − R（零位移處）的正負分「偏高」「偏低」——
  大片平坦區同向偏差通常是系統性的（輸出、MU、密度換算），不是幾何。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from rtgaia_geom import Grid

NORMALIZATIONS = ("global", "local")
RESOLUTIONS = (3, 5, 10)
DEFAULT_DOSE_PCT = 3.0
DEFAULT_DTA_MM = 2.0
DEFAULT_THRESHOLD_PCT = 10.0
DEFAULT_MAX_GAMMA = 2.0
DEFAULT_RESOLUTION = 5
MAX_OFFSETS = 40_000
"""搜尋球的格點數上限（`max_gamma` 3、`resolution` 10 → 約 11 萬點，擋掉）。"""
CHUNK_POINTS = 50_000
"""一塊的參考點數（一個執行緒一次處理一塊；記憶體 ≈ 點數 × 3 個 float64 座標）。"""


def threads() -> int:
    """γ 用幾個執行緒（`RTGAIA_GAMMA_THREADS`，預設 CPU 數的一半、最多 16）。"""
    import os

    raw = os.environ.get("RTGAIA_GAMMA_THREADS", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return max(1, min(16, (os.cpu_count() or 2) // 2))


HISTOGRAM_BINS = 40
REFINE_ROUNDS = 2
_NEIGHBORS = np.array(
    [(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1) if (a, b, c) != (0, 0, 0)], dtype=np.float64
)


@dataclass(frozen=True)
class GammaCriteria:
    dose_pct: float = DEFAULT_DOSE_PCT
    dta_mm: float = DEFAULT_DTA_MM
    normalization: str = "global"
    threshold_pct: float = DEFAULT_THRESHOLD_PCT
    norm_gy: float | None = None
    """全域 ΔD 與門檻的基準；None ＝ 參考劑量的最大值。"""
    max_gamma: float = DEFAULT_MAX_GAMMA
    resolution: int = DEFAULT_RESOLUTION

    def to_wire(self) -> dict[str, Any]:
        return {
            "dose_pct": self.dose_pct,
            "dta_mm": self.dta_mm,
            "normalization": self.normalization,
            "threshold_pct": self.threshold_pct,
            "norm_gy": self.norm_gy,
            "max_gamma": self.max_gamma,
            "resolution": self.resolution,
        }

    @property
    def label(self) -> str:
        """`3%/2 mm G, 10%`。"""
        norm = "G" if self.normalization == "global" else "L"
        return f"{self.dose_pct:g}%/{self.dta_mm:g} mm {norm}, {self.threshold_pct:g}%"


def check_criteria(body: dict[str, Any]) -> tuple[GammaCriteria | None, str | None]:
    """請求的條件 → `GammaCriteria`；不合理的回原因。"""

    def num(key: str, default: float) -> float:
        v = body.get(key, default)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v):
            raise ValueError(f"{key} 要是數字")
        return float(v)

    try:
        dose_pct = num("dose_pct", DEFAULT_DOSE_PCT)
        dta_mm = num("dta_mm", DEFAULT_DTA_MM)
        threshold_pct = num("threshold_pct", DEFAULT_THRESHOLD_PCT)
        max_gamma = num("max_gamma", DEFAULT_MAX_GAMMA)
        norm_raw = body.get("norm_gy")
        norm_gy = None if norm_raw is None else num("norm_gy", 0.0)
    except ValueError as exc:
        return None, str(exc)
    normalization = body.get("normalization", "global")
    resolution = body.get("resolution", DEFAULT_RESOLUTION)
    if not 0.1 <= dose_pct <= 20:
        return None, "劑量差標準要在 0.1%–20%"
    if not 0.1 <= dta_mm <= 10:
        return None, "距離標準要在 0.1–10 mm"
    if not 0 <= threshold_pct < 100:
        return None, "低劑量門檻要在 0%–100%"
    if not 1 <= max_gamma <= 3:
        return None, "γ 上限要在 1–3"
    if normalization not in NORMALIZATIONS:
        return None, "正規化要是 global 或 local"
    if resolution not in RESOLUTIONS:
        return None, "搜尋解析度要是 DTA ÷ 3、÷ 5 或 ÷ 10"
    if norm_gy is not None and norm_gy <= 0:
        return None, "正規化劑量要是正數"
    c = GammaCriteria(
        dose_pct=dose_pct,
        dta_mm=dta_mm,
        normalization=str(normalization),
        threshold_pct=threshold_pct,
        norm_gy=norm_gy,
        max_gamma=max_gamma,
        resolution=int(resolution),
    )
    if len(search_offsets_mm(c)) > MAX_OFFSETS:
        return None, "搜尋範圍太大（降低 γ 上限或搜尋解析度）"
    return c, None


def search_offsets_mm(c: GammaCriteria) -> np.ndarray:
    """搜尋球裡的格點（mm，(M, 3)），依距離由近到遠；第一個是 (0, 0, 0)。"""
    step = c.dta_mm / c.resolution
    radius = c.max_gamma * c.dta_mm
    n = int(np.floor(radius / step + 1e-9))
    ax = np.arange(-n, n + 1, dtype=np.float64) * step
    gx, gy, gz = np.meshgrid(ax, ax, ax, indexing="ij")
    pts = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    d = np.linalg.norm(pts, axis=1)
    keep = d <= radius + 1e-9
    pts, d = pts[keep], d[keep]
    order = np.argsort(d, kind="stable")
    return pts[order]


@dataclass
class GammaResult:
    gamma_kji: np.ndarray
    """參考網格上的 γ（float32）；沒評估的 NaN；≥ `max_gamma` 的記成 `max_gamma`。"""
    stats: dict[str, Any]


def gamma_3d(
    ref_kji: np.ndarray,
    ref_grid: Grid,
    eval_kji: np.ndarray,
    eval_grid: Grid,
    eval_to_ref: np.ndarray,
    criteria: GammaCriteria,
) -> GammaResult:
    """`eval_to_ref`：row-major 4×4，被評估劑量的世界座標 → 參考劑量的世界座標（同一個空間就是單位矩陣）。"""
    from scipy.ndimage import map_coordinates

    c = criteria
    ref = np.asarray(ref_kji, dtype=np.float32)
    ev = np.asarray(eval_kji, dtype=np.float32)
    finite_ref = np.isfinite(ref)
    ref_max = float(ref[finite_ref].max()) if finite_ref.any() else 0.0
    norm = float(c.norm_gy) if c.norm_gy is not None else ref_max
    out = np.full(ref.shape, np.nan, dtype=np.float32)
    if norm <= 0:
        return GammaResult(out, _stats(out, np.zeros(0), np.zeros(0, bool), np.zeros(0), 0, c, norm, ref_max))
    threshold = c.threshold_pct / 100.0 * norm
    sel = finite_ref & (ref >= threshold)
    kk, jj, ii = np.nonzero(sel)
    n = kk.size
    # 參考點 → 被評估劑量的連續索引（ijk）：ref ijk → ref world → eval world → eval ijk
    m = eval_grid.world_to_index_matrix @ np.linalg.inv(eval_to_ref) @ ref_grid.index_to_world_matrix
    offsets_mm = search_offsets_mm(c)
    # 位移沿參考網格的軸（世界 mm）→ eval 索引的位移
    ref_dir = ref_grid.direction_matrix
    lin = eval_grid.world_to_index_matrix[:3, :3] @ np.linalg.inv(eval_to_ref)[:3, :3]
    offsets_idx = (lin @ (ref_dir @ offsets_mm.T)).T  # (M, 3) ijk
    dist2 = (np.linalg.norm(offsets_mm, axis=1) / c.dta_mm) ** 2
    gmax2 = c.max_gamma**2
    to_idx = lin @ ref_dir  # 參考網格軸上的 mm 位移 → eval 索引位移
    step = c.dta_mm / c.resolution
    radius = c.max_gamma * c.dta_mm
    gamma2_all = np.empty(n, dtype=np.float64)
    zero_diff = np.full(n, np.nan, dtype=np.float64)

    def chunk(start: int) -> None:
        sl = slice(start, min(n, start + CHUNK_POINTS))
        pk, pj, pi = kk[sl], jj[sl], ii[sl]
        r = ref[pk, pj, pi].astype(np.float64)
        dd = (c.dose_pct / 100.0) * (np.full_like(r, norm) if c.normalization == "global" else r)
        inv_dd2 = 1.0 / np.maximum(dd, 1e-12) ** 2
        base = m[:3, :3] @ np.stack([pi, pj, pk]).astype(np.float64) + m[:3, 3:4]  # (3, N) ijk
        best = np.full(r.size, np.inf)
        best_off = np.zeros((r.size, 3))
        seen = np.zeros(r.size, dtype=bool)
        active = np.arange(r.size)
        for o in range(offsets_idx.shape[0]):
            d2 = dist2[o]
            if d2 > gmax2:
                break
            # 距離項已經不小於目前最好的 → 這些點不可能再更好
            if o > 0:
                active = active[best[active] > d2]
                if active.size == 0:
                    break
            q = base[:, active] + offsets_idx[o][:, None]
            e = map_coordinates(ev, [q[2], q[1], q[0]], order=1, mode="constant", cval=np.nan, prefilter=False)
            ok = np.isfinite(e)
            if o == 0:
                zero_diff[start + active[ok]] = e[ok] - r[active[ok]]
                # 參考點本身沒有被評估劑量 → 不評估（不拿遠處的值來湊）
                active, e, ok = active[ok], e[ok], ok[ok]
            if not ok.any():
                continue
            idx = active[ok]
            g2 = d2 + (e[ok] - r[idx]) ** 2 * inv_dd2[idx]
            seen[idx] = True
            better = g2 < best[idx]
            best[idx[better]] = g2[better]
            best_off[idx[better]] = offsets_mm[o]
        # 在最佳格點附近細找（只找 0 < γ < 上限的點：0 不會更好、上限以上照記上限）
        for k in range(1, REFINE_ROUNDS + 1):
            pts = np.nonzero(seen & (best > 0) & (best < gmax2))[0]
            if pts.size == 0:
                break
            h = step / 3**k
            for nb in _NEIGHBORS:
                cand = best_off[pts] + nb * h
                d2c = np.sum(cand**2, axis=1) / c.dta_mm**2
                inside = (d2c <= (radius / c.dta_mm) ** 2 + 1e-12) & (d2c < best[pts])
                if not inside.any():
                    continue
                p_in = pts[inside]
                q = base[:, p_in] + to_idx @ cand[inside].T
                e = map_coordinates(ev, [q[2], q[1], q[0]], order=1, mode="constant", cval=np.nan, prefilter=False)
                ok = np.isfinite(e)
                g2 = d2c[inside][ok] + (e[ok] - r[p_in[ok]]) ** 2 * inv_dd2[p_in[ok]]
                better = g2 < best[p_in[ok]]
                upd = p_in[ok][better]
                best[upd] = g2[better]
                best_off[upd] = cand[inside][ok][better]
        best = np.where(seen, np.minimum(best, gmax2), np.nan)
        gamma2_all[sl] = best

    # 每塊各自獨立（只寫自己那一段），scipy 的內插會釋放 GIL → 多執行緒真的平行；結果跟單執行緒逐位元相同
    starts = list(range(0, n, CHUNK_POINTS))
    workers = max(1, min(threads(), len(starts)))
    if workers == 1:
        for st in starts:
            chunk(st)
    else:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(chunk, starts))
    gamma = np.sqrt(gamma2_all)
    out[kk, jj, ii] = gamma.astype(np.float32)
    # 失敗點的說明：參考劑量的梯度（Gy／mm）
    high_grad = np.zeros(n, dtype=bool)
    if n:
        spacing = np.asarray(ref_grid.spacing, dtype=np.float64)
        filled = np.where(finite_ref, ref, 0.0).astype(np.float32)
        gk, gj, gi = np.gradient(filled, spacing[2], spacing[1], spacing[0])
        grad = np.sqrt(gk[kk, jj, ii] ** 2 + gj[kk, jj, ii] ** 2 + gi[kk, jj, ii] ** 2).astype(np.float64)
        r_all = ref[kk, jj, ii].astype(np.float64)
        dd_all = (c.dose_pct / 100.0) * (norm if c.normalization == "global" else r_all)
        high_grad = grad * c.dta_mm >= dd_all
    return GammaResult(out, _stats(out, gamma, high_grad, zero_diff, n, c, norm, ref_max))


def _stats(
    out: np.ndarray,
    gamma: np.ndarray,
    high_grad: np.ndarray,
    zero_diff: np.ndarray,
    candidates: int,
    c: GammaCriteria,
    norm: float,
    ref_max: float,
) -> dict[str, Any]:
    evaluated = np.isfinite(gamma)
    g = gamma[evaluated]
    n_eval = int(g.size)
    fail = g > 1.0
    edges = np.linspace(0.0, c.max_gamma, HISTOGRAM_BINS + 1)
    hist = np.histogram(np.minimum(g, c.max_gamma), bins=edges)[0] if n_eval else np.zeros(HISTOGRAM_BINS, int)
    hg = high_grad[evaluated] if high_grad.size else np.zeros(n_eval, bool)
    zd = zero_diff[evaluated] if zero_diff.size else np.zeros(n_eval)
    flat_fail = fail & ~hg
    return {
        "criteria": c.to_wire(),
        "criteria_label": c.label,
        "norm_gy": norm,
        "reference_max_gy": ref_max,
        "threshold_gy": c.threshold_pct / 100.0 * norm,
        "candidates": int(candidates),
        "evaluated": n_eval,
        "no_data": int(candidates - n_eval),
        "pass_rate": float((~fail).mean()) if n_eval else None,
        "mean_gamma": float(g.mean()) if n_eval else None,
        "p95_gamma": float(np.percentile(g, 95)) if n_eval else None,
        "max_gamma": float(g.max()) if n_eval else None,
        "capped": int((g >= c.max_gamma - 1e-9).sum()),
        "histogram": {"edges": edges.tolist(), "counts": [int(x) for x in hist]},
        "failures": {
            "count": int(fail.sum()),
            "high_gradient": int((fail & hg).sum()),
            "flat": int(flat_fail.sum()),
            "flat_hot": int((flat_fail & (zd > 0)).sum()),
            "flat_cold": int((flat_fail & (zd < 0)).sum()),
        },
    }


def region_pass_rates(
    gamma_kji: np.ndarray, gamma_grid: Grid, targets: list[Any], gamma_to_primary: np.ndarray
) -> list[dict[str, Any]]:
    """每個結構裡的通過率（`DvhTarget`；結構體素中心取最近的 γ 體素，沒評估的不算）。"""
    from .dvh import target_voxel_centers_world

    out: list[dict[str, Any]] = []
    inv = np.linalg.inv(gamma_to_primary)
    nk, nj, ni = gamma_kji.shape
    for t in targets:
        own = target_voxel_centers_world(t)
        if own.shape[0] == 0:
            out.append({"structure_id": t.structure_id, "name": t.name, "evaluated": 0, "pass_rate": None})
            continue
        primary = own @ t.to_primary[:3, :3].T + t.to_primary[:3, 3]
        local = primary @ inv[:3, :3].T + inv[:3, 3]
        idx = np.rint(gamma_grid.world_to_index(local)).astype(np.int64)
        inside = (
            (idx[:, 0] >= 0)
            & (idx[:, 0] < ni)
            & (idx[:, 1] >= 0)
            & (idx[:, 1] < nj)
            & (idx[:, 2] >= 0)
            & (idx[:, 2] < nk)
        )
        idx = idx[inside]
        g = gamma_kji[idx[:, 2], idx[:, 1], idx[:, 0]]
        g = g[np.isfinite(g)]
        out.append(
            {
                "structure_id": t.structure_id,
                "name": t.name,
                "voxels": int(own.shape[0]),
                "evaluated": int(g.size),
                "pass_rate": float((g <= 1.0).mean()) if g.size else None,
                "mean_gamma": float(g.mean()) if g.size else None,
                "max_gamma": float(g.max()) if g.size else None,
            }
        )
    return out
