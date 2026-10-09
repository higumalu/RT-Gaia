"""資源上限與 CPU 工作的併發預算。

所有上限都可用環境變數覆寫，而且**在呼叫時讀**（不是 import 時）——測試以 monkeypatch 設小額配額來驗
「拒絕發生在配置／解碼之前」，不必真的耗盡記憶體。院內大 study 只要調設定，不必改程式。

| 環境變數 | 預設 | 用在 |
|---|---|---|
| `RTGAIA_IMPORT_BODY_MAX_BYTES` | 4 GiB（＝ nginx 上限） | `PUT /import/batches/{id}/files` 串流累計 |
| `RTGAIA_ZIP_TOTAL_MAX_BYTES` | 8 GiB | zip 展開總量（宣告值 ＋ 實讀） |
| `RTGAIA_ZIP_MEMBERS_MAX` | 50,000 | zip 成員數 |
| `RTGAIA_ZIP_RATIO_MAX` | 200 | 展開／壓縮比（zip bomb） |
| `RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES` | 2 GiB | plugin 結果單一 artifact 下載（邊讀邊累計） |
| `RTGAIA_RENDER_PIXEL_BUDGET` | 64,000,000 | 重切 `w×h`、3D 出圖 `w×h×layers` |
| `RTGAIA_CPU_WORKERS` | min(4, CPU 數) | 重切／3D／DVH 等 CPU 工作同時進行數 |
| `RTGAIA_PASSWORD_WORKERS` | 2 | Argon2 雜湊／驗證同時進行數（登入、改密碼） |
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, TypeVar

T = TypeVar("T")

GIB = 1024**3

# ── 識別碼的長度（毒丸列）──────────────────────────────────────
# 病例寫回 DB 是整份快照：一列超過欄寬就整個交易失敗，之後這個病例的每一次寫回都失敗、改的東西都存不進去。
# 欄寬以 `rtgaia_server/db/models.py` 為準；使用者給的值在入口驗（422），程式衍生的值用 `fit_id` 截斷。
STRUCTURE_ID_MAX = 128
MEASUREMENT_ID_MAX = 64
CLIENT_ID_MAX = 64
USERNAME_MAX = 64
SETTING_KEY_MAX = 64


def fit_id(value: str, max_len: int) -> str:
    """程式衍生的識別碼（由名稱、來源 id 組出來的）放得進 `max_len`：太長就截斷 ＋ 原值的雜湊（仍然唯一、可重現）。"""
    if len(value) <= max_len:
        return value
    import hashlib

    tail = hashlib.sha1(value.encode("utf-8")).hexdigest()[:8]
    return f"{value[: max_len - len(tail) - 1]}_{tail}"


DEFAULTS: dict[str, int] = {
    "RTGAIA_IMPORT_BODY_MAX_BYTES": 4 * GIB,
    "RTGAIA_ZIP_TOTAL_MAX_BYTES": 8 * GIB,
    "RTGAIA_ZIP_MEMBERS_MAX": 50_000,
    "RTGAIA_ZIP_RATIO_MAX": 200,
    "RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES": 2 * GIB,
    "RTGAIA_RENDER_PIXEL_BUDGET": 64_000_000,
    "RTGAIA_CPU_WORKERS": max(1, min(4, os.cpu_count() or 1)),
    "RTGAIA_PASSWORD_WORKERS": 2,
}


def limit(name: str) -> int:
    """讀一個上限；環境變數壞值（非整數、負數）退回預設，不讓設定錯誤變成「沒有上限」。"""
    raw = os.environ.get(name, "").strip()
    if raw:
        try:
            value = int(float(raw))
            if value > 0:
                return value
        except ValueError:
            pass
    return DEFAULTS[name]


class LimitExceeded(ValueError):
    """超過上限。`code` 給 HTTP 層轉成 413／422；`limit` 與 `actual` 給訊息。"""

    def __init__(self, code: str, message: str, *, limit: int, actual: int | None = None) -> None:
        super().__init__(message)
        self.code, self.limit, self.actual = code, limit, actual

    def to_wire(self) -> dict[str, object]:
        out: dict[str, object] = {"code": self.code, "message": str(self), "limit": self.limit}
        if self.actual is not None:
            out["actual"] = self.actual
        return out


# ── CPU 工作的併發預算 ─────────────────────────────────────────────────────────
#
# 🔴 asyncio 的 Semaphore 在第一次真的要等待時綁到當時的 event loop；TestClient 每個 context 是自己的 loop，
# 模組層一把鎖會在第二個 loop 炸「bound to a different event loop」。因此按 loop 各給一把。
_semaphores: dict[tuple[int, str], asyncio.Semaphore] = {}


def _semaphore(name: str = "RTGAIA_CPU_WORKERS") -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    key = (id(loop), name)
    sem = _semaphores.get(key)
    if sem is None:
        sem = asyncio.Semaphore(limit(name))
        _semaphores[key] = sem
        if len(_semaphores) > 64:  # 測試會開很多 loop；不讓字典無限長
            for k in list(_semaphores)[:-16]:
                _semaphores.pop(k, None)
    return sem


@asynccontextmanager
async def cpu_slot() -> AsyncIterator[None]:
    """`async with cpu_slot(): await asyncio.to_thread(...)` —— 超過預算的請求排隊等，不擠爆執行緒池。"""
    sem = _semaphore()
    await sem.acquire()
    try:
        yield
    finally:
        sem.release()


async def run_cpu(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """在 CPU 預算內把 `fn` 丟到執行緒跑。

    跟 `async with cpu_slot(): await asyncio.to_thread(...)` 的差別：HTTP 被取消時，`to_thread` 的執行緒**還在跑**，
    但 `cpu_slot` 的名額已經隨 `finally` 還回去 —— 預算形同虛設。這裡名額在**執行緒真的結束**時才還；
    等待被取消只是不再等結果（`shield`），不會提早放出名額。
    """
    return await _run_bounded("RTGAIA_CPU_WORKERS", fn, *args, **kwargs)


async def run_password(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Argon2 雜湊／驗證：以前在 async 方法裡同步算，一次登入卡住整個 event loop
    （其他人的影像、WS 一起等）。獨立的小預算（`RTGAIA_PASSWORD_WORKERS`），不跟重切搶名額。"""
    return await _run_bounded("RTGAIA_PASSWORD_WORKERS", fn, *args, **kwargs)


async def _run_bounded(name: str, fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    sem = _semaphore(name)
    await sem.acquire()
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()
    fut = loop.run_in_executor(None, functools.partial(ctx.run, fn, *args, **kwargs))
    fut.add_done_callback(lambda _f: sem.release())
    return await asyncio.shield(fut)
