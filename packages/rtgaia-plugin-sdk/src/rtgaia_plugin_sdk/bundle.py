"""組 ImportBundle。只做結構正確的組裝，語意驗證在 `contract.py`。"""

from __future__ import annotations

from typing import Any

from rtgaia_geom import Grid

from .geometry import grid_to_json


class BundleBuilder:
    def __init__(self, module_version: str, *, source: str = "model", parent_hash: str | None = None) -> None:
        self._bundle: dict[str, Any] = {
            "bundle_version": "1",
            "provenance": {"module_version": module_version, "source": source, "parent_hash": parent_hash},
        }

    def _list(self, key: str) -> list[dict[str, Any]]:
        return self._bundle.setdefault(key, [])

    def add_frame_group(
        self, *, frame_of_reference_uid: str, series_id: str, transform_to_primary: list[float], kind: str = "rigid"
    ) -> BundleBuilder:
        self._list("frame_groups").append(
            {
                "frame_of_reference_uid": frame_of_reference_uid,
                "series_id": series_id,
                "transform_to_primary": [float(v) for v in transform_to_primary],
                "transform_kind": kind,
            }
        )
        return self

    def add_image(
        self,
        *,
        series_id: str,
        label: str,
        modality: str,
        grid: Grid,
        url: str,
        encoding: str = "nifti",
        window_level: tuple[float, float] | None = None,
    ) -> BundleBuilder:
        m: dict[str, Any] = {
            "series_id": series_id,
            "label": label,
            "modality": modality,
            "frame_of_reference_uid": grid.frame_of_reference_uid,
            "grid": grid_to_json(grid, with_for=False),
            "voxels": {"encoding": encoding, "url": url},
        }
        if window_level:
            m["window_level"] = {"center": window_level[0], "width": window_level[1]}
        self._list("images").append(m)
        return self

    def add_structure_labelmap(
        self,
        *,
        name: str,
        color_rgb: tuple[int, int, int],
        frame_of_reference_uid: str,
        url: str,
        value: int,
        tg263_code: str | None = None,
        allow_empty: bool = False,
    ) -> BundleBuilder:
        m: dict[str, Any] = {
            "name": name,
            "color_rgb": list(color_rgb),
            "frame_of_reference_uid": frame_of_reference_uid,
            "mask": {"encoding": "labelmap", "url": url, "value": int(value)},
        }
        if tg263_code is not None:
            m["tg263_code"] = tg263_code
        if allow_empty:
            m["allow_empty"] = True
        self._list("structures").append(m)
        return self

    def add_dose(
        self, *, label: str, grid: Grid, url: str, encoding: str = "nifti", summation: str | None = None
    ) -> BundleBuilder:
        m: dict[str, Any] = {
            "label": label,
            "unit": "Gy",
            "frame_of_reference_uid": grid.frame_of_reference_uid,
            "grid": grid_to_json(grid, with_for=False),
            "voxels": {"encoding": encoding, "url": url},
        }
        if summation:
            m["dose_summation_type"] = summation
        self._list("doses").append(m)
        return self

    def add_measurement(
        self, *, kind: str, label: str, frame_of_reference_uid: str, points: list[float]
    ) -> BundleBuilder:
        self._list("measurements").append(
            {
                "kind": kind,
                "label": label,
                "frame_of_reference_uid": frame_of_reference_uid,
                "points": [float(v) for v in points],
            }
        )
        return self

    def add_report(self, *, label: str, media_type: str, url: str) -> BundleBuilder:
        self._list("reports").append({"label": label, "media_type": media_type, "url": url})
        return self

    def to_dict(self) -> dict[str, Any]:
        return self._bundle
