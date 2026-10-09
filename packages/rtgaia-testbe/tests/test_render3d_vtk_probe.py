"""VTK probe 的退路本身 —— **這個檔案不能有 skipif**。

它測的正是「這台機器畫不動時會怎樣」，而那在畫得動的機器上也要能測。

🔴 背景：`_probe()` 原本在行程內跑 `rw.Render()`，而沒有 GL 裝置的機器上那行是
SIGSEGV 不是例外。症狀是 pytest 在 collect `test_render3d_vtk.py` 時整個行程以
exit 139 死掉（GitHub CI 因此紅了九天），以及後端收到第一個 `/render3d`
就被打死 ——「沒有 VTK 就退回 MIP」的退路等於不存在。
"""

from __future__ import annotations

from typing import Any

import pytest
from rtgaia_core import render3d_vtk


@pytest.fixture
def fresh_state() -> Any:
    """`_STATE` 是模組層快取；動過要還原，否則後面的 VTK 測試會拿到假的狀態。"""
    saved = dict(render3d_vtk._STATE)
    render3d_vtk._STATE.clear()
    render3d_vtk._STATE.update({"checked": False, "available": False, "gpu": False, "reason": None})
    yield render3d_vtk._STATE
    render3d_vtk._STATE.clear()
    render3d_vtk._STATE.update(saved)


@pytest.mark.parametrize(
    ("source", "expect_in_reason"),
    [
        ("import os, signal; os.kill(os.getpid(), signal.SIGSEGV)", "SIGSEGV"),
        ("import os, signal; os.kill(os.getpid(), signal.SIGABRT)", "SIGABRT"),
        ("raise SystemExit(3)", "exit 3"),
        ("import sys; sys.stdout.write('沒有標記的輸出')", "沒印出結果"),
        (f"import sys; sys.stdout.write({render3d_vtk.PROBE_MARKER!r} + 'not json')", "不是 JSON"),
    ],
)
def test_probe_child_death_always_means_unavailable(source: str, expect_in_reason: str) -> None:
    got = render3d_vtk.probe_subprocess(source)
    assert got["available"] is False
    assert got["gpu"] is False
    assert expect_in_reason in got["reason"]
    # 🔴 這一行本身就是斷言：主行程沒被子行程的 SIGSEGV 帶走。
    assert render3d_vtk.probe_subprocess("pass")["available"] is False


def test_probe_timeout_does_not_block_caller() -> None:
    got = render3d_vtk.probe_subprocess("import time; time.sleep(30)", timeout_s=0.5)
    assert got["available"] is False and "逾時" in got["reason"]


def test_probe_reads_back_child_result() -> None:
    source = (
        "import json, sys; "
        f"sys.stdout.write('VTK 的警告會混進來' + {render3d_vtk.PROBE_MARKER!r} + "
        "json.dumps({'available': True, 'gpu': True, 'window_class': 'vtkFakeRenderWindow'}))"
    )
    got = render3d_vtk.probe_subprocess(source)
    assert got == {"available": True, "gpu": True, "window_class": "vtkFakeRenderWindow"}


def test_disable_env_skips_the_child_entirely(fresh_state: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RTGAIA_DISABLE_VTK", "1")
    monkeypatch.setattr(
        render3d_vtk,
        "probe_subprocess",
        lambda *a, **k: pytest.fail("RTGAIA_DISABLE_VTK 設了還是起了子行程"),
    )
    assert render3d_vtk.available() is False
    assert render3d_vtk.gpu_available() is False
    assert render3d_vtk.status()["reason"] == "RTGAIA_DISABLE_VTK 已設"


@pytest.mark.parametrize("value", ["", "0"])
def test_disable_env_empty_or_zero_is_not_disabled(
    fresh_state: Any, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("RTGAIA_DISABLE_VTK", value)
    monkeypatch.setattr(render3d_vtk, "probe_subprocess", lambda *a, **k: {"available": True, "gpu": False})
    assert render3d_vtk.available() is True


def test_render3d_falls_back_to_mip_when_unavailable(
    fresh_state: Any, monkeypatch: pytest.MonkeyPatch, driver: Any
) -> None:
    """退路：`available()` False → 端點給 MIP 並在 header 標明，不是 500、更不是打死後端。"""
    monkeypatch.setattr(
        render3d_vtk,
        "probe_subprocess",
        lambda *a, **k: {"available": False, "gpu": False, "reason": "probe 子行程被 SIGSEGV 打死"},
    )
    driver.load("phantom:overlap_set")
    header, png = driver.render3d(output_size_px=(64, 64))
    assert header["technique_used"] == "mip"
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


class _FakeWindow:
    """假的離屏視窗 —— 場景的生命週期跟 VTK 裝不裝得起來無關，這幾條測試也就不該被 skip。"""

    def __init__(self) -> None:
        self.finalized = False

    def Finalize(self) -> None:  # noqa: N802  VTK 的命名
        self.finalized = True


def test_drop_session_finalizes_its_scene(driver: Any) -> None:
    """🔴 `drop_scene` 原本一直沒有任何呼叫端 —— 每個畫過 3D 的 session 都留著一個視窗。"""
    driver.load("phantom:landmark")
    first = driver.session_id
    window = _FakeWindow()
    render3d_vtk._SCENES[first] = render3d_vtk._Scene(rw=window, ren=object())

    driver.load("phantom:landmark")  # 同一個人、同一個 study → 舊 session 被汰除

    assert driver.session_id != first
    assert first not in render3d_vtk._SCENES
    assert window.finalized is True


def test_drop_scene_without_a_scene_does_not_wake_the_vtk_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    """大多數 session 沒畫過 3D；為它們喚醒 VTK 執行緒只會把 VTK 拉進不需要它的路徑。"""
    monkeypatch.setattr(render3d_vtk, "run_in_vtk_thread", lambda *a, **k: pytest.fail("沒有場景還是進了 VTK 執行緒"))
    render3d_vtk.drop_scene("sess_沒有這個")
    render3d_vtk.shutdown_scenes()


def test_app_shutdown_finalizes_remaining_scenes() -> None:
    """後端關機時剩下的場景要收掉 —— 不能留給直譯器解構（那會在錯的執行緒上碰 GLX context）。"""
    from rtgaia_testbe import Session

    window = _FakeWindow()
    with Session() as session:
        session.load("phantom:landmark")
        render3d_vtk._SCENES[session.session_id] = render3d_vtk._Scene(rw=window, ren=object())
    assert render3d_vtk._SCENES == {}
    assert window.finalized is True
