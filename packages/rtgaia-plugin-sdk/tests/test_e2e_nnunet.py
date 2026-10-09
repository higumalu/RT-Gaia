"""nnU-Net plugin：local（fake 引擎）與 remote（轉發到 server.py）兩種模式都走完契約；面板端點的角色守門。"""

from __future__ import annotations

import os

import httpx
import pytest
from conftest import Served, load_plugin_app
from rtgaia_plugin_sdk.check import run_check

pytestmark = pytest.mark.e2e

ADMIN = {"X-RTGaia-Actor": "alice", "X-RTGaia-Role": "admin"}
CONTOURER = {"X-RTGaia-Actor": "bob", "X-RTGaia-Role": "contourer"}


@pytest.fixture
def nnunet(artifacts_dir, tmp_path):
    os.environ["RTGAIA_SEG_ENGINE"] = "fake"
    os.environ["RTGAIA_PLUGIN_DATA"] = str(tmp_path / "plugin-data")
    # engine／plugin 模組在 sys.modules 裡會快取；每個測試重新載入拿到乾淨的設定
    import sys

    for name in [n for n in sys.modules if n.startswith("example_plugin_nnunet") or n == "engine"]:
        del sys.modules[name]
    return load_plugin_app("plugin-nnunet")


def test_local_fake_all_and_subset(nnunet) -> None:
    with Served(nnunet) as s:
        labels = httpx.get(f"{s.url}/labels", headers=CONTOURER).json()
        assert {v["name"] for v in labels.values()} == {"Fake_Body", "Fake_Core"}
        report = run_check(s.url, timeout_s=60)
        assert report.ok, report.render()
        assert [a["name"] for a in report.accepted if a["kind"] == "structure"] == ["Fake_Body", "Fake_Core"]
        report = run_check(s.url, timeout_s=60, params={"structures": ["Fake_Core"]})
        assert report.ok, report.render()
        assert [a["name"] for a in report.accepted if a["kind"] == "structure"] == ["Fake_Core"]
        # 未知 ROI → job failed 帶說人話的原因
        report = run_check(s.url, timeout_s=60, params={"structures": ["Nope"]})
        assert not report.ok and report.done and "unknown structures" in (report.done.get("error") or "")


def test_settings_role_guard_and_validation(nnunet) -> None:
    with Served(nnunet) as s:
        assert httpx.get(f"{s.url}/settings").status_code == 403  # 沒經宿主
        assert httpx.patch(f"{s.url}/settings", json={"mode": "remote"}, headers=CONTOURER).status_code == 403
        r = httpx.patch(
            f"{s.url}/settings", json={"mode": "remote", "remote_url": "gpu-box", "remote_port": 8710}, headers=ADMIN
        )
        assert r.status_code == 422
        r = httpx.patch(
            f"{s.url}/settings",
            json={"mode": "remote", "remote_url": "http://127.0.0.1", "remote_port": 1, "remote_token": "t"},
            headers=ADMIN,
        )
        assert r.status_code == 200 and r.json()["mode"] == "remote" and r.json()["remote_token_set"] is True
        assert "remote_token" not in r.json()
        assert httpx.get(f"{s.url}/settings", headers=CONTOURER).json()["remote_port"] == 1
        health = httpx.post(f"{s.url}/remote/health", headers=CONTOURER).json()
        assert health["ok"] is False


def test_remote_mode_forwards_to_server(nnunet, tmp_path) -> None:
    os.environ["RTGAIA_SEG_REMOTE_TOKEN"] = "secret"
    server = load_plugin_app("plugin-nnunet", module="server")
    with Served(server) as remote, Served(nnunet) as s:
        patch = {
            "mode": "remote",
            "remote_url": "http://127.0.0.1",
            "remote_port": remote.port,
            "remote_token": "secret",
        }
        assert httpx.patch(f"{s.url}/settings", json=patch, headers=ADMIN).status_code == 200
        health = httpx.post(f"{s.url}/remote/health", headers=CONTOURER).json()
        assert health["ok"] is True and health["engine"] == "fake"
        labels = httpx.get(f"{s.url}/labels", headers=CONTOURER).json()
        assert "Fake_Body" in {v["name"] for v in labels.values()}
        report = run_check(s.url, timeout_s=120, params={"structures": ["Fake_Body"]})
        assert report.ok, report.render()
        assert [a["name"] for a in report.accepted if a["kind"] == "structure"] == ["Fake_Body"]
        assert report.audits and report.audits[0]["payload"]["mode"] == "remote"
    os.environ.pop("RTGAIA_SEG_REMOTE_TOKEN", None)
