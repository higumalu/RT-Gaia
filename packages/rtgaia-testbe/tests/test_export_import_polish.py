"""2026-09-18 四項設計修正的前三項：整套 ≤ 24 個全部預設顯示；空 ROI 匯入保留；匯出標籤帶來源與日期。"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from rtgaia_core.jobs import _default_label
from rtgaia_core.loaders.case import DEFAULT_VISIBLE_PER_STRUCTURE_SET, _to_phantom_structures
from rtgaia_core.loaders.rtstruct import LoadedStructure, read_rtstruct
from rtgaia_geom import Grid

FOR = "1.2.3.4"


def _loaded(n: int) -> list[LoadedStructure]:
    return [
        LoadedStructure(
            structure_id=f"s{i}",
            name=f"s{i}",
            color_rgb=(1, 2, 3),
            roi_number=i + 1,
            interpreted_type=None,
            offset_ijk=(0, 0, 0),
            size_ijk=(1, 1, 1),
            block=np.ones((1, 1, 1), dtype=np.uint8),
            contour_count=1,
            slice_count=1,
            geometric_types=("CLOSED_PLANAR",),
        )
        for i in range(n)
    ]


def test_small_sets_are_fully_visible_large_sets_capped() -> None:
    assert all(p.default_visible for p in _to_phantom_structures(_loaded(14), FOR))
    big = _to_phantom_structures(_loaded(40), FOR)
    assert sum(p.default_visible for p in big) == DEFAULT_VISIBLE_PER_STRUCTURE_SET
    assert not any(p.default_visible for p in _to_phantom_structures(_loaded(5), FOR, default_visible=False))


def _rtstruct_with_empty_roi(path) -> None:  # type: ignore[no-untyped-def]
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.481.3"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "RTSTRUCT"
    ds.StructureSetROISequence = []
    ds.ROIContourSequence = []
    for num, name in ((1, "liver"), (2, "vertebrae_C1")):
        roi = Dataset()
        roi.ROINumber = num
        roi.ROIName = name
        roi.ReferencedFrameOfReferenceUID = FOR
        ds.StructureSetROISequence.append(roi)
        rc = Dataset()
        rc.ReferencedROINumber = num
        rc.ROIDisplayColor = [255, 0, 0]
        if num == 1:
            c = Dataset()
            c.ContourGeometricType = "CLOSED_PLANAR"
            pts = [(2, 2), (6, 2), (6, 6), (2, 6)]
            c.ContourData = [v for x, y in pts for v in (float(x), float(y), 0.0)]
            c.NumberOfContourPoints = len(pts)
            rc.ContourSequence = [c]
        ds.ROIContourSequence.append(rc)
    ds.save_as(str(path), enforce_file_format=True)


def test_import_keeps_empty_roi_as_empty_structure(tmp_path) -> None:  # type: ignore[no-untyped-def]
    p = tmp_path / "rs.dcm"
    _rtstruct_with_empty_roi(p)
    grid = Grid(
        size=(8, 8, 2),
        spacing=(1.0, 1.0, 1.0),
        origin=(0.0, 0.0, 0.0),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid=FOR,
    )
    out = read_rtstruct(p, grid)
    assert [s.name for s in out] == ["liver", "vertebrae_C1"]
    liver, c1 = out
    assert not liver.empty and liver.block.sum() > 0
    assert c1.empty and c1.block.shape == (1, 1, 1) and int(c1.block.sum()) == 0 and c1.contour_count == 0


def _case(structures: dict[str, tuple[str, str, str | None]], sets: dict[str, dict] | None = None):  # type: ignore[no-untyped-def]
    """structures: id → (module_version, status, structure_set_id)"""
    objs = {
        sid: SimpleNamespace(provenance=SimpleNamespace(module_version=mv), status=st, structure_set_id=ss)
        for sid, (mv, st, ss) in structures.items()
    }
    return SimpleNamespace(
        structures={(sid, None): o for sid, o in objs.items()},
        structure=lambda sid: objs[sid],
        structure_set=lambda ssid: (sets or {}).get(ssid),
    )


def test_export_label_and_description_name_the_plugin_source() -> None:
    case = _case(
        {
            "a": ("nnunet-oar@0.2.0", "under_review", "work:carol:x"),
            "b": ("nnunet-oar@0.2.0", "under_review", "work:carol:x"),
        }
    )
    label, desc = _default_label(case, ["a", "b"], {}, user="carol")
    assert label.startswith("nnunet 20") and len(label) <= 16
    assert "來源 nnunet-oar@0.2.0" in desc and "carol" in desc and "2 結構" in desc and "含未簽核" in desc
    # 手動／混合來源：沿用工作集名稱，放得下才加 DRAFT
    case2 = _case(
        {"a": ("rt-gaia-core@0.1.0", "approved", "work:carol:x")},
        {"work:carol:x": {"kind": "work", "label": "ART fx1", "owner": "carol"}},
    )
    label2, desc2 = _default_label(case2, ["a"], {}, user="carol")
    assert label2 == "ART fx1" and "來源 manual" in desc2 and "全部已簽核" in desc2
    # 沒改過的預設名稱（「carol 的結構集」）→ 帳號：中文名稱到 Eclipse 只剩底線，英文介面也看不懂
    case2b = _case(
        {"a": ("rt-gaia-core@0.1.0", "approved", "work:carol:x")},
        {"work:carol:x": {"kind": "work", "label": "carol 的結構集", "owner": "carol"}},
    )
    assert _default_label(case2b, ["a"], {}, user="carol")[0] == "carol"
    case3 = _case({"a": ("rt-gaia-core@0.1.0", "under_review", None)})
    label3, desc3 = _default_label(case3, ["a"], {})
    # 「RTGAIA 20260918 DRAFT」放不進 16 字 → 標籤不加 DRAFT，描述一定寫
    assert label3.startswith("RTGAIA ") and "DRAFT" not in label3 and len(label3) <= 16 and "含未簽核" in desc3
