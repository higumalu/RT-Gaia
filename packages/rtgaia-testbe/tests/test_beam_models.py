"""擬合出來的射束模型：挑模型（啟用中的優先、機器名稱、明確指定草稿、停用的不行）、擬合請求的檢查、啟用時停掉
同規則的舊模型、API（擬合工作 → 草稿 → 啟用 → 劑量計算用它 → 停用；權限）。擬合子行程換成假的（CI 沒有 GPU）。"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from rtgaia_core import beam_model_jobs as bm
from rtgaia_core.auth import required_role_for
from rtgaia_core.dosecalc_jobs import PrepareError
from rtgaia_dosecalc import beam_models
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth_plan


def _rec(model_id: str, status: str, machines: list[str] | None = None, base: str = "demo-6x") -> dict:  # type: ignore[type-arg]
    m = {**{x["model_id"]: x for x in beam_models.builtin_models()}[base], "model_id": model_id, "name": model_id}
    return {"model": m, "status": status, "machines": machines or []}


def test_model_for_prefers_active_user_models() -> None:
    users = [
        _rec("fit_a", "active"),
        _rec("fit_b", "active", ["LA3"]),
        _rec("fit_d", "draft"),
        _rec("fit_r", "retired"),
    ]
    pick = lambda **kw: beam_models.model_for(6.0, "STANDARD", mlc_devices=["MLCX"], user_models=users, **kw)  # noqa: E731
    assert pick(machine="LA3")[0]["model_id"] == "fit_b"  # 寫了機器名稱、對得上的最優先
    assert pick(machine="la3 ")[0]["model_id"] == "fit_b"  # 大小寫與空白不計
    assert pick(machine="LA1")[0]["model_id"] == "fit_a"  # 對不上 → 沒寫機器名稱的
    assert (
        beam_models.model_for(
            6.0, "STANDARD", mlc_devices=["MLCX"], user_models=[_rec("x", "active", ["LA3"])], machine="LA1"
        )[0]["model_id"]
        == "demo-6x"
    )
    assert beam_models.model_for(6.0, "STANDARD", mlc_devices=["MLCX"], user_models=[])[0]["model_id"] == "demo-6x"
    # 明確指定：草稿可以（啟用前試算）、停用的不行、不存在的不行
    assert beam_models.model_for(6.0, "STANDARD", "fit_d", ["MLCX"], user_models=users)[0]["model_id"] == "fit_d"
    m, why = beam_models.model_for(6.0, "STANDARD", "fit_r", ["MLCX"], user_models=users)
    assert m is None and "停用" in why
    assert beam_models.model_for(6.0, "STANDARD", "nope", ["MLCX"], user_models=users)[0] is None
    # 能量、模式、MLC 不合的使用者模型不會被挑到
    assert beam_models.model_for(6.0, "FFF", mlc_devices=["MLCX"], user_models=users)[0]["model_id"] == "demo-6xfff"


def test_activate_retires_the_same_rule() -> None:
    rows = [
        _rec("old", "active"),
        _rec("new", "draft"),
        _rec("other_machine", "active", ["LA3"]),
        _rec("fff", "active", base="demo-6xfff"),
    ]
    assert bm.activate(rows, "new", user="admin") == ["old"]
    assert [r["status"] for r in rows] == ["retired", "active", "active", "active"]
    assert rows[1]["activated_by"] == "admin" and rows[0]["retired_by"] == "admin"


def _user_dataset(status: str, energy: float = 6.0) -> dict:  # type: ignore[type-arg]
    return {
        "dataset_id": "bd_1",
        "name": "mine",
        "status": status,
        "beam": {"energy_mv": energy, "fluence_mode": "STANDARD"},
        "measurements": [],
    }


def test_prepare_fit_checks() -> None:
    ok = bm.prepare_fit(
        {"prior_model_id": "demo-6x", "fit_datasets": ["pub-beyer2013-6x"], "validate_datasets": ["pub-akino2020-6x"]},
        [],
        [],
    )
    assert (
        ok["prior"]["model_id"] == "demo-6x"
        and ok["histories"] == bm.DEFAULT_HISTORIES
        and ok["model_id"].startswith("fit_")
    )
    assert [d["dataset_id"] for d in ok["validate_datasets"]] == ["pub-akino2020-6x"]
    bad = [
        ({"prior_model_id": "nope", "fit_datasets": ["pub-beyer2013-6x"]}, "NO_BEAM_MODEL"),
        ({"prior_model_id": "demo-6x", "fit_datasets": []}, "BAD_FIT_REQUEST"),
        (
            {
                "prior_model_id": "demo-6x",
                "fit_datasets": ["pub-beyer2013-6x"],
                "validate_datasets": ["pub-beyer2013-6x"],
            },
            "BAD_FIT_REQUEST",
        ),
        ({"prior_model_id": "demo-6x", "fit_datasets": ["pub-beyer2013-6x"], "histories": 123}, "BAD_FIT_REQUEST"),
        ({"prior_model_id": "demo-6x", "fit_datasets": ["pub-beyer2013-15x"]}, "BEAM_MISMATCH"),
        ({"prior_model_id": "demo-6x", "fit_datasets": ["bd_1"]}, "BEAM_DATA_NOT_LOCKED"),
        ({"prior_model_id": "demo-6x", "fit_datasets": ["bd_x"]}, "NO_BEAM_DATA"),
    ]
    for body, code in bad:
        with pytest.raises(PrepareError) as exc:
            bm.prepare_fit(body, [_user_dataset("draft")], [])
        assert exc.value.code == code, (body, exc.value.problems)
    locked = bm.prepare_fit({"prior_model_id": "demo-6x", "fit_datasets": ["bd_1"]}, [_user_dataset("locked")], [])
    assert locked["fit_datasets"][0]["dataset_id"] == "bd_1"


def test_admin_only_writes() -> None:
    assert required_role_for("GET", "/api/v1/dosecalc/beam-models") == "viewer"
    for method, path in (
        ("POST", "/api/v1/dosecalc/beam-models/fit"),
        ("POST", "/api/v1/dosecalc/beam-models/user/fit_1/activate"),
        ("POST", "/api/v1/dosecalc/beam-models/user/fit_1/retire"),
        ("DELETE", "/api/v1/dosecalc/beam-models/user/fit_1"),
    ):
        assert required_role_for(method, path) == "admin", path


# ── API ───────────────────────────────────────────────────────────────────────

FAKE_FIT = r"""
import json, sys, pathlib
prior, model_id, out = json.loads(pathlib.Path(sys.argv[1]).read_text()), sys.argv[2], pathlib.Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
fit = {"prior_model_id": prior["model_id"], "datasets": ["pub-beyer2013-6x"], "unconstrained": []}
m = {**prior, "model_id": model_id, "fit": fit}
m["params"] = {**m["params"], "focal_spot_sigma_mm": 0.8}
stage = {"name": "focal_spot", "parameters": {"focal_spot_sigma_mm": 0.8}}
check = {"dataset_id": "pub-beyer2013-6x", "role": "fit", "summary": {"points": 26, "pass": 18, "fail": 8}}
(out / "model.json").write_text(json.dumps(m))
(out / "fit.json").write_text(json.dumps({"stages": [stage]}))
(out / "checks.json").write_text(json.dumps([{**check, "checks": []}]))
(out / "progress.json").write_text(json.dumps({"phase": "done", "percent": 100}))
"""


@pytest.fixture(scope="module")
def case(tmp_path_factory):  # type: ignore[no-untyped-def]
    return synth_plan.build(tmp_path_factory.mktemp("synth-plan-beam-models"))


@pytest.fixture
def env(tmp_path: Path, monkeypatch):  # type: ignore[no-untyped-def]
    from rtgaia_dosecalc import engines

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_DOSECALC_TEST_ENGINE", "1")
    real = engines.available
    monkeypatch.setattr(engines, "available", lambda: [*real(), {"name": "gpu", "ready": True, "reason": ""}])
    script = tmp_path / "fake_fit.py"
    script.write_text(FAKE_FIT, encoding="utf-8")

    def command(req, out):  # type: ignore[no-untyped-def]
        return [
            sys.executable,
            str(script),
            str(Path(req["work_dir"]) / "in" / "prior.json"),
            req["model_id"],
            str(out),
        ]

    monkeypatch.setattr(bm, "fit_command", command)


def _wait_job(s: Session, job_id: str, timeout: float = 60.0) -> dict:  # type: ignore[type-arg]
    deadline = time.time() + timeout
    while (j := s._get(f"/api/v1/jobs/{job_id}"))["status"] not in ("done", "failed"):
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.2)
    return j


def _delete(s: Session, path: str):  # type: ignore[no-untyped-def]
    return s._unwrap(s._client.delete(path, headers=s._headers))


def _summary(s: Session, dc: str, body: dict) -> dict:  # type: ignore[type-arg]
    """送出劑量計算只為了看它挑了哪個模型：馬上取消（不佔 worker）。"""
    job = s._post(dc, body)
    s._client.delete(f"{dc}/{job['job_id']}", headers=s._headers)
    return job["summary"]


def test_fit_job_draft_activate_use_retire(case, env) -> None:  # type: ignore[no-untyped-def]
    base = "/api/v1/dosecalc/beam-models"
    with Session(library_root=str(case.root.parent), user="admin") as s:
        s.load_case(
            {
                "image_series_uids": [case.expected["ct_series_instance_uid"]],
                "plan_uids": [case.expected["plan_series_instance_uid"]],
            },
            webgl2=False,
            tier="C",
        )
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"{base}/fit", {"prior_model_id": "demo-6x", "fit_datasets": ["pub-beyer2013-15x"]})
        started = s._post(
            f"{base}/fit",
            {
                "prior_model_id": "demo-6x",
                "fit_datasets": ["pub-beyer2013-6x"],
                "validate_datasets": ["pub-akino2020-6x"],
                "machines": ["SynthLinac"],
                "name": "TB 6X fit",
            },
        )
        job = _wait_job(s, started["job_id"])
        assert job["status"] == "done", job
        mid = started["model_id"]
        listed = s._get(base)
        user = next(m for m in listed["user_models"] if m["model_id"] == mid)
        assert user["status"] == "draft" and user["name"] == "TB 6X fit" and user["machines"] == ["SynthLinac"]
        assert user["focal_spot_sigma_mm"] == 0.8 and user["checks"][0]["pass"] == 18
        assert user["created_by"] == "admin" and user["job_id"] == started["job_id"]
        detail = s._get(f"{base}/user/{mid}")
        assert detail["fit_report"]["stages"][0]["name"] == "focal_spot" and detail["model"]["model_id"] == mid
        # 工作目錄裡有先驗與資料集（擬合要說得出用了哪些固定的資料）
        req = next(j for j in s._get("/api/v1/jobs") if j["job_id"] == started["job_id"])
        assert req["kind"] == "beamfit"
        # 草稿：劑量計算不會自己挑；明確指定可以
        plan = case.expected["plan_sop_instance_uid"]
        dc = f"/api/v1/studies/{s.study_id}/dosecalc"
        auto = _summary(s, dc, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct"})["beam_model"]
        assert auto["model_id"] == "demo-6x"
        explicit = _summary(
            s, dc, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct", "beam_model_id": mid}
        )
        assert explicit["beam_model"]["model_id"] == mid
        engines = s._get("/api/v1/dosecalc/engines")["beam_models"]
        assert {"model_id": mid, "status": "draft"}.items() <= next(m for m in engines if m["model_id"] == mid).items()
        # 啟用 → 自動挑它（合成計畫的機器名稱是 SynthLinac 嗎？不是的話，沒寫機器名稱的才會被挑）
        act = s._post(f"{base}/user/{mid}/activate", {})
        assert act["status"] == "active" and act["retired"] == []
        with pytest.raises(RuntimeError, match="422"):
            _delete(s, f"{base}/user/{mid}")
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"{base}/user/{mid}/activate", {})
        # 第二個（沒寫機器名稱）→ 啟用 → 自動挑到
        second = s._post(f"{base}/fit", {"prior_model_id": "demo-6x", "fit_datasets": ["pub-beyer2013-6x"]})
        assert _wait_job(s, second["job_id"])["status"] == "done"
        s._post(f"{base}/user/{second['model_id']}/activate", {})
        auto = _summary(s, dc, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct"})["beam_model"]
        assert auto["model_id"] in (mid, second["model_id"])
        # 停用 → 不能再用；刪草稿
        s._post(f"{base}/user/{second['model_id']}/retire", {})
        s._post(f"{base}/user/{mid}/retire", {})
        with pytest.raises(RuntimeError, match="422"):
            s._post(dc, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct", "beam_model_id": mid})
        assert (
            _summary(s, dc, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct"})["beam_model"]["model_id"]
            == "demo-6x"
        )
        third = s._post(f"{base}/fit", {"prior_model_id": "demo-6x", "fit_datasets": ["pub-beyer2013-6x"]})
        assert _wait_job(s, third["job_id"])["status"] == "done"
        assert _delete(s, f"{base}/user/{third['model_id']}")["deleted"] == third["model_id"]
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"{base}/user/{third['model_id']}")
        assert [m["status"] for m in s._get(base)["user_models"]] == ["retired", "retired"]
