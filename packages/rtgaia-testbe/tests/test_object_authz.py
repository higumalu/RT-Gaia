"""物件級讀取授權 —— 別人的暫存結果在**每一個**讀取入口都不可見。

重現：Alice 的暫存結構，Bob 讀一般 mask 得 404，但 mesh／versions／版本 mask 都 200，
連 Alice session 的 WS 也收到含私人結構的 `scene.replace`。修法是一個共用的閘（`deps.readable_structure`）
套到所有入口，並讓 WS 依連線 Principal 拒絕別人的 session。需要 Postgres（真帳號）。
"""

from __future__ import annotations

import os

import numpy as np
import pytest
from rtgaia_core.state import StructureState
from rtgaia_geom import Provenance, payload_content_hash
from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
from rtgaia_testbe import Session
from starlette.websockets import WebSocketDisconnect
from synth_dicom import SynthCase, write_synth_case

pytestmark = pytest.mark.db
DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")
PW = "correct-horse-battery"


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def db_url(monkeypatch, tmp_path) -> str:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    return DB_URL


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [synth.plan_dose_uid],
        "registration_uids": [],
        "plan_uids": [synth.plan_uid],
    }


def _inject_transient(app_state, case, owner: str, structure_id: str) -> StructureState:  # type: ignore[no-untyped-def]
    """把一個「plugin 結果」直接放進 Case 的暫存集（與 test_plugins 同一招；不走真 plugin）。"""
    for_uid = case.mask_grid.grid.frame_of_reference_uid
    tset = case.transient_set_for(owner, for_uid, module_version="x@1")
    block = np.ones((2, 2, 2), dtype=np.uint8)
    st = StructureState(
        structure_id=structure_id,
        name="private",
        color_rgb=(1, 2, 3),
        frame_of_reference_uid=for_uid,
        offset_ijk=(0, 0, 0),
        size_ijk=(2, 2, 2),
        block=block,
        content_hash=payload_content_hash(offset_ijk=(0, 0, 0), size_ijk=(2, 2, 2), data=block.tobytes(), prefix="mh_"),
        provenance=Provenance(source="model", module_version="x@1"),
        structure_set_id=tset["structure_set_id"],
    )
    case.structures[st.key] = st
    return st


def test_every_read_entry_hides_others_transient(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("admin", PW)
        admin.create_user("alice", PW, "contourer")
        admin.create_user("bob", PW, "contourer")
        alice, bob = Session(client=admin._client), Session(client=admin._client)
        alice.login("alice", PW)
        bob.login("bob", PW)
        oa = alice.load_case(_selection(synth))
        bob.load_case(_selection(synth))
        admin.load_case(_selection(synth))
        rt = admin._app.state.rtgaia
        case = rt.store.get(oa["session_id"]).case
        tid = "pl_private_000"
        st = _inject_transient(rt, case, "alice", tid)
        vid = st.head.version_id

        # 擁有者：全部 200
        assert alice.mask(tid)[0]["structure_id"] == tid
        assert alice.mesh(tid)[0]["structure_id"] == tid
        assert alice.versions(tid)["head_version_id"] == vid
        assert alice.version_mask(tid, vid)[0]["content_hash"] == st.content_hash
        assert alice.dvh(synth.plan_dose_uid, [tid])["structures"][0]["structure_id"] == tid
        assert tid in [e["structure_id"] for e in alice.structures()]

        # 另一位 contourer：每個入口 404（不是 403 —— 不洩漏存在性）
        for call in (
            lambda: bob.mask(tid),
            lambda: bob.mesh(tid),
            lambda: bob.versions(tid),
            lambda: bob.version_mask(tid, vid),
            lambda: bob.dvh(synth.plan_dose_uid, [tid]),
        ):
            with pytest.raises(RuntimeError, match="404") as exc:
                call()
            assert "NO_STRUCTURE" in str(exc.value)
        assert tid not in [e["structure_id"] for e in bob.structures()]
        # 匯出與 3D 出圖：指定別人的暫存結構 → 404，不會建 job／不會出圖
        with pytest.raises(RuntimeError, match="404"):
            bob._post(f"/api/v1/studies/{bob.study_id}/export", {"format": "rtstruct", "structure_ids": [tid]})
        assert not [j for j in bob._get("/api/v1/jobs", case_id=oa["case_id"]) if tid in str(j.get("request"))]
        with pytest.raises(RuntimeError, match="404"):
            bob.render3d(
                layers=[
                    {"renderer": "mask-3d", "kind": "mask", "contentRef": tid, "structure_id": tid, "opacity": 1.0}
                ],
                technique="mip",
            )

        # admin 也看不到別人的暫存結果（暫存是個人工作台，與 structure_list／can_edit 的既有立場一致）
        with pytest.raises(RuntimeError, match="404"):
            admin.mesh(tid)


def test_websocket_rejects_other_users_session(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("admin", PW)
        admin.create_user("alice", PW, "contourer")
        admin.create_user("bob", PW, "contourer")
        alice, bob = Session(client=admin._client), Session(client=admin._client)
        alice_token = alice.login("alice", PW)["token"]
        bob_token = bob.login("bob", PW)["token"]
        oa = alice.load_case(_selection(synth))
        bob.load_case(_selection(synth))
        rt = admin._app.state.rtgaia
        case = rt.store.get(oa["session_id"]).case
        _inject_transient(rt, case, "alice", "pl_private_001")

        client = admin._client
        client.cookies.clear()
        # Bob 連 Alice 的 session → 4403，一則訊息都收不到
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/api/v1/session/{oa['session_id']}/events?token={bob_token}"):
                pass
        assert exc.value.code == 4403
        # Alice 自己連 → scene.replace 含她的暫存 mask layer
        with client.websocket_connect(f"/api/v1/session/{oa['session_id']}/events?token={alice_token}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "scene.replace"
            refs = [x["contentRef"] for x in msg["payload"]["layers"] if x["kind"] == "mask"]
            assert "pl_private_001" in refs
        # Bob 連自己的 current → 正常，且 scene 裡沒有 Alice 的暫存
        with client.websocket_connect(f"/api/v1/session/current/events?token={bob_token}") as ws:
            msg = ws.receive_json()
            refs = [x["contentRef"] for x in msg["payload"]["layers"] if x["kind"] == "mask"]
            assert "pl_private_001" not in refs
        # HTTP 拿場景（推送太大時前端走這條）：同一條規則 —— Bob 拿 Alice 的 403、Alice 自己的有她的暫存
        r = client.get(f"/api/v1/sessions/{oa['session_id']}/scene", headers={"Authorization": f"Bearer {bob_token}"})
        assert r.status_code == 403 and r.json()["detail"]["code"] == "NOT_OWNER"
        r = client.get(f"/api/v1/sessions/{oa['session_id']}/scene", headers={"Authorization": f"Bearer {alice_token}"})
        assert r.status_code == 200
        assert "pl_private_001" in [x["contentRef"] for x in r.json()["layers"] if x["kind"] == "mask"]
        # 沒登入 → 4401（既有行為不回歸）
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/api/v1/session/{oa['session_id']}/events"):
                pass
        assert exc.value.code == 4401


def test_websocket_account_policy_matches_http_and_revokes_live_connections(db_url: str, synth: SynthCase) -> None:
    """WS 以前只在連線當下驗 token —— 被要求改密碼的帳號照樣收得到業務推送，連上之後被停用
    或改密碼也不會斷。現在跟 HTTP 同一套政策，而且帳號一變動（`invalidate_principal`）開著的連線立刻重驗。"""
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("admin", PW)
        carol_id = admin.create_user("carol", PW, "contourer", must_change_password=True)["user_id"]
        dave_id = admin.create_user("dave", PW, "contourer")["user_id"]
        carol, dave = Session(client=admin._client), Session(client=admin._client)
        carol_token = carol.login("carol", PW)["token"]
        dave_token = dave.login("dave", PW)["token"]
        od = dave.load_case(_selection(synth))
        client = admin._client
        client.cookies.clear()

        # 1) 被要求改密碼 → 4403（HTTP 只放行帳號 API，業務推送也一樣不給）
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/api/v1/session/current/events?token={carol_token}"):
                pass
        assert exc.value.code == 4403
        assert carol_id

        # 2) dave 連著 → 管理者停用 dave → 這條連線立刻被關（4401），不用等 60 秒快取或重驗週期
        with client.websocket_connect(f"/api/v1/session/{od['session_id']}/events?token={dave_token}") as ws:
            assert ws.receive_json()["type"] == "scene.replace"
            _patch_user(admin, dave_id, {"disabled": True})
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4401
        # 停用後重連 → 4401
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/api/v1/session/{od['session_id']}/events?token={dave_token}"):
                pass
        assert exc.value.code == 4401

        # 3) 管理者重設密碼（對方要改密碼）→ 舊 token 的連線被關
        _patch_user(admin, dave_id, {"disabled": False})
        dave_token = dave.login("dave", PW)["token"]
        od = dave.load_case(_selection(synth))
        client.cookies.clear()
        with client.websocket_connect(f"/api/v1/session/{od['session_id']}/events?token={dave_token}") as ws:
            assert ws.receive_json()["type"] == "scene.replace"
            _patch_user(admin, dave_id, {"password": "another-long-password-9"})
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code in (4401, 4403)


def _patch_user(admin: Session, user_id: str, body: dict) -> None:  # type: ignore[type-arg]
    r = admin._client.patch(f"/api/v1/auth/users/{user_id}", json=body, headers=admin._headers)
    assert r.status_code == 200, r.text
