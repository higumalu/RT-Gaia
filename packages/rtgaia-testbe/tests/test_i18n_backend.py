"""多語系：後端訊息在 API 邊界依 `Accept-Language` 翻。

1. 防退步：`rtgaia_core`／`rtgaia_server`／`rtgaia_geom` 裡每個會在執行期出現的中文字串（字面值與 f-string 模板；
   docstring 與「單獨一行的字串」不算）在英文字典 `rtgaia_core.i18n_en.EN` 都有譯文，佔位符一致。
2. `translate`：完全相同、模板比對（含參數遞迴翻）、查不到退回原文、只由佔位符組成的模板不比對。
3. 端到端：`Accept-Language: en` 時 HTTP 錯誤、`/ops`、`/settings`、`/export/profiles` 是英文；繁中時不變。
4. 請求沒說語言 → 英文（`DEFAULT_LANG`；測試一律從繁中開始，見 `conftest.py`）；命令列說明、啟動訊息、日誌寫英文原文。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest
from rtgaia_core.i18n import lang_from_header, translate, translate_detail, translate_fields
from rtgaia_core.i18n_en import EN
from rtgaia_testbe import Session

ROOT = Path(__file__).resolve().parents[3]
SCANNED = [
    ROOT / "packages/rtgaia-core/src",
    ROOT / "packages/rtgaia-server/src",
    ROOT / "packages/rtgaia-geom/src",
]
CJK = re.compile(r"[㐀-鿿＀-￯　-〿]")
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _placeholder_name(expr: ast.expr, i: int, used: set[str]) -> str:
    base = expr.id if isinstance(expr, ast.Name) else expr.attr if isinstance(expr, ast.Attribute) else f"p{i}"
    name, k = base, 2
    while name in used:
        name, k = f"{base}{k}", k + 1
    used.add(name)
    return name


def backend_templates() -> dict[str, str]:
    """原文模板 → 第一次出現的位置。f-string 的運算式換成 `{name}`（變數名／屬性名，其他 `p{i}`）。"""
    out: dict[str, str] = {}
    for root in SCANNED:
        for path in sorted(root.rglob("*.py")):
            if "i18n_en.py" in path.name:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            standalone = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr)}
            # OpenAPI 文件用的說明（`Query(description=…)`、`FastAPI(description=…)`）不是介面文字
            for n in ast.walk(tree):
                if (
                    isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Name)
                    and n.func.id in ("Query", "Path", "FastAPI", "Field")
                ):
                    for kw in n.keywords:
                        if kw.arg in ("description", "title", "summary"):
                            standalone.add(id(kw.value))
                # 命令列說明（argparse `help=`）是 CLI 文件，不是介面文字
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "add_argument":
                    for kw in n.keywords:
                        if kw.arg == "help":
                            standalone.add(id(kw.value))
                # 子行程執行的程式碼（`*_SCRIPT`／`*_SOURCE`；中文只在它的註解裡）
                if isinstance(n, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id.endswith(("_SCRIPT", "_SOURCE")) for t in n.targets
                ):
                    standalone.add(id(n.value))
            in_fstring = {id(v) for n in ast.walk(tree) if isinstance(n, ast.JoinedStr) for v in n.values}
            for node in ast.walk(tree):
                where = f"{path.relative_to(ROOT)}:{getattr(node, 'lineno', 0)}"
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    if CJK.search(node.value) and id(node) not in standalone and id(node) not in in_fstring:
                        out.setdefault(node.value, where)
                elif isinstance(node, ast.JoinedStr) and id(node) not in standalone:
                    if not any(isinstance(v, ast.Constant) and CJK.search(v.value) for v in node.values):
                        continue
                    used: set[str] = set()
                    tpl, i = "", 0
                    for v in node.values:
                        if isinstance(v, ast.Constant):
                            tpl += v.value
                        else:
                            tpl += "{" + _placeholder_name(v.value, i, used) + "}"  # type: ignore[attr-defined]
                            i += 1
                    out.setdefault(tpl, where)
    return out


def test_every_backend_message_has_english() -> None:
    templates = backend_templates()
    missing = [f"{where} {src!r}" for src, where in templates.items() if src not in EN]
    assert missing == [], f"{len(missing)} 條沒有英文譯文"
    mismatch = [
        f"{src!r} → {EN[src]!r}"
        for src in templates
        if isinstance(EN.get(src), str) and sorted(PLACEHOLDER.findall(src)) != sorted(PLACEHOLDER.findall(EN[src]))
    ]
    assert mismatch == []


def test_translate_rules() -> None:
    assert lang_from_header("en-US,en;q=0.9") == "en" and lang_from_header("zh-TW") == "zh-TW"
    assert translate("沒有節點 n_1", "zh-TW") == "沒有節點 n_1"
    assert translate("沒有節點 n_1", "en") == "No node n_1"
    # 參數值本身是一句中文 → 也翻
    assert translate("未註冊的運算 x。可用：a, b", "en") == "Unregistered operation x. Available: a, b"
    # 查不到 → 原文；只由佔位符組成的模板不比對（否則什麼都比中、還會無窮遞迴）
    assert translate("完全沒有這一句", "en") == "完全沒有這一句"
    assert translate_detail({"code": "X", "message": "沒有節點 n_2", "problems": ["port 必須是整數"]}, "en") == {
        "code": "X",
        "message": "No node n_2",
        "problems": ["port must be an integer"],
    }
    # 只翻指定欄位（label／name 可能是 DICOM 內容，不碰）
    data = {"error": "沒有節點 n_3", "label": "沒有節點 n_3", "items": [{"reason": "非 ASCII 字元"}]}
    assert translate_fields(data, frozenset({"error", "reason"}), "en") == {
        "error": "No node n_3",
        "label": "沒有節點 n_3",
        "items": [{"reason": "non-ASCII characters"}],
    }


def test_case_warnings_are_translated() -> None:
    """開病例回的 `warnings`（例：PET 切片間距不完全均勻）在英文介面要是英文 —— 以前整句中文。"""
    from rtgaia_core.i18n import MESSAGE_FIELDS

    raw = (
        "影像「FDG 3D SUV OSEM」：切片間距不完全均勻（間距 3.270 mm，最大偏差 0.080 mm、位置最多差 0.040 mm），"
        "在容許值內，以等距網格載入"
    )
    out = translate_fields({"session_id": "s", "warnings": [raw]}, MESSAGE_FIELDS, "en")
    assert out["warnings"] == [
        'Image "FDG 3D SUV OSEM": Slice spacing is not perfectly uniform (spacing 3.270 mm, '
        "largest deviation 0.080 mm, positions off by up to 0.040 mm); "
        "within tolerance, loaded on an evenly spaced grid"
    ]
    assert translate_fields({"warnings": [raw]}, MESSAGE_FIELDS, "zh-TW")["warnings"] == [raw]


def test_default_copy_name_follows_accept_language(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """複製的預設名稱存進 DB、會匯出到 RTSTRUCT —— 跟介面語言（以前英文介面也存成「X 複本」）。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="qa") as s:
        s.load("phantom:overlap_set")
        src = s.structures()[0]
        en = {**s._headers, "Accept-Language": "en"}
        copied_en = s._client.post(f"/api/v1/structures/{src['structure_id']}/copy", json={}, headers=en).json()
        copied_zh = s._client.post(f"/api/v1/structures/{src['structure_id']}/copy", json={}, headers=s._headers).json()
        names = {st["structure_id"]: st["name"] for st in s.structures()}
        assert names[copied_en["structure_id"]] == f"{src['name']} copy"
        assert names[copied_zh["structure_id"]] == f"{src['name']} 複本"


def test_api_messages_follow_accept_language(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="qa") as s:
        s.load("phantom:overlap_set")
        en = {**s._headers, "Accept-Language": "en"}
        # HTTP 錯誤（HTTPException detail）
        r = s._client.post("/api/v1/dimse/nodes/node_nope/echo", headers=en)
        zh = s._client.post("/api/v1/dimse/nodes/node_nope/echo", headers=s._headers)
        assert r.status_code == 404 and zh.status_code == 404
        assert r.json()["detail"]["message"] == "No node node_nope"
        assert zh.json()["detail"]["message"].strip("'") == "沒有節點 node_nope"  # 繁中：原樣（KeyError 帶引號）
        # /ops：運算名稱與參數標題
        ops_en = {o["op"]: o for o in s._client.get("/api/v1/ops", headers=en).json()}
        ops_zh = {o["op"]: o for o in s._client.get("/api/v1/ops", headers=s._headers).json()}
        assert ops_en["fill_holes"]["label"] == "Fill holes" and ops_zh["fill_holes"]["label"] == "填洞"
        assert ops_en["fill_holes"]["params_schema"]["properties"]["per_slice"]["title"] == "Per slice (2D)"
        assert not any(CJK.search(str(o["label"]) + str(o["description"])) for o in ops_en.values())
        # /export/profiles
        prof = s._client.get("/api/v1/export/profiles", headers=en).json()
        assert {p["label"] for p in prof["profiles"]} == {"Varian Eclipse", "Generic (UTF-8, names not truncated)"}
        assert not CJK.search(prof["uid_root"])
        # 422 的 problems／message（匯出標籤驗證）
        bad = s._client.post(
            f"/api/v1/studies/{s.study_id}/export",
            json={"format": "rtstruct", "tags": {"PatientSex": "X"}},
            headers=en,
        )
        assert bad.status_code == 422 and not CJK.search(bad.json()["detail"]["message"])


def test_default_language_is_english(
    shipped_default_lang: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """請求沒說要哪種語言（curl、腳本、plugin 回呼）→ 英文，跟介面的預設一致；以前是繁中。"""
    assert shipped_default_lang == "en"
    assert lang_from_header(None) == "en" and lang_from_header("") == "en" and lang_from_header("*") == "en"
    assert lang_from_header("ja,ko;q=0.8") == "en"  # 都不支援
    assert lang_from_header("zh-TW,zh;q=0.9,en;q=0.8") == "zh-TW" and lang_from_header("zh-CN") == "zh-TW"
    assert lang_from_header("ja,zh-TW;q=0.9,en;q=0.8") == "zh-TW"  # 第一個支援的
    assert lang_from_header("en;q=0.5, zh-TW;q=0.9") == "zh-TW"  # 照 q 值，不是照順序
    assert lang_from_header("zh-TW;q=0, en") == "en"  # q=0 是「不要」
    assert translate("沒有節點 n_1") == "No node n_1"  # 請求以外也是預設語言
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="qa") as s:
        s.load("phantom:overlap_set")
        assert "Accept-Language" not in s._headers
        r = s._client.post("/api/v1/dimse/nodes/node_nope/echo", headers=s._headers)
        assert r.status_code == 404 and r.json()["detail"]["message"] == "No node node_nope"
        ops = {o["op"]: o for o in s._client.get("/api/v1/ops", headers=s._headers).json()}
        assert ops["fill_holes"]["label"] == "Fill holes"
        zh = s._client.post(
            "/api/v1/dimse/nodes/node_nope/echo", headers={**s._headers, "Accept-Language": "zh-TW,en;q=0.5"}
        )
        assert zh.json()["detail"]["message"].strip("'") == "沒有節點 node_nope"


def test_command_line_and_log_text_is_english() -> None:
    """命令列說明、啟動訊息、日誌是給管理者看的，寫英文原文、不翻 —— 以前是中文。"""
    from rtgaia_server.cli import build_parser

    for parser in (build_parser(), build_parser(prog="rtgaia-testbe", test_api=True)):
        assert not CJK.search(parser.format_help())
    loggers = {"log", "logger", "_log", "LOG", "logging"}
    found = []
    for root in SCANNED:
        for path in sorted(root.rglob("*.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not isinstance(node, ast.Call):
                    continue
                f = node.func
                is_log = isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in loggers
                is_cli = (isinstance(f, ast.Name) and f.id in ("print", "SystemExit", "ArgumentParser")) or (
                    isinstance(f, ast.Attribute) and f.attr in ("add_argument", "ArgumentParser")
                )
                if (is_log or is_cli) and any(
                    isinstance(n, ast.Constant) and isinstance(n.value, str) and CJK.search(n.value)
                    for n in ast.walk(node)
                ):
                    found.append(f"{path.relative_to(ROOT)}:{node.lineno}")
    assert found == []
