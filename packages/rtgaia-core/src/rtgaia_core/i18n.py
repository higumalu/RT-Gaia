"""多語系的後端那一半。

後端的訊息原文是繁中（錯誤、job 失敗原因、運算清單、服務設定頁的行程設定…）。前端每個 `/api/` 請求帶
`Accept-Language`（跟使用者選的介面語言），中介層放進 `current_lang`；**在 API 邊界翻**：

* HTTP 錯誤：`detail` 是字串、或 dict 的 `message`／`problems[]`（`api/__init__.py` 的例外處理）
* 會回後端文字的端點自己呼叫 `translate` / `translate_fields`（`/ops`、`/settings`、`/export/profiles`、job 欄位）
* WebSocket 推的訊息：前端送 `POST /i18n/translate` 翻

不改各處的 `raise`：字典的 key 是**原文模板**（f-string 的運算式換成 `{name}`），查不到完全相同的就用模板比對
（`沒有節點 {node_id}` 比得到 `沒有節點 n_12`），比對到的參數值也遞迴翻（例：理由裡再嵌一句中文）。
查不到 → 原文（不會壞）。英文字典在 `i18n_en.py`；`tests/test_i18n_backend.py` 保證每條原文都有譯文。

請求沒說語言（沒帶 `Accept-Language`、帶的都不支援、或在請求以外）時是 `DEFAULT_LANG`：英文，
跟介面的預設一致（以前繁中）。直接打 API 的腳本、curl 拿到英文；要繁中就帶 `Accept-Language: zh-TW`。
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from functools import lru_cache
from typing import Any

DEFAULT_LANG = "en"
"""請求沒說語言時用的語言（模組層級、執行時才讀：測試把它設成繁中，見 `rtgaia-testbe/tests/conftest.py`）。"""

current_lang: ContextVar[str | None] = ContextVar("rtgaia_lang", default=None)
"""目前請求的語言（最外層中介層設）；讀的時候用 `request_lang()`。"""

_PLACEHOLDER = re.compile(r"\{(\w+)\}")
_CJK = re.compile(r"[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]")


def request_lang() -> str:
    """目前請求的語言；請求以外（WebSocket、背景工作）是 `DEFAULT_LANG`。"""
    return current_lang.get() or DEFAULT_LANG


def lang_from_header(value: str | None) -> str:
    """`Accept-Language` → `en` 或 `zh-TW`：依偏好（q 值，同分照順序）第一個支援的 —— `zh…` 繁中、`en…` 英文；
    沒給、`*`、或都不支援 → `DEFAULT_LANG`。例：`zh-TW,zh;q=0.9,en;q=0.8` → 繁中、`ja,en;q=0.5` → 英文。"""
    ranked: list[tuple[float, int, str]] = []
    for i, part in enumerate((value or "").split(",")):
        tag, *params = (x.strip() for x in part.split(";"))
        q = 1.0
        for param in params:
            key, _, number = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    q = float(number)
                except ValueError:
                    q = 0.0
        if q > 0:
            ranked.append((-q, i, tag.lower()))
    for _q, _i, tag in sorted(ranked):
        if tag == "zh" or tag.startswith("zh-"):
            return "zh-TW"
        if tag == "en" or tag.startswith("en-"):
            return "en"
    return DEFAULT_LANG


def _catalog() -> dict[str, str]:
    from .i18n_en import EN

    return EN


@lru_cache(maxsize=1)
def _templates() -> list[tuple[re.Pattern[str], str, list[str]]]:
    """有佔位符的原文 → 比對用的正規式（長的先比，避免短模板吃掉長訊息）。"""
    out = []
    for source, target in _catalog().items():
        names = _PLACEHOLDER.findall(source)
        if not names:
            continue
        parts = _PLACEHOLDER.split(source)
        # 只由佔位符組成（`{p0}{p1}`）會比中任何字串、而且遞迴翻不完；字面部分沒有中文的也不需要翻 → 都不進模板比對
        if not _CJK.search("".join(parts[0::2])):
            continue
        pattern = ""
        for i, part in enumerate(parts):
            pattern += re.escape(part) if i % 2 == 0 else f"(?P<{part}>.*?)"
        try:
            out.append((re.compile(f"^{pattern}$", re.DOTALL), target, names))
        except re.error:  # 同名佔位符出現兩次之類：這條只能靠完全相同比對
            continue
    out.sort(key=lambda x: -len(x[0].pattern))
    return out


def _fill(target: str, values: dict[str, str], lang: str) -> str:
    return _PLACEHOLDER.sub(lambda m: translate(values.get(m.group(1), m.group(0)), lang), target)


def translate(text: str, lang: str | None = None) -> str:
    """把一段後端原文翻成 `lang`（預設目前請求的語言）；繁中或查不到就原樣。"""
    lang = lang or request_lang()
    if lang == "zh-TW" or not isinstance(text, str) or not text:
        return text
    catalog = _catalog()
    # `str(KeyError("…"))` 會帶引號，不少路由把它原樣放進 message
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"" and text[0] not in text[1:-1]:
        inner = translate(text[1:-1], lang)
        if inner != text[1:-1]:
            return inner
    exact = catalog.get(text)
    if exact is not None:
        return exact
    for pattern, target, _names in _templates():
        m = pattern.match(text)
        if m:
            return _fill(target, m.groupdict(), lang)
    return text


def translate_fields(obj: Any, fields: frozenset[str] | set[str], lang: str | None = None) -> Any:
    """遞迴翻 dict／list 裡**指定欄位名**的字串值（其他欄位 —— 特別是 DICOM 內容 —— 不碰）。"""
    lang = lang or request_lang()
    if lang == "zh-TW":
        return obj
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k in fields and isinstance(v, str):
                out[k] = translate(v, lang)
            elif k in fields and isinstance(v, list) and all(isinstance(x, str) for x in v):
                out[k] = [translate(x, lang) for x in v]
            else:
                out[k] = translate_fields(v, fields, lang)
        return out
    if isinstance(obj, list):
        return [translate_fields(v, fields, lang) for v in obj]
    return obj


def translate_detail(detail: Any, lang: str | None = None) -> Any:
    """HTTPException 的 `detail`：字串整段翻；dict 翻 `message`、`reason`、`problems[]`。"""
    lang = lang or request_lang()
    if lang == "zh-TW":
        return detail
    if isinstance(detail, str):
        return translate(detail, lang)
    if isinstance(detail, dict):
        out = dict(detail)
        for key in ("message", "reason", "hint"):
            if isinstance(out.get(key), str):
                out[key] = translate(out[key], lang)
        if isinstance(out.get("problems"), list):
            out["problems"] = [translate(p, lang) if isinstance(p, str) else p for p in out["problems"]]
        return out
    return detail


# `warnings`：開病例（`POST /sessions`）與資料頁 4D 組的警告 —— 以前沒翻，英文介面整句中文
MESSAGE_FIELDS = frozenset(
    {"error", "message", "reason", "hint", "anonymize_forced_reason", "scp_error", "detail", "decode_error", "warnings"}
)
"""回應裡「是後端寫的句子」的欄位名（不含 label／name 這種可能是 DICOM 內容的欄位）。"""


def localized_route_class() -> type:
    """給 router 用的 `route_class`：JSON 回應裡 `MESSAGE_FIELDS` 的值依請求語言翻（繁中時不動、零成本）。"""
    import json

    from fastapi.routing import APIRoute
    from starlette.responses import Response

    class LocalizedRoute(APIRoute):
        def get_route_handler(self):  # type: ignore[no-untyped-def]
            original = super().get_route_handler()

            async def handler(request):  # type: ignore[no-untyped-def]
                response: Response = await original(request)
                if request_lang() == "zh-TW" or response.media_type != "application/json":
                    return response
                try:
                    data = json.loads(bytes(response.body))
                except (ValueError, AttributeError):
                    return response
                # 改原本的回應、不另建一個：另建會丟掉 `background`（匯入管線就是 BackgroundTasks —— 以前英文介面上傳
                # 永遠停在 open）與重複的標頭（多個 Set-Cookie）
                body = json.dumps(translate_fields(data, MESSAGE_FIELDS), ensure_ascii=False).encode("utf-8")
                response.body = body
                response.headers["content-length"] = str(len(body))
                return response

            return handler

    return LocalizedRoute
