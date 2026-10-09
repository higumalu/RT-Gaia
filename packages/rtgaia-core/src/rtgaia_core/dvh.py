"""劑量體積直方圖 —— 純 numpy，零 FastAPI。

## 跨 FoR 的鏈

結構體素中心（自己的 mask grid 索引）→ 自己 FoR 的世界座標 → **primary** 世界座標
（結構所在 FrameGroup 的 `transform_to_primary`）→ 劑量 FoR 的世界座標（劑量所在
FrameGroup 的**逆**變換）→ 劑量網格連續索引 → 三線性取樣。

因此「計畫 CT 的 PTV 對 fx1 的劑量」算得出來 —— 這正是自適應要看的東西。

## 部分覆蓋

落在劑量網格外的體素**劑量未知**，不是 0 Gy。`outside_fraction` > `PARTIAL_TOLERANCE`（0.1%）
的結構標 `partial: true`：

* 曲線照樣算（分母是整個結構、網格外的體素不計入「≥ edge」）→ 是真實曲線的**下限**；
* 整體統計（Dmin、Dmean、D98、D95、D50、D2、V(ref)）回 `null` —— 網格外的劑量不知道，算不出來；
* Dmax 照給（網格內的最大值）。

容差是為了貼著網格邊緣的結構：0.1% 以下的體素落在外面不影響臨床讀數，跟前端「外」徽章的門檻一致。

## 統計定義

* 累積 DVH：`cumulative[b]` ＝ 劑量 ≥ `edges[b]` 的體積百分比（`edges` 從 0 到 `dose_max_gy`
  均分 `bins` 格，因此同一個劑量的所有結構共用 x 軸）。
* D98／D95／D50／D2：至少 98%／95%／50%／2% 體積收到的劑量 ＝ 劑量分佈的第 2／5／50／98 百分位。
* V(ref)：收到 ≥ `reference_gy` 的體積百分比。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from rtgaia_geom import Grid

PARTIAL_TOLERANCE = 0.001
"""`outside_fraction` 超過這個值就算部分覆蓋（0.1%）。"""

_WHOLE_STRUCTURE_STATS = ("dmin_gy", "dmean_gy", "d98_gy", "d95_gy", "d50_gy", "d2_gy", "v_ref_pct")


@dataclass(frozen=True)
class DvhTarget:
    """一個要算 DVH 的結構：裁切到 bbox 的 mask ＋ 它的網格 ＋ 到 primary 的變換。"""

    structure_id: str
    name: str
    color_rgb: tuple[int, int, int]
    block: np.ndarray
    """`(k, j, i)` 非零 ＝ 在結構內。"""
    offset_ijk: tuple[int, int, int]
    grid: Grid
    to_primary: np.ndarray
    """row-major 4×4：本 FoR → primary。"""


def trilinear_sample(volume_kji: np.ndarray, idx_ijk: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """三線性取樣。`idx_ijk` (N,3) 連續索引；回 `(values, inside)`。網格外的 value ＝ 0。"""
    nk, nj, ni = volume_kji.shape
    size = np.array([ni, nj, nk], dtype=np.float64)
    inside = np.all((idx_ijk >= 0) & (idx_ijk <= size - 1), axis=1)
    p = np.clip(idx_ijk, 0, size - 1)
    i0 = np.floor(p).astype(np.int64)
    i1 = np.minimum(i0 + 1, (size - 1).astype(np.int64))
    f = p - i0
    fi, fj, fk = f[:, 0], f[:, 1], f[:, 2]
    v = volume_kji

    def at(ci: np.ndarray, cj: np.ndarray, ck: np.ndarray) -> np.ndarray:
        return v[ck, cj, ci].astype(np.float64)

    c000 = at(i0[:, 0], i0[:, 1], i0[:, 2])
    c100 = at(i1[:, 0], i0[:, 1], i0[:, 2])
    c010 = at(i0[:, 0], i1[:, 1], i0[:, 2])
    c110 = at(i1[:, 0], i1[:, 1], i0[:, 2])
    c001 = at(i0[:, 0], i0[:, 1], i1[:, 2])
    c101 = at(i1[:, 0], i0[:, 1], i1[:, 2])
    c011 = at(i0[:, 0], i1[:, 1], i1[:, 2])
    c111 = at(i1[:, 0], i1[:, 1], i1[:, 2])
    c00 = c000 * (1 - fi) + c100 * fi
    c10 = c010 * (1 - fi) + c110 * fi
    c01 = c001 * (1 - fi) + c101 * fi
    c11 = c011 * (1 - fi) + c111 * fi
    c0 = c00 * (1 - fj) + c10 * fj
    c1 = c01 * (1 - fj) + c11 * fj
    out = c0 * (1 - fk) + c1 * fk
    out[~inside] = 0.0
    return out, inside


def target_voxel_centers_world(target: DvhTarget) -> np.ndarray:
    """結構內每個體素中心的世界座標（**自己的 FoR**），(N,3)。"""
    kk, jj, ii = np.nonzero(target.block)
    ijk = np.stack([ii, jj, kk], axis=1).astype(np.float64) + np.asarray(target.offset_ijk, dtype=np.float64)
    return target.grid.index_to_world(ijk)


def _apply(m: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ m[:3, :3].T + m[:3, 3]


def sample_dose_for_target(
    target: DvhTarget, dose_kji: np.ndarray, dose_grid: Grid, dose_to_primary: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """結構的每個體素收到的劑量（Gy）與是否落在劑量網格內。"""
    own = target_voxel_centers_world(target)
    if own.shape[0] == 0:
        return np.zeros(0), np.zeros(0, dtype=bool)
    primary = _apply(target.to_primary, own)
    in_dose_for = _apply(np.linalg.inv(dose_to_primary), primary)
    idx = dose_grid.world_to_index(in_dose_for)
    values, inside = trilinear_sample(dose_kji, idx)
    # 劑量運算結果在 B 沒蓋到的地方是 NaN（沒資料）—— 跟網格外一樣算「不在劑量裡」（partial），不是 0 Gy
    known = np.isfinite(values)
    if not known.all():
        inside = inside & known
        values = np.where(known, values, 0.0)
    return values, inside


def cumulative_dvh(doses_gy: np.ndarray, edges_gy: np.ndarray) -> np.ndarray:
    """`cumulative[b]` ＝ 劑量 ≥ `edges[b]` 的體積百分比。"""
    if doses_gy.size == 0:
        return np.zeros(edges_gy.shape[0])
    sorted_d = np.sort(doses_gy)
    # 有多少個 < edge → 剩下的是 ≥ edge
    below = np.searchsorted(sorted_d, edges_gy, side="left")
    return (1.0 - below / sorted_d.size) * 100.0


def dvh_stats(doses_gy: np.ndarray, reference_gy: float | None) -> dict[str, Any]:
    if doses_gy.size == 0:
        return {
            "dmin_gy": 0.0,
            "dmax_gy": 0.0,
            "dmean_gy": 0.0,
            "d98_gy": 0.0,
            "d95_gy": 0.0,
            "d50_gy": 0.0,
            "d2_gy": 0.0,
            "v_ref_pct": None,
        }
    out: dict[str, Any] = {
        "dmin_gy": float(doses_gy.min()),
        "dmax_gy": float(doses_gy.max()),
        "dmean_gy": float(doses_gy.mean()),
        "d98_gy": float(np.percentile(doses_gy, 2)),
        "d95_gy": float(np.percentile(doses_gy, 5)),
        "d50_gy": float(np.percentile(doses_gy, 50)),
        "d2_gy": float(np.percentile(doses_gy, 98)),
        "v_ref_pct": None,
    }
    if reference_gy is not None and reference_gy > 0:
        out["v_ref_pct"] = float((doses_gy >= reference_gy).mean() * 100.0)
    return out


def compute_dvh(
    *,
    dose_kji: np.ndarray,
    dose_grid: Grid,
    dose_to_primary: np.ndarray,
    targets: list[DvhTarget],
    bins: int = 200,
    reference_gy: float | None = None,
) -> dict[str, Any]:
    dose_max = float(np.nanmax(dose_kji)) if dose_kji.size else 0.0
    edges = np.linspace(0.0, dose_max if dose_max > 0 else 1.0, int(bins) + 1)
    structures: list[dict[str, Any]] = []
    for t in targets:
        doses, inside = sample_dose_for_target(t, dose_kji, dose_grid, dose_to_primary)
        voxel_cc = t.grid.voxel_volume_mm3 / 1000.0
        outside = float(1.0 - inside.mean()) if inside.size else 0.0
        partial = outside > PARTIAL_TOLERANCE
        stats = dvh_stats(doses, reference_gy)
        if partial:
            # 網格外的劑量未知：只留網格內的 Dmax；其他整體統計不給（不是 0）
            stats["dmax_gy"] = float(doses[inside].max()) if inside.any() else None
            for key in _WHOLE_STRUCTURE_STATS:
                stats[key] = None
        structures.append(
            {
                "structure_id": t.structure_id,
                "name": t.name,
                "color_rgb": list(t.color_rgb),
                "voxel_count": int(doses.size),
                "volume_cc": float(doses.size * voxel_cc),
                "outside_fraction": outside,
                "partial": partial,
                **stats,
                # 網格外的體素（取樣值 0）不會 ≥ 任何 edge > 0 → partial 時是真實曲線的下限
                "cumulative_pct": cumulative_dvh(doses, edges).round(4).tolist(),
            }
        )
    return {
        "bins": int(bins),
        # 契約上寫明這份數字的單位由誰保證；路由只放 GY 的劑量進來
        "dose_units": "GY",
        "dose_max_gy": dose_max,
        "reference_gy": reference_gy,
        "edges_gy": edges.round(6).tolist(),
        "structures": structures,
    }
