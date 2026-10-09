"""壓縮影像 —— JPEG 2000／RLE 解得開且體素與未壓縮的一模一樣；
解不了的格式（JPEG Lossless Process 14，目前沒有寬鬆授權又乾淨的解碼器）在索引上標出來、
載入時給清楚的原因（只解碼不轉碼）。"""

from __future__ import annotations

import copy
import shutil
from pathlib import Path

import numpy as np
import pydicom
import pytest
from pydicom.encaps import encapsulate
from pydicom.uid import JPEG2000Lossless, JPEGLosslessSV1, RLELossless
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.dicom import read_series
from rtgaia_core.pixel_codecs import can_decode, decode_status, transfer_syntax_name
from synth_dicom import write_synth_case


@pytest.fixture(scope="module")
def plan_ct(tmp_path_factory) -> tuple[Path, str]:
    """合成 CT 的標頭當範本、改成 64×64×3（OpenJPEG 預設 6 層 DWT，邊長要 ≥ 32）、像素是有結構的 HU 值。"""
    synth = write_synth_case(tmp_path_factory.mktemp("synth"))
    out = tmp_path_factory.mktemp("ct64")
    template = pydicom.dcmread(sorted(synth.plan_ct.directory.glob("CT.*.dcm"))[0])
    jj, ii = np.meshgrid(np.arange(64), np.arange(64), indexing="ij")
    for k in range(3):
        ds = copy.deepcopy(template)
        ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = f"{template.SOPInstanceUID}.{k + 1}"
        ds.InstanceNumber = k + 1
        ds.Rows = ds.Columns = 64
        ds.ImagePositionPatient = [0.0, 0.0, float(k) * 2.0]
        hu = ((ii * 7 + jj * 13 + k * 101) % 2000) - 1000
        ds.PixelData = (hu + 1024).astype(np.uint16).tobytes()
        ds.save_as(out / f"CT.{k:03d}.dcm", enforce_file_format=True)
    return out, str(template.SeriesInstanceUID)


def _copy_compressed(src: Path, dst: Path, syntax) -> Path:  # type: ignore[no-untyped-def]
    dst.mkdir(parents=True)
    for f in sorted(src.glob("CT.*.dcm")):
        ds = pydicom.dcmread(f)
        ds.compress(syntax)
        ds.save_as(dst / f.name, enforce_file_format=True)
    return dst


def test_codec_table() -> None:
    assert can_decode("") and can_decode("1.2.840.10008.1.2.1")  # 沒記錄／未壓縮
    assert can_decode(JPEG2000Lossless) and can_decode(RLELossless)
    assert not can_decode(JPEGLosslessSV1)
    assert transfer_syntax_name(JPEG2000Lossless).startswith("JPEG 2000")
    status = decode_status({JPEGLosslessSV1, "1.2.840.10008.1.2.1"})
    assert status["decodable"] is False and "JPEG Lossless" in status["decode_error"]
    assert decode_status(set())["decodable"] is True


@pytest.mark.parametrize("syntax", [JPEG2000Lossless, RLELossless])
def test_lossless_compressed_series_loads_identically(plan_ct: tuple[Path, str], tmp_path: Path, syntax) -> None:  # type: ignore[no-untyped-def]
    src, series_uid = plan_ct
    ref, grid_ref, _ = read_series(src)
    packed = _copy_compressed(src, tmp_path / "packed", syntax)
    idx = LibraryIndex.scan(packed, use_cache=False)
    wire = idx.series[series_uid].to_wire(show_names=False)
    assert wire["decodable"] is True and wire["decode_error"] is None
    assert wire["transfer_syntax"] == transfer_syntax_name(syntax)
    vol, grid, _ = read_series(packed)
    assert grid == grid_ref
    np.testing.assert_array_equal(vol, ref)


def test_undecodable_series_is_marked_and_fails_clearly(plan_ct: tuple[Path, str], tmp_path: Path) -> None:
    src, series_uid = plan_ct
    bad = tmp_path / "jpegll"
    shutil.copytree(src, bad)
    for f in sorted(bad.glob("CT.*.dcm")):
        ds = pydicom.dcmread(f)
        ds.file_meta.TransferSyntaxUID = JPEGLosslessSV1
        ds.PixelData = encapsulate([b"\xff\xd8\xff\xc3" + b"\x00" * 16 + b"\xff\xd9"])
        ds["PixelData"].VR = "OB"
        ds.save_as(f, enforce_file_format=True)
    idx = LibraryIndex.scan(bad, use_cache=False)
    wire = idx.series[series_uid].to_wire(show_names=False)
    assert wire["decodable"] is False
    assert "JPEG Lossless" in wire["transfer_syntax"] and "沒有可用的解碼器" in wire["decode_error"]
    with pytest.raises(ValueError, match="沒有可用的解碼器"):
        read_series(bad)
