"""套件拆層：依賴方向只有一個 —— server → core ← testbe。

* `rtgaia_core` 的原始碼不得 import `rtgaia_server`／`rtgaia_testbe`，也不得 import 任何 SQLAlchemy／Alembic／asyncpg。
* `rtgaia_server` 不得 import `rtgaia_testbe`。
* `rtgaia_testbe` 的原始碼不得直接用 pydicom／SimpleITK／vtk（那些是產品邏輯，在 core）。
* `rtgaia_server.app.create_app()` **永遠**不掛 `/api/v1/_test/*`，就算環境變數 `RTGAIA_TEST_API=1`。
"""

from __future__ import annotations

import re
from pathlib import Path

import rtgaia_core
import rtgaia_server
import rtgaia_testbe

CORE = Path(rtgaia_core.__file__).parent
SERVER = Path(rtgaia_server.__file__).parent
TESTBE = Path(rtgaia_testbe.__file__).parent

IMPORT = re.compile(r"^\s*(?:from|import)\s+([a-zA-Z_][\w.]*)", re.M)


def _imports(root: Path) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for p in root.rglob("*.py"):
        mods = {m.split(".")[0] for m in IMPORT.findall(p.read_text(encoding="utf-8"))}
        out[str(p.relative_to(root))] = mods
    return out


def test_core_imports_no_server_no_testbe_no_sql() -> None:
    bad = {
        f: m & {"rtgaia_server", "rtgaia_testbe", "sqlalchemy", "alembic", "asyncpg"} for f, m in _imports(CORE).items()
    }
    assert {f: m for f, m in bad.items() if m} == {}


def test_server_imports_no_testbe() -> None:
    bad = {f: m & {"rtgaia_testbe"} for f, m in _imports(SERVER).items()}
    assert {f: m for f, m in bad.items() if m} == {}


def test_testbe_source_has_no_dicom_or_vtk() -> None:
    bad = {f: m & {"pydicom", "SimpleITK", "vtk"} for f, m in _imports(TESTBE).items() if not f.startswith("fixtures")}
    assert {f: m for f, m in bad.items() if m} == {}


def test_server_app_never_mounts_test_api(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_TEST_API", "1")
    monkeypatch.setenv("RTGAIA_DB_URL", "")
    from rtgaia_server.app import create_app

    app = create_app()
    assert not any(p.startswith("/api/v1/_test") for p in app.openapi()["paths"])
    # testbe 的 create_app 同一個環境變數 → 有
    from rtgaia_testbe.app import create_app as testbe_create_app

    assert any(p.startswith("/api/v1/_test") for p in testbe_create_app().openapi()["paths"])
