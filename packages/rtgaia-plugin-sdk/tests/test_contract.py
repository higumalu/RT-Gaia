"""契約驗證器：schema 與 B1–B8 各一個會踩到的案例。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import Grid
from rtgaia_plugin_sdk import (
    BundleBuilder,
    ContractError,
    check_bundle_semantics,
    validate_bundle_structure,
    validate_manifest,
)
from rtgaia_plugin_sdk.geometry import nifti_bytes

FOR = "1.2.826.0.1.3680043.8.498.1"
GRID = Grid(
    size=(8, 8, 4),
    spacing=(1.0, 1.0, 2.0),
    origin=(0.0, 0.0, 0.0),
    direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
    frame_of_reference_uid=FOR,
)
MV = "acme-x@1.0.0"


def manifest(**over):
    m = {
        "id": "acme-x",
        "version": "1.0.0",
        "api_version": "1",
        "label": "X",
        "licenses": ["MIT"],
        "soup": [],
        "required_role": "contourer",
        "capabilities": ["read-image", "write-transient"],
        "inputs": {"image": {"required": True, "format": "nifti"}, "params_schema": {"type": "object"}},
        "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
        "execution": {"timeout_s": 60, "progress": "callback", "concurrency": 1},
    }
    m.update(over)
    return m


def test_manifest_ok_and_license_gate() -> None:
    validate_manifest(manifest())
    with pytest.raises(ContractError) as e:
        validate_manifest(manifest(licenses=["GPL-3.0-only"]))
    assert e.value.code == "PL-LICENSE"
    validate_manifest(manifest(licenses=["GPL-3.0-only"]), allow_licenses=["GPL-3.0-only"])
    with pytest.raises(ContractError) as e:
        validate_manifest(manifest(id="Bad Id"))
    assert e.value.code == "PL-SCHEMA" and e.value.pointer == "/id"


def _labelmap_files(values: np.ndarray, grid: Grid = GRID) -> dict[str, bytes]:
    return {"https://p/seg.nii.gz": nifti_bytes(values.astype(np.uint8), grid)}


def _bundle(mv: str = MV, for_uid: str = FOR, **kw) -> dict:
    b = BundleBuilder(mv, parent_hash="sha256:" + "0" * 64)
    b.add_structure_labelmap(
        name="A", color_rgb=(1, 2, 3), frame_of_reference_uid=for_uid, url="https://p/seg.nii.gz", value=1, **kw
    )
    return b.to_dict()


def _check(bundle, files, **over):
    args = dict(
        expected_module_version=MV,
        known_frame_of_reference_uids=[FOR],
        mask_grids={FOR: GRID},
        quota_bytes=10**9,
        fetch=lambda u: files[u],
    )
    args.update(over)
    return check_bundle_semantics(bundle, **args)


def test_bundle_accepts_matching_labelmap() -> None:
    lm = np.zeros((4, 8, 8), dtype=np.uint8)
    lm[1:3, 2:5, 2:5] = 1
    validate_bundle_structure(_bundle())
    accepted, rejected = _check(_bundle(), _labelmap_files(lm))
    assert not rejected and accepted[0]["voxels"] == 18


def test_b1_module_version_mismatch_rejects_whole_bundle() -> None:
    accepted, rejected = _check(_bundle(mv="acme-x@9.9.9"), _labelmap_files(np.ones((4, 8, 8))))
    assert not accepted and rejected[0].code == "B1"


def test_b2_unknown_for() -> None:
    _, rejected = _check(_bundle(for_uid="9.9.9"), _labelmap_files(np.ones((4, 8, 8))))
    assert rejected[0].code == "B2"


def test_b3_grid_mismatch_is_rejected_not_resampled() -> None:
    other = Grid(
        size=(8, 8, 4),
        spacing=(1.0, 1.0, 2.5),
        origin=(0.0, 0.0, 0.0),
        direction=GRID.direction,
        frame_of_reference_uid=FOR,
    )
    _, rejected = _check(_bundle(), _labelmap_files(np.ones((4, 8, 8)), other))
    assert rejected[0].code == "B3" and "spacing" in rejected[0].reason


def test_b5_duplicate_names() -> None:
    b = BundleBuilder(MV)
    for _ in range(2):
        b.add_structure_labelmap(
            name="A", color_rgb=(1, 2, 3), frame_of_reference_uid=FOR, url="https://p/seg.nii.gz", value=1
        )
    accepted, rejected = _check(b.to_dict(), _labelmap_files(np.ones((4, 8, 8))))
    assert len(accepted) == 1 and rejected[0].code == "B5"


def test_b6_quota() -> None:
    _, rejected = _check(_bundle(), _labelmap_files(np.ones((4, 8, 8))), quota_bytes=10)
    assert any(r.code == "B6" for r in rejected)


def test_b7_unfetchable() -> None:
    _, rejected = _check(_bundle(), {})
    assert rejected[0].code == "B7"


def test_b8_empty_unless_allowed() -> None:
    _, rejected = _check(_bundle(), _labelmap_files(np.zeros((4, 8, 8))))
    assert rejected[0].code == "B8"
    accepted, rejected = _check(_bundle(allow_empty=True), _labelmap_files(np.zeros((4, 8, 8))))
    assert not rejected and accepted[0]["voxels"] == 0


def test_schema_rejects_deformable() -> None:
    b = BundleBuilder(MV).add_frame_group(
        frame_of_reference_uid="1.2", series_id="s", transform_to_primary=[1.0] * 16, kind="deformable"
    )
    with pytest.raises(ContractError) as e:
        validate_bundle_structure(b.to_dict())
    assert e.value.code == "PL-SCHEMA"


def test_b6_nifti_rejected_before_decode_when_too_big() -> None:
    """以 gzip ISIZE 估解壓後大小，超過 `max_decoded_bytes` 就 B6、**不解碼**。"""
    from rtgaia_plugin_sdk.geometry import gzip_decoded_size_hint

    files = _labelmap_files(np.ones((4, 8, 8), dtype=np.uint8))
    data = files["https://p/seg.nii.gz"]
    hint = gzip_decoded_size_hint(data)
    assert hint is not None and hint > 8 * 8 * 4  # NIfTI 標頭 ＋ 體素
    assert gzip_decoded_size_hint(b"not gzip at all") is None
    _, rejected = _check(_bundle(), files, max_decoded_bytes=10)
    assert rejected[0].code == "B6" and "not decoded" in rejected[0].reason
    accepted, rejected = _check(_bundle(), files, max_decoded_bytes=hint)
    assert not rejected and accepted[0]["voxels"] == 256
