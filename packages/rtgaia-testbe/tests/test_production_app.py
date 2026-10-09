"""以**生產設定**建出來的 app 不得有測試端點；一般編輯者不能改 approved 結構。

在 `auth=required` 下重現：contourer 打 `/_test/mask` 覆寫事先標成 approved 的結構，
回 200、可自帶 status、沒有稽核。修法不是幫 `_test` 加權限，而是生產 app 根本不掛那組 router。
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from rtgaia_testbe import Session
from rtgaia_testbe.api import create_app

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


def _all_paths(routes) -> list[str]:  # type: ignore[no-untyped-def]
    """新版 FastAPI 把 `include_router` 包成 `_IncludedRouter`（沒有 path、有 routes）—— 要遞迴攤平。"""
    out: list[str] = []
    for r in routes:
        path = getattr(r, "path", None)
        if isinstance(path, str):
            out.append(path)
        sub = getattr(r, "routes", None) or getattr(getattr(r, "original_router", None), "routes", None)
        if sub:
            out.extend(_all_paths(sub))
    return out


def _test_paths(app) -> list[str]:  # type: ignore[no-untyped-def]
    return sorted(p for p in _all_paths(app.routes) if p.startswith("/api/v1/_test"))


def test_production_app_has_no_test_routes(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """不給 `test_api`、環境變數也沒設 → 沒有任何 `/api/v1/_test` 路徑，打了就是 404。"""
    monkeypatch.delenv("RTGAIA_TEST_API", raising=False)
    app = create_app()
    assert _test_paths(app) == []
    with TestClient(app) as c:
        assert c.get("/api/v1/_test/phantoms").status_code == 404
        # 正常路徑仍在（不是整個 app 壞掉）
        assert c.get("/healthz").status_code == 200


def test_test_api_flag_by_parameter(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_TEST_API", raising=False)
    app = create_app(test_api=True)
    paths = _test_paths(app)
    assert "/api/v1/_test/phantoms" in paths and "/api/v1/_test/mask" in paths
    with TestClient(app) as c:
        assert c.get("/api/v1/_test/phantoms").status_code == 200


def test_test_api_flag_by_env(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """旗標方向寫錯（例如 `not`）時這條會抓到：env 開 → 有；env 關 → 沒有。"""
    monkeypatch.setenv("RTGAIA_TEST_API", "1")
    assert "/api/v1/_test/phantoms" in _test_paths(create_app())
    monkeypatch.setenv("RTGAIA_TEST_API", "0")
    assert _test_paths(create_app()) == []
    # 參數優先於環境變數
    monkeypatch.setenv("RTGAIA_TEST_API", "1")
    assert _test_paths(create_app(test_api=False)) == []


def test_driver_app_keeps_test_api() -> None:
    """驅動腳本（前端 e2e 也用它）必須拿到 `_test`，否則整組 e2e 會在 `load()` 就 404。"""
    with Session() as s:
        assert "/api/v1/_test/load" in _test_paths(s._app)


@pytest.mark.db
def test_contourer_cannot_edit_approved(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """負向測試：走**正常路由**、`auth=required`、真 DB —— contourer 對 approver 已標
    approved 的結構送 edit → 409 `APPROVED_LOCKED`，`head_version_id` 不變。這才是「一般編輯者不能修改
    approved 結構」的證據；`_test/mask` 在生產 app 上根本不存在（上面那條）。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import numpy as np
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
    from synth_dicom import write_synth_case

    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    os.environ["RTGAIA_DATA_DIR"] = str(tmp_path / "data")
    synth = write_synth_case(tmp_path / "synth")
    selection = {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [],
        "registration_uids": [],
        "plan_uids": [],
    }
    with Session(library_root=str(synth.root), db_url=DB_URL) as admin:
        # 生產設定：`test_api` 沒開（driver 會開，所以這裡另建一個 app 再共用 client）
        assert admin._app.state.rtgaia.auth_mode == "required"
        admin.bootstrap("admin", "correct-horse-battery")
        admin.create_user("tech1", "correct-horse-battery", "contourer")
        admin.create_user("dr1", "correct-horse-battery", "approver")
        tech, doc = Session(client=admin._client), Session(client=admin._client)
        tech.login("tech1", "correct-horse-battery")
        doc.login("dr1", "correct-horse-battery")

        tech.load_case(selection)
        sid = tech.claim(tech.structures()[0]["structure_id"])
        tech.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        doc.load_case(selection)
        doc.review({sid: "approved"}, note="ok")
        head = tech.versions(sid)["head_version_id"]

        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            tech.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=2)
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            tech.postprocess(sid, "fill_holes", per_slice=True)
        assert tech.versions(sid)["head_version_id"] == head
        # 同一個 app 上也沒有 `_test/mask` 可以繞（driver 建的 app 有 _test，這裡直接驗生產 app）
        assert _test_paths(create_app(db_url=DB_URL, public_url="http://testserver")) == []
