"""重切核心的行為，以及它與 `rtgaia_geom` 幾何一致。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import Grid, ViewReference
from rtgaia_geom.kernel import KernelUnavailable, ResliceKernel, load_kernel

pytestmark = pytest.mark.kernel


@pytest.fixture(scope="module")
def kernel() -> ResliceKernel:
    try:
        return load_kernel()
    except KernelUnavailable as exc:
        pytest.skip(f"重切核心未建置：{exc}")


def _landmark_volume(grid: Grid, ijk: tuple[int, int, int], value: int = 3000) -> np.ndarray:
    """`landmark` 假體的最小形式：平滑漸層底 ＋ 一個唯一高值體素。"""
    nk, nj, ni = grid.size[2], grid.size[1], grid.size[0]
    k, j, i = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    vol = ((i + j + k) * 2 - 200).astype(np.int16)
    vol[ijk[2], ijk[1], ijk[0]] = value
    return vol


def test_abi_and_struct_layout(kernel: ResliceKernel) -> None:
    """載入時就已斷言 ABI 版本與結構大小；這裡只確認核心真的在。"""
    assert kernel.library_path.exists()


def test_sample_world_matches_python_geometry(kernel: ResliceKernel, tilted_grid: Grid) -> None:
    """🔴 Python 端與核心對同一個 world 座標取到同一個體素值。

    用**傾斜**網格跑這一條，才會抓到「漏傳 direction」——軸對齊網格上就算把
    direction 當單位矩陣也是對的。
    """
    ijk = (17, 23, 9)
    vol = _landmark_volume(tilted_grid, ijk)
    world = tilted_grid.index_to_world(list(ijk))
    # Python 端：反算回 ijk 必須是同一個體素
    assert tuple(tilted_grid.world_to_nearest_voxel(world)) == ijk
    # 核心端：在同一個 world 座標取樣必須拿到那個高值
    assert kernel.sample_world(vol, tilted_grid, world) == pytest.approx(3000.0)


def test_sample_outside_returns_fill(kernel: ResliceKernel, axial_grid: Grid) -> None:
    vol = _landmark_volume(axial_grid, (0, 0, 0))
    far = axial_grid.index_to_world([-50.0, 0.0, 0.0])
    assert kernel.sample_world(vol, axial_grid, far, outside=-1024.0) == -1024.0


def test_reslice_axial_plane_hits_landmark(kernel: ResliceKernel, axial_grid: Grid) -> None:
    """在通過標記點的軸向平面上重切，標記點必須落在畫面正中央。"""
    ijk = (32, 24, 10)
    vol = _landmark_volume(axial_grid, ijk)
    world = axial_grid.index_to_world(list(ijk))
    view = ViewReference.axial(
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        display_grid_id="dg_test",
        plane_origin=tuple(float(v) for v in world),
    )
    plane = kernel.reslice(vol, axial_grid, view, out_size_px=(65, 65), px_mm=1.0)
    assert plane.shape == (65, 65)
    assert plane[32, 32] == pytest.approx(3000.0)
    # 相鄰像素不得也是 3000（否則是取樣被抹開了）
    assert plane[32, 33] < 3000.0


def test_reslice_respects_view_up_orientation(kernel: ResliceKernel, axial_grid: Grid) -> None:
    """`up` = -view_up：畫面第 0 列在頂端。上下顛倒在對稱假體上看不出來，所以要測。"""
    vol = np.zeros((axial_grid.size[2], axial_grid.size[1], axial_grid.size[0]), dtype=np.int16)
    ijk = (32, 20, 10)  # j = 20，比中心 (32) 小 → LPS 的 y 較小 → 解剖上偏前（A）
    vol[ijk[2], ijk[1], ijk[0]] = 2000
    center = axial_grid.index_to_world([32, 32, 10])
    view = ViewReference.axial(
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        display_grid_id="dg",
        plane_origin=tuple(float(v) for v in center),
    )
    plane = kernel.reslice(vol, axial_grid, view, out_size_px=(65, 65), px_mm=1.0, outside=0.0)
    row, col = np.unravel_index(int(np.argmax(plane)), plane.shape)
    # view_up = (0,-1,0)（指向 A）→ y 較小者在畫面上方 → row < 中心
    assert row < 32, f"上下顛倒：亮點落在 row={row}"
    assert col == 32


def test_reslice_oblique_is_geometrically_consistent(kernel: ResliceKernel, axial_grid: Grid) -> None:
    """斜面上取到的值，必須等於直接以 world 座標單點取樣的值。

    這是斜面 MPR 唯一有意義的自洽檢查：**重切只是「對一組 world 座標取樣」**，
    平面數學若有誤，兩者就會分岔。
    """
    vol = _landmark_volume(axial_grid, (30, 30, 10))
    n = np.array([0.0, 0.5, 0.8660254037844386])
    up = np.array([0.0, 0.8660254037844386, -0.5])
    center = axial_grid.index_to_world([32, 32, 10])
    view = ViewReference(
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        display_grid_id="dg",
        plane_origin=tuple(float(v) for v in center),
        view_plane_normal=tuple(float(v) for v in n),
        view_up=tuple(float(v) for v in up),
        slab_thickness_mm=0.0,
    )
    px = 1.0
    w = h = 33
    plane = kernel.reslice(vol, axial_grid, view, out_size_px=(w, h), px_mm=px, outside=-1024.0)
    right = view.right
    rows = -view.up  # 與 plane_desc 的 up 欄位同義
    for py, px_i in [(0, 0), (5, 27), (16, 16), (32, 32)]:
        world = view.origin + right * (px_i - (w - 1) / 2) * px + rows * (py - (h - 1) / 2) * px
        expected = kernel.sample_world(vol, axial_grid, world, outside=-1024.0)
        assert plane[py, px_i] == pytest.approx(expected, abs=1e-3)


def test_mean_blend_smooths_anisotropic_steps(kernel: ResliceKernel) -> None:
    """`mean` 用於緩解非等向資料在斜面上的階梯 artifact。"""
    grid = Grid(
        size=(32, 32, 12),
        spacing=(1.0, 1.0, 5.0),  # anisotropic 假體
        origin=(-15.5, -15.5, -27.5),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid="for.aniso",
    )
    vol = np.zeros((12, 32, 32), dtype=np.int16)
    vol[6, :, :] = 1000  # 單一高值層
    center = grid.index_to_world([16, 16, 6])
    view = ViewReference(
        frame_of_reference_uid="for.aniso",
        display_grid_id="dg",
        plane_origin=tuple(float(v) for v in center),
        view_plane_normal=(0.0, 0.3826834, 0.9238795),
        view_up=(0.0, 0.9238795, -0.3826834),
        slab_thickness_mm=10.0,
    )
    center_only = kernel.reslice(vol, grid, view, out_size_px=(32, 32), px_mm=1.0, blend="center", outside=0.0)
    averaged = kernel.reslice(vol, grid, view, out_size_px=(32, 32), px_mm=1.0, blend="mean", outside=0.0)
    assert averaged.std() < center_only.std(), "mean 混合必須比單一中心面平滑"


def test_window_to_u8_matches_definition(kernel: ResliceKernel) -> None:
    plane = np.array([[-1000.0, 40.0, 1000.0]], dtype=np.float32)
    out = kernel.window_to_u8(plane, 40.0, 400.0)
    assert out.tolist() == [[0, 128, 255]]


def test_mip_over_slab_is_exactly_the_union_of_the_sampled_planes(kernel: ResliceKernel, axial_grid: Grid) -> None:
    """🔴 **slab 輪廓語意 B（slab 內聯集）不需要多邊形布林。**

    直覺上會把 B 的成本當成「×N ＋ 多邊形布林聯集」，並據此判它昂貴。那個假設是錯的：

        ∪ᵢ { x : fᵢ(x) ≥ 0.5 }  ==  { x : maxᵢ fᵢ(x) ≥ 0.5 }

    逐像素最大值就是聯集，而逐像素最大值正是 `Blend::Mip` —— 核心早就有了。
    因此 B ＝ `N × 取樣 ＋ 1 × marching squares`，不必縫合、不必布林、
    **不必引入任何新的函式庫**（那還要先過授權檢查）。

    這一條把那個等式釘住：**MIP 的門檻結果必須與逐面 OR 完全相同**。
    形狀刻意沿 z 收斂（圓錐），否則每一面都一樣、聯集等於中心面，測不出東西。
    """
    nk, nj, ni = axial_grid.size[2], axial_grid.size[1], axial_grid.size[0]
    k, j, i = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    world = axial_grid.index_to_world(np.stack([i.ravel(), j.ravel(), k.ravel()], axis=1).astype(np.float64)).reshape(
        nk, nj, ni, 3
    )
    # 圓錐：半徑隨 z 線性縮小 → 每一張切面的輪廓都不一樣
    radius = 18.0 - 0.45 * (world[..., 2] + 28.5)
    rho = np.hypot(world[..., 0], world[..., 1])
    mask = (rho <= np.maximum(radius, 0.0)).astype(np.uint8)
    assert mask.any() and not mask.all()

    slab_mm, samples = 12.0, 5
    out_px, px_mm = (48, 48), 1.0
    centre = (0.0, 0.0, 0.0)

    def view(offset_mm: float, slab: float) -> ViewReference:
        return ViewReference(
            frame_of_reference_uid=axial_grid.frame_of_reference_uid,
            display_grid_id="dg",
            plane_origin=(centre[0], centre[1], centre[2] + offset_mm),
            view_plane_normal=(0.0, 0.0, -1.0),
            view_up=(0.0, -1.0, 0.0),
            slab_thickness_mm=slab,
        )

    # 逐面各自取樣後 OR 起來（字面上的 B，但在場而非多邊形上做）
    half = slab_mm / 2.0
    union = np.zeros((out_px[1], out_px[0]), dtype=bool)
    for n in range(samples):
        offset = -half + slab_mm * n / (samples - 1)
        plane = kernel.reslice(
            mask,
            axial_grid,
            view(offset, 0.0),
            out_size_px=out_px,
            px_mm=px_mm,
            blend="center",
            outside=0.0,
        )
        union |= plane >= 0.5

    # 一次 MIP
    mip = kernel.reslice(
        mask,
        axial_grid,
        view(0.0, slab_mm),
        out_size_px=out_px,
        px_mm=px_mm,
        blend="mip",
        slab_samples=samples,
        outside=0.0,
    )
    assert np.array_equal(mip >= 0.5, union), "MIP 的門檻結果必須與逐面 OR 完全相同"

    # 而且它真的與中心面不同 —— 否則這條測試是空的
    centre_plane = kernel.reslice(
        mask,
        axial_grid,
        view(0.0, 0.0),
        out_size_px=out_px,
        px_mm=px_mm,
        blend="center",
        outside=0.0,
    )
    assert int(union.sum()) > int((centre_plane >= 0.5).sum()), "聯集必須嚴格大於中心面"


def test_outline_of_a_sphere_is_a_closed_loop(kernel: ResliceKernel, axial_grid: Grid) -> None:
    """預設路徑：mask → 平面 → marching squares → 縫合成 polyline。"""
    nk, nj, ni = axial_grid.size[2], axial_grid.size[1], axial_grid.size[0]
    k, j, i = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    world = axial_grid.index_to_world(np.stack([i.ravel(), j.ravel(), k.ravel()], axis=1).astype(np.float64))
    r = np.linalg.norm(world, axis=1).reshape(nk, nj, ni)
    mask = (r <= 10.0).astype(np.uint8)
    assert mask.any()
    view = ViewReference.axial(
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        display_grid_id="dg",
        plane_origin=(0.0, 0.0, 0.0),
    )
    field = kernel.reslice(mask, axial_grid, view, out_size_px=(64, 64), px_mm=0.75, outside=0.0)
    segs = kernel.marching_squares(field, 0.5)
    assert len(segs) > 20
    polylines = kernel.stitch(segs)
    assert len(polylines) == 1, "球在中心面上的輪廓只該有一條"
    loop = polylines[0]
    assert np.allclose(loop[0], loop[-1], atol=1e-3), "輪廓必須閉合"
    # 半徑檢查：輪廓點到中心的距離應接近 10 mm / 0.75 mm-per-px
    center = np.array([(64 - 1) / 2, (64 - 1) / 2])
    radii = np.linalg.norm(loop - center, axis=1) * 0.75
    assert radii.mean() == pytest.approx(10.0, abs=0.6)
