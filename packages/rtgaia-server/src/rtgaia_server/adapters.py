"""`rtgaia_core.ports.Adapters` 的 SQL 實作：把 `db/` 裡的 Postgres store 接進 core 的 `AppState`。"""

from __future__ import annotations

from typing import Any

from rtgaia_core.ports import Deliver


class SqlAdapters:
    def catalog_store(self, db_url: str) -> Any:
        from .db import CatalogStore

        return CatalogStore(db_url)

    def upgrade_to_head(self, db_url: str) -> None:
        from .db import upgrade_to_head

        upgrade_to_head(db_url)

    def case_store(self, engine: Any, blobs: Any) -> Any:
        from .db.cases import CaseStore

        return CaseStore(engine, blobs)

    def rebuild_structures(self, loaded: Any, store: Any) -> dict[tuple[str, int | None], Any]:
        from .db.cases import rebuild_structures

        return rebuild_structures(loaded, store)

    def audit_store(self, engine: Any) -> Any:
        from .db.audit import AuditStore

        return AuditStore(engine)

    def user_store(self, engine: Any) -> Any:
        from .db.users import UserStore

        return UserStore(engine)

    def nodes(self, engine: Any) -> Any:
        from .db.nodes import DbNodes

        return DbNodes(engine)

    def settings(self, engine: Any) -> Any:
        from .db.settings import DbSettings

        return DbSettings(engine)

    def plugins(self, engine: Any) -> Any:
        from .db.plugins import DbPlugins

        return DbPlugins(engine)

    def job_queue(self, engine: Any) -> Any:
        from .db.jobs import DbJobQueue

        return DbJobQueue(engine)

    def export_records(self, engine: Any) -> Any:
        from .db.export_records import DbExportRecords

        return DbExportRecords(engine)

    def storage_locations(self, engine: Any) -> Any:
        from .db.storage_locations import DbLocations

        return DbLocations(engine)

    def bus(self, engine: Any, db_url: str, deliver: Deliver | None) -> Any:
        from .db.bus import PgBus

        return PgBus(engine, db_url, deliver)
