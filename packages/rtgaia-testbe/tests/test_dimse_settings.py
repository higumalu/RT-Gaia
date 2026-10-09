"""DIMSE 設定：`DimseSettings` 驗證、`GET/PUT /settings`、接收端熱重啟、calling AE Title／IP 驗證、
不支援 SOP Class 的策略、節點角色、`probe`。對方仍以 `FakeNode`（test_dimse）假扮。記憶體模式；DB 持久化另有一測。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from pydicom.uid import ExplicitVRLittleEndian
from rtgaia_core import dimse
from rtgaia_core.settings import DimseSettings, _mask_url
from rtgaia_testbe import Session
from synth_dicom import SynthCase, _file, write_synth_case
from test_dimse import FakeNode, _free_port, _wait_job

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def fake(synth: SynthCase, tmp_path: Path) -> FakeNode:
    files = sorted(p for p in synth.root.rglob("*.dcm"))
    node = FakeNode(files, tmp_path / "fake_received")
    yield node  # type: ignore[misc]
    node.stop()


def _put(s: Session, path: str, body: dict) -> dict:
    r = s._client.put(path, json=body, headers=s._headers)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text}")
    return r.json()


def _echo_our_scp(port: int, *, called: str, calling: str) -> dict:
    node = dimse.Node(node_id="us", name="us", ae_title=called, host="127.0.0.1", port=port, our_calling_aet=calling)
    return dimse.echo(node)


def test_settings_validation_env_defaults_and_masking(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_AE_TITLE", raising=False)
    monkeypatch.delenv("RTGAIA_SCP", raising=False)
    monkeypatch.delenv("RTGAIA_SCP_PORT", raising=False)
    base = DimseSettings.from_env(has_db=False)
    assert (base.ae_title, base.scp_enabled, base.scp_port, base.accept_unknown_callers) == (
        "RTGAIA",
        False,
        11112,
        True,
    )
    assert DimseSettings.from_env(has_db=True).accept_unknown_callers is False  # 生產預設拒絕
    monkeypatch.setenv("RTGAIA_SCP_PORT", "4242")
    monkeypatch.setenv("RTGAIA_AE_TITLE", "GAIA_HOSP")
    env = DimseSettings.from_env(has_db=True)
    assert env.scp_enabled is True and env.scp_port == 4242 and env.ae_title == "GAIA_HOSP"
    # 合法覆寫：字串型的布林／整數也收
    ok = base.merged({"scp_port": "104", "accept_unknown_callers": "false", "idle_seconds": 10})
    assert ok.scp_port == 104 and ok.accept_unknown_callers is False and ok.idle_seconds == 10.0
    for bad in (
        {"ae_title": ""},
        {"ae_title": "THIS_IS_WAY_TOO_LONG_AET"},
        {"ae_title": "有中文"},
        {"scp_port": 0},
        {"scp_port": 70000},
        {"idle_seconds": 1},
        {"unsupported_sop_policy": "drop"},
        {"acse_timeout": True},
        {"nonsense": 1},
    ):
        with pytest.raises(ValueError):
            base.merged(bad)
    assert base.connect_timeout == 5
    with pytest.raises(ValueError):
        base.merged({"connect_timeout": 0})
    assert base.scp_changed(base.merged({"scp_port": 105})) is True
    assert base.scp_changed(base.merged({"idle_seconds": 9})) is False
    assert (
        _mask_url("postgresql+asyncpg://rtgaia:secret@db:5432/rtgaia")
        == "postgresql+asyncpg://rtgaia:***@db:5432/rtgaia"
    )


def test_put_settings_restarts_scp_and_verifies_callers(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    port1 = _free_port()
    monkeypatch.setenv("RTGAIA_SCP_PORT", str(port1))
    lib = tmp_path / "lib"
    lib.mkdir()
    with Session(library_root=str(lib), user="admin") as s:
        got = s._get("/api/v1/settings")
        assert got["dimse"]["ae_title"] == "RTGAIA" and got["dimse"]["scp_port"] == port1
        assert (
            got["dimse"]["scp_enabled"] is True and got["dimse"]["accept_unknown_callers"] is True
        )  # 沒有 DB：開發預設
        assert got["sources"]["scp_port"] == "env" and got["scp"]["running"] is True
        assert {r["key"] for r in got["readonly"]} >= {"RTGAIA_DB_URL", "RTGAIA_AUTH", "RTGAIA_DATA_DIR"}
        assert _echo_our_scp(port1, called="RTGAIA", calling="ANYONE")["ok"] is True
        # 非 admin 看不到設定
        tech = Session(client=s._client, user="tech")
        tech._headers["X-RTGaia-Role"] = "contourer"
        with pytest.raises(RuntimeError, match="403"):
            tech._get("/api/v1/settings")
        # 1) 改 AE Title 與 port → 接收端熱重啟到新 port
        port2 = _free_port()
        out = _put(s, "/api/v1/settings/dimse", {"ae_title": "GAIA2", "scp_port": port2})
        # 🔴 PUT 要回與 GET 同一個形狀：前端把回應整份當頁面狀態，少 readonly／updated／scp_owner 就白頁
        assert set(out) == set(got) and out["readonly"] and out["updated"]["updated_by"] == "admin"
        assert out["dimse"]["ae_title"] == "GAIA2" and out["sources"]["ae_title"] == "db"
        assert out["scp"]["running"] is True and out["scp"]["port"] == port2 and out["scp"]["ae_title"] == "GAIA2"
        assert _echo_our_scp(port1, called="GAIA2", calling="ANYONE")["ok"] is False
        assert _echo_our_scp(port2, called="GAIA2", calling="ANYONE")["ok"] is True
        assert s._get("/api/v1/dimse/status")["our_ae_title"] == "GAIA2"
        # 2) 不接受未登錄來源 → 拒絕；登錄「可接收」節點後放行；綁錯 IP 又拒絕
        out = _put(s, "/api/v1/settings/dimse", {"accept_unknown_callers": False})
        assert out["scp"]["verify_callers"] is True and out["scp"]["port"] == port2  # 不用重啟
        assert _echo_our_scp(port2, called="GAIA2", calling="STRANGER")["ok"] is False
        node = s._post(
            "/api/v1/dimse/nodes",
            {"name": "CBCT 主機", "ae_title": "TRUEBEAM1", "roles": {"send": False, "receive": True}},
        )
        assert node["host"] == "" and node["port"] == 0 and node["roles"] == {"send": False, "receive": True}
        assert _echo_our_scp(port2, called="GAIA2", calling="TRUEBEAM1")["ok"] is True
        s._client.patch(f"/api/v1/dimse/nodes/{node['node_id']}", json={"inbound_ip": "10.9.9.9"}, headers=s._headers)
        assert _echo_our_scp(port2, called="GAIA2", calling="TRUEBEAM1")["ok"] is False
        s._client.patch(f"/api/v1/dimse/nodes/{node['node_id']}", json={"inbound_ip": "127.0.0.1"}, headers=s._headers)
        assert _echo_our_scp(port2, called="GAIA2", calling="TRUEBEAM1")["ok"] is True
        status = s._get("/api/v1/dimse/status")["scp"]
        assert status["rejected_total"] == 2 and status["last_rejected"]["calling_aet"] == "TRUEBEAM1"
        # 只有接收角色的節點不能 echo／send／retrieve
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dimse/nodes/{node['node_id']}/echo")
        job = s._post(f"/api/v1/dimse/nodes/{node['node_id']}/retrieve", {"series_uids": ["1.2.3"], "method": "get"})
        assert "可送出" in (_wait_job(s, job["job_id"])["error"] or "")
        # 3) 登錄的節點送進來：批次帶 node_id
        us = dimse.Node(
            node_id="us", name="us", ae_title="GAIA2", host="127.0.0.1", port=port2, our_calling_aet="TRUEBEAM1"
        )
        ct_files = sorted(p for p in synth.plan_ct.directory.iterdir() if p.is_file())
        assert dimse.store(us, ct_files)["sent"] == len(ct_files)
        deadline = time.time() + 60
        while time.time() < deadline:
            imports = s._get("/api/v1/jobs", kind="import")
            if imports and imports[0]["status"] in ("done", "failed"):
                break
            time.sleep(0.1)
        assert imports[0]["status"] == "done" and imports[0]["detail"]["node_id"] == node["node_id"]
        assert imports[0]["detail"]["calling_aet"] == "TRUEBEAM1" and imports[0]["source"] == "dimse:TRUEBEAM1"
        assert s._get("/api/v1/dimse/status")["scp"]["last_batch"]["received"] == len(ct_files)
        # 4) 不支援的 SOP Class：預設收下標記；reject 策略 → 該 instance 0x0122
        cr = _file(
            "1.2.840.10008.5.1.4.1.1.1",  # CR Image Storage：不在 ACCEPTED_SOP_CLASSES
            "1.2.826.0.1.3680043.8.498.777.31.1",
            "CR",
            None,
            series_uid="1.2.826.0.1.3680043.8.498.777.2.31",
            series_date="20260601",
            description="CR",
        )
        cr.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        cr_path = tmp_path / "cr.dcm"
        cr.save_as(str(cr_path), enforce_file_format=True)
        assert dimse.store(us, [cr_path])["sent"] == 1
        _put(s, "/api/v1/settings/dimse", {"unsupported_sop_policy": "reject"})
        rejected = dimse.store(us, [cr_path])
        assert rejected["sent"] == 0 and rejected["failed"][0]["status"] == 0x0122
        # 4b) TCP 連線逾時：pynetdicom 預設無限等（ECHO 關機的節點卡 2 分鐘）→ 一律設；設定可調
        assert dimse._ae(None).connection_timeout == 5
        _put(s, "/api/v1/settings/dimse", {"connect_timeout": 2})
        assert dimse._ae(None).connection_timeout == 2
        # 5) 壞的設定 422；重啟端點；關掉接收端
        for bad in ({"scp_port": 99999}, {"idle_seconds": 1}, {"ae_title": ""}, {}):
            with pytest.raises(RuntimeError, match="422"):
                _put(s, "/api/v1/settings/dimse", bad)
        restarted = s._post("/api/v1/dimse/scp/restart")
        assert (
            restarted["restarted"] is True and restarted["running"] is True and restarted["scp"]["received_total"] == 0
        )
        out = _put(s, "/api/v1/settings/dimse", {"scp_enabled": False})
        assert out["scp"] is None and s._get("/api/v1/dimse/status")["scp"] is None
        assert _echo_our_scp(port2, called="GAIA2", calling="TRUEBEAM1")["ok"] is False
        # 稽核：設定與節點寫入都記
        actions = {e["action"] for e in s._app.state.rtgaia.audit_tail}
        assert "PUT /api/v1/settings/dimse" in actions and "POST /api/v1/dimse/nodes" in actions


def test_probe_and_node_roles(fake: FakeNode, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="admin") as s:
        # 角色驗證
        with pytest.raises(RuntimeError, match="422"):
            s._post("/api/v1/dimse/nodes", {"ae_title": "X", "roles": {"send": False, "receive": False}})
        with pytest.raises(RuntimeError, match="422"):
            s._post("/api/v1/dimse/nodes", {"ae_title": "X", "roles": {"send": True}})  # 可送出要有 host
        node = s._post(
            "/api/v1/dimse/nodes",
            {"ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port, "description": "測試 PACS"},
        )
        assert node["roles"] == {"send": True, "receive": True} and node["description"] == "測試 PACS"
        # probe：對方接受 echo／find／move／get／store
        probed = s._post(f"/api/v1/dimse/nodes/{node['node_id']}/probe")
        assert probed["ok"] is True and probed["supports"] == {
            "echo": True,
            "find": True,
            "move": True,
            "get": True,
            "store": True,
        }
        assert probed["node"]["last_echo_ok"] is True
        dead = s._post("/api/v1/dimse/nodes", {"ae_title": "NOBODY", "host": "127.0.0.1", "port": _free_port()})
        assert s._post(f"/api/v1/dimse/nodes/{dead['node_id']}/probe")["ok"] is False
        # 套用 supports
        s._client.patch(
            f"/api/v1/dimse/nodes/{node['node_id']}", json={"supports": probed["supports"]}, headers=s._headers
        )
        assert s._get("/api/v1/dimse/nodes")[0]["supports"]["get"] is True


def test_s8_node_pdu_transfer_syntax_probe_find_and_paging(fake: FakeNode, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """節點的 PDU 上限與 Transfer Syntax 偏好（驗證、生效）、probe 送 C-FIND、截斷與分頁。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="admin") as s:
        base = {"ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port}
        for bad in ({"max_pdu": 100}, {"max_pdu": "x"}, {"transfer_syntaxes": ["1.2.840.10008.1.2.4.50"]}):
            with pytest.raises(RuntimeError, match="422"):
                s._post("/api/v1/dimse/nodes", {**base, **bad})
        implicit = "1.2.840.10008.1.2"
        node = s._post("/api/v1/dimse/nodes", {**base, "max_pdu": 8192, "transfer_syntaxes": [implicit]})
        assert node["max_pdu"] == 8192 and node["transfer_syntaxes"] == [implicit]
        nid = node["node_id"]
        # 只提議 Implicit VR LE、PDU 8192：ECHO／FIND 照樣通
        assert s._post(f"/api/v1/dimse/nodes/{nid}/echo")["ok"] is True
        probed = s._post(f"/api/v1/dimse/nodes/{nid}/probe")
        assert probed["find_test"] == {"ok": True, "status": "0x0000", "matches": 0, "error": None}
        # 分頁：offset／limit 在收到的結果上切
        full = s._post(f"/api/v1/dimse/nodes/{nid}/find", {"level": "series", "query": {}})
        assert full["truncated"] is False and full["total"] >= 3
        page = s._post(f"/api/v1/dimse/nodes/{nid}/find", {"level": "series", "query": {}, "offset": 1, "limit": 2})
        assert page["total"] == full["total"] and [r["SeriesInstanceUID"] for r in page["rows"]] == [
            r["SeriesInstanceUID"] for r in full["rows"][1:3]
        ]
        # 截斷：收滿就送 C-CANCEL，回 truncated
        n = dimse.Node.from_wire(base)
        rows, truncated = dimse.find_capped(n, "series", {}, max_results=2)
        assert len(rows) == 2 and truncated is True
        rows, truncated = dimse.find_capped(n, "series", {}, max_results=500)
        assert truncated is False and len(rows) == full["total"]


def test_scp_only_accepts_uncompressed_so_pacs_must_decompress(tmp_path: Path) -> None:
    """JPEG Lossless／JPEG-LS 先不支援，但要有例外處理：我方 SCP 只協商未壓縮的
    Transfer Syntax —— 對方只提議 JPEG Lossless 時那個 context 被拒（它得先解壓再送）；提議 Explicit LE 就接受。"""
    from pydicom.uid import JPEGLosslessSV1
    from pynetdicom import AE

    ct = "1.2.840.10008.5.1.4.1.1.2"
    port = _free_port()
    scp = dimse.ReceiveServer(
        staging_root=tmp_path / "in", on_batch=lambda *_: None, ae_title="GAIA_T", port=port, host="127.0.0.1"
    )
    scp.start()
    try:
        ae = AE(ae_title="PACS")
        ae.add_requested_context(ct, [JPEGLosslessSV1])
        ae.add_requested_context(ct, [ExplicitVRLittleEndian])
        assoc = ae.associate("127.0.0.1", port, ae_title="GAIA_T")
        assert assoc.is_established
        accepted = {str(cx.transfer_syntax[0]) for cx in assoc.accepted_contexts}
        rejected = {str(cx.transfer_syntax[0]) for cx in assoc.rejected_contexts}
        assoc.release()
        assert accepted == {str(ExplicitVRLittleEndian)} and str(JPEGLosslessSV1) in rejected
    finally:
        scp.stop()


@pytest.mark.db
def test_settings_and_roles_persist_in_db(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RTGAIA_SCP", raising=False)
    monkeypatch.delenv("RTGAIA_SCP_PORT", raising=False)
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="admin") as s:
        got = s._get("/api/v1/settings")
        assert got["dimse"]["accept_unknown_callers"] is False and got["dimse"]["scp_enabled"] is False  # 生產預設
        _put(s, "/api/v1/settings/dimse", {"ae_title": "GAIA_DB", "idle_seconds": 7})
        node = s._post(
            "/api/v1/dimse/nodes",
            {
                "ae_title": "TPS",
                "roles": {"send": False, "receive": True},
                "inbound_ip": "10.1.2.3",
                "description": "d",
                "max_pdu": 32768,
                "transfer_syntaxes": ["1.2.840.10008.1.2"],
            },
        )
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="admin") as s2:
        got = s2._get("/api/v1/settings")
        assert got["dimse"]["ae_title"] == "GAIA_DB" and got["dimse"]["idle_seconds"] == 7.0
        assert got["sources"]["ae_title"] == "db" and got["sources"]["scp_port"] == "env"
        assert got["updated"]["updated_by"] == "admin"
        n = s2._get("/api/v1/dimse/nodes")[0]
        assert n["node_id"] == node["node_id"] and n["roles"] == {"send": False, "receive": True}
        assert n["inbound_ip"] == "10.1.2.3" and n["description"] == "d"
        # PDU 上限與 Transfer Syntax 偏好（migration 0021）
        assert n["max_pdu"] == 32768 and n["transfer_syntaxes"] == ["1.2.840.10008.1.2"]
        audit = s2._get("/api/v1/audit")
        assert "PUT /api/v1/settings/dimse" in {e["action"] for e in audit}
