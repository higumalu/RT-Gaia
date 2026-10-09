"""保留政策。

* **資料庫裡還在的東西全部保留**（版本鏈、簽核事件、稽核都不自動清）。
* **刪除 → 暫存區**：`RTGAIA_TRASH_DAYS`（預設 14）天後自動永久清除，期間可救回或手動清除。
  結構（`structure.deleted_at`）與資料頁移除的 DICOM 檔（`<library>/.rtgaia/trash/`）都是。
* **已簽核的被刪 → 封存區**：不自動清；只有管理者能看、改備註、救回、永久刪除（`#/archive`）。

這裡放與 DB 無關的部分：天數、截止時間、檔案垃圾桶、定時清理。結構的 SQL 在 `rtgaia_server.db.cases.CaseStore`。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .library.trash import TRASH_DIR

log = logging.getLogger(__name__)

DEFAULT_TRASH_DAYS = 14


def trash_days() -> int:
    raw = os.environ.get("RTGAIA_TRASH_DAYS", "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_TRASH_DAYS
    except ValueError:
        return DEFAULT_TRASH_DAYS


def _now() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime) -> str:
    """與 `Case.updated_at` 同格式（秒、+00:00），字串比較就是時間比較。"""
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def cutoff_iso(now: datetime | None = None, days: int | None = None) -> str:
    return iso((now or _now()) - timedelta(days=days if days is not None else trash_days()))


def expires_at(deleted_at: str | None, days: int | None = None) -> str | None:
    if not deleted_at:
        return None
    try:
        return iso(datetime.fromisoformat(deleted_at) + timedelta(days=days if days is not None else trash_days()))
    except ValueError:
        return None


# ── 資料頁移除的 DICOM（檔案垃圾桶） ───────────────────────────────────────


def library_trash_items(root: str | Path) -> list[dict[str, Any]]:
    base = Path(root) / TRASH_DIR
    if not base.is_dir():
        return []
    out = []
    for d in sorted(base.iterdir(), reverse=True):
        mf = d / "manifest.json"
        if not d.is_dir() or not mf.exists():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append(
            {
                "item_id": d.name,
                "level": m.get("level"),
                "key": m.get("key"),
                "series_uids": m.get("series_uids") or [],
                "file_count": len(m.get("files") or []),
                "deleted_by": m.get("who", ""),
                "deleted_at": m.get("at"),
                "expires_at": expires_at(m.get("at")),
            }
        )
    return out


def _item_dir(root: str | Path, item_id: str) -> Path:
    base = (Path(root) / TRASH_DIR).resolve()
    d = (base / item_id).resolve()
    if d.parent != base or not (d / "manifest.json").exists():
        raise KeyError(item_id)
    return d


def restore_library_item(root: str | Path, item_id: str) -> dict[str, Any]:
    """檔案搬回原位（原位已有同名檔就跳過並回報），然後刪掉垃圾桶目錄。呼叫端要重掃目錄。"""
    d = _item_dir(root, item_id)
    m = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    restored, skipped = 0, []
    for f in m.get("files") or []:
        src, dst = Path(f["to"]), Path(f["from"])
        if not src.exists():
            continue
        if dst.exists():
            skipped.append(str(dst))
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        restored += 1
    if not skipped:
        shutil.rmtree(d, ignore_errors=True)
    return {"item_id": item_id, "restored": restored, "skipped": skipped}


def purge_library_item(root: str | Path, item_id: str) -> dict[str, Any]:
    d = _item_dir(root, item_id)
    n = sum(1 for p in d.rglob("*") if p.is_file())
    shutil.rmtree(d, ignore_errors=True)
    return {"item_id": item_id, "files": n}


def expired_library_items(root: str | Path, now: datetime | None = None) -> list[dict[str, Any]]:
    cutoff = cutoff_iso(now)
    return [item for item in library_trash_items(root) if item["deleted_at"] and item["deleted_at"] < cutoff]


def purge_expired_library(root: str | Path, now: datetime | None = None) -> list[str]:
    """沒有稽核的版本（測試與工具用）；定時清理走 `retention_tick`（逐項先寫稽核再刪）。"""
    gone = []
    for item in expired_library_items(root, now):
        purge_library_item(root, item["item_id"])
        gone.append(item["item_id"])
    return gone


async def retention_tick(app: Any, now: datetime | None = None) -> dict[str, Any]:
    """定時清理：暫存區過期的結構（有 DB 才有）＋ 過期的檔案垃圾桶。封存區永不自動清。

    每一項**先寫稽核再刪**：以前整批刪完才寫一筆，中途出錯時已經永久刪掉的沒有紀錄。
    稽核寫不進去就丟出去、這一項不刪；刪除本身失敗記 log、下一輪再試（稽核裡會再出現一次）。
    """
    from .audit_events import new_event

    days = trash_days()

    async def audit(object_type: str, object_id: str, case_id: str | None, detail: dict[str, Any]) -> None:
        await app.audit(
            new_event(
                user="system",
                action="retention.purge",
                status=200,
                object_type=object_type,
                object_id=object_id,
                case_id=case_id,
                client_id=None,
                remote_addr=None,
                detail={**detail, "days": days},
            )
        )

    out: dict[str, Any] = {"structures": [], "library": []}
    if app.db_url:
        store = await app.case_store_async()
        for item in await store.expired_structures(cutoff_iso(now)):
            await audit("structure", item["structure_id"], item["case_id"], item)
            try:
                counts = await store.purge_structure(item["case_id"], item["structure_id"])
            except Exception:  # noqa: BLE001 - 下一輪再試
                log.exception("Retention: purging structure %s/%s failed", item["case_id"], item["structure_id"])
                continue
            out["structures"].append({**item, **counts})
    if app.library_root:
        for item in expired_library_items(app.library_root, now):
            await audit("library", item["item_id"], None, item)
            try:
                purge_library_item(app.library_root, item["item_id"])
            except Exception:  # noqa: BLE001 - 下一輪再試
                log.exception("Retention: purging library trash item %s failed", item["item_id"])
                continue
            out["library"].append(item["item_id"])
        if out["library"]:
            await app.library_index_async(rescan=True)
    return out
