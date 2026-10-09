"""行程外 plugin 的宿主端（契約見 `docs/plugin-contract.md`）。

* **登錄**：admin 貼 endpoint ＋ bearer → 抓 manifest → schema／授權／api_version
  （與 `rtgaia_plugin_sdk.contract` 同一份驗證器）→ 存 `plugin` 表 → 廣播 `plugins.changed`。
* **健康檢查與版本協商**：`tick()` 每 `RTGAIA_PLUGIN_HEALTH_SECONDS`（預設 30）秒 `GET /health`；
  連續 3 次失敗 → `failed`；版本變了 → 重抓 manifest、重驗、更新快照、廣播。
  **開著的前端只提示重新載入**，不在頁內熱替換。
* **派工**：使用者 `POST /plugins/{id}/run` → job（kind `plugin:<id>`）→ worker 送 `POST {endpoint}/run`
  帶 RunRequest 與 scoped token；callback 模式等 plugin 打 `/done`，poll 模式由 `tick()` 輪詢；
  超過 `timeout_s` → failed。
* **回呼**：`/api/v1/plugins/{id}/jobs/{job}/…`，以 job token 認（不是使用者 cookie），
  並依 manifest `capabilities` 限範圍。
* **收包**：`POST …/results` → `validate_bundle_structure` ＋ `check_bundle_semantics`（B1–B8）
  → 接受的成員與抓回的檔案進 blob store `plugin-results/`，摘要進 job.result。
  接受的結構再落地成觸發者的暫存物件（`accept_results`）。

🔴 `deliver()` 對 `system` target 不進 WS；`plugins.changed` 要讓前端知道，所以用 `*` 廣播。
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import secrets
import socket
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import httpx
from rtgaia_geom import Grid, digest_bytes
from rtgaia_plugin_sdk.contract import (
    ContractError,
    check_bundle_semantics,
    validate_bundle_structure,
    validate_manifest,
)
from rtgaia_plugin_sdk.geometry import grid_to_json, nifti_bytes

from .jobs import TERMINAL, JobFinishedElsewhere, check_attempt
from .limits import SETTING_KEY_MAX, fit_id, limit
from .plugin_store import PluginRecord

HEALTH_FAILURES_TO_FAIL = 3
TOKEN_GRACE_SECONDS = 10 * 60
RESULTS_NAMESPACE = "plugin-results"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class PluginError(Exception):
    """plugin 契約的錯誤碼；路由轉成對應的 HTTP 狀態。"""

    def __init__(self, code: str, message: str, *, status: int = 422, pointer: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.status, self.pointer = code, message, status, pointer

    def __str__(self) -> str:
        # B7 的拒絕原因是 `str(exc)`：帶上 code，使用者才看得出是「來源未核可」而不是「網路不通」
        return f"{self.code}: {self.message}"

    def to_wire(self) -> dict[str, Any]:
        out = {"code": self.code, "message": self.message}
        if self.pointer:
            out["pointer"] = self.pointer
        return out


@dataclass(frozen=True)
class JobToken:
    """scoped token：綁 plugin id ＋ job id ＋ 到期；capabilities 從 manifest 讀（plugin 停用時立刻縮）。"""

    plugin_id: str
    job_id: str
    expires_at: str

    @staticmethod
    def issue(plugin_id: str, job_id: str, timeout_s: int) -> tuple[str, dict[str, Any]]:
        raw = secrets.token_urlsafe(32)
        expires = (datetime.now(UTC) + timedelta(seconds=timeout_s + TOKEN_GRACE_SECONDS)).isoformat(timespec="seconds")
        return raw, {"token_sha256": hashlib.sha256(raw.encode()).hexdigest(), "token_expires_at": expires}

    @staticmethod
    def verify(raw: str | None, job_request: dict[str, Any]) -> bool:
        if not raw:
            return False
        if hashlib.sha256(raw.encode()).hexdigest() != job_request.get("token_sha256"):
            return False
        return _now() <= str(job_request.get("token_expires_at", ""))


class PluginManager:
    def __init__(self, app: Any, store: Any) -> None:
        self.app = app
        self.store = store
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0))
        # 收包抓 artifact 用（同步、在執行緒裡）：**啟動時建好一個共用**。每次 `httpx.Client()` 都會重建
        # SSL context 去讀 certifi 的 CA 檔；venv 被 `uv sync` 換掉後舊行程讀不到那個檔 → FileNotFoundError
        # → 整包 B7（實際發生過）。
        self._fetch_client: httpx.Client | None = None  # 第一次收包時建（見 _fetch_http）
        self.health_seconds = float(_env("RTGAIA_PLUGIN_HEALTH_SECONDS", "30"))
        self.registration_token = _env("RTGAIA_PLUGIN_REGISTRATION_TOKEN", "")
        self.quota_bytes = int(float(_env("RTGAIA_TRANSIENT_MAX_GB", "2")) * 1024**3)
        self._last_tick = 0.0
        self._job_locks: dict[str, asyncio.Lock] = {}

    def job_lock(self, job_id: str) -> asyncio.Lock:
        """同一個 plugin 工作的回呼（進度、結果、完成）、輪詢、逾時、取消一次一個。
        以前各拿一份副本各自處理：poll 模式下 `/done` 與輪詢各收一次結果（暫存結構落地兩次）。
        拿到鎖之後要重讀那一列（`queue.get`），再看它還在不在跑。"""
        lock = self._job_locks.get(job_id)
        if lock is None:
            lock = self._job_locks[job_id] = asyncio.Lock()
        return lock

    async def close(self) -> None:
        await self._client.aclose()
        if self._fetch_client is not None:
            self._fetch_client.close()

    def _fetch_http(self) -> httpx.Client:
        """收 artifact 的共用同步 client。**懶建**：測試用 monkeypatch 換掉 `httpx.Client` 要在第一次收包前生效；
        真行程裡等於啟動後第一次收包就建好、之後共用（venv 被 `uv sync` 換掉那類失效點只在這一次出現）。"""
        if self._fetch_client is None:
            self._fetch_client = httpx.Client(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=False)
        return self._fetch_client

    # ── 查詢 ─────────────────────────────────────────────────────────────────
    async def list(self) -> list[PluginRecord]:
        return await self.store.list()

    async def get(self, plugin_id: str) -> PluginRecord:
        rec = await self.store.get(plugin_id)
        if rec is None:
            raise PluginError("PL-SCHEMA", f"沒有 plugin {plugin_id}", status=404)
        return rec

    async def get_active(self, plugin_id: str) -> PluginRecord:
        rec = await self.get(plugin_id)
        if not rec.enabled or rec.status not in ("active",):
            raise PluginError(
                "PL-DOWN", f"plugin {plugin_id} 狀態 {rec.status}{'' if rec.enabled else '（已停用）'}", status=503
            )
        return rec

    # ── 登錄與 manifest ───────────────────────────────────────────────────────
    def _headers(self, rec: PluginRecord, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Authorization": f"Bearer {rec.token}"} if rec.token else {}
        h.update(extra or {})
        return h

    async def fetch_manifest(self, endpoint: str, token: str, *, allow_licenses: list[str]) -> dict[str, Any]:
        try:
            r = await self._client.get(
                endpoint.rstrip("/") + "/manifest", headers={"Authorization": f"Bearer {token}"} if token else {}
            )
            r.raise_for_status()
            manifest = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise PluginError("PL-DOWN", f"抓不到 manifest：{exc}", status=502) from exc
        try:
            validate_manifest(manifest, allow_licenses=allow_licenses)
        except ContractError as exc:
            raise PluginError(exc.code, exc.message, pointer=exc.pointer) from exc
        return manifest

    async def register(
        self, *, endpoint: str, token: str, by: str, allow_licenses: list[str] | None = None
    ) -> PluginRecord:
        allow = list(allow_licenses or [])
        manifest = await self.fetch_manifest(endpoint, token, allow_licenses=allow)
        pid = str(manifest["id"])
        existing = await self.store.get(pid)
        rec = existing or PluginRecord(plugin_id=pid, endpoint=endpoint, registered_by=by)
        rec.endpoint, rec.token, rec.manifest, rec.allow_licenses = endpoint.rstrip("/"), token, manifest, allow
        rec.status, rec.error, rec.health_failures, rec.last_seen_at = "active", None, 0, _now()
        # UI bundle 的 digest 在登錄時釘住；之後代理每次比對（proxy_ui）
        rec.ui_digest = await self._ui_digest(rec) if rec.has_ui else None
        if allow:
            await self.app.audit(_audit(by, "plugin.license_override", pid, {"allow_licenses": allow}))
        await self.store.put(rec)
        await self.app.audit(
            _audit(by, "plugin.register" if existing is None else "plugin.update", pid, {"version": rec.version})
        )
        await self.changed(pid, "registered" if existing is None else "updated")
        return rec

    async def update(self, plugin_id: str, patch: dict[str, Any], *, by: str) -> PluginRecord:
        rec = await self.get(plugin_id)
        allowed = {"enabled", "token", "endpoint", "allow_licenses", "artifact_origins"}
        bad = set(patch) - allowed
        if bad:
            raise PluginError("PL-SCHEMA", f"未知欄位 {sorted(bad)}")
        if "artifact_origins" in patch:
            origins = [str(o).rstrip("/").lower() for o in (patch["artifact_origins"] or [])]
            for o in origins:
                u = urlsplit(o)
                if u.scheme not in ("http", "https") or not u.netloc or u.path or u.query or u.fragment:
                    raise PluginError("PL-SCHEMA", f"artifact origin 必須是 scheme://host[:port]：{o!r}")
            rec.artifact_origins = origins
            await self.store.put(rec)
            await self.app.audit(_audit(by, "plugin.artifact_origins", plugin_id, {"artifact_origins": origins}))
            patch = {k: v for k, v in patch.items() if k != "artifact_origins"}
            if not patch:
                return rec
        if "endpoint" in patch or "token" in patch or "allow_licenses" in patch:
            return await self.register(
                endpoint=str(patch.get("endpoint", rec.endpoint)),
                token=str(patch.get("token", rec.token)),
                by=by,
                allow_licenses=list(patch.get("allow_licenses", rec.allow_licenses)),
            )
        if "enabled" in patch:
            rec.enabled = bool(patch["enabled"])
            rec.status = "active" if rec.enabled else "disabled"
            rec.error = None
            await self.store.put(rec)
            await self.app.audit(_audit(by, "plugin.enable" if rec.enabled else "plugin.disable", plugin_id, {}))
            await self.changed(plugin_id, "enabled" if rec.enabled else "disabled")
        return rec

    async def remove(self, plugin_id: str, *, by: str) -> None:
        await self.get(plugin_id)
        await self.store.delete(plugin_id)
        await self.app.audit(_audit(by, "plugin.remove", plugin_id, {}))
        await self.changed(plugin_id, "removed")

    async def changed(self, plugin_id: str, what: str) -> None:
        await self.app.publish("*", "plugins.changed", {"pluginId": plugin_id, "what": what})

    # ── 健康檢查與版本協商 ────────────────────────────────────────────────────
    async def refresh(self, rec: PluginRecord) -> PluginRecord:
        if not rec.enabled:
            return rec
        try:
            r = await self._client.get(rec.endpoint + "/health", headers=self._headers(rec), timeout=10.0)
            r.raise_for_status()
            health = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            rec.health_failures += 1
            if rec.health_failures >= HEALTH_FAILURES_TO_FAIL and rec.status != "failed":
                rec.status, rec.error = "failed", f"健康檢查連續失敗：{exc}"
                await self.store.put(rec)
                await self.changed(rec.plugin_id, "failed")
            else:
                await self.store.put(rec)
            return rec
        rec.last_seen_at = _now()
        was_failed = rec.status == "failed"
        rec.health_failures = 0
        version = str(health.get("version", rec.version))
        if version != rec.version:
            try:
                manifest = await self.fetch_manifest(rec.endpoint, rec.token, allow_licenses=rec.allow_licenses)
                if manifest["id"] != rec.plugin_id:
                    raise PluginError("PL-SCHEMA", f"manifest id 變成 {manifest['id']}")
                rec.manifest, rec.status, rec.error = manifest, "active", None
                rec.ui_digest = await self._ui_digest(rec) if rec.has_ui else None
                await self.store.put(rec)
                await self.app.audit(
                    _audit("system", "plugin.version", rec.plugin_id, {"version": version, "ui_digest": rec.ui_digest})
                )
                await self.changed(rec.plugin_id, "version")
                return rec
            except PluginError as exc:
                rec.status, rec.error = ("license" if exc.code == "PL-LICENSE" else "version-mismatch"), exc.message
                await self.store.put(rec)
                await self.changed(rec.plugin_id, rec.status)
                return rec
        if was_failed or rec.status in ("failed",):
            rec.status, rec.error = "active", None
            await self.store.put(rec)
            await self.changed(rec.plugin_id, "recovered")
        else:
            await self.store.put(rec)
        return rec

    async def tick(self, *, force: bool = False) -> None:
        """健康檢查 ＋ poll 模式 job 輪詢 ＋ 逾時。由 app 的背景 task 每幾秒呼叫一次；測試直接呼叫。"""
        now = time.monotonic()
        if force or self.health_seconds > 0 and now - self._last_tick >= self.health_seconds:
            self._last_tick = now
            for rec in await self.store.list():
                await self.refresh(rec)
        await self._tick_jobs()

    # ── 派工 ─────────────────────────────────────────────────────────────────
    async def start_run(
        self,
        rec: PluginRecord,
        *,
        session: Any,
        principal_name: str,
        params: dict[str, Any],
        image_series_id: str | None,
        structure_ids: list[str],
        actor_role: str = "contourer",
    ) -> Any:
        from .jobs import new_job

        exec_ = rec.manifest.get("execution", {})
        timeout_s = int(exec_.get("timeout_s", 3600))
        series_id = image_series_id or _primary_series_id(session)
        # 面板會送選的影像（使用者可以選要 infer 哪一組 CT） —— 必須是這個病例裡的**影像**序列
        chosen = next((s for s in session.dataset.series if str(s.series_id) == str(series_id)), None)
        if chosen is None or chosen.kind != "image":
            raise PluginError("PL-SCHEMA", f"image_series_id 不是這個病例的影像序列：{series_id}", status=422)
        job = new_job(session.case.case_id, f"plugin:{rec.plugin_id}", {}, requested_by=principal_name)  # type: ignore[arg-type]
        raw, token_fields = JobToken.issue(rec.plugin_id, job.job_id, timeout_s)
        job.request = {
            "plugin_id": rec.plugin_id,
            "module_version": rec.module_version,
            "session_id": session.session_id,  # 推送目標提示；派工不再依賴它
            "study_id": session.dataset.study_id,
            "selection_hash": session.case.selection_hash,  # 重建後不符 → PL-CASE-CHANGED
            "case_id": session.case.case_id,
            "series_id": series_id,
            "structure_ids": list(structure_ids),
            "params": params,
            "actor": principal_name,
            # 排入前就寫好（以前排入後才補寫，worker 可能已經用預設值派工）
            "actor_role": actor_role,
            "timeout_s": timeout_s,
            "progress_mode": exec_.get("progress", "callback"),
            "plugin_job_id": None,
            "deadline_at": (datetime.now(UTC) + timedelta(seconds=timeout_s)).isoformat(timespec="seconds"),
            "callback_token": raw,  # 只在派工前存在；送出 RunRequest 後由 worker 抹掉
            **token_fields,
        }
        await (await self.app.job_queue_async()).enqueue(job)
        session.case.jobs[job.job_id] = job.to_wire()
        return job

    async def dispatch(self, job: Any) -> None:
        """worker 端：組 RunRequest → `POST {endpoint}/run`。成功後 job 留在 running（DEFERRED），等回呼或輪詢。"""
        rec = await self.get_active(job.request["plugin_id"])
        case = await self._case_for(job)
        series = case.dataset.series_by_id(job.request["series_id"])
        vol_hash = _series_content_hash(case, job.request["series_id"])
        base = f"{self.app.public_base_url()}/api/v1/plugins/{rec.plugin_id}/jobs/{job.job_id}"
        raw = job.request.pop("callback_token", None)
        if raw is None:
            raise PluginError("PL-SCOPE", "callback token 已用掉（重試派工不允許）", status=409)
        run_request = {
            "job_id": job.job_id,
            "callback": {"base_url": base, "token": raw, "expires_at": job.request["token_expires_at"]},
            "case": {
                "case_id": case.case_id,
                "primary_frame_of_reference_uid": case.mask_grid.grid.frame_of_reference_uid,
            },
            "inputs": {
                "image": {
                    "series_id": series.series_id,
                    "frame_of_reference_uid": series.grid.frame_of_reference_uid,
                    "modality": str(series.modality),
                    "grid": grid_to_json(series.grid),
                    "content_hash": vol_hash,
                    "url": base + "/inputs/image",
                    # 體素值的單位與比例（PET 換成 SUV 時存 SUV×100、value_scale 0.01）；CT／MR 沒有這兩欄
                    **(
                        {
                            "value_unit": series.params["value_unit"],
                            "value_scale": series.params.get("value_scale", 1.0),
                        }
                        if (series.params or {}).get("value_unit")
                        else {}
                    ),
                },
                "structures": [
                    {
                        "structure_id": sid,
                        "name": case.structure(sid).name,
                        "url": f"{base}/inputs/structures/{sid}",
                    }
                    for sid in job.request.get("structure_ids", [])
                    if (sid, None) in case.structures
                ],
                "params": job.request.get("params", {}),
            },
            "actor": {"username": job.requested_by, "role": job.request.get("actor_role", "contourer")},
            "timeout_s": job.request["timeout_s"],
        }
        job.request["image_content_hash"] = vol_hash

        def before(fresh: Any) -> bool:
            # 派工前：token 原文從佇列抹掉、記下影像 hash —— 只改這兩個欄位
            check_attempt(fresh, job)
            if fresh.status in TERMINAL:
                raise JobFinishedElsewhere(f"{job.job_id} 已經是 {fresh.status}")
            fresh.request.pop("callback_token", None)
            fresh.request["image_content_hash"] = vol_hash
            return True

        await self.app.mutate_job(job.job_id, before)
        try:
            r = await self._client.post(rec.endpoint + "/run", json=run_request, headers=self._headers(rec))
        except httpx.HTTPError as exc:
            raise PluginError("PL-DOWN", f"plugin 連不上：{exc}", status=503) from exc
        if r.status_code == 429:
            raise PluginError("PL-DOWN", "plugin 併發已滿（429）", status=503)
        if r.status_code != 202:
            raise PluginError("PL-DOWN", f"plugin /run 回 {r.status_code}：{r.text[:300]}", status=502)
        plugin_job_id = r.json().get("job_id", job.job_id)
        job.request["plugin_job_id"] = plugin_job_id
        job.phase, job.percent = "dispatched", 1

        def after(fresh: Any) -> bool:
            # plugin 可能已經回呼過（進度、結果，甚至做完）：只補 plugin 的 job id，進度只往前
            if fresh.status in TERMINAL:
                return False
            fresh.request["plugin_job_id"] = plugin_job_id
            if fresh.phase in ("queued", "running"):
                fresh.phase, fresh.percent = "dispatched", max(1, fresh.percent)
            return True

        await self.app.mutate_job(job.job_id, after)

    async def cancel(self, job: Any, *, by: str) -> None:
        rec = await self.get(job.request["plugin_id"])
        pjid = job.request.get("plugin_job_id") or job.job_id
        try:
            await self._client.delete(f"{rec.endpoint}/jobs/{pjid}", headers=self._headers(rec), timeout=10.0)
        except httpx.HTTPError:
            pass
        await self.finish(job, status="failed", error="cancelled")
        await self.app.audit(_audit(by, "plugin.cancel", rec.plugin_id, {"job_id": job.job_id}))

    async def finish(self, job: Any, *, status: str, error: str | None = None) -> None:
        """收尾（呼叫端持有 `job_lock`）：已經結束的不再動；回呼 token 隨終態失效（D.5）。"""
        finished_at = _now()

        def change(fresh: Any) -> bool:
            if fresh.status in TERMINAL:
                return False
            fresh.status, fresh.phase = status, status
            fresh.percent = 100 if status == "done" else fresh.percent
            fresh.error, fresh.finished_at = error, finished_at
            fresh.request.pop("token_sha256", None)
            return True

        written = await self.app.mutate_job(job.job_id, change)
        if written is None:
            return
        job.__dict__.update(written.__dict__)
        self._job_locks.pop(job.job_id, None)
        if status == "done":
            await self.app.notify_case(
                job.case_id, "job.progress", {"jobId": job.job_id, "phase": "done", "percent": 100}
            )
        else:
            await self.app.notify_case(
                job.case_id, "error", {"code": "JOB_FAILED", "message": error or "", "jobId": job.job_id}
            )

    async def _running_plugin_jobs(self) -> list[Any]:
        from .jobs import find_all

        # DB 端篩 running 的 plugin／service.call，全部分頁拿完（以前「最近 500 筆」會漏掉舊的長工作）
        queue = await self.app.job_queue_async()
        return await find_all(queue, status="running", kinds=["service.call"], kind_prefixes=["plugin:"])

    async def _tick_jobs(self) -> None:
        queue = await self.app.job_queue_async()
        for listed in await self._running_plugin_jobs():
            async with self.job_lock(listed.job_id):
                job = await queue.get(listed.job_id)  # 拿到鎖之後重讀：回呼可能剛處理完
                if job is None or job.status != "running":
                    continue
                if _now() > str(job.request.get("deadline_at", "9999")):
                    await self.finish(job, status="failed", error=f"timeout（{job.request.get('timeout_s')} s）")
                    continue
                if job.kind == "service.call":
                    await self._tick_service_call(job)
                elif job.request.get("progress_mode") == "poll" and job.request.get("plugin_job_id"):
                    await self._poll(job)

    async def _tick_service_call(self, job: Any) -> None:
        """service.call：`sent_at` 之後完成的 import job 裡，有同 study 的 RT 物件就算節點回傳了。"""
        sent_at = str(job.request.get("sent_at") or "")
        if not sent_at:
            return
        wanted = set(job.request.get("wanted_modalities") or ["RTSTRUCT", "SEG", "RTDOSE", "REG"])
        study_uid = str(job.request.get("study_instance_uid") or "")
        from .jobs import find_all

        queue = await self.app.job_queue_async()
        received: list[dict[str, Any]] = []
        # `sent_at` 之後完成的 import，DB 端篩（以前是最近 500 筆，流量大時回傳會「消失」）
        for imp in await find_all(queue, status="done", kinds=["import"], finished_after=sent_at):
            for s in imp.result.get("series", []):
                if s.get("study_instance_uid") == study_uid and s.get("modality") in wanted:
                    received.append({**s, "import_job_id": imp.job_id})
        if not received:
            return

        def record(fresh: Any) -> bool:
            if fresh.status in TERMINAL:
                return False
            fresh.result = {**fresh.result, "received": received, "node_id": fresh.request.get("node_id")}
            return True

        if await self.app.mutate_job(job.job_id, record) is None:
            return
        await self.finish(job, status="done")
        await self.app.notify_case(
            job.case_id,
            "service.received",
            {
                "jobId": job.job_id,
                "nodeId": job.request.get("node_id"),
                "nodeName": job.request.get("node_name"),
                "received": received,
                "requestedBy": job.requested_by,
            },
        )
        await self.app.audit(
            _audit(
                job.requested_by,
                "service.received",
                str(job.request.get("node_id")),
                {"job_id": job.job_id, "received": received},
            )
        )

    async def _poll(self, job: Any) -> None:
        rec = await self.store.get(job.request["plugin_id"])
        if rec is None:
            await self.finish(job, status="failed", error="plugin 已移除")
            return
        pjid = job.request["plugin_job_id"]
        try:
            r = await self._client.get(f"{rec.endpoint}/jobs/{pjid}", headers=self._headers(rec), timeout=10.0)
            r.raise_for_status()
            st = r.json()
        except (httpx.HTTPError, ValueError):
            return  # 下次再問
        if st.get("status") == "failed":
            await self.finish(job, status="failed", error=str(st.get("error") or "plugin 回報失敗"))
        elif st.get("status") == "done":
            try:
                res = await self._client.get(f"{rec.endpoint}/jobs/{pjid}/result", headers=self._headers(rec))
                res.raise_for_status()
                outcome = await self.accept_results(job, res.json())
            except (httpx.HTTPError, ValueError) as exc:
                await self.finish(job, status="failed", error=f"拉結果失敗：{exc}")
                return
            except PluginError as exc:
                await self.finish(job, status="failed", error=exc.message)
                return
            await self._finish_from_outcome(job, outcome)
        else:
            pct = st.get("percent")
            if isinstance(pct, (int, float)):
                await self.progress(job, float(pct), st.get("phase"))

    async def _finish_from_outcome(self, job: Any, outcome: dict[str, Any]) -> None:
        n_ok, n_bad = len(outcome.get("accepted", [])), len(outcome.get("rejected", []))
        if n_ok == 0 and n_bad > 0:
            # 曾經 117 個結構全被 B7 拒、訊息只有第一個的 reason，看不出「全部同一個原因」
            # 還是各自不同 → 依 code 計數，reason 取第一個。
            counts: dict[str, int] = {}
            for r in outcome["rejected"]:
                counts[str(r.get("code", "?"))] = counts.get(str(r.get("code", "?")), 0) + 1
            codes = "、".join(f"{c}×{n}" for c, n in sorted(counts.items(), key=lambda kv: -kv[1]))
            first = outcome["rejected"][0]
            await self.finish(job, status="failed", error=f"全部 {n_bad} 個成員被拒（{codes}）：{first['reason']}")
        else:
            await self.finish(job, status="done")

    # ── 回呼 ─────────────────────────────────────────────────────────────────
    async def job_for_callback(self, plugin_id: str, job_id: str, raw_token: str | None, capability: str | None) -> Any:
        job = await (await self.app.job_queue_async()).get(job_id)
        if job is None or job.request.get("plugin_id") != plugin_id:
            raise PluginError("PL-SCOPE", "job 不存在或不屬於這個 plugin", status=403)
        if not JobToken.verify(raw_token, job.request):
            raise PluginError("PL-SCOPE", "token 不符或已到期", status=403)
        if job.status in TERMINAL:  # 結束的工作不再收任何回呼（以前派工失敗後 token 仍然有效）
            raise PluginError("PL-SCOPE", "job 已經結束", status=409)
        if capability is not None:
            rec = await self.get(plugin_id)
            if capability not in rec.capabilities:
                raise PluginError("PL-SCOPE", f"manifest 沒宣告 capability {capability}", status=403)
        return job

    async def _case_for(self, job: Any) -> Any:
        """job 只引用**可持久重建**的病例：`case_async` 在 API 行程拿記憶體那份、在獨立 worker 從 DB 重建。
        先前是 `store.get(session_id)`——worker 沒有 API 的 session，一派工就 `KeyError`。
        病例在 job 飛行期間被改（selection 換了）→ 明確失敗，不拿舊快照算出對不上的結果。"""
        case = await self.app.case_async(job.case_id)
        expected = job.request.get("selection_hash")
        if "selection_hash" in job.request and case.selection_hash != expected:
            raise PluginError("PL-CASE-CHANGED", "病例的選取在 job 進行期間改變，結果無法對應", status=409)
        return case

    async def image_nifti(self, job: Any) -> tuple[bytes, Grid, str]:
        from .api.deps import image_volume

        case = await self._case_for(job)
        vol, grid = image_volume(case, job.request["series_id"], None)
        scale = float((case.dataset.series_by_id(job.request["series_id"]).params or {}).get("value_scale") or 1.0)
        if scale != 1.0:
            # PET 存 SUV×100 → NIfTI 給實際的 SUV（float32），plugin 不用知道存法
            import numpy as np

            vol = np.asarray(vol, dtype=np.float32) * np.float32(scale)
        data = nifti_bytes(vol, grid)
        return (
            data,
            grid,
            job.request.get("image_content_hash") or _series_content_hash(case, job.request["series_id"]),
        )

    async def structure_nifti(self, job: Any, structure_id: str) -> bytes:
        import numpy as np

        case = await self._case_for(job)
        st = case.structure(structure_id)
        mg = case.mask_grid_for(st.frame_of_reference_uid)
        full = np.zeros(tuple(reversed(mg.grid.size)), dtype=np.uint8)
        o, s = st.offset_ijk, st.size_ijk
        full[o[2] : o[2] + s[2], o[1] : o[1] + s[1], o[0] : o[0] + s[0]] = st.block
        return nifti_bytes(full, mg.grid)

    async def progress(self, job: Any, percent: float, phase: str | None) -> None:
        """回呼或輪詢來的進度（呼叫端持有 `job_lock`）：只改 phase／percent，結束了的不動。"""
        pct = int(max(0, min(100, percent)))

        def change(fresh: Any) -> bool:
            if fresh.status in TERMINAL:
                return False
            fresh.percent = pct
            if phase:
                fresh.phase = phase
            return True

        written = await self.app.mutate_job(job.job_id, change)
        if written is None:
            return
        job.phase, job.percent = written.phase, written.percent
        await self.app.notify_case(
            job.case_id, "job.progress", {"jobId": job.job_id, "phase": job.phase, "percent": job.percent}
        )

    async def accept_results(self, job: Any, bundle: dict[str, Any]) -> dict[str, Any]:
        """驗（結構＋B1–B8）→ 存（blob store）→ job.result 摘要，再把接受的成員變成暫存物件。"""
        rec = await self.get(job.request["plugin_id"])
        try:
            validate_bundle_structure(bundle)
        except ContractError as exc:
            raise PluginError(exc.code, exc.message, pointer=exc.pointer) from exc
        case = await self._case_for(job)
        mask_grids = {for_uid: mg.grid for for_uid, mg in case.mask_grids.items()}
        fetched: dict[str, bytes] = {}
        # 配額：這個 job 已收的 bytes ＋ 這個人在這個病例已有的暫存結構（跨 job 加總，D.12）
        used = int(job.result.get("bytes", 0)) + sum(
            st.block.nbytes for st in case.transient_structures(job.requested_by)
        )
        quota_left = max(0, self.quota_bytes - used)
        fetch = self._artifact_fetcher(
            rec, fetched, cap_bytes=min(quota_left, limit("RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES"))
        )
        # 抓檔與 NIfTI 解碼是同步 I/O ＋ CPU，放到執行緒；事件迴圈不被慢 plugin 拖住
        accepted, rejected = await asyncio.to_thread(
            check_bundle_semantics,
            bundle,
            expected_module_version=rec.module_version,
            known_frame_of_reference_uids=list(mask_grids),
            mask_grids=mask_grids,
            quota_bytes=quota_left,
            fetch=fetch,
        )
        blobs = self.app.blob_store()
        stored: dict[str, str] = {}
        for url, data in fetched.items():
            stored[url] = blobs.put(
                data, namespace=RESULTS_NAMESPACE, key=f"{job.job_id}-{digest_bytes(url.encode(), length=12)}"
            )
        summary = {
            "bundle": bundle,
            "accepted": [
                {k: (v if not isinstance(v, Grid) else grid_to_json(v)) for k, v in a.items()} for a in accepted
            ],
            "rejected": [r.to_wire() for r in rejected],
            "files": stored,
        }
        # 接受的結構落地成**真結構**，掛在觸發者的暫存集（只有他看得到；不進 DB；可編輯；不能簽核）
        made = await self._materialize_structures(job, case, rec, bundle, accepted, fetched)
        skipped = [a["kind"] for a in accepted if a["kind"] in ("image", "dose")]
        added_bytes = sum(len(d) for d in fetched.values())

        def record(fresh: Any) -> bool:
            # 呼叫端持有 `job_lock`；worker 的派工寫回可能同時發生 → 套在最新的那一列上
            res = fresh.result
            res.setdefault("bundles", []).append(summary)
            res["accepted"] = res.get("accepted", 0) + len(accepted)
            res["rejected"] = res.get("rejected", 0) + len(rejected)
            res["bytes"] = int(res.get("bytes", 0)) + added_bytes
            res["module_version"] = rec.module_version
            res["materialized"] = res.get("materialized", 0) + len(made)
            if skipped:
                res["not_materialized"] = res.get("not_materialized", []) + skipped  # 影像／劑量暫存留後續批
            return True

        written = await self.app.mutate_job(job.job_id, record)
        if written is not None:
            job.result = written.result
        batch_index = len(job.result.get("bundles", [])) - 1
        await self.app.audit(
            _audit(
                job.requested_by,
                "plugin.results",
                rec.plugin_id,
                {"job_id": job.job_id, "batch": batch_index, "accepted": len(accepted), "rejected": len(rejected)},
            )
        )
        return {
            "accepted": [
                {"kind": a["kind"], "index": a["index"], "id": f"{job.job_id}:{batch_index}:{a['kind']}:{a['index']}"}
                for a in accepted
            ],
            "rejected": [r.to_wire() for r in rejected],
        }

    async def _materialize_structures(
        self,
        job: Any,
        case: Any,
        rec: PluginRecord,
        bundle: dict[str, Any],
        accepted: list[dict[str, Any]],
        fetched: dict[str, bytes],
    ) -> list[str]:
        import numpy as np
        from rtgaia_geom import Provenance, payload_content_hash

        from .state import StructureState

        owner = job.requested_by
        parent_hash = job.request.get("image_content_hash")
        made: list[str] = []
        labelmaps: dict[str, np.ndarray] = {}
        for a in accepted:
            if a["kind"] != "structure":
                continue
            member = bundle["structures"][a["index"]]
            mask = member["mask"]
            for_uid = member["frame_of_reference_uid"]
            mg = case.mask_grid_for(for_uid)
            if mask["encoding"] == "labelmap":
                if mask["url"] not in labelmaps:
                    from rtgaia_plugin_sdk.geometry import nifti_from_bytes

                    labelmaps[mask["url"]], _ = nifti_from_bytes(fetched[mask["url"]], frame_of_reference_uid=for_uid)
                full = labelmaps[mask["url"]] == int(mask["value"])
            elif mask["encoding"] == "json-mask":
                import base64

                import zstandard

                bits = zstandard.ZstdDecompressor().decompress(base64.b64decode(mask["bits"]))
                bb = mask["bbox_ijk"]
                size = tuple(int(v) for v in bb["size"])
                block = np.unpackbits(np.frombuffer(bits, dtype=np.uint8))[: size[0] * size[1] * size[2]]
                full = np.zeros(tuple(reversed(mg.grid.size)), dtype=bool)
                o = [int(v) for v in bb["offset"]]
                full[o[2] : o[2] + size[2], o[1] : o[1] + size[1], o[0] : o[0] + size[0]] = block.reshape(
                    size[2], size[1], size[0]
                ).astype(bool)
            else:
                continue  # dicom-rtstruct／dicom-seg：由匯入 loader 轉換，本批不落地
            # 裁到 bbox；全空（allow_empty）就給 1 個體素的空塊
            nz = np.argwhere(full)
            if nz.size == 0:
                offset, size_ijk, block_arr = (0, 0, 0), (1, 1, 1), np.zeros((1, 1, 1), dtype=np.uint8)
            else:
                lo, hi = nz.min(axis=0), nz.max(axis=0) + 1  # (k, j, i)
                block_arr = full[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]].astype(np.uint8)
                offset, size_ijk = (
                    (int(lo[2]), int(lo[1]), int(lo[0])),
                    (int(hi[2] - lo[2]), int(hi[1] - lo[1]), int(hi[0] - lo[0])),
                )
            tset = case.transient_set_for(owner, for_uid, module_version=rec.module_version)
            structure_id = case.unique_structure_id(f"pl_{job.job_id[-6:]}_{a['index']:03d}")
            st = StructureState(
                structure_id=structure_id,
                name=member["name"],
                color_rgb=tuple(int(v) for v in member["color_rgb"]),  # type: ignore[arg-type]
                frame_of_reference_uid=for_uid,
                offset_ijk=offset,
                size_ijk=size_ijk,
                block=np.ascontiguousarray(block_arr),
                content_hash=payload_content_hash(
                    offset_ijk=offset, size_ijk=size_ijk, data=block_arr.tobytes(), prefix="mh_"
                ),
                provenance=Provenance(source="model", module_version=rec.module_version, parent_hash=parent_hash),
                status="ai_generated",
                tg263_code=member.get("tg263_code"),
                structure_set_id=tset["structure_set_id"],
                created_by=f"plugin:{rec.plugin_id}",
                updated_by=owner,
            )
            case.structures[st.key] = st
            tset["roi_count"] = int(tset.get("roi_count", 0)) + 1
            made.append(structure_id)
        if made:
            case.touch()
            await self.push_to_owner(case.case_id, owner, made)
        return made

    async def push_to_owner(self, case_id: str, owner: str, structure_ids: list[str]) -> None:
        """只推給擁有者自己的 session（別人看不到暫存結果）；用 `layer.add` ＋ `structure_sets.changed`。"""
        for s in self.app.store.sessions_of(case_id):
            if s.user != owner:
                continue
            layers = {x["contentRef"]: x for x in s.layers() if x["kind"] == "mask"}
            for sid in structure_ids:
                if sid in layers:
                    await self.app.publish(s.session_id, "layer.add", layers[sid])
            await self.app.publish(s.session_id, "structure_sets.changed", {"caseId": case_id})

    # ── KV ───────────────────────────────────────────────────────────────────
    async def kv_get(self, plugin_id: str, namespace: str, key: str) -> Any:
        store = await self.app.settings_store_async()
        bag = await store.get(_kv_key(plugin_id, namespace)) or {}
        if key not in bag:
            raise PluginError("PL-SCHEMA", "no such key", status=404)
        return bag[key]

    async def kv_put(self, plugin_id: str, namespace: str, key: str, value: Any, *, by: str) -> None:
        store = await self.app.settings_store_async()
        skey = _kv_key(plugin_id, namespace)
        bag = await store.get(skey) or {}
        bag[key] = value
        encoded = json.dumps(bag, ensure_ascii=False)
        if len(json.dumps(value, ensure_ascii=False)) > 1024 * 1024:
            raise PluginError("PL-QUOTA", "單一 key 超過 1 MB", status=413)
        if len(encoded) > int(_env("RTGAIA_PLUGIN_KV_MAX_MB", "16")) * 1024 * 1024:
            raise PluginError("PL-QUOTA", "plugin KV 總量超過上限", status=413)
        await store.put(skey, bag, updated_by=by)

    async def kv_delete(self, plugin_id: str, namespace: str, key: str, *, by: str) -> None:
        store = await self.app.settings_store_async()
        skey = _kv_key(plugin_id, namespace)
        bag = await store.get(skey) or {}
        if key in bag:
            del bag[key]
            await store.put(skey, bag, updated_by=by)

    # ── 代理 ─────────────────────────────────────────────────────────────────
    async def proxy(
        self,
        rec: PluginRecord,
        *,
        method: str,
        path: str,
        query: str,
        body: bytes,
        content_type: str | None,
        actor: str,
        role: str,
    ) -> httpx.Response:
        url = f"{rec.endpoint}/{path.lstrip('/')}" + (f"?{query}" if query else "")
        headers = self._headers(rec, {"X-RTGaia-Actor": actor, "X-RTGaia-Role": role})
        if content_type:
            headers["Content-Type"] = content_type
        try:
            return await self._client.request(method, url, content=body, headers=headers)
        except httpx.HTTPError as exc:
            raise PluginError("PL-DOWN", f"plugin 連不上：{exc}", status=503) from exc

    # ── UI bundle 與 artifact 來源 ────────────────────────────────
    async def _ui_digest(self, rec: PluginRecord) -> str:
        """登錄時抓一次 bundle 算 sha256；抓不到就不讓登錄過（有 ui 卻拿不到 bundle 是壞的登錄）。"""
        path = rec.ui_bundle_path or ""
        try:
            r = await self._client.get(rec.endpoint + path, headers=self._headers(rec), timeout=30.0)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise PluginError("PL-DOWN", f"抓不到 UI bundle {path}：{exc}", status=502) from exc
        return hashlib.sha256(r.content).hexdigest()

    async def proxy_ui(self, rec: PluginRecord, path: str, *, actor: str, role: str) -> httpx.Response:
        """只代理 manifest 宣告的那一支 bundle；內容 sha256 必須等於登錄時釘住的 digest。

        不符 → plugin 標 `quarantined`（`get_active` 從此拒絕；要恢復得 admin 重新登錄、確認新 digest）、稽核、廣播，
        回 502 `PL-UI-DIGEST`。這不是沙箱：受信任 UI 仍以宿主權限執行；這裡保證的是「執行的就是核准過的那份」。
        """
        wanted = (rec.ui_bundle_path or "").removeprefix("/ui/")
        if not rec.has_ui or path != wanted:
            raise PluginError("PL-UI-PATH", f"只代理 manifest 宣告的 bundle（{rec.ui_bundle_path}）", status=404)
        upstream = await self.proxy(
            rec, method="GET", path=f"ui/{path}", query="", body=b"", content_type=None, actor=actor, role=role
        )
        if upstream.status_code == 200:
            digest = hashlib.sha256(upstream.content).hexdigest()
            if rec.ui_digest and digest != rec.ui_digest:
                rec.status, rec.error = (
                    "quarantined",
                    f"UI bundle digest 不符（登錄 {rec.ui_digest[:12]}…，現在 {digest[:12]}…）",
                )
                await self.store.put(rec)
                await self.app.audit(
                    _audit("system", "plugin.quarantine", rec.plugin_id, {"expected": rec.ui_digest, "actual": digest})
                )
                await self.changed(rec.plugin_id, "quarantined")
                raise PluginError("PL-UI-DIGEST", rec.error, status=502)
        return upstream

    def _check_artifact_url(self, rec: PluginRecord, url: str) -> str:
        """bundle 給的 URL 只能指向核可的 origin（endpoint 自己 ∪ manifest ∪ admin 核可），
        協定只允許 http／https，路徑不得含 `..`，解析後的 IP 不得是 link-local／metadata／未指定位址。
        院內 plugin 合法使用私有網段——所以**不**一律擋 RFC1918，而是要求 origin 明確核可（endpoint 本身就是）。"""
        u = urlsplit(url)
        if u.scheme.lower() not in ("http", "https") or not u.netloc:
            raise PluginError("PL-ARTIFACT-ORIGIN", f"artifact URL 協定不允許：{url[:80]}")
        origin = f"{u.scheme.lower()}://{u.netloc.lower()}"
        if origin not in rec.effective_artifact_origins():
            raise PluginError(
                "PL-ARTIFACT-ORIGIN", f"artifact 來源 {origin} 未核可（manifest artifact_origins 或管理頁）"
            )
        if ".." in u.path.split("/"):
            raise PluginError("PL-ARTIFACT-ORIGIN", "artifact 路徑含 ..")
        host = u.hostname or ""
        try:
            infos = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
        except OSError as exc:
            raise PluginError("PL-ARTIFACT-ORIGIN", f"artifact 主機解析失敗：{host}（{exc}）") from exc
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved:
                raise PluginError("PL-ARTIFACT-ORIGIN", f"artifact 主機 {host} 解析到 {ip}，不允許")
        return url

    def _artifact_fetcher(self, rec: PluginRecord, fetched: dict[str, bytes], *, cap_bytes: int) -> Any:
        """同步 fetch（在執行緒裡跑）：來源檢查 → 串流下載邊累計 → 超過 cap 立刻停。憑證只附給核可的來源。"""
        headers = self._headers(rec)

        def fetch(url: str) -> bytes:
            if url.startswith("data:"):
                import base64

                return base64.b64decode(url.split(",", 1)[1])
            self._check_artifact_url(rec, url)
            if True:  # 共用 client（見 __init__）；縮排保留讓 diff 小
                with self._fetch_http().stream("GET", url, headers=headers) as r:
                    if 300 <= r.status_code < 400:
                        raise PluginError(
                            "PL-ARTIFACT-ORIGIN", f"artifact 重導向到 {r.headers.get('location', '?')[:80]}，不跟"
                        )
                    r.raise_for_status()
                    declared = r.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > cap_bytes:
                        raise PluginError(
                            "PL-QUOTA", f"artifact 宣告 {declared} bytes 超過上限 {cap_bytes}", status=413
                        )
                    buf = bytearray()
                    for chunk in r.iter_bytes():
                        buf.extend(chunk)
                        if len(buf) > cap_bytes:
                            raise PluginError(
                                "PL-QUOTA", f"artifact 超過上限 {cap_bytes} bytes（下載中止）", status=413
                            )
            fetched[url] = bytes(buf)
            return fetched[url]

        return fetch


# ── helpers ───────────────────────────────────────────────────────────────────


def _kv_key(plugin_id: str, namespace: str) -> str:
    """KV 存在 `app_setting`（鍵 64 字）：長的 plugin id ＋ 使用者命名空間截斷加雜湊（以前超過就寫不進去、回 500）。"""
    return fit_id(f"plugin-kv:{plugin_id}:{namespace}", SETTING_KEY_MAX)


def _env(name: str, default: str) -> str:
    import os

    return os.environ.get(name, default)


def _audit(user: str, action: str, plugin_id: str, detail: dict[str, Any]) -> dict[str, Any]:
    from .audit_events import new_event

    return new_event(
        user=user,
        action=action,
        status=200,
        object_type="plugin",
        object_id=plugin_id,
        case_id=None,
        client_id=None,
        remote_addr=None,
        detail={"module": plugin_id, **detail},
    )


def _primary_series_id(session: Any) -> str:
    for s in session.dataset.series:
        if s.role == "primary" and s.kind == "image":
            return str(s.series_id)
    return str(session.dataset.series[0].series_id)


def _series_content_hash(case: Any, series_id: str) -> str:
    """輸入影像的 content hash（→ bundle `parent_hash`）：以序列 id ＋ 網格為身分，不重算體素（那要幾秒）。"""
    series = case.dataset.series_by_id(series_id)
    ident = json.dumps({"case": case.case_id, "series": series_id, "grid": grid_to_json(series.grid)}, sort_keys=True)
    return "sha256:" + hashlib.sha256(ident.encode()).hexdigest()
