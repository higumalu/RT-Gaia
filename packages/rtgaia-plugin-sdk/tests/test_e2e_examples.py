"""兩個範例 plugin 起真 uvicorn，用 `rtgaia-plugin-check` 的程式化入口走完契約。"""

from __future__ import annotations

import pytest
from conftest import Served, load_plugin_app
from rtgaia_plugin_sdk.check import run_check

pytestmark = pytest.mark.e2e


def test_hello_plugin_passes_contract_check(artifacts_dir) -> None:
    with Served(load_plugin_app("plugin-hello-python")) as s:
        report = run_check(s.url, timeout_s=60, params={"hu_min": 0, "name": "Sphere"})
    assert report.ok, report.render()
    assert report.accepted and report.accepted[0]["voxels"] > 0
    assert report.progress and report.audits and report.done == {"status": "done"}


def test_check_reports_b3_when_plugin_returns_wrong_grid(artifacts_dir) -> None:
    """負向：回一個 spacing 不同的 labelmap → 宿主 B3 拒收，check 判 FAIL。"""
    import numpy as np
    from rtgaia_geom import Grid
    from rtgaia_plugin_sdk import PluginApp, RunContext
    from rtgaia_plugin_sdk.check import phantom

    _, grid = phantom()
    bad = Grid(
        size=grid.size,
        spacing=(2.0, 2.0, 2.0),
        origin=grid.origin,
        direction=grid.direction,
        frame_of_reference_uid=grid.frame_of_reference_uid,
    )

    def run(ctx: RunContext) -> None:
        url = ctx.publish_nifti("seg.nii.gz", np.ones((48, 64, 64), dtype=np.uint8), bad)
        ctx.submit(
            ctx.bundle().add_structure_labelmap(
                name="Bad", color_rgb=(1, 1, 1), frame_of_reference_uid=grid.frame_of_reference_uid, url=url, value=1
            )
        )

    m = {
        "id": "bad-grid",
        "version": "0.0.1",
        "api_version": "1",
        "label": "bad",
        "licenses": ["MIT"],
        "soup": [],
        "required_role": "contourer",
        "capabilities": ["write-transient"],
        "inputs": {"image": {"required": True, "format": "nifti"}, "params_schema": {"type": "object"}},
        "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
        "execution": {"timeout_s": 60, "progress": "poll", "concurrency": 1},
    }
    with Served(PluginApp(manifest=m, run=run, artifacts_dir=artifacts_dir).app) as s:
        report = run_check(s.url, timeout_s=60)
    assert not report.ok
    assert any(r.code == "B3" for r in report.rejected), report.render()
