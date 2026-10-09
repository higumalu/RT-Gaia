"""填洞、去離島、平滑只在結構的外接方塊上跑（`ops.run_op`）—— 結果必須跟整個網格跑的一模一樣。

非等向網格（0.9 × 1.1 × 2.5 mm）、斜的 direction、有洞的球 ＋ 兩個小島；結構貼著網格邊緣的情況也要一樣。
"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_core.ops import OpContext, get_op, run_op
from rtgaia_geom.grid import Grid

C, S = np.cos(0.3), np.sin(0.3)
GRID = Grid(
    size=(90, 80, 40),
    spacing=(0.9, 1.1, 2.5),
    origin=(-40.0, -30.0, -50.0),
    direction=(C, -S, 0.0, S, C, 0.0, 0.0, 0.0, 1.0),
    frame_of_reference_uid="1.2.3",
)
CTX = OpContext(other_mask=lambda _sid: np.zeros((40, 80, 90), dtype=np.uint8))


def _mask(center_kji: tuple[int, int, int]) -> np.ndarray:
    kk, jj, ii = np.mgrid[0:40, 0:80, 0:90]
    ck, cj, ci = center_kji
    r = ((ii - ci) * 0.9) ** 2 + ((jj - cj) * 1.1) ** 2 + ((kk - ck) * 2.5) ** 2
    m = (r <= 12.0**2).astype(np.uint8)
    m[r <= 4.0**2] = 0  # 洞
    m[ck, max(0, cj - 14), max(0, ci - 18)] = 1  # 小島
    m[min(39, ck + 3), min(79, cj + 15), min(89, ci + 16)] = 1
    return m


@pytest.mark.parametrize("center", [(20, 40, 45), (3, 6, 7), (37, 76, 86)])
@pytest.mark.parametrize(
    ("op_id", "params"),
    [
        ("fill_holes", {}),
        ("fill_holes", {"per_slice": True}),
        ("remove_islands", {"keep_largest_n": 1}),
        ("remove_islands", {"min_volume_cc": 0.01}),
        ("smooth", {"sigma_mm": 1.5}),
        ("smooth", {"sigma_mm": 3.0}),
    ],
)
def test_local_ops_on_the_bounding_box_equal_the_whole_grid(
    center: tuple[int, int, int], op_id: str, params: dict
) -> None:
    m = _mask(center)
    op = get_op(op_id)
    whole = op.fn(m, GRID, params, CTX)
    local = run_op(op, m, GRID, params, CTX)
    assert local.shape == whole.shape and local.dtype == np.uint8
    assert np.array_equal(local, whole), f"{op_id} {params} 差 {int(np.count_nonzero(local != whole))} 個體素"


def test_empty_mask_and_non_local_ops_run_on_the_whole_grid() -> None:
    empty = np.zeros((40, 80, 90), dtype=np.uint8)
    assert not run_op(get_op("smooth"), empty, GRID, {}, CTX).any()
    m = _mask((20, 40, 45))
    op = get_op("interpolate")
    p = {"slice_range": [10, 30]}
    assert np.array_equal(run_op(op, m, GRID, p, CTX), op.fn(m, GRID, p, CTX))
