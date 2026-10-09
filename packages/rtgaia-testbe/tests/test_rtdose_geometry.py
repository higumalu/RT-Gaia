"""RTDOSE `GridFrameOffsetVector` 的兩種編碼（PS3.3 C.8.8.3.2）。

重現：IPP `[4,5,6]`、IOP axial、GFOV `[6,8,10]`（絕對 z）→ 先前算出原點 `[4,5,12]`，
合法值是 `[4,5,6]`。這裡把相對／絕對／遞減／不合法組合逐一釘住，再加一條「與 CT 的世界座標交點」
—— 只驗 origin 抓不到「疊合位置錯」這個真正的症狀。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from rtgaia_core.loaders.rtdose import read_dose_header, read_dose_pixels
from rtgaia_geom.errors import ContractViolation

RTDOSE_SOP = "1.2.840.10008.5.1.4.1.1.481.2"
AXIAL = [1, 0, 0, 0, 1, 0]
OBLIQUE = [1, 0, 0, 0, 0.8, 0.6]  # 繞 x 轉 ~37°


def write_dose(
    path: Path,
    *,
    ipp: list[float],
    iop: list[float],
    gfov: list[float],
    spacing: tuple[float, float] = (2.0, 2.0),
    size: tuple[int, int] = (4, 3),
    units: str = "GY",
    scaling: str = "1e-3",
    values: np.ndarray | None = None,
) -> Path:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = RTDOSE_SOP
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = RTDOSE_SOP, meta.MediaStorageSOPInstanceUID
    ds.Modality = "RTDOSE"
    ds.SeriesInstanceUID = generate_uid()
    ds.FrameOfReferenceUID = "1.2.826.0.1.3680043.8.498.999.1"
    ni, nj = size
    nk = len(gfov)
    ds.Rows, ds.Columns, ds.NumberOfFrames = nj, ni, nk
    ds.PixelSpacing = [spacing[1], spacing[0]]
    ds.ImageOrientationPatient = iop
    ds.ImagePositionPatient = ipp
    ds.GridFrameOffsetVector = gfov
    ds.FrameIncrementPointer = (0x3004, 0x000C)
    ds.DoseUnits, ds.DoseType, ds.DoseSummationType = units, "PHYSICAL", "PLAN"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 32, 32, 31
    ds.PixelRepresentation, ds.SamplesPerPixel, ds.PhotometricInterpretation = 0, 1, "MONOCHROME2"
    ds.DoseGridScaling = scaling
    arr = values if values is not None else np.arange(nk * nj * ni, dtype=np.uint32).reshape(nk, nj, ni)
    ds.PixelData = np.ascontiguousarray(arr, dtype=np.uint32).tobytes()
    ds.save_as(str(path), enforce_file_format=True)
    return path


def test_relative_increasing(tmp_path: Path) -> None:
    h = read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 6], iop=AXIAL, gfov=[0, 2, 4]))
    assert np.allclose(h.grid.origin, [4, 5, 6])
    assert h.grid.spacing[2] == 2.0
    assert np.allclose(np.asarray(h.grid.direction).reshape(3, 3)[:, 2], [0, 0, 1])


def test_relative_decreasing_flips_normal(tmp_path: Path) -> None:
    h = read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 6], iop=AXIAL, gfov=[0, -2, -4]))
    assert np.allclose(h.grid.origin, [4, 5, 6])
    assert h.grid.spacing[2] == 2.0
    assert np.allclose(np.asarray(h.grid.direction).reshape(3, 3)[:, 2], [0, 0, -1])


def test_absolute_z_is_not_offset_twice(tmp_path: Path) -> None:
    """重現值：合法原點是 `[4,5,6]`，先前得到 `[4,5,12]`。"""
    h = read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 6], iop=AXIAL, gfov=[6, 8, 10]))
    assert np.allclose(h.grid.origin, [4, 5, 6])
    assert h.grid.spacing[2] == 2.0


def test_absolute_z_decreasing(tmp_path: Path) -> None:
    h = read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 10], iop=AXIAL, gfov=[10, 8, 6]))
    assert np.allclose(h.grid.origin, [4, 5, 10])
    assert np.allclose(np.asarray(h.grid.direction).reshape(3, 3)[:, 2], [0, 0, -1])


def test_absolute_z_mismatching_ipp_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ContractViolation) as exc:
        read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 99], iop=AXIAL, gfov=[6, 8, 10]))
    assert exc.value.code == "RD8"


def test_absolute_z_with_oblique_iop_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ContractViolation) as exc:
        read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 6], iop=OBLIQUE, gfov=[6, 8, 10]))
    assert exc.value.code == "RD7"


def test_relative_oblique_is_fine(tmp_path: Path) -> None:
    """相對編碼不限 axial：斜向劑量網格沿自己的法線推進。"""
    h = read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 6], iop=OBLIQUE, gfov=[0, 2, 4]))
    assert np.allclose(h.grid.origin, [4, 5, 6])
    n = np.asarray(h.grid.direction).reshape(3, 3)[:, 2]
    assert np.allclose(n, np.cross(OBLIQUE[:3], OBLIQUE[3:]))


def test_non_uniform_is_still_rejected(tmp_path: Path) -> None:
    with pytest.raises(ContractViolation) as exc:
        read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[4, 5, 6], iop=AXIAL, gfov=[0, 2, 5]))
    assert exc.value.code == "RD5"


def test_units_normalised_upper(tmp_path: Path) -> None:
    h = read_dose_header(write_dose(tmp_path / "d.dcm", ipp=[0, 0, 0], iop=AXIAL, gfov=[0, 2], units=" relative "))
    assert h.units == "RELATIVE"


def test_world_coordinate_of_hot_voxel_matches_both_encodings(tmp_path: Path) -> None:
    """同一個劑量場、兩種編碼寫出來 → 最熱 voxel 的 LPS 世界座標必須相同。
    這是「疊合在 CT 上的位置」的直接檢查，origin 相等只是它的必要條件。"""
    ipp = [10.0, -20.0, 30.0]
    nk, nj, ni = 3, 3, 4
    vals = np.zeros((nk, nj, ni), dtype=np.uint32)
    vals[2, 1, 3] = 1000  # k=2, j=1, i=3
    rel = read_dose_header(write_dose(tmp_path / "rel.dcm", ipp=ipp, iop=AXIAL, gfov=[0, 2.5, 5.0], values=vals))
    ab = read_dose_header(write_dose(tmp_path / "abs.dcm", ipp=ipp, iop=AXIAL, gfov=[30.0, 32.5, 35.0], values=vals))

    def hot_world(h) -> np.ndarray:  # type: ignore[no-untyped-def]
        px = read_dose_pixels(h)
        k, j, i = np.unravel_index(int(np.argmax(px)), px.shape)
        d = np.asarray(h.grid.direction).reshape(3, 3)
        return np.asarray(h.grid.origin) + d @ (np.asarray([i, j, k]) * np.asarray(h.grid.spacing))

    expected = np.asarray([10.0 + 3 * 2.0, -20.0 + 1 * 2.0, 30.0 + 2 * 2.5])
    assert np.allclose(hot_world(rel), expected)
    assert np.allclose(hot_world(ab), expected)
