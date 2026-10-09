"""病例狀態與工作清單。

資料頁要回答「哪些病例待簽核／已簽核／已匯出」。狀態不另外存欄位，**從既有事實推**：
工作集裡的結構數與簽核狀態（`structure.status`）、最近一次成功匯出（`job kind=export status=done`）、病例最後更新時間。
純函式在這裡，記憶體與 DB 兩條路徑共用同一個判定。
"""

from __future__ import annotations

from typing import Any, Literal

CaseStatus = Literal["none", "in_progress", "review", "approved", "exported"]

STATUS_ORDER: tuple[CaseStatus, ...] = ("none", "in_progress", "review", "approved", "exported")


def case_status(
    *,
    work_total: int,
    approved: int,
    under_review: int,
    last_export_at: str | None,
    updated_at: str,
) -> CaseStatus:
    """規則（「無／進行中／待審／已簽核／已匯出」）：
    沒有工作集結構 → `none`；最近一次成功匯出在最後更新之後 → `exported`（匯出後又改就掉回來）；
    全部工作集結構都已簽核 → `approved`；有待審 → `review`；其餘 `in_progress`。"""
    if work_total <= 0:
        return "none"
    if last_export_at and last_export_at >= updated_at:
        return "exported"
    if approved >= work_total:
        return "approved"
    if under_review > 0:
        return "review"
    return "in_progress"


def is_work_set(structure_set_id: str | None) -> bool:
    """工作集 id 形如 `work:<user>:<hash>[:<n>]`；匯入集是 RTSTRUCT 的 SeriesInstanceUID；暫存集 `transient:`。"""
    return bool(structure_set_id and structure_set_id.startswith("work:"))


def counts_from_structures(rows: list[tuple[str | None, str]]) -> dict[str, int]:
    """`rows`：(structure_set_id, status)，一個結構一筆（多相位只算一次由呼叫端處理）。"""
    out = {"work_total": 0, "approved": 0, "under_review": 0, "edited": 0, "rejected": 0, "import_total": 0}
    for set_id, status in rows:
        if not is_work_set(set_id):
            out["import_total"] += 1
            continue
        out["work_total"] += 1
        if status == "approved":
            out["approved"] += 1
        elif status == "under_review":
            out["under_review"] += 1
        elif status == "edited":
            out["edited"] += 1
        elif status == "rejected":
            out["rejected"] += 1
    return out


def worklist_entry(
    *,
    case: dict[str, Any],
    counts: dict[str, int],
    last_export_at: str | None,
    open_users: list[str],
    study: dict[str, Any] | None,
) -> dict[str, Any]:
    status = case_status(
        work_total=counts["work_total"],
        approved=counts["approved"],
        under_review=counts["under_review"],
        last_export_at=last_export_at,
        updated_at=str(case.get("updated_at") or ""),
    )
    return {
        "case_id": case["case_id"],
        "study_id": case.get("study_id"),
        "source": case.get("source", ""),
        "description": case.get("description", ""),
        "selection": case.get("selection") or None,
        "created_by": case.get("created_by", ""),
        "created_at": case.get("created_at"),
        "updated_at": case.get("updated_at"),
        "status": status,
        "counts": counts,
        "last_export_at": last_export_at,
        "open_users": sorted(set(open_users)),
        "patient_id": (study or {}).get("patient_id"),
        "study_date": (study or {}).get("study_date", ""),
        "study_description": (study or {}).get("study_description", ""),
    }
