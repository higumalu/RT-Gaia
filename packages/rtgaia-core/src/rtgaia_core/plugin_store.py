"""plugin 登錄的紀錄與記憶體實作（從 `db/plugins.py` 抽出）。

Postgres 實作在 `rtgaia_server.db.plugins.DbPlugins`。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class PluginRecord:
    plugin_id: str
    endpoint: str
    token: str = ""
    manifest: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    status: str = "active"
    """active｜disabled｜failed｜version-mismatch｜license"""
    error: str | None = None
    allow_licenses: list[str] = field(default_factory=list)
    registered_by: str = ""
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    last_seen_at: str | None = None
    health_failures: int = 0
    artifact_origins: list[str] = field(default_factory=list)
    """admin 額外核可的 artifact 來源；manifest 自己宣告的另計，endpoint 的 origin 永遠允許。"""
    ui_digest: str | None = None
    """UI bundle 的 sha256（登錄／版本變更時由宿主抓一次算的）；代理時不符 → quarantined。"""

    @property
    def version(self) -> str:
        return str(self.manifest.get("version", ""))

    @property
    def module_version(self) -> str:
        return f"{self.plugin_id}@{self.version}"

    @property
    def required_role(self) -> str:
        return str(self.manifest.get("required_role", "admin"))

    @property
    def capabilities(self) -> set[str]:
        return set(self.manifest.get("capabilities", []))

    @property
    def ui_trust(self) -> str | None:
        ui = self.manifest.get("ui")
        return str(ui.get("trust")) if isinstance(ui, dict) and ui.get("trust") else None

    @property
    def has_ui(self) -> bool:
        """有 bundle **且**宣告 `ui.trust`（沒宣告就不載，退回宣告式面板）。"""
        return "ui" in self.manifest and self.ui_trust == "host-equivalent"

    @property
    def ui_bundle_path(self) -> str | None:
        ui = self.manifest.get("ui")
        return str(ui["bundle"]) if isinstance(ui, dict) and ui.get("bundle") else None

    def endpoint_origin(self) -> str:
        from urllib.parse import urlsplit

        u = urlsplit(self.endpoint)
        return f"{u.scheme.lower()}://{u.netloc.lower()}"

    def effective_artifact_origins(self) -> set[str]:
        """endpoint 自己的 origin ∪ manifest `artifact_origins` ∪ admin 核可的。"""
        declared = [str(x) for x in self.manifest.get("artifact_origins", []) or []]
        return {self.endpoint_origin(), *(o.rstrip("/").lower() for o in declared + list(self.artifact_origins))}

    def to_wire(self, *, admin: bool, allowed: bool) -> dict[str, Any]:
        """admin 看全部（含 soup、錯誤、endpoint）；其他人只看 D.10 列的欄位。token 永不回傳。"""
        m = self.manifest
        base: dict[str, Any] = {
            "plugin_id": self.plugin_id,
            "version": self.version,
            "label": m.get("label", self.plugin_id),
            "icon": m.get("icon"),
            "description": m.get("description", ""),
            "has_ui": self.has_ui,
            "ui": m.get("ui"),
            "ui_trust": self.ui_trust,
            "ui_digest": self.ui_digest,
            "required_role": self.required_role,
            "status": self.status,
            "enabled": self.enabled,
            "allowed": allowed,
            "params_schema": (m.get("inputs") or {}).get("params_schema"),
        }
        if admin:
            base.update(
                {
                    "endpoint": self.endpoint,
                    "token_set": bool(self.token),
                    "manifest": m,
                    "error": self.error,
                    "allow_licenses": self.allow_licenses,
                    "registered_by": self.registered_by,
                    "created_at": self.created_at,
                    "updated_at": self.updated_at,
                    "last_seen_at": self.last_seen_at,
                    "health_failures": self.health_failures,
                    "artifact_origins": list(self.artifact_origins),
                    "effective_artifact_origins": sorted(self.effective_artifact_origins()),
                }
            )
        return base


class MemoryPlugins:
    def __init__(self) -> None:
        self._rows: dict[str, PluginRecord] = {}

    async def list(self) -> list[PluginRecord]:
        return sorted(self._rows.values(), key=lambda p: p.created_at)

    async def get(self, plugin_id: str) -> PluginRecord | None:
        return self._rows.get(plugin_id)

    async def put(self, rec: PluginRecord) -> PluginRecord:
        rec.updated_at = _now()
        self._rows[rec.plugin_id] = rec
        return rec

    async def delete(self, plugin_id: str) -> None:
        self._rows.pop(plugin_id, None)
