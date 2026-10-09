"""稽核事件的形狀（從 `db/audit.py` 抽出的純函式；寫入端在 `rtgaia_server.db.audit.AuditStore`）。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any


def new_event(
    *,
    user: str,
    action: str,
    status: int,
    object_type: str | None,
    object_id: str | None,
    case_id: str | None,
    client_id: str | None,
    remote_addr: str | None,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "event_id": f"aud_{uuid.uuid4().hex[:12]}",
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "user": user,
        "action": action,
        "status": status,
        "object_type": object_type,
        "object_id": object_id,
        "case_id": case_id,
        "client_id": client_id,
        "remote_addr": remote_addr,
        "detail": detail or {},
    }
