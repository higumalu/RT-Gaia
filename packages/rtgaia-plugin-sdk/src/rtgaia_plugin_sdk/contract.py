"""契約驗證：schema（結構）＋ B1–B8（語意）。宿主與 `rtgaia-plugin-check` 用同一份。

schema 來源：套件內 `schemas/`（wheel 由 `rtgaia-plugin-api/schemas` 複製進來）；
在 repo 內開發時退回讀 `packages/rtgaia-plugin-api/schemas/`。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from rtgaia_geom import Grid

from .geometry import grid_from_json, grids_equal, gzip_decoded_size_hint, is_orthonormal, nifti_from_bytes

LICENSE_ALLOWLIST = frozenset({"MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"})
MAX_STRUCTURES = 256
MAX_IMAGES = 8
MAX_DOSES = 8


class ContractError(ValueError):
    """契約的錯誤碼 ＋ 訊息 ＋（可選）JSON pointer。"""

    def __init__(self, code: str, message: str, pointer: str | None = None) -> None:
        super().__init__(f"{code}: {message}" + (f" @ {pointer}" if pointer else ""))
        self.code = code
        self.message = message
        self.pointer = pointer


@dataclass(frozen=True)
class BundleRejection:
    kind: str
    index: int
    code: str
    reason: str

    def to_wire(self) -> dict[str, Any]:
        return {"kind": self.kind, "index": self.index, "code": self.code, "reason": self.reason}


def _schema_dir() -> Path:
    here = Path(__file__).parent
    if (here / "schemas").is_dir():
        return here / "schemas"
    for parent in here.parents:
        repo = parent / "packages" / "rtgaia-plugin-api" / "schemas"
        if repo.is_dir():
            return repo
    raise FileNotFoundError(
        "Contract schema directory not found (schemas/ in the package or packages/rtgaia-plugin-api/schemas/)"
    )


@cache
def load_schema(name: str) -> dict[str, Any]:
    """`manifest` 或 `import-bundle`。"""
    return json.loads((_schema_dir() / f"{name}.schema.json").read_text(encoding="utf-8"))


def _validate(name: str, doc: Any) -> None:
    validator = Draft202012Validator(load_schema(name))
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
    if errors:
        e = errors[0]
        pointer = "/" + "/".join(str(p) for p in e.absolute_path)
        raise ContractError("PL-SCHEMA", f"{name} does not match the schema: {e.message}", pointer)


def validate_manifest(manifest: Any, *, allow_licenses: Iterable[str] = ()) -> None:
    """結構 ＋ 授權白名單。`allow_licenses` 是 admin 明示放行的清單。"""
    _validate("manifest", manifest)
    allowed = LICENSE_ALLOWLIST | set(allow_licenses)
    bad = [lic for lic in manifest["licenses"] if lic not in allowed]
    if bad:
        raise ContractError(
            "PL-LICENSE", f"License not on the allow-list: {bad} (allowed: {sorted(LICENSE_ALLOWLIST)})", "/licenses"
        )
    if manifest.get("api_version") != "1":
        raise ContractError("PL-API", f"api_version {manifest.get('api_version')!r} is not 1", "/api_version")


def validate_bundle_structure(bundle: Any) -> None:
    _validate("import-bundle", bundle)


Fetch = Callable[[str], bytes]


def check_bundle_semantics(
    bundle: dict[str, Any],
    *,
    expected_module_version: str,
    known_frame_of_reference_uids: Iterable[str],
    mask_grids: dict[str, Grid],
    quota_bytes: int,
    fetch: Fetch,
    max_decoded_bytes: int | None = None,
) -> tuple[list[dict[str, Any]], list[BundleRejection]]:
    """B1–B8。回 (accepted, rejected)；accepted 的每一項是 `{kind, index, ...解析後的資料}`。

    * `mask_grids`：每個 FoR 的 `MaskGrid`（宿主決定；check 工具用輸入影像網格）。
    * `fetch(url) -> bytes`：宿主用登錄 bearer 抓；抓不到就是 B7。
    * `max_decoded_bytes`：NIfTI **解碼前**以 gzip ISIZE 估解壓後大小，超過就 B6、不解碼（預設＝配額）。
    * 整包只要 B1 失敗就全部拒收（冒充模組不能部分接受）。
    """
    accepted: list[dict[str, Any]] = []
    rejected: list[BundleRejection] = []
    decoded_cap = quota_bytes if max_decoded_bytes is None else max_decoded_bytes

    def too_big_to_decode(data: bytes) -> str | None:
        hint = gzip_decoded_size_hint(data)
        if hint is not None and hint > decoded_cap:
            return f"NIfTI would decompress to about {hint} bytes, over the quota of {decoded_cap}; not decoded"
        return None

    # B1
    mv = bundle["provenance"]["module_version"]
    if mv != expected_module_version:
        rejected.append(
            BundleRejection(
                "bundle", -1, "B1", f"module_version {mv!r} differs from the registered {expected_module_version!r}"
            )
        )
        return accepted, rejected

    fors = set(known_frame_of_reference_uids)
    declared_series = {img["series_id"] for img in bundle.get("images", [])}
    for i, fg in enumerate(bundle.get("frame_groups", [])):
        if fg["series_id"] not in declared_series:
            rejected.append(
                BundleRejection(
                    "frame_group", i, "B2", f"series_id {fg['series_id']!r} is not among the images of this bundle"
                )
            )
            continue
        fors.add(fg["frame_of_reference_uid"])
        accepted.append({"kind": "frame_group", "index": i, "frame_of_reference_uid": fg["frame_of_reference_uid"]})

    total_bytes = 0
    fetched: dict[str, bytes] = {}

    def get(url: str) -> bytes:
        nonlocal total_bytes
        if url not in fetched:
            fetched[url] = fetch(url)
            total_bytes += len(fetched[url])
        return fetched[url]

    def for_ok(kind: str, i: int, member: dict[str, Any]) -> bool:
        if member["frame_of_reference_uid"] not in fors:
            rejected.append(
                BundleRejection(
                    kind,
                    i,
                    "B2",
                    f"frame of reference {member['frame_of_reference_uid']} is neither in the session "
                    "nor declared in this bundle",
                )
            )
            return False
        return True

    # B4：影像／劑量自帶網格
    for kind, key, cap in (("image", "images", MAX_IMAGES), ("dose", "doses", MAX_DOSES)):
        members = bundle.get(key, [])
        if len(members) > cap:
            rejected.append(BundleRejection(kind, -1, "B6", f"more than {cap} {key}"))
            continue
        for i, m in enumerate(members):
            if not for_ok(kind, i, m):
                continue
            grid = grid_from_json(m["grid"], frame_of_reference_uid=m["frame_of_reference_uid"])
            if not is_orthonormal(grid.direction):
                rejected.append(BundleRejection(kind, i, "B4", "direction is not an orthonormal matrix"))
                continue
            try:
                data = get(m["voxels"]["url"])
            except Exception as exc:  # noqa: BLE001
                rejected.append(BundleRejection(kind, i, "B7", f"cannot fetch voxels: {exc}"))
                continue
            if m["voxels"]["encoding"] == "nifti":
                big = too_big_to_decode(data)
                if big:
                    rejected.append(BundleRejection(kind, i, "B6", big))
                    continue
                _, file_grid = nifti_from_bytes(data, frame_of_reference_uid=m["frame_of_reference_uid"])
                why = grids_equal(file_grid, grid)
                if why:
                    rejected.append(BundleRejection(kind, i, "B4", f"NIfTI header does not match the grid: {why}"))
                    continue
            accepted.append({"kind": kind, "index": i, "grid": grid, "label": m["label"]})

    # B3／B5／B8：結構
    structures = bundle.get("structures", [])
    if len(structures) > MAX_STRUCTURES:
        rejected.append(BundleRejection("structure", -1, "B6", f"more than {MAX_STRUCTURES} structures"))
        structures = []
    seen_names: set[str] = set()
    for i, st in enumerate(structures):
        if st["name"] in seen_names:
            rejected.append(BundleRejection("structure", i, "B5", f"duplicate name: {st['name']!r}"))
            continue
        seen_names.add(st["name"])
        if not for_ok("structure", i, st):
            continue
        mask_grid = mask_grids.get(st["frame_of_reference_uid"])
        if mask_grid is None:
            rejected.append(
                BundleRejection(
                    "structure",
                    i,
                    "B3",
                    f"frame of reference {st['frame_of_reference_uid']} has no mask grid "
                    "(structures on a newly declared frame of reference are not accepted in this version)",
                )
            )
            continue
        mask = st["mask"]
        enc = mask["encoding"]
        if enc == "labelmap":
            try:
                data = get(mask["url"])
            except Exception as exc:  # noqa: BLE001
                rejected.append(BundleRejection("structure", i, "B7", f"cannot fetch the labelmap: {exc}"))
                continue
            big = too_big_to_decode(data)
            if big:
                rejected.append(BundleRejection("structure", i, "B6", big))
                continue
            arr, file_grid = nifti_from_bytes(data, frame_of_reference_uid=st["frame_of_reference_uid"])
            why = grids_equal(file_grid, mask_grid)
            if why:
                rejected.append(
                    BundleRejection("structure", i, "B3", f"labelmap grid differs from the mask grid: {why}")
                )
                continue
            voxels = int((arr == mask["value"]).sum())
            if voxels == 0 and not st.get("allow_empty", False):
                rejected.append(
                    BundleRejection(
                        "structure", i, "B8", f"labelmap has no voxels with value {mask['value']} (empty_mask)"
                    )
                )
                continue
            accepted.append({"kind": "structure", "index": i, "name": st["name"], "voxels": voxels, "grid": mask_grid})
        elif enc == "json-mask":
            grid = grid_from_json(mask["grid"], frame_of_reference_uid=st["frame_of_reference_uid"])
            why = grids_equal(grid, mask_grid)
            if why:
                rejected.append(
                    BundleRejection("structure", i, "B3", f"json-mask grid differs from the mask grid: {why}")
                )
                continue
            total_bytes += len(mask["bits"])
            accepted.append({"kind": "structure", "index": i, "name": st["name"], "grid": mask_grid})
        else:
            # dicom-rtstruct／dicom-seg：幾何取自 DICOM，由宿主 loader 轉換後再驗；check 工具只驗抓得到
            try:
                get(mask["url"])
            except Exception as exc:  # noqa: BLE001
                rejected.append(BundleRejection("structure", i, "B7", f"cannot fetch {enc}: {exc}"))
                continue
            accepted.append({"kind": "structure", "index": i, "name": st["name"], "encoding": enc})

    for i, m in enumerate(bundle.get("measurements", [])):
        if for_ok("measurement", i, m):
            if len(m["points"]) % 3 != 0:
                rejected.append(BundleRejection("measurement", i, "B4", "points are not xyz triples"))
                continue
            accepted.append({"kind": "measurement", "index": i, "label": m["label"]})
    for i, r in enumerate(bundle.get("reports", [])):
        accepted.append({"kind": "report", "index": i, "label": r["label"]})

    # B6：配額（整包）
    if total_bytes > quota_bytes:
        rejected.append(
            BundleRejection("bundle", -1, "B6", f"bundle of {total_bytes} bytes exceeds the quota of {quota_bytes}")
        )
        accepted.clear()
    return accepted, rejected
