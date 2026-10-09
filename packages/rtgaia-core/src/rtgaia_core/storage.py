"""本機磁碟的容量提醒與完整性巡檢。

前提：只有本機磁碟、原則上不自動刪除但容量超過 90% 要提醒、
PACS 不一定是正本 → 我們要長期保存、搬移一律人工確認、90 天／1 年（等有 warm／cold 再用）、
還原速度等評估。
所以這一期不搬任何東西，只做兩件長期保存一定要的事：

1. **容量**：資料庫根目錄（DICOM）、blob（mask 版本、匯出）、快取所在的磁碟，使用率超過門檻
   （`RTGAIA_DISK_WARN_PERCENT`，預設 90）→ 所有登入者看得到的提醒、服務設定頁的明細、跨過門檻（與回落）各記一筆稽核。
   同一顆磁碟只列一次。
2. **完整性**：每個 DICOM 檔一筆位置紀錄（`storage_location`：路徑、SOP、層、sha256、大小、存入與驗證時間、結果）；
   背景巡檢每次挑最久沒驗的一批重算 sha256，缺檔或內容變了就報（稽核＋服務設定頁），
   管理者確認是合法變動可以「重設基準」。
   匯入的檔以內容定址（`blobs/<sha256>.dcm`）—— 檔名就是基準，第一次就驗得出來；其他檔第一次看到時記下當時的 sha256。

搬到 warm／cold、政策引擎、還原等有 NAS／物件儲存再做；這張表的 `tier` 欄就是為那時留的。
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_WARN_PERCENT = 90
DEFAULT_INTEGRITY_BATCH = 500
_SHA_NAME = re.compile(r"^([0-9a-f]{64})\.dcm$")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def warn_percent() -> int:
    """容量提醒門檻（%）：`RTGAIA_DISK_WARN_PERCENT`，50–99，壞值用預設 90。"""
    raw = os.environ.get("RTGAIA_DISK_WARN_PERCENT", "").strip()
    try:
        v = int(raw) if raw else DEFAULT_WARN_PERCENT
    except ValueError:
        return DEFAULT_WARN_PERCENT
    return min(99, max(50, v))


def integrity_batch() -> int:
    raw = os.environ.get("RTGAIA_INTEGRITY_BATCH", "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_INTEGRITY_BATCH
    except ValueError:
        return DEFAULT_INTEGRITY_BATCH


# ── 容量 ─────────────────────────────────────────────────────────────────────


def volumes(paths: dict[str, str | Path | None], *, threshold: int | None = None) -> list[dict[str, Any]]:
    """每顆磁碟一列（同一個檔案系統的多個用途合併成一列）：`labels`、`path`、`total`／`used`／`free`（bytes）、`percent`
    （與 `df` 同算法：used ÷ (used ＋ 一般使用者可用)）、`warn`。不存在的路徑往上找到存在的父目錄。"""
    limit = warn_percent() if threshold is None else threshold
    by_dev: dict[int, dict[str, Any]] = {}
    for label, raw in paths.items():
        if not raw:
            continue
        p = Path(raw).expanduser()
        while not p.exists() and p != p.parent:
            p = p.parent
        try:
            dev = p.stat().st_dev
            usage = shutil.disk_usage(p)
        except OSError:
            continue
        # shutil：used ＝ 真的用掉的（f_blocks − f_bfree）、free ＝ 一般使用者可用（f_bavail，不含保留給 root 的區塊）。
        # 與 df 的 Use% 同算法：used ÷ (used ＋ avail) —— 保留區塊不算用掉、也不算可用
        used = usage.used
        percent = round(100.0 * used / max(1, used + usage.free), 1)
        entry = by_dev.get(dev)
        if entry is None:
            by_dev[dev] = {
                "labels": [label],
                "path": str(p),
                "total": int(usage.total),
                "used": int(used),
                "free": int(usage.free),
                "percent": percent,
                "warn": percent >= limit,
            }
        else:
            entry["labels"].append(label)
    return list(by_dev.values())


class StorageMonitor:
    """定時量容量；跨過門檻與回落各回報一次（呼叫端寫稽核）。狀態放記憶體（重啟後重新量，第一次超過就再報一次）。"""

    def __init__(self) -> None:
        self.last: dict[str, Any] | None = None
        self._warned: set[str] = set()

    def check(self, paths: dict[str, str | Path | None]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """回 (狀態, 這次要寫的事件)。
        事件 `{action: 'storage.threshold_exceeded'|'storage.threshold_recovered', volume}`。"""
        threshold = warn_percent()
        vols = volumes(paths, threshold=threshold)
        events: list[dict[str, Any]] = []
        now_warn = {v["path"] for v in vols if v["warn"]}
        for v in vols:
            if v["warn"] and v["path"] not in self._warned:
                events.append({"action": "storage.threshold_exceeded", "volume": v})
            if not v["warn"] and v["path"] in self._warned:
                events.append({"action": "storage.threshold_recovered", "volume": v})
        self._warned = now_warn
        status = {"checked_at": _now(), "threshold": threshold, "volumes": vols, "warn": bool(now_warn)}
        self.last = status
        return status, events


# ── 完整性 ───────────────────────────────────────────────────────────────────


@dataclass
class Location:
    path: str
    sop_instance_uid: str = ""
    tier: str = "hot"
    sha256: str = ""
    size: int = 0
    stored_at: str = ""
    verified_at: str | None = None
    verify_status: str | None = None
    """None（還沒驗過）、`ok`、`missing`、`mismatch`、`retired`（已不在資料庫：移到暫存區或清掉了）。"""
    detail: str = ""

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def expected_from_name(path: str | Path) -> str | None:
    """內容定址的匯入檔（`blobs/<sha256>.dcm`）：檔名就是 sha256。"""
    m = _SHA_NAME.match(Path(path).name)
    return m.group(1) if m else None


class MemoryLocations:
    """沒有 DB 時的 `storage_location`（DB 實作 `rtgaia_server.db.storage_locations.DbLocations`）。"""

    def __init__(self) -> None:
        self.rows: dict[str, Location] = {}

    async def get_many(self, paths: list[str]) -> dict[str, Location]:
        return {p: self.rows[p] for p in paths if p in self.rows}

    async def put_many(self, rows: list[Location]) -> None:
        for r in rows:
            self.rows[r.path] = r

    async def all(self) -> list[Location]:
        return list(self.rows.values())


def verify_one(path: str, row: Location | None, sop_uid: str) -> Location:
    """驗一個檔：第一次看到 → 記基準（內容定址的以檔名為準，第一次就驗）；之後重算比對。"""
    now = _now()
    if row is None:
        row = Location(path=path, sop_instance_uid=sop_uid, stored_at=now)
    if not Path(path).exists():
        row.verify_status, row.detail, row.verified_at = "missing", "檔案不見了", now
        return row
    actual = sha256_file(path)
    row.size = Path(path).stat().st_size
    baseline = row.sha256 or expected_from_name(path)
    if not baseline:
        row.sha256, row.verify_status, row.detail, row.verified_at = actual, "ok", "第一次記錄基準", now
        return row
    row.sha256 = baseline
    if actual == baseline:
        row.verify_status, row.detail = "ok", ""
    else:
        row.verify_status, row.detail = "mismatch", f"內容與基準不同（現在 {actual[:12]}…，基準 {baseline[:12]}…）"
    row.verified_at = now
    return row


async def patrol(store: Any, files: list[tuple[str, str]], *, batch: int | None = None) -> dict[str, Any]:
    """巡檢一輪：`files` 是資料庫裡現有的 (路徑, SOP)。先挑沒驗過的、再挑最久沒驗的，最多 `batch` 個；
    不在 `files` 裡但表上還是 ok 的標 `retired`（移到暫存區或清掉了，不是遺失）。回這一輪的摘要與問題。"""
    limit = integrity_batch() if batch is None else batch
    current = {p: sop for p, sop in files}
    rows = {r.path: r for r in await store.all()}
    retired = [r for p, r in rows.items() if p not in current and r.verify_status != "retired"]
    for r in retired:
        r.verify_status, r.detail = "retired", "已不在資料庫（移到暫存區或已清除）"
    order = sorted(current, key=lambda p: (rows[p].verified_at or "") if p in rows else "")
    picked = order[:limit]
    checked = [verify_one(p, rows.get(p), current[p]) for p in picked]
    await store.put_many(checked + retired)
    problems = [r.to_wire() for r in checked if r.verify_status in ("missing", "mismatch")]
    return {
        "ran_at": _now(),
        "checked": len(checked),
        "total_files": len(current),
        "problems": problems,
        "retired": len(retired),
    }


async def integrity_summary(store: Any, files: list[tuple[str, str]]) -> dict[str, Any]:
    """服務設定頁：總數、驗過幾個、最舊的驗證時間、目前的問題清單。"""
    current = {p for p, _ in files}
    rows = [r for r in await store.all() if r.path in current]
    verified = [r for r in rows if r.verified_at]
    problems = [r.to_wire() for r in rows if r.verify_status in ("missing", "mismatch")]
    return {
        "total_files": len(current),
        "registered": len(rows),
        "verified": len(verified),
        "oldest_verified_at": min((r.verified_at for r in verified if r.verified_at), default=None),
        "problems": problems,
    }


async def rebaseline(store: Any, paths: list[str]) -> list[dict[str, Any]]:
    """管理者確認是合法變動：以現在的內容為新基準。不存在的檔不能重設。"""
    rows = await store.get_many(paths)
    out: list[Location] = []
    for p in paths:
        if not Path(p).exists():
            continue
        r = rows.get(p) or Location(path=p, stored_at=_now())
        r.sha256 = sha256_file(p)
        r.size = Path(p).stat().st_size
        r.verify_status, r.detail, r.verified_at = "ok", "管理者重設基準", _now()
        out.append(r)
    await store.put_many(out)
    return [r.to_wire() for r in out]
