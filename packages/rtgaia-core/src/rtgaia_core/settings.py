"""服務設定。

* **可執行期改的**放 `DimseSettings`：環境變數是預設、`app_setting` 表覆寫（`key="dimse"`）。
  改了接收端相關欄位 → `AppState.apply_dimse_settings()` 重啟 `ReceiveServer`；其他行程（獨立 `rtgaia-scp`）經匯流排
  `settings.changed` 收到後自己重載。
* **唯讀的**（`readonly_settings()`）只顯示：DB 連線、資料目錄、認證模式、金鑰、worker 模式…… 改了要重啟行程。
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, fields
from typing import Any

SETTINGS_KEY = "dimse"
UNSUPPORTED_POLICIES = ("store", "reject")


@dataclass
class DimseSettings:
    ae_title: str = "RTGAIA"
    """我方 AE Title（SCP 與預設的 calling AET）。"""
    scp_enabled: bool = False
    scp_port: int = 11112
    scp_host: str = "0.0.0.0"
    accept_unknown_callers: bool = False
    """False：calling AE Title（與選配 IP）不在「可接收」節點清單 → 拒絕 association。"""
    unsupported_sop_policy: str = "store"
    """不支援的 SOP Class：`store`（收下標記）或 `reject`（該 instance 回 0x0122）。"""
    idle_seconds: float = 5.0
    """association 閒置多久視為一批結束（3–60）。"""
    acse_timeout: int = 15
    dimse_timeout: int = 60
    network_timeout: int = 60
    connect_timeout: int = 5
    """TCP 連線逾時（秒）。🔴 pynetdicom 預設 None＝無限等：對關機的節點按 ECHO 會卡到作業系統放棄（約 2 分鐘），
    頁面看起來像沒反應（實際踩過：對一個已關機的節點按 ECHO）。"""

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def field_names() -> tuple[str, ...]:
        return tuple(f.name for f in fields(DimseSettings))

    @classmethod
    def from_env(cls, *, has_db: bool) -> DimseSettings:
        """環境變數 → 預設。沒有 DB（純開發）預設接受未登錄來源；有 DB 預設拒絕。"""
        port = 11112
        try:
            port = int(os.environ.get("RTGAIA_SCP_PORT") or port)
        except ValueError:
            pass
        enabled = os.environ.get("RTGAIA_SCP", "").strip() in ("1", "true", "yes") or bool(
            os.environ.get("RTGAIA_SCP_PORT", "").strip()
        )
        return cls(
            ae_title=(os.environ.get("RTGAIA_AE_TITLE") or "RTGAIA").strip()[:16] or "RTGAIA",
            scp_enabled=enabled,
            scp_port=port,
            scp_host=os.environ.get("RTGAIA_SCP_HOST", "0.0.0.0").strip() or "0.0.0.0",
            accept_unknown_callers=not has_db,
        )

    def merged(self, patch: dict[str, Any]) -> DimseSettings:
        """套上一份（來自 DB 或 PUT 的）部分欄位；檢查型別與範圍，錯了 `ValueError`。"""
        out = DimseSettings(**asdict(self))
        problems: list[str] = []
        for key, value in patch.items():
            if key not in self.field_names():
                problems.append(f"不認識的欄位 {key}")
                continue
            try:
                setattr(out, key, _coerce(key, value))
            except (TypeError, ValueError) as exc:
                problems.append(str(exc))
        problems.extend(out.problems())
        if problems:
            raise ValueError("；".join(problems))
        return out

    def problems(self) -> list[str]:
        out = []
        if not self.ae_title or len(self.ae_title) > 16 or not self.ae_title.isascii() or " " in self.ae_title:
            out.append("ae_title 必填、≤ 16 個 ASCII 字元、不含空白")
        if not 1 <= self.scp_port <= 65535:
            out.append("scp_port 必須在 1–65535")
        if not self.scp_host:
            out.append("scp_host 必填（0.0.0.0 ＝ 全部介面）")
        if self.unsupported_sop_policy not in UNSUPPORTED_POLICIES:
            out.append("unsupported_sop_policy 必須是 store 或 reject")
        if not 3.0 <= self.idle_seconds <= 60.0:
            out.append("idle_seconds 必須在 3–60")
        for name in ("acse_timeout", "dimse_timeout", "network_timeout"):
            if not 1 <= int(getattr(self, name)) <= 3600:
                out.append(f"{name} 必須在 1–3600 秒")
        if not 1 <= int(self.connect_timeout) <= 60:
            out.append("connect_timeout 必須在 1–60 秒")
        return out

    def scp_changed(self, other: DimseSettings) -> bool:
        """接收端要重啟的欄位有沒有變。"""
        return any(
            getattr(self, k) != getattr(other, k)
            for k in ("ae_title", "scp_enabled", "scp_port", "scp_host", "network_timeout")
        )


def _coerce(key: str, value: Any) -> Any:
    kind = {f.name: f.type for f in fields(DimseSettings)}[key]
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "false", "1", "0", "yes", "no"):
            return value.lower() in ("true", "1", "yes")
        raise ValueError(f"{key} 必須是布林")
    if kind == "int":
        if isinstance(value, bool):
            raise ValueError(f"{key} 必須是整數")
        return int(value)
    if kind == "float":
        return float(value)
    return str(value).strip()


def readonly_settings(
    *, db_url: str, library_root: str, auth_mode: str, inprocess_worker: bool
) -> list[dict[str, Any]]:
    """唯讀顯示（來源＝環境變數／參數）；改了要改 `deploy/.env` 並重啟行程。"""
    from .blobs import blob_root

    def env(name: str) -> str | None:
        v = os.environ.get(name)
        return v if v is not None and v != "" else None

    def row(key: str, label: str, value: str) -> dict[str, Any]:
        return {"key": key, "label": label, "value": value}

    secret = "已設定" if env("RTGAIA_SECRET") else "未設定（每次啟動隨機，重啟要重新登入）"
    names = "是" if env("RTGAIA_LIBRARY_SHOW_NAMES") in ("1", "true", "yes") else "否"
    from .dicom_uid import describe as _uid_describe
    from .export_profile import default_profile as _default_profile

    uid_label = _uid_describe()
    export_profile = _default_profile()
    return [
        row("RTGAIA_DB_URL", "資料庫連線", _mask_url(db_url) if db_url else "（無：記憶體模式）"),
        row("RTGAIA_LIBRARY_ROOT", "DICOM 資料庫目錄", library_root or "（未設）"),
        row("RTGAIA_DATA_DIR", "資料目錄（blobs／staging）", str(blob_root().parent)),
        row("RTGAIA_AUTH", "認證模式", auth_mode),
        row("RTGAIA_SECRET", "登入金鑰", secret),
        row("RTGAIA_INPROCESS_WORKER", "worker", "API 行程內建" if inprocess_worker else "獨立 rtgaia-worker"),
        row("RTGAIA_CACHE_MAX_GB", "快取上限（GB）", env("RTGAIA_CACHE_MAX_GB") or "預設"),
        row("RTGAIA_LIBRARY_SHOW_NAMES", "顯示 PatientName", names),
        row("RTGAIA_UID_ROOT", "匯出 UID 前綴", uid_label),
        row("RTGAIA_EXPORT_PROFILE", "預設匯出 profile", export_profile),
    ]


def _mask_url(url: str) -> str:
    """`postgresql+asyncpg://user:pass@host/db` → `postgresql+asyncpg://user:***@host/db`。"""
    if "@" not in url or "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host = rest.rsplit("@", 1)
    user = creds.split(":", 1)[0]
    return f"{scheme}://{user}:***@{host}"
