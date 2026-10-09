"""應用程式狀態與共用輔助。

`api/` 是**薄層**：路由只負責解析請求、呼叫下面的模組、
套用 chaos、組回應。任何幾何或狀態邏輯都不該出現在這一層。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from fastapi import Request, Response
from rtgaia_geom import CONTENT_TYPE, encode
from rtgaia_geom.grid import Grid

from ..chaos import ChaosConfig, corrupt_frame, corrupt_json
from ..push import PushHub
from ..state import Session, SessionStore
from ..storage import StorageMonitor

API = "/api/v1"
log = logging.getLogger(__name__)


class AuditUnavailable(RuntimeError):
    """稽核主表與待送表都寫不進去；中介層回 503 `AUDIT_UNAVAILABLE`。"""


@dataclass
class AppState:
    store: SessionStore = field(default_factory=SessionStore)
    hub: PushHub = field(default_factory=PushHub)
    chaos: ChaosConfig = field(default_factory=ChaosConfig)
    fixtures_dir: str = ""
    exports: dict[str, bytes] = field(default_factory=dict)
    # ── 資料庫 ────────────────────────────────────────────────────
    library_root: str = ""
    """`RTGAIA_LIBRARY_ROOT`；空字串 ＝ 沒有資料庫（資料頁只列假體）。"""
    show_patient_names: bool = False
    """預設**不送** PatientName；`RTGAIA_LIBRARY_SHOW_NAMES=1` 才開。"""
    library: Any = None
    adapters: Any = None
    """`rtgaia_core.ports.Adapters`（SQL 實作由 `rtgaia_server` 注入）；沒有 DB 時可以是 None。"""
    """惰性建立的 `LibraryIndex`（第一次查詢才掃描；DB 模式下從 Postgres 載入）。"""
    db_url: str = ""
    """`RTGAIA_DB_URL`；空字串 ＝ 沒有資料庫，目錄只在記憶體 ＋ JSON 快取。"""
    catalog_store: Any = None
    """`CatalogStore`（DB 模式）。（`store` 是 SessionStore，別搞混。）"""
    db_ready: bool = False
    # ── 身分 ─────────────────────────────────────────────────────────
    auth_mode: str = "off"
    """`required`（有 DB 時預設）或 `off`（stub：`X-RTGaia-User`／`X-RTGaia-Role` 標頭）。"""
    secret: bytes = b""
    user_store: Any = None
    _principal_cache: dict[str, Any] = field(default_factory=dict)
    _ws_watches: dict[str, set[Any]] = field(default_factory=dict)
    """user_id → 開著的 WS 的喚醒事件（帳號變動時立刻重驗）。"""
    # ── 病例持久化 ────────────────────────────────────────────────
    case_store: Any = None
    blobs: Any = None
    # ── job 與稽核 ────────────────────────────────────────────────
    job_queue: Any = None
    audit_store: Any = None
    audit_tail: list[dict[str, Any]] = field(default_factory=list)
    """最近的稽核事件（記憶體環形，供 `_test/state` 與沒有 DB 的模式）。"""
    worker_task: Any = None
    worker_health: dict[str, Any] = field(default_factory=dict)
    """worker 迴圈的心跳：`last_tick`（epoch 秒）、`busy_job`、`jobs`、`errors`、
    `last_error`。`/healthz` 顯示、`/readyz` 判斷；獨立 worker 另寫心跳檔（`RTGAIA_WORKER_HEARTBEAT_FILE`）
    給容器健康檢查。"""
    # ── DIMSE ────────────────────────────────────────────────────
    nodes: Any = None
    export_records: Any = None
    # 容量監看與完整性巡檢
    storage_locations: Any = None
    storage_monitor: Any = field(default_factory=lambda: StorageMonitor())
    integrity_last_run: dict[str, Any] | None = None
    plugins: Any = None
    """`PluginManager`（登錄表、健康檢查、派工、回呼）。"""
    public_url: str = ""
    """宿主對外位址：只來自 `RTGAIA_PUBLIC_URL`／`create_app(public_url=)`，不再由 request 的 Host 學來。"""
    allowed_hosts: set[str] | None = None
    """`/api/v1/*` 接受的 Host（不含 port 也比）；None ＝ 不判（開發／off 模式沒設定）。"""
    """宿主對 plugin 可見的位址（`RTGAIA_PUBLIC_URL`；沒設就用 plugin 打進來的 Host 或 http://127.0.0.1:<port>）。"""
    scp: Any = None
    plugin_tick_task: Any = None
    retention_task: Any = None
    scp_error: str | None = None
    loop: Any = None
    """API 的 event loop（SCP 的 pynetdicom 執行緒要把 job 丟回來）。"""

    def __post_init__(self) -> None:
        # chaos `push_limit`：推送上限跟著故障注入設定走（同一個物件，`_test/chaos` 改了立刻生效）
        self.hub.chaos = self.chaos

    def staging_root(self) -> str:
        from pathlib import Path

        from ..blobs import blob_root

        root = blob_root().parent / "staging"
        Path(root).mkdir(parents=True, exist_ok=True)
        return str(root)

    def _adapters(self) -> Any:
        """SQL 實作由 `rtgaia_server` 注入；core 自己不認識任何 SQLAlchemy 類別。"""
        if self.adapters is None:
            from ..ports import NoAdapters

            raise NoAdapters(
                "設了 RTGAIA_DB_URL 但沒有 SQL adapters：請用 rtgaia_server.app.create_app()（或 rtgaia_testbe）建 app"
            )
        return self.adapters

    def storage_paths(self) -> dict[str, str | None]:
        """要監看容量的位置（同一顆磁碟會合併）：DICOM、blob（mask 版本、匯出）、快取。"""
        from ..blobs import blob_root
        from ..dataset_io import cache_root

        return {"library": self.library_root or None, "blobs": str(blob_root()), "cache": str(cache_root())}

    async def storage_check(self) -> dict[str, Any]:
        """量一次容量；跨過門檻／回落寫稽核（`storage.threshold_exceeded`／`storage.threshold_recovered`）。"""
        import asyncio

        from ..audit_events import new_event

        status, events = await asyncio.to_thread(self.storage_monitor.check, self.storage_paths())
        for e in events:
            vol = e["volume"]
            try:
                await self.audit(
                    new_event(
                        user="system",
                        action=e["action"],
                        status=200,
                        object_type="storage",
                        object_id=vol["path"],
                        case_id=None,
                        client_id=None,
                        remote_addr=None,
                        detail={"labels": vol["labels"], "percent": vol["percent"], "threshold": status["threshold"]},
                    )
                )
            except Exception:  # noqa: BLE001 - 稽核寫不進去不能讓監看停掉（outbox 會重送）
                pass
        return status

    async def storage_locations_async(self) -> Any:
        from ..storage import MemoryLocations

        if self.storage_locations is None:
            if self.db_url:
                await self.ensure_db()
                self.storage_locations = self._adapters().storage_locations(self.catalog_store.engine)
            else:
                self.storage_locations = MemoryLocations()
        return self.storage_locations

    async def library_files(self) -> list[tuple[str, str]]:
        """資料庫裡現有的 DICOM 檔（路徑, SOP）—— 巡檢的對象。沒有資料庫根目錄 → 空。"""
        if not self.library_root:
            return []
        index = await self.library_index_async()
        return [(h.path, h.sop_instance_uid) for s in index.series.values() for h in s.instances]

    async def integrity_tick(self, *, batch: int | None = None) -> dict[str, Any]:
        """巡檢一輪；有問題寫一筆稽核 `storage.integrity_problem`（列出前 50 個）。"""
        import asyncio

        from .. import storage
        from ..audit_events import new_event

        store = await self.storage_locations_async()
        files = await self.library_files()
        result = (
            await storage.patrol(store, files, batch=batch)
            if files
            else {"ran_at": None, "checked": 0, "total_files": 0, "problems": [], "retired": 0}
        )
        await asyncio.sleep(0)
        self.integrity_last_run = {k: v for k, v in result.items() if k != "problems"} | {
            "problem_count": len(result["problems"])
        }
        if result["problems"]:
            try:
                await self.audit(
                    new_event(
                        user="system",
                        action="storage.integrity_problem",
                        status=200,
                        object_type="storage",
                        object_id=None,
                        case_id=None,
                        client_id=None,
                        remote_addr=None,
                        detail={"count": len(result["problems"]), "problems": result["problems"][:50]},
                    )
                )
            except Exception:  # noqa: BLE001
                pass
        return result

    async def nodes_async(self) -> Any:
        from ..node_store import MemoryNodes

        if self.nodes is None:
            if self.db_url:
                await self.ensure_db()
                self.nodes = self._adapters().nodes(self.catalog_store.engine)
            else:
                self.nodes = MemoryNodes()
        return self.nodes

    async def export_records_async(self) -> Any:
        from ..export_records import MemoryExportRecords

        if self.export_records is None:
            if self.db_url:
                await self.ensure_db()
                self.export_records = self._adapters().export_records(self.catalog_store.engine)
            else:
                self.export_records = MemoryExportRecords()
        return self.export_records

    async def record_export(self, job: Any) -> Any:
        """結束的 export／send job → 一筆匯出紀錄。"""
        from ..export_records import record_from_job

        rec = record_from_job(
            {**job.to_wire(), "request": job.request, "result": job.result, "result_blob_key": job.result_blob_key}
        )
        if rec is None:
            return None
        return await (await self.export_records_async()).put(rec)

    async def enqueue_import(
        self,
        staging_dir: str,
        *,
        source: str,
        detail: dict[str, Any],
        requested_by: str = "dimse",
        move: bool = True,
    ) -> Any:
        """`move=True`：來源是我們自己的暫存區（接收端、C-GET），匯入後搬走；使用者指定的目錄一律 `move=False`（複製）。
        🔴 `move` 要在排入時就定：以前先以搬移排入、之後才改成複製再寫回，worker 在空檔領走就會搬走使用者目錄的檔案。"""
        from ..jobs import new_job

        job = new_job(
            "",
            "import",
            {"staging_dir": staging_dir, "source": source, "detail": detail, "move": move},
            requested_by=requested_by,
        )
        await (await self.job_queue_async()).enqueue(job)
        return job

    def enqueue_import_threadsafe(
        self, staging_dir: str, *, source: str, detail: dict[str, Any], timeout: float = 30.0
    ) -> Any:
        """給 pynetdicom 與接收端清掃執行緒用：把 import job 丟回 API 的 loop，**等它寫進佇列**；寫不進去就 raise
        （接收端記下來重試）。以前丟了就不管（future 沒人看），loop 還沒設也默默略過。
        不能在那個 loop 上呼叫（會互等）。"""
        import asyncio

        if self.loop is None:
            raise RuntimeError("the receiver has no event loop to queue the import job on")
        future = asyncio.run_coroutine_threadsafe(
            self.enqueue_import(staging_dir, source=source, detail=detail), self.loop
        )
        return future.result(timeout=timeout)

    def start_scp(self, *, port: int | None = None, host: str | None = None, settings: Any = None) -> Any:
        """在 API 行程裡起接收端（`RTGAIA_SCP=1` 或設定 `scp_enabled`；獨立行程用 `rtgaia-scp`）。

        `settings`：`DimseSettings`（缺省用目前生效的）；`port`／`host` 可覆寫（測試）。"""
        from pathlib import Path

        from .. import dimse
        from ..dimse import ReceiveServer

        if self.scp is not None:
            return self.scp
        cfg = settings if settings is not None else dimse.current_settings()

        def on_batch(d: Path, meta: dict[str, Any]) -> None:
            self.enqueue_import_threadsafe(str(d), source=f"dimse:{meta.get('calling_aet', '')}", detail=meta)

        self.scp = ReceiveServer(
            staging_root=Path(self.staging_root()) / "scp",
            on_batch=on_batch,
            ae_title=cfg.ae_title,
            port=port or int(cfg.scp_port),
            host=host or str(cfg.scp_host),
            is_allowed=None if cfg.accept_unknown_callers else self.scp_is_allowed,
            unsupported_policy=cfg.unsupported_sop_policy,
            idle_seconds=cfg.idle_seconds,
            network_timeout=cfg.network_timeout,
        )
        self.scp.start()
        self.scp_error = None
        return self.scp

    def stop_scp(self) -> None:
        if self.scp is not None:
            try:
                self.scp.stop()
            finally:
                self.scp = None

    # ── 服務設定 ────────────────────────────────────────────────
    settings_store: Any = None
    dimse_settings: Any = None
    """目前生效的 `DimseSettings`（env 預設 ＋ DB 覆寫）。"""
    _receive_nodes_cache: Any = None
    """接收驗證用的快照：[(ae_title, inbound_ip, node_id)]；節點變了（本行程或匯流排 `nodes.changed`）就清。"""

    async def settings_store_async(self) -> Any:
        from ..settings_store import MemorySettings

        if self.settings_store is None:
            if self.db_url:
                await self.ensure_db()
                self.settings_store = self._adapters().settings(self.catalog_store.engine)
            else:
                self.settings_store = MemorySettings()
        return self.settings_store

    async def dimse_settings_async(self, *, refresh: bool = False) -> Any:
        """env 預設 → DB 覆寫（`app_setting.dimse`）→ `dimse.configure()`。"""
        from .. import dimse
        from ..settings import SETTINGS_KEY, DimseSettings

        if self.dimse_settings is None or refresh:
            base = DimseSettings.from_env(has_db=bool(self.db_url))
            stored = await (await self.settings_store_async()).get(SETTINGS_KEY)
            try:
                merged = base.merged(stored) if stored else base
            except ValueError:
                merged = base  # DB 裡的值壞了（舊版欄位）：用預設，不讓服務起不來
            if self.scp_cli_override:
                merged = merged.merged({k: v for k, v in self.scp_cli_override.items() if v})
            self.dimse_settings = merged
            self.settings_sources = {
                k: ("db" if stored and k in stored else "env") for k in DimseSettings.field_names()
            }
            dimse.configure(merged)
        return self.dimse_settings

    settings_sources: dict[str, str] = field(default_factory=dict)
    scp_cli_override: dict[str, Any] = field(default_factory=dict)
    """`rtgaia-scp --port/--host`：蓋過設定（設定改了重載時仍保留）。"""

    async def save_dimse_settings(self, patch: dict[str, Any], *, updated_by: str) -> Any:
        """驗證 → 只存 PUT 進來的欄位（其餘維持 env 預設）→ 匯流排 `settings.changed`
        （本行程同步收到 → 重載、套用；獨立 `rtgaia-scp` 行程也收到）。"""
        from ..settings import SETTINGS_KEY

        current = await self.dimse_settings_async()
        new = current.merged(patch)  # ValueError 由路由轉 422
        store = await self.settings_store_async()
        stored = await store.get(SETTINGS_KEY) or {}
        await store.put(SETTINGS_KEY, {**stored, **{k: getattr(new, k) for k in patch}}, updated_by=updated_by)
        await self.publish("system", "settings.changed", {"key": SETTINGS_KEY, "by": updated_by})
        if self.dimse_settings is current:
            # 匯流排沒把本地送達（worker 行程不訂閱）：自己重載
            await self.dimse_settings_async(refresh=True)
            await self.apply_dimse_settings(previous=current)
        return self.dimse_settings

    async def apply_dimse_settings(self, *, previous: Any = None, force: bool = False) -> dict[str, Any]:
        """讓接收端符合目前設定：開關、AE Title、port 變了就重啟；其他（閒置秒數、策略）直接改在跑的 server 上。"""
        import asyncio

        cfg = await self.dimse_settings_async()
        restart = force or previous is None or previous.scp_changed(cfg)
        if self.scp is not None:
            self.scp.unsupported_policy = cfg.unsupported_sop_policy
            self.scp.idle_seconds = float(cfg.idle_seconds)
            self.scp.is_allowed = None if cfg.accept_unknown_callers else self.scp_is_allowed
        if not restart:
            return {"restarted": False, "running": self.scp is not None}
        if self.scp is not None:
            await asyncio.to_thread(self.stop_scp)
        if cfg.scp_enabled and self.scp_owner:
            try:
                await asyncio.to_thread(self.start_scp, settings=cfg)
            except Exception as exc:  # noqa: BLE001 - port 被佔等：記下來給頁面看
                self.scp = None
                self.scp_error = str(exc)
                return {"restarted": True, "running": False, "error": self.scp_error}
        return {"restarted": True, "running": self.scp is not None}

    scp_owner: bool = True
    """這個行程要不要照設定起接收端（API 內建；`RTGAIA_SCP_OWNER=0` 時交給獨立 `rtgaia-scp`）。"""

    def scp_is_allowed(self, calling_aet: str, remote_ip: str) -> tuple[bool, str | None]:
        """接收驗證（pynetdicom 執行緒呼叫）：calling AET 在「可接收」節點裡；節點有 `inbound_ip` 就也要對。"""
        import asyncio

        snapshot = self._receive_nodes_cache
        if snapshot is None:
            if self.loop is None:
                return False, None
            fut = asyncio.run_coroutine_threadsafe(self._receive_nodes_async(), self.loop)
            try:
                snapshot = fut.result(timeout=5.0)
            except Exception:  # noqa: BLE001
                return False, None
        for aet, ip, node_id in snapshot:
            if aet == calling_aet and (ip is None or ip == remote_ip):
                return True, node_id
        return False, None

    async def _receive_nodes_async(self) -> list[tuple[str, str | None, str]]:
        nodes = await (await self.nodes_async()).list()
        snap = [(n.ae_title.strip(), n.inbound_ip, n.node_id) for n in nodes if n.role_receive]
        self._receive_nodes_cache = snap
        return snap

    async def nodes_changed(self) -> None:
        """節點寫入後：本行程快照失效 ＋ 通知其他行程。"""
        self._receive_nodes_cache = None
        await self.publish("system", "nodes.changed", {})

    # ── 事件匯流排 ────────────────────────────────────────────────
    bus: Any = None
    inprocess_worker: bool = True
    """`RTGAIA_INPROCESS_WORKER=0` → 不在 API 行程跑 worker（改用 `rtgaia-worker` 獨立行程）。"""
    test_api: bool = False
    """是否掛載 `/api/v1/_test/*`：測試與開發入口明確打開；生產預設沒有這組路徑。"""
    subscribe: bool = True
    """API 行程訂閱匯流排（worker 行程只發布）。"""
    owns_live_cases: bool = True
    """這個行程的記憶體病例是不是即時狀態。API 行程是（寫入同步進 DB）；獨立 worker、接收端不是 ——
    它們的 `case_async` 每次從 DB 重建、不留快取，否則 API 之後的編輯、簽核、改名它都看不到。"""

    async def plugins_async(self) -> Any:
        from ..plugin_store import MemoryPlugins
        from ..plugins import PluginManager

        if self.plugins is None:
            if self.db_url:
                await self.ensure_db()
                store = self._adapters().plugins(self.catalog_store.engine)
            else:
                store = MemoryPlugins()
            self.plugins = PluginManager(self, store)
        return self.plugins

    def public_base_url(self) -> str:
        """RunRequest 的 `callback.base_url` 前綴：設定值 > 開發回退 `http://127.0.0.1:8080`；
        `required` 模式沒設定就 raise —— 不會再用第一個 request 的 Host。"""
        import os

        configured = (os.environ.get("RTGAIA_PUBLIC_URL") or self.public_url or "").strip()
        if configured:
            return configured.rstrip("/")
        if self.auth_mode == "required":
            raise RuntimeError("RTGAIA_PUBLIC_URL 未設定：required 模式不允許猜對外位址")
        return "http://127.0.0.1:8080"

    async def bus_async(self) -> Any:
        from ..bus import LocalBus

        if self.bus is None:
            if self.db_url:
                await self.ensure_db()
                self.bus = self._adapters().bus(
                    self.catalog_store.engine, self.db_url, self.deliver if self.subscribe else None
                )
                await self.bus.start()
            else:
                self.bus = LocalBus(self.deliver)
        return self.bus

    async def publish(self, target: str, message_type: str, payload: dict[str, Any]) -> None:
        """對外的唯一推送入口：`target` ＝ session_id｜`case:<id>`｜`*`。"""
        await (await self.bus_async()).publish(target, message_type, payload)

    async def deliver(self, target: str, message_type: str, payload: dict[str, Any]) -> int:
        """匯流排送到**這個行程**：展開 target → PushHub；`catalog.changed` 另讓目錄索引失效。"""
        if message_type == "catalog.changed":
            self.library = None
            self.catalog = None
        if target == "system":
            # 跨行程的設定／節點變更（不進 WS）
            if message_type == "nodes.changed":
                self._receive_nodes_cache = None
            elif message_type == "settings.changed":
                previous = self.dimse_settings
                await self.dimse_settings_async(refresh=True)
                await self.apply_dimse_settings(previous=previous)
            return 0
        if target == "*":
            return await self.hub.broadcast(message_type, payload)
        if target.startswith("case:"):
            delivered = 0
            for s in self.store.sessions_of(target[5:]):
                delivered += await self.hub.send(s.session_id, message_type, payload)
            return delivered
        return await self.hub.send(target, message_type, payload)

    async def job_queue_async(self) -> Any:
        from ..jobs import MemoryJobQueue

        if self.job_queue is None:
            if self.db_url:
                await self.ensure_db()
                self.job_queue = self._adapters().job_queue(self.catalog_store.engine)
            else:
                self.job_queue = MemoryJobQueue()
            self.job_queue.on_lease_failed = self._lease_failed
        return self.job_queue

    async def job_queue_async_update(self, job: Any, *, release_lease: bool = False) -> None:
        """整份寫回（要帶讀出時的版本，別人寫過就 `JobChanged`）。改工作列優先用 `mutate_job`。"""
        await (await self.job_queue_async()).update(job, release_lease=release_lease)
        self._mirror_job(job)

    async def mutate_job(self, job_id: str, change: Any, *, release_lease: bool = False) -> Any:
        """`jobs.mutate_job`（讀最新 → 改自己的欄位 → 寫回，被搶先就重來）＋ `case.jobs` 鏡像。"""
        from ..jobs import mutate_job

        written = await mutate_job(await self.job_queue_async(), job_id, change, release_lease=release_lease)
        if written is not None:
            self._mirror_job(written)
        return written

    def _mirror_job(self, job: Any) -> None:
        # `case.jobs` 鏡像：舊 client（`_test/state`、GET /cases/{id}）看得到
        try:
            case = self.store.case(job.case_id)
            case.jobs[job.job_id] = job.to_wire()
        except KeyError:
            pass

    async def _lease_failed(self, jobs: list[Any]) -> None:
        """租約過期、重試用完被判失敗的工作：推錯誤（以前只改狀態，畫面一直顯示執行中）。"""
        for job in jobs:
            self._mirror_job(job)
            try:
                await self.notify_case(
                    job.case_id, "error", {"code": "JOB_FAILED", "message": job.error or "", "jobId": job.job_id}
                )
            except Exception:  # noqa: BLE001 - 通知失敗不能讓領工作失敗
                log.warning("Could not notify the lease failure of %s", job.job_id)

    def export_blobs_put(self, job_id: str, data: bytes) -> str:
        """匯出結果：有 blob store 就進 `exports/`（重啟後仍可下載）；沒有 DB 也進 blob store（檔案系統本來就有）。"""
        return self.blob_store().put(data, namespace="exports", key=job_id)

    def export_blobs_get(self, key: str) -> bytes:
        return self.blob_store().get(key, namespace="exports")

    async def case_async(self, case_id: str) -> Any:
        """API 行程：記憶體那份就是即時狀態，不在記憶體才從 DB 重建並留著。
        不擁有即時病例的行程（`owns_live_cases=False`）：每次都從 DB 重建、不留 —— 以前獨立 worker 第一次載入後
        就一直用那份，之後的匯出、plugin 派工拿到的是舊輪廓。"""
        if self.db_url and not self.owns_live_cases:
            return await self.load_case_async(case_id, register=False)
        try:
            return self.store.case(case_id)
        except KeyError:
            if not self.db_url:
                raise
            return await self.load_case_async(case_id)

    async def publish_presence(self, case_id: str) -> None:
        """誰開著這個病例 → `case:` 頻道 `presence`（session 建立、WS 連上／斷線、過期時）。"""
        users = [
            {
                "user": s.user,
                "sessionId": s.session_id,
                "connections": s.connections,
                "createdAt": s.created_at,
                # 正在編輯的結構 id（名稱由收的人用自己的結構清單解析；
                # 看不到的暫存結構就只顯示「編輯中」）
                "editing": s.editing,
            }
            for s in self.store.sessions_of(case_id)
        ]
        try:
            await self.publish(f"case:{case_id}", "presence", {"caseId": case_id, "users": users})
        except Exception:  # noqa: BLE001 - presence 是輔助資訊，不能讓主操作失敗
            pass

    async def notify_case(self, case_id: str, message_type: str, payload: dict[str, Any]) -> int:
        """病例級推送 —— 經匯流排（獨立 worker 也用這條到達 API 的 WS 連線）。"""
        await self.publish(f"case:{case_id}", message_type, payload)
        return len(self.store.sessions_of(case_id))

    async def audit_store_async(self) -> Any:

        await self.ensure_db()
        if self.audit_store is None:
            self.audit_store = self._adapters().audit_store(self.catalog_store.engine)
        return self.audit_store

    async def audit(self, event: dict[str, Any]) -> None:
        """稽核：寫 `audit_event`；失敗 → 落 `audit_outbox` 由背景重送；**兩邊都失敗 → raise**
        `AuditUnavailable`，中介層把請求變 503 —— 業務變更已發生但沒有稽核，不能當成正常路徑靜默回 200。

        🔴 先前註解說「已回應」所以只記 tail：不成立——`audit_writes` 中介層在 route 之後、回應送出**之前** await。
        """
        self.audit_tail.append(event)
        del self.audit_tail[: max(0, len(self.audit_tail) - 200)]
        if not self.db_url:
            return
        try:
            store = await self.audit_store_async()
            await store.append(event)
        except Exception as exc:  # noqa: BLE001 - 進 outbox（先存乾淨的事件，旗標之後才標在 tail 那份上）
            try:
                await (await self.audit_store_async()).enqueue(dict(event), str(exc))
                event["persist_error"] = True
                event["queued"] = True
            except Exception as exc2:  # noqa: BLE001
                raise AuditUnavailable(f"audit_event 與 audit_outbox 都寫不進去：{exc} / {exc2}") from exc2

    async def flush_audit_outbox(self) -> dict[str, int] | None:
        if not self.db_url:
            return None
        try:
            return await (await self.audit_store_async()).flush()
        except Exception:  # noqa: BLE001 - DB 沒好：下一輪再試
            return None

    async def audit_lag(self) -> dict[str, Any] | None:
        if not self.db_url:
            return None
        try:
            return await (await self.audit_store_async()).lag()
        except Exception as exc:  # noqa: BLE001
            return {"pending": None, "oldest_age_s": None, "gave_up": None, "error": str(exc)[:200]}

    def blob_store(self) -> Any:
        from ..blobs import FsBlobStore

        if self.blobs is None:
            self.blobs = FsBlobStore()
        return self.blobs

    async def case_store_async(self) -> Any:

        await self.ensure_db()
        if self.case_store is None:
            self.case_store = self._adapters().case_store(self.catalog_store.engine, self.blob_store())
        return self.case_store

    async def persist_case(self, case: Any, *, created_by: str = "") -> dict[str, int] | None:
        """有 DB 且是 library 病例（有 selection_hash）就整批寫回；沒有 DB 什麼都不做。"""
        if not self.db_url or case.selection_hash is None:
            return None
        store = await self.case_store_async()
        return await store.persist(case, created_by=created_by)

    async def adopt_work_sets(self, case: Any, *, by: str = "") -> list[dict[str, Any]]:
        """2026-09-18：工作集跟著影像走 —— 開一個「同影像、不同選取」的病例時，把別的病例裡我（們）的工作集搬過來。

        DB 模式：先搬 DB（`CaseStore.adopt_work_sets`），再把搬過來的結構重建進記憶體；舊病例若在記憶體也把那份拿掉。
        沒有 DB：只在記憶體裡搬。回傳搬動摘要（空 ＝ 沒事）。
        """
        if not case.uses_structure_sets:
            return []
        fors = [fg.frame_of_reference_uid for fg in case.frame_groups]
        moved: list[dict[str, Any]] = []
        if self.db_url:
            store = await self.case_store_async()
            moved = await store.adopt_work_sets(case.case_id, fors)
            real = [m for m in moved if "skipped" not in m]
            if real:
                loaded = await store.load(case.case_id)
                wanted = {m["structure_set_id"] for m in real}
                for ws in loaded.structure_sets:
                    if ws["structure_set_id"] in wanted and case.structure_set(ws["structure_set_id"]) is None:
                        case.structure_sets.append(dict(ws))
                rebuilt = self._adapters().rebuild_structures(loaded, store)
                for key, st in rebuilt.items():
                    if st.structure_set_id in wanted and key not in case.structures:
                        case.structures[key] = st
                # 舊病例還在記憶體 → 那份是過期的，拿掉（DB 已經沒有了）
                for m in real:
                    old = self.store._cases.get(m["from_case_id"])
                    if old is not None:
                        for k in [
                            k for k, st in old.structures.items() if st.structure_set_id == m["structure_set_id"]
                        ]:
                            old.structures.pop(k, None)
                        old.structure_sets[:] = [
                            w for w in old.structure_sets if w["structure_set_id"] != m["structure_set_id"]
                        ]
                case.touch()
        else:
            moved = self.store.adopt_work_sets_in_memory(case)
        real = [m for m in moved if "skipped" not in m]
        if real:
            from ..audit_events import new_event

            await self.audit(
                new_event(
                    user=by or "system",
                    action="workset.adopt",
                    status=200,
                    object_type="case",
                    object_id=case.case_id,
                    case_id=case.case_id,
                    client_id=None,
                    remote_addr=None,
                    detail={
                        "moved": [
                            {k: v for k, v in m.items() if k != "structure_ids"}
                            | {"count": len(m.get("structure_ids", []))}
                            for m in real
                        ]
                    },
                )
            )
        return moved

    async def reassemble_case(self, case: Any, selection: dict[str, Any]) -> Any:
        """同一個病例換一份選取（時間軸組成／拆開／攤開）→ **原地**重組，`case_id` 不變。

        資料集照新選取重組（影像網格、時間軸、匯入的 RTSTRUCT）；結構（含版本鏈）、簽核事件、量測、transform、
        手動對位、工作集與暫存集、劑量運算的暫存結果、client_seq 水位全部沿用。
        所有開著這個病例的 session 換指到新的 Case，
        各自推 `scene.replace`（前端看到時間軸變了會整條載入鏈重跑）。有 DB 就寫回（選取一起存，重啟後照新選取重組）。
        """
        from ..loaders.case import CaseSelection, build_case_dataset
        from ..state import _now_iso, rebuild_case

        index = await self.library_index_async()
        dataset = build_case_dataset(index, CaseSelection.from_wire(selection))
        structures = remap_temporal_frames(case.dataset, dataset, case.structures)
        new = rebuild_case(
            dataset=dataset,
            case_id=case.case_id,
            source=case.source,
            selection_hash=case.selection_hash,
            selection=selection,
            frame_groups=[fg.to_wire() for fg in case.frame_groups],
            structures=structures,
            review_events=case.review_events,
            transforms=case.transforms,
            measurements=case.measurements,
            created_at=case.created_at,
            updated_at=_now_iso(),
            structure_sets=[s for s in case.structure_sets if s.get("kind", "import") != "import"],
            keep_mask_grids=dict(case.mask_grids),
        )
        for s in case.dataset.series:
            if isinstance((s.params or {}).get("derived"), dict):
                new.add_derived_dose(s)
        new.jobs = case.jobs
        new.last_client_seq = case.last_client_seq
        new.retired_structure_ids = set(case.retired_structure_ids)
        # 原地換內容、物件不換：進行中的請求（合併、plugin 結果落地）拿著的是同一個 Case，之後寫的不會落在沒人看的
        # 舊物件上（以前換成新物件、session 改指過去）。上面到這裡沒有 await，不會插進別的寫入。
        case.__dict__.update(new.__dict__)
        sessions = self.store.sessions_of(case.case_id)
        await self.persist_case(case)
        for s in sessions:
            await self.publish(s.session_id, "scene.replace", s.scene_push())
        return case

    _case_locks: Any = None

    def case_lock(self, key: str) -> Any:
        """同一個病例（或同一組選取）的載入一次只有一個：兩個請求同時從 DB 載同一個病例，會有兩個活的 Case 物件，
        各自寫回整份快照時互相把對方的新結構標成刪除。"""
        import asyncio

        if self._case_locks is None:
            self._case_locks = {}
        lock = self._case_locks.get(key)
        if lock is None:
            lock = self._case_locks[key] = asyncio.Lock()
        return lock

    async def load_case_async(self, case_id: str, *, register: bool = True) -> Any:
        """從 DB 重組一個 Case（不在記憶體時）。需要 library 索引來重組資料集。
        `register=False`：不放進 `store`（不擁有即時病例的行程用完就丟）。
        `register=True` 時同一個病例一次只載一份：等鎖的時候別人已經載好了，就用那一份。"""
        if not register:
            return await self._load_case(case_id, register=False)
        async with self.case_lock(f"case:{case_id}"):
            try:
                return self.store.case(case_id)
            except KeyError:
                return await self._load_case(case_id, register=True)

    async def _load_case(self, case_id: str, *, register: bool) -> Any:
        from ..loaders.case import CaseSelection, build_case_dataset
        from ..state import rebuild_case

        store = await self.case_store_async()
        loaded = await store.load(case_id)
        index = await self.library_index_async()
        selection = CaseSelection.from_wire(loaded.case["selection"])
        dataset = build_case_dataset(index, selection)
        structures = self._adapters().rebuild_structures(loaded, store)
        case = rebuild_case(
            dataset=dataset,
            case_id=case_id,
            source=loaded.case["source"],
            selection_hash=loaded.case["selection_hash"],
            selection=loaded.case["selection"],
            frame_groups=loaded.frame_groups,
            structures=structures,
            review_events=loaded.review_events,
            transforms=loaded.transforms,
            measurements=loaded.measurements,
            created_at=loaded.case["created_at"],
            updated_at=loaded.case["updated_at"],
            structure_sets=loaded.structure_sets,
        )
        if register:
            self.store.register_case(case)
        case.retired_structure_ids = set(getattr(loaded, "retired_structure_ids", []) or [])
        return case

    _db_lock: Any = None

    async def ensure_db(self) -> None:
        """升級 schema、建立 CatalogStore（身分、目錄、job、稽核共用同一個引擎）。

        🔴 用鎖串行化：worker 在啟動時就會初始化 DB，與第一個請求同時跑 Alembic 升級會撞
        （症狀是 KeyError 'script' 之類的隨機錯，實際踩過）。
        """
        import asyncio

        if not self.db_url:
            raise KeyError("沒有設定 RTGAIA_DB_URL")
        if self._db_lock is None:
            self._db_lock = asyncio.Lock()
        async with self._db_lock:
            if self.catalog_store is None:
                self.catalog_store = self._adapters().catalog_store(self.db_url)
            if not self.db_ready:
                await asyncio.to_thread(self._adapters().upgrade_to_head, self.db_url)
                self.db_ready = True

    async def user_store_async(self) -> Any:

        await self.ensure_db()
        if self.user_store is None:
            self.user_store = self._adapters().user_store(self.catalog_store.engine)
        return self.user_store

    async def principal_for_token(self, token: str) -> Any:
        """token → Principal（DB 查一次後快取 60 s；停用／改角色最多 60 s 後生效）。"""
        import time
        from datetime import datetime

        from ..auth import parse_token_claims

        claims = parse_token_claims(token, self.secret)
        if claims is None:
            return None
        user_id, iat = claims
        cached = self._principal_cache.get(user_id)
        if cached and cached[0] > time.time():
            principal, changed_at = cached[1], cached[2]
        else:
            users = await self.user_store_async()
            row = await users.by_id(user_id)
            principal = None if row is None or row.disabled else users.principal(row)
            changed_at = 0
            if row is not None and getattr(row, "password_changed_at", None):
                try:
                    changed_at = int(datetime.fromisoformat(row.password_changed_at).timestamp() * 1000)
                except ValueError:
                    changed_at = 0
            self._principal_cache[user_id] = (time.time() + 60, principal, changed_at)
        # 改密碼之前簽的 token 作廢
        if principal is not None and iat < changed_at:
            return None
        return principal

    def invalidate_principal(self, user_id: str) -> None:
        """改密碼／角色／停用／解鎖後立刻生效（不必等 60 秒快取）；
        這個人開著的 WS 也立刻重驗。"""
        self._principal_cache.pop(user_id, None)
        for wake in list(self._ws_watches.get(user_id, ())):
            wake.set()

    def register_ws_watch(self, user_id: str) -> Any:
        import asyncio

        wake = asyncio.Event()
        self._ws_watches.setdefault(user_id, set()).add(wake)
        return wake

    def unregister_ws_watch(self, user_id: str, wake: Any) -> None:
        watches = self._ws_watches.get(user_id)
        if watches is not None:
            watches.discard(wake)
            if not watches:
                self._ws_watches.pop(user_id, None)

    catalog: Any = None
    """`LibraryIndex` 的樹狀視圖；索引換了就重建（`routes_catalog._catalog`）。"""
    importer: Any = None
    """匯入器：批次在記憶體、暫存區與 blobs 在 `library_root` 底下。"""

    def library_index(self, *, rescan: bool = False) -> Any:
        """同步版：**只給沒有 DB 的模式**。DB 模式一律 `await library_index_async()`。"""
        from ..library import LibraryIndex

        if not self.library_root:
            raise KeyError("沒有設定資料庫根目錄（RTGAIA_LIBRARY_ROOT 或 --library）")
        if self.db_url:
            if self.library is None or rescan:
                raise RuntimeError("DB 模式下請用 library_index_async()")
            return self.library
        if self.library is None or rescan:
            self.library = LibraryIndex.scan(self.library_root)
        return self.library

    async def library_index_async(self, *, rescan: bool = False) -> Any:
        """DB 模式：目錄的真相在 Postgres。

        * 第一次：升級 schema → 從 DB 載入 headers → 沒有任何列且有 `library_root` 就掃一次檔案系統寫進去。
        * `rescan=True`：以 DB 裡的 mtime＋size 當 `previous` 增量掃檔案系統 → 整批換掉 DB → 重建記憶體視圖。
        * 之後每次：對一下目錄世代（`replace_headers` 每次加一），別的行程改過就重新載入 —— 獨立 worker 不訂閱
          匯流排、收不到 `catalog.changed`，以前會一直用啟動時的目錄。
        沒有 DB 就退回同步版。
        """
        import asyncio

        if not self.db_url:
            return self.library_index(rescan=rescan)
        if not self.library_root:
            raise KeyError("沒有設定資料庫根目錄（RTGAIA_LIBRARY_ROOT 或 --library）")
        from ..library.scan import scan_tree

        await self.ensure_db()
        if self.library is not None and not rescan:
            if await self.catalog_store.generation() != self.library.generation:
                self.library = None
                self.catalog = None
        if self.library is None and not rescan:
            index = await self.catalog_store.load_index(self.library_root)
            if len(index.headers) == 0:
                rescan = True
            else:
                self.library = index
        if rescan or self.library is None:
            previous = await self.catalog_store.previous_map()
            headers = await asyncio.to_thread(scan_tree, self.library_root, previous=previous)
            self.library = await self.catalog_store.replace_headers(self.library_root, headers)
        return self.library


def state(request: Request) -> AppState:
    return request.app.state.rtgaia  # type: ignore[no-any-return]


_ID_RE = re.compile(r"^(?!\.+$)[\w.:-]+$")


def require_id(value: Any, *, field: str, max_len: int) -> str:
    """使用者（或 client）給的識別碼：1–`max_len` 個字元、只有字母數字底線點冒號連字號（會進 URL 路徑），否則 422。
    以前不驗 —— 一個超過欄寬的 id 進了病例，之後這個病例的每一次寫回 DB 都失敗。"""
    from fastapi import HTTPException

    text = str(value) if value is not None else ""
    if not text or len(text) > max_len or not _ID_RE.match(text):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "BAD_ID",
                "field": field,
                "max_length": max_len,
                "message": f"{field} 必須是 1–{max_len} 個字元的字母、數字、底線、點、冒號或連字號",
            },
        )
    return text


def actor(request: Request) -> str:
    """誰在操作：登入的 principal；`RTGAIA_AUTH=off` 時退回 `X-RTGaia-User` 標頭 stub，缺省 `anonymous`。"""
    principal = getattr(request.state, "principal", None)
    if principal is not None:
        return str(principal.username)
    return (request.headers.get("X-RTGaia-User") or "anonymous").strip() or "anonymous"


def session_for_study(app: AppState, request: Request, study_id: str, *, own: bool = False) -> Session:
    """以 study 找 session，**先找請求者自己的**。

    * `own=False`：Case 級的操作（結構、匯出、3D、量測）—— 自己的優先，沒有就用同病例任何一個（Case 資料都一樣）。
    * `own=True`：個人顯示狀態（網格重新協商、高品質重切比對 DisplayGrid）—— 帳號模式下只認自己的，沒有就 404
      （全域 KeyError → 404），不能退回別人的 session。`RTGAIA_AUTH=off` 沒有身分可言，照舊自己的優先。
    """
    strict = own and app.auth_mode == "required"
    return app.store.by_study(study_id, user=actor(request), strict=strict)


SESSION_HEADER = "X-RTGaia-Session"
"""檢視器每個請求都帶自己的 session id；用物件 id 定位的端點（結構、量測、序列）只在那個 session 裡找。"""


def _requested_session(request: Request) -> str | None:
    return (request.headers.get(SESSION_HEADER) or "").strip() or None


def session_for_structure(app: AppState, request: Request, structure_id: str) -> Session:
    """結構所在的 session —— 只找請求者自己的（`SessionStore.find_own`）。"""
    return app.store.find_own(
        actor(request),
        lambda s: any(sid == structure_id for sid, _ in s.structures),
        object_id=structure_id,
        missing=f"沒有結構 {structure_id}",
        session_id=_requested_session(request),
    )


def session_for_measurement(app: AppState, request: Request, measurement_id: str) -> Session:
    return app.store.find_own(
        actor(request),
        lambda s: measurement_id in s.measurements,
        object_id=measurement_id,
        missing=f"沒有量測 {measurement_id}",
        session_id=_requested_session(request),
    )


def session_for_series(app: AppState, request: Request, series_id: str) -> Session:
    """寫入用（例：提交 transform）：序列可能同時在好幾個病例裡，只找請求者自己的。讀影像仍用 `by_series`。"""
    return app.store.find_own(
        actor(request),
        lambda s: any(x.series_id == series_id for x in s.dataset.series),
        object_id=series_id,
        missing=f"沒有序列 {series_id}",
        session_id=_requested_session(request),
    )


def is_admin(request: Request) -> bool:
    principal = getattr(request.state, "principal", None)
    return bool(principal is not None and getattr(principal, "role", "") == "admin")


def readable_structure(session: Session, structure_id: str, frame: int | None, request: Request) -> Any:
    """**所有**讀結構的入口共用這一個閘：mask、mesh、versions、版本 mask、DVH、3D、匯出、plugin 輸入。

    暫存集只有觸發者看得到 —— 找不到與不可見**都回 404 `NO_STRUCTURE`**，不用 403：403 會告訴別人
    「這個 ID 存在但不是你的」。admin 也看不到別人的暫存結果（與 `Case.structure_list`／`can_edit` 一致：
    暫存是個人的工作台，不是病例資料）。先前只有 `/mask` 有這個檢查，mesh／versions／版本 mask
    都回 200。新端點要讀結構一律經這裡，不要再各自寫。
    """
    from fastapi import HTTPException

    try:
        st = session.structure(structure_id, frame)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "message": str(exc)}) from exc
    if session.case.is_transient_of_other(st.structure_set_id, actor(request)):
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "message": "別人的暫存結果不可見"})
    return st


def readable_dose(app: AppState, series_id: str, request: Request | None) -> tuple[Session, Any]:
    """讀劑量的共用閘：找不到、不是劑量、**別人的劑量運算暫存結果**都在這裡擋（後者跟暫存結構一樣回 404）。"""
    from fastapi import HTTPException

    try:
        session = app.store.by_series(series_id)
        series = session.dataset.series_by_id(series_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": series_id}) from exc
    if series.kind != "dose":
        raise HTTPException(status_code=422, detail={"code": "NOT_DOSE", "series_id": series_id, "kind": series.kind})
    if request is not None and session.case.is_derived_dose_of_other(series_id, actor(request)):
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": series_id})
    return session, series


def readable_structure_ids(session: Session, structure_ids: list[str], request: Request) -> list[str]:
    """一批 structure_id 全部經 `readable_structure`；任何一個看不到就整批 404（匯出、3D、plugin 輸入用）。"""
    for sid in structure_ids:
        readable_structure(session, sid, None, request)
    return list(structure_ids)


def remap_temporal_frames(old: Any, new: Any, structures: dict[Any, Any]) -> dict[Any, Any]:
    """同一條時間軸（key 不變）重組後幀變了（重新取樣補回中間的相位、或改回排除）→ 只屬某一幀的結構
    依**序列 UID** 換到新的幀號。新的時間軸沒有那一幀了 → `TA19`（不默默丟掉別人畫的輪廓）。

    只處理兩邊都有、而且是跨序列（每一幀一個序列）的時間軸；組成／拆開時 key 本來就換了，不在這裡。"""
    from rtgaia_geom import ContractViolation

    def frames_of(ds: Any) -> dict[str, tuple[str, ...]]:
        return {
            s.temporal_group_id: tuple(s.frame_series_uids)
            for s in ds.image_series
            if s.temporal_group_id is not None and len(set(s.frame_series_uids)) > 1
        }

    before, after = frames_of(old), frames_of(new)
    maps: dict[str, dict[int, int | None]] = {}
    for key, uids in before.items():
        if key in after and after[key] != uids:
            pos = {u: n for n, u in enumerate(after[key])}
            maps[key] = {n: pos.get(u) for n, u in enumerate(uids)}
    if not maps:
        return structures
    moves: list[tuple[Any, Any, int]] = []
    for (sid, frame), st in structures.items():
        m = maps.get(st.temporal_group_id) if frame is not None else None
        if m is None:
            continue
        target = m.get(frame)
        if target is None:
            # 先全部檢查完才動：擋下時原本的病例一點都沒變
            raise ContractViolation(
                "TA19",
                f"「{st.name}」畫在第 {frame + 1} 幀，這一幀改了之後就不在時間軸上；先刪掉或移到其他幀",
                structure_id=sid,
                frame_index=frame,
            )
        moves.append(((sid, frame), st, target))
    out = {k: st for k, st in structures.items() if k not in {key for key, _, _ in moves}}
    for (sid, _frame), st, target in moves:
        st.frame_index = target
        out[(sid, target)] = st
    return out


async def push_case(app: AppState, session: Session, message_type: str, payload: dict[str, Any]) -> int:
    """推給**同一個病例的所有 session**；並把病例寫回 DB（每個會推送的變更就是一個持久化點）。"""
    await app.persist_case(session.case)
    await app.publish(f"case:{session.case.case_id}", message_type, payload)
    return len(app.store.sessions_of(session.case.case_id))


async def push_scene_to_case(app: AppState, session: Session) -> int:
    """`scene.replace` 是 session 級（各自的 DisplayGrid）：每個 session 送**自己的** scene_push。也持久化。"""
    await app.persist_case(session.case)
    for s in app.store.sessions_of(session.case.case_id):
        await app.publish(s.session_id, "scene.replace", s.scene_push())
    return len(app.store.sessions_of(session.case.case_id))


def encode_frame(header: dict[str, Any], body: bytes, chaos: ChaosConfig, *, compress: bool = True) -> bytes:
    """JSON header ＋ zstd raw buffer 的單一訊框。
    同步、吃 CPU（大 volume 的 zstd）—— 大的放執行緒。"""
    return corrupt_frame(encode(header, body, compress=compress), chaos)


def payload_response(header: dict[str, Any], body: bytes, chaos: ChaosConfig, *, compress: bool = True) -> Response:
    """JSON header ＋ zstd raw buffer 的單一訊框回應。
    小的 payload（mask 區塊）用；大 volume 走 `encode_frame` ＋ `run_cpu`。"""
    return Response(content=encode_frame(header, body, chaos, compress=compress), media_type=CONTENT_TYPE)


def json_maybe_corrupted(payload: dict[str, Any], chaos: ChaosConfig) -> dict[str, Any]:
    return corrupt_json(payload, chaos)


def image_volume(session: Any, series_id: str, frame_index: int | None) -> tuple[np.ndarray, Grid]:
    """`session` 可以是 Session 或 Case（兩者都有 `.dataset`；worker 以 Case 呼叫）。"""
    from .. import dataset_io as phantoms

    series = session.dataset.series_by_id(series_id)
    vol = phantoms.volume(session.dataset, series, frame_index or 0)
    return vol, series.grid


def downsample(volume: np.ndarray, factor: tuple[int, int, int]) -> np.ndarray:
    """整數倍**盒平均**降採樣，與 `DisplayGrid.derive` 的 origin 算法配對。

    🔴 這裡若改成「每 f 個取一個」（strided），影像會相對 `DisplayGrid` 宣告的
    origin 偏移 `(f-1)/2 * spacing`——而 `DisplayGrid` 的 origin 是**盒中心**。
    兩邊必須是同一個約定，否則 Tier B 上所有結構看起來都偏半格。
    """
    fi, fj, fk = (int(v) for v in factor)
    if (fi, fj, fk) == (1, 1, 1):
        return np.ascontiguousarray(volume)
    nk = volume.shape[0] // fk
    nj = volume.shape[1] // fj
    ni = volume.shape[2] // fi
    trimmed = volume[: nk * fk, : nj * fj, : ni * fi].astype(np.float32)
    boxed = trimmed.reshape(nk, fk, nj, fj, ni, fi).mean(axis=(1, 3, 5))
    if np.issubdtype(volume.dtype, np.floating):
        # 劑量（float32 Gy）不得四捨五入 —— 0.5 Gy 的量化誤差在臨床上不可接受
        return np.ascontiguousarray(boxed.astype(volume.dtype))
    return np.ascontiguousarray(np.rint(boxed).astype(volume.dtype))


def lod_factor(lod: int) -> tuple[int, int, int]:
    """`lod` → 額外的降採樣倍率（多解析度金字塔）。"""
    f = 2 ** max(0, min(2, int(lod)))
    return (f, f, f)
