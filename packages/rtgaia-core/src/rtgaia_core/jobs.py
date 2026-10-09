"""Job 佇列與 worker。

* `Job`：一個非同步工作（現在只有 `export`；之後 `import`、`inference`、`render3d` 都是同一張表）。
* `MemoryJobQueue`（沒有 DB）與 `DbJobQueue`（Postgres，`FOR UPDATE SKIP LOCKED` 領工作）同一個介面。
* `worker_loop(app)`：app 啟動時一條 asyncio task，輪詢領工作 → 依 `kind` 執行 → 進度寫回佇列並推 `job.progress`。
  單行程時 worker 就在 app 裡；多行程（第 4 段）時可以另起 `rtgaia-testbe worker` 行程連同一個 DB。
* 結果（匯出的 RTSTRUCT）進 blob store（namespace `exports`），下載端點從那裡讀 —— 重啟後仍可下載。
* 用 DB 當佇列而非 Celery 的理由：job 狀態與領域狀態在同一個資料庫、同一套備份與交易語意；
  現階段的量（每病例幾次匯出）也遠不需要 broker。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import socket
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

log = logging.getLogger(__name__)

JobKind = Literal["export", "import", "send", "retrieve", "plugin", "service.call"]
JobStatus = Literal["queued", "running", "done", "failed"]

MAX_ATTEMPTS = 3
STALE_RUNNING_SECONDS = 30 * 60
"""（舊）回收門檻；之後改用租約，
只剩 migration 0023 把升級當下 running 的列換算成租約時用。"""

LEASE_SECONDS = 120.0
"""租約長度：worker 領到工作時拿到 `attempt_id` 與 `lease_until`，執行期間每 `LEASE_SECONDS / 3`
續約一次（心跳）。只有租約**真的過期**（worker 死了、網路斷了）的 running 工作才會被回收重排 —— 以前是「started_at 超過
30 分鐘」，活著的長工作（例：plugin 推論）也會被重派。"""
RECLAIM_EVERY_SECONDS = 15.0
"""回收過期租約是低頻、有上限的批次（不是每次領工作都把全部 running 列拉進 Python）。"""
RECLAIM_BATCH = 100


class StaleAttempt(RuntimeError):
    """這個 attempt 已經不是目前的那一個（租約過期被回收、別的 worker 接手）—— 它的結果不能寫回去。"""


class JobChanged(RuntimeError):
    """寫回時發現這一列在讀出之後被別人寫過（`version` 不同）→ 重讀、重套自己的改變再寫（`mutate_job`）。

    以前整列覆寫、最後寫的贏 —— 取消被 worker 的進度蓋回 running、plugin 早到的結果
    被派工的寫回蓋掉、worker 每次寫進度都把領取當下的租約寫回去（心跳延長的被縮短，長工作會被回收重跑）。"""


class JobFinishedElsewhere(RuntimeError):
    """worker 還在跑，這一列已經在別處結束了（取消、逾時）—— 停下來，不寫回。"""


TERMINAL: frozenset[str] = frozenset({"done", "failed"})


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _precise(dt: datetime) -> str:
    """租約時間用微秒（32 字元，欄位寬度剛好）：秒精度下短租約會「一領到就過期」。"""
    return dt.astimezone(UTC).isoformat(timespec="microseconds")


def now_precise() -> str:
    return _precise(datetime.now(UTC))


def lease_deadline(seconds: float | None = None) -> str:
    return _precise(datetime.now(UTC) + timedelta(seconds=LEASE_SECONDS if seconds is None else seconds))


@dataclass
class Job:
    job_id: str
    case_id: str
    kind: JobKind
    request: dict[str, Any]
    requested_by: str = "anonymous"
    requested_at: str = field(default_factory=_now)
    status: JobStatus = "queued"
    phase: str = "queued"
    percent: int = 0
    result: dict[str, Any] = field(default_factory=dict)
    result_blob_key: str | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    worker_id: str | None = None
    attempts: int = 0
    lease_until: str | None = None
    """租約期限；None ＝ 沒有租約（queued、已結束，或已派送給外部、由自己的 deadline 管的 DEFERRED 工作）。"""
    attempt_id: str | None = None
    """這一次領取的代號：`update` 只接受目前的 attempt，舊 worker 的結果寫不回去。"""
    version: int = 0
    """這一列被寫過幾次：`update` 只接受跟佇列裡一樣的版本，不一樣就 `JobChanged`。"""
    parent: Job | None = field(default=None, repr=False, compare=False)
    """子步驟（匯出後存進資料庫、C-GET 後的匯入、service.call 的送出）：借用父工作的身分執行，**自己不寫進佇列**。
    以前子步驟各自寫回 —— 同一個 job_id 的被改成 kind=import、status=queued（多個 worker 時會被別人領走重跑、
    匯出結果與下載連結遺失），`-send` 變成一筆新的 queued 工作、被 worker 再送一次（每次 service.call 影像送兩次）。"""

    def to_wire(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "case_id": self.case_id,
            "kind": self.kind,
            "status": self.status,
            "phase": self.phase,
            "percent": self.percent,
            "requested_by": self.requested_by,
            "requested_at": self.requested_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "worker_id": self.worker_id,
            "attempts": self.attempts,
            "error": self.error,
            "download_url": f"/api/v1/jobs/{self.job_id}/download" if self.result_blob_key else None,
            **self.result,
        }


#: `find` 一頁幾筆。
FIND_PAGE = 200


class JobQueue(Protocol):
    async def enqueue(self, job: Job) -> Job: ...
    async def claim(self, worker_id: str) -> Job | None: ...
    async def update(self, job: Job, *, release_lease: bool = False) -> None: ...
    async def get(self, job_id: str) -> Job | None: ...
    async def list(self, case_id: str | None = None, *, limit: int = 50) -> list[Job]: ...
    async def heartbeat(self, job_id: str, attempt_id: str, lease_seconds: float | None = None) -> bool: ...
    async def reclaim_expired(self) -> int: ...
    async def find(
        self,
        *,
        status: str | None = None,
        kinds: Sequence[str] = (),
        kind_prefixes: Sequence[str] = (),
        finished_after: str | None = None,
        after: tuple[str, str] | None = None,
        limit: int = FIND_PAGE,
    ) -> list[Job]: ...


def _matches(
    job: Job, status: str | None, kinds: Sequence[str], kind_prefixes: Sequence[str], finished_after: str | None
) -> bool:
    if status is not None and job.status != status:
        return False
    if (kinds or kind_prefixes) and not (
        str(job.kind) in kinds or any(str(job.kind).startswith(p) for p in kind_prefixes)
    ):
        return False
    return finished_after is None or str(job.finished_at or "") >= finished_after


async def find_all(queue: JobQueue, **criteria: Any) -> list[Job]:
    """把 `find` 的每一頁都拿完：以前 plugin 輪詢拿「最近 500 筆」再在 Python 篩，
    一個長 plugin 之後又來 500 筆別的工作，它就不再被輪詢、逾時也不會被處理。"""
    out: list[Job] = []
    after: tuple[str, str] | None = None
    while True:
        page = await queue.find(**criteria, after=after, limit=FIND_PAGE)
        out.extend(page)
        if len(page) < FIND_PAGE:
            return out
        after = (page[-1].requested_at, page[-1].job_id)


def _copy(job: Job) -> Job:
    return replace(job, request=dict(job.request), result=dict(job.result), parent=None)


class MemoryJobQueue:
    """跟 `DbJobQueue` 同一套寫入規則：存的、拿出去的都是副本；`update` 要列存在、attempt 是目前的、
    版本一樣；租約只由領取、心跳、`release_lease` 與終態改。"""

    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.blobs: dict[str, bytes] = {}
        self.on_lease_failed: Callable[[list[Job]], Awaitable[None]] | None = None
        """租約過期、重試用完被判失敗的工作（推通知用；AppState 設）。"""

    async def enqueue(self, job: Job) -> Job:
        self.jobs[job.job_id] = _copy(job)
        return job

    async def claim(self, worker_id: str) -> Job | None:
        await self.reclaim_expired()
        for job in sorted(self.jobs.values(), key=lambda j: j.requested_at):
            if job.status == "queued":
                job.status = "running"
                job.worker_id = worker_id
                job.started_at = _now()
                job.attempts += 1
                job.attempt_id = uuid.uuid4().hex[:16]
                job.lease_until = lease_deadline()
                job.version += 1
                # 回傳副本：跟 Postgres 一樣，worker 手上的是「領到當下」的那一份，回收不會悄悄改到它
                return _copy(job)
        return None

    async def update(self, job: Job, *, release_lease: bool = False) -> None:
        stored = self.jobs.get(job.job_id)
        if stored is None:
            raise KeyError(f"沒有 job {job.job_id}")
        if job.attempt_id is not None and stored.attempt_id != job.attempt_id:
            raise StaleAttempt(f"{job.job_id}：attempt {job.attempt_id} 已不是目前的（{stored.attempt_id}）")
        if stored.version != job.version:
            raise JobChanged(f"{job.job_id}：讀出時是第 {job.version} 版，現在是第 {stored.version} 版")
        lease = None if release_lease or job.status in TERMINAL else stored.lease_until
        written = replace(_copy(job), lease_until=lease, version=stored.version + 1)
        self.jobs[job.job_id] = written
        job.version, job.lease_until = written.version, written.lease_until

    async def heartbeat(self, job_id: str, attempt_id: str, lease_seconds: float | None = None) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.status != "running" or job.attempt_id != attempt_id or job.lease_until is None:
            return False
        job.lease_until = lease_deadline(lease_seconds)
        return True

    async def reclaim_expired(self) -> int:
        now = now_precise()
        reclaimed = []
        for job in self.jobs.values():
            if job.status == "running" and job.lease_until is not None and job.lease_until < now:
                _reclaim(job)
                reclaimed.append(_copy(job))
        failed = [j for j in reclaimed if j.status == "failed"]
        if failed and self.on_lease_failed is not None:
            await self.on_lease_failed(failed)
        return len(reclaimed)

    async def get(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        return None if job is None else _copy(job)

    async def list(self, case_id: str | None = None, *, limit: int = 50) -> list[Job]:
        out = [_copy(j) for j in self.jobs.values() if case_id is None or j.case_id == case_id]
        return sorted(out, key=lambda j: j.requested_at, reverse=True)[:limit]

    async def find(
        self,
        *,
        status: str | None = None,
        kinds: Sequence[str] = (),
        kind_prefixes: Sequence[str] = (),
        finished_after: str | None = None,
        after: tuple[str, str] | None = None,
        limit: int = FIND_PAGE,
    ) -> list[Job]:
        """依條件篩，**舊到新**（`requested_at`, `job_id`），keyset 分頁 `after`。"""
        out = sorted(
            (_copy(j) for j in self.jobs.values() if _matches(j, status, kinds, kind_prefixes, finished_after)),
            key=lambda j: (j.requested_at, j.job_id),
        )
        if after is not None:
            out = [j for j in out if (j.requested_at, j.job_id) > after]
        return out[:limit]


def _reclaim(job: Job) -> None:
    """租約過期：還能再試就回 queued，否則 failed（記結束時間）。attempt 清掉 → 舊 worker 之後的寫回會被拒絕。"""
    job.status = "queued" if job.attempts < MAX_ATTEMPTS else "failed"  # type: ignore[assignment]
    job.error = None if job.status == "queued" else f"worker 租約過期，已重試 {job.attempts} 次"
    if job.status == "failed":
        job.phase, job.finished_at = "failed", _now()
    job.attempt_id = None
    job.lease_until = None
    job.version += 1


async def mutate_job(
    queue: Any,
    job_id: str,
    change: Callable[[Job], bool | None],
    *,
    release_lease: bool = False,
    attempts: int = 8,
) -> Job | None:
    """讀最新的那一列 → `change(job)` 就地改 → 寫回；寫回時發現別人剛寫過（`JobChanged`）就重讀、重套。

    `change` 回 False ＝ 這次不寫（例：工作已經在別處結束）；它也可以丟例外中止（例：`StaleAttempt`）。
    回寫進去的那一份；沒寫回 None。會改工作列的地方都用它，各自只改自己負責的欄位，不再拿舊副本整列覆寫。"""
    for _ in range(attempts):
        job = await queue.get(job_id)
        if job is None:
            return None
        if change(job) is False:
            return None
        try:
            await queue.update(job, release_lease=release_lease)
        except JobChanged:
            continue
        return job
    raise JobChanged(f"{job_id}：連續 {attempts} 次寫回都被別人搶先")


def check_attempt(fresh: Job, job: Job) -> None:
    """worker 寫回前：這一列還是這一次領取的（沒被回收）。"""
    if fresh.attempt_id != job.attempt_id:
        raise StaleAttempt(f"{job.job_id}：attempt {job.attempt_id} 已不是目前的（{fresh.attempt_id}）")


def new_job(case_id: str, kind: JobKind, request: dict[str, Any], *, requested_by: str) -> Job:
    return Job(
        job_id=f"job_{uuid.uuid4().hex[:10]}", case_id=case_id, kind=kind, request=request, requested_by=requested_by
    )


# ── 執行 ─────────────────────────────────────────────────────────────────────


async def _progress(app: Any, job: Job, phase: str, percent: int) -> None:
    """worker 寫進度：只改 phase、percent 與 worker 負責的 result（例：送出前先記想送什麼）—— 不寫租約（心跳延長的
    不會被領取當下那份蓋回去）、不蓋別人寫的欄位；這一列已經在別處結束了（取消）就停下這個工作。"""
    job.phase, job.percent = phase, percent
    if job.parent is not None:
        return  # 子步驟不寫進佇列：父工作進這一步之前已經寫了自己的進度

    def change(fresh: Job) -> bool:
        check_attempt(fresh, job)
        if fresh.status in TERMINAL:
            raise JobFinishedElsewhere(f"{job.job_id} 已經是 {fresh.status}")
        fresh.phase, fresh.percent, fresh.result = phase, percent, dict(job.result)
        return True

    await app.mutate_job(job.job_id, change)
    await app.notify_case(job.case_id, "job.progress", {"jobId": job.job_id, "phase": phase, "percent": percent})


def _export_source(case: Any, structure_ids: list[str]) -> str | None:
    """全部結構的 provenance 都來自同一個 plugin（`<id>@<ver>`）→ 回那個 module_version；否則 None。"""
    mvs = {case.structure(sid).provenance.module_version for sid in structure_ids if (sid, None) in case.structures}
    if len(mvs) == 1:
        mv = next(iter(mvs))
        # 核心自己的 module_version（rt-gaia-core、rtgaia-testbe、testbe-…）不算「來源」
        if "@" in mv and not mv.startswith(("rt-gaia", "rtgaia", "testbe")):
            return mv
    return None


def _default_label(
    case: Any, structure_ids: list[str], body: dict[str, Any], *, user: str = "", ascii_only: bool = False
) -> tuple[str, str]:
    """(StructureSetLabel ≤ 16 字, StructureSetDescription／SeriesDescription ≤ 64 字)。

    讓匯出標籤看得出是哪次、哪個模型的結果：
    * 全部來自同一個 plugin → 標籤「<plugin 前 6 字> <日期>」（例 `nnunet 20260918`）；
    * 否則沿用：同一個工作集 → 集名稱；再不然 `RTGAIA <日期>`；
    * 有未簽核的加 ` DRAFT`（放得下才加進標籤；描述一定寫）。
    描述帶日期、來源（module_version）、操作者、結構數、簽核狀態，資料頁與 TPS 都看得到。
    """
    from datetime import UTC, datetime

    from .state import default_work_set_label

    date = datetime.now(UTC).strftime("%Y%m%d")
    known = [sid for sid in structure_ids if (sid, None) in case.structures]
    unapproved = any(case.structure(sid).status != "approved" for sid in known)
    source = _export_source(case, known)
    label = ""
    if source is not None:
        label = f"{source.split('@')[0][:6]} {date}"
    else:
        sets = {case.structure(sid).structure_set_id for sid in known}
        if len(sets) == 1:
            s = case.structure_set(next(iter(sets)))
            if s and s.get("kind") == "work":
                owner = str(s.get("owner") or "")
                stored = str(s.get("label") or "")
                # 沒改過的預設名稱（「<帳號> 的結構集」）不寫進 DICOM：中文到 Eclipse 只剩「physicist _」，
                # 英文介面的人也看不懂 → 用帳號；使用者自己取的名稱照用
                label = owner if owner and stored in ("", default_work_set_label(owner)) else stored
        if not label:
            label = f"RTGAIA {date}"
    if unapproved and len(f"{label} DRAFT") <= 16:
        label = f"{label} DRAFT"
    if ascii_only:
        # Varian profile 用英文組（把中文硬轉 ASCII 只會剩一串底線）
        description = " | ".join(
            [
                f"RT-Gaia {date}",
                f"source {source or 'manual'}",
                *([user] if user else []),
                f"{len(known)} ROIs",
                "has unapproved" if unapproved else "all approved",
            ]
        )
        return label[:16], description[:64]
    description = " · ".join(
        [
            f"RT-Gaia {date}",
            f"來源 {source or 'manual'}",
            *([user] if user else []),
            f"{len(known)} 結構",
            "含未簽核" if unapproved else "全部已簽核",
        ]
    )
    return label[:16], description[:64]


def _uid_root_label() -> str:
    from .dicom_uid import describe

    return describe()


async def run_export(app: Any, job: Job) -> None:
    """從 labelmap 在取像平面重抽輪廓 → RTSTRUCT bytes → blob store（namespace `exports`）。

    `request.anonymize`（預設 True）。False 且是 library 病例 → 寫真實病人識別、引用真實影像 SOP UID
    （TPS 才會掛到對的病人）；假體沒有真實識別，一律匿名（結果 `anonymize_forced_reason`）。
    `request.tags`（白名單 `EDITABLE_TAGS`，最後套）；`request.save_to_library`（匯出後直接進匯入管線
    → 資料庫多一套 RS；**強制帶真實識別**，否則會掛到假病人底下）。
    """
    from .rtstruct import PHI_TAGS, build_rtstruct, read_identity, validate_tags

    body = job.request
    if body.get("format") == "rtdose":
        await _finish_prebuilt_rtdose(app, job)
        return
    case = await app.case_async(job.case_id)
    await _progress(app, job, "extract_contours", 10)
    target_for = body.get("target_frame_of_reference_uid") or case.dataset.primary.frame_of_reference_uid
    grid = case.grid_for_frame(target_for)
    # 引用的影像：目標 FoR 的那組（不是永遠 primary —— 匯出到 CBCT 的結構要掛 CBCT）
    try:
        image_series = case.dataset.image_series_for(target_for)
    except StopIteration:
        image_series = case.dataset.primary
    save_to_library = bool(body.get("save_to_library", False))
    tags = validate_tags(dict(body.get("tags") or {}))
    want_identity = not bool(body.get("anonymize", True))
    identity = None
    forced_reason = None
    if save_to_library and not want_identity:
        want_identity = True
        forced_reason = "存入資料庫必須帶真實病人識別（否則會掛到假病人底下）"
    if want_identity:
        if image_series.source_path:
            identity = await asyncio.to_thread(read_identity, image_series.source_path)
        else:
            forced_reason = "假體沒有真實病人識別，只能匿名"
    if identity is None and any(tags.get(k) for k in PHI_TAGS):
        # 匿名時使用者硬填的病人欄位：允許（例如研究用假名），但結果標出來
        forced_reason = (forced_reason + "；" if forced_reason else "") + "病人欄位為使用者填寫"
    structure_ids = list(dict.fromkeys(body.get("structure_ids") or [sid for sid, _ in case.structures]))
    # 4D 影像 → 一份 RTSTRUCT 只引用**一幀**（那個相位的序列與切片）。
    # 幀 ＝ 請求帶的 `frame_index` → 清單裡第一個帶時間軸的結構所在的幀 → 0；其他幀的結構略過（`not_in_frame`）
    frame: int | None = None
    if image_series.frame_series_uids:
        frame = body.get("frame_index")
        if frame is None:
            frames_of: dict[str, list[int]] = {}
            for sid, fi in case.structures:
                if fi is not None:
                    frames_of.setdefault(sid, []).append(fi)
            frame = next((min(frames_of[sid]) for sid in structure_ids if sid in frames_of), 0)
        frame = max(0, min(int(frame), len(image_series.frame_series_uids) - 1))
    entries = []
    skipped: list[dict[str, Any]] = []
    exported_versions: dict[str, str] = {}
    for n, structure_id in enumerate(structure_ids):
        try:
            st = case.structure(structure_id, frame)
        except KeyError:
            skipped.append({"structure_id": structure_id, "reason": "not_in_frame", "frame_index": frame})
            continue
        if st.frame_of_reference_uid != target_for:
            skipped.append(
                {
                    "structure_id": structure_id,
                    "reason": "not_in_target_frame",
                    "frame_of_reference_uid": st.frame_of_reference_uid,
                }
            )
            continue
        exported_versions[structure_id] = st.head.version_id
        entries.append(
            {
                "structure_id": structure_id,
                "name": st.name,
                "color_rgb": st.color_rgb,
                "mask_dense": st.dense(grid),
                # 來源 RTSTRUCT 的類型；沒有 → profile 依名字推（之前一律「名字含 PTV 才 PTV、其餘 ORGAN」）
                "interpreted_type": st.interpreted_type,
                "provenance_source": getattr(st.provenance, "source", None),
            }
        )
        await _progress(app, job, "extract_contours", 10 + int(70 * (n + 1) / max(1, len(structure_ids))))
    await _progress(app, job, "write_dicom", 85)
    from .export_profile import apply_profile, default_profile

    profile = str(body.get("profile") or default_profile())
    label, description = _default_label(
        case, structure_ids, body, user=job.requested_by, ascii_only=profile == "varian"
    )
    applied = apply_profile(
        profile,
        entries,
        {"label": label, "description": description, "series_description": description or label},
    )
    entries, label, description = applied.entries, applied.header["label"], applied.header.get("description", "")
    ds = await asyncio.to_thread(
        build_rtstruct,
        structures=entries,
        grid=grid,
        series_uid=image_series.frame_series_uids[frame] if frame is not None else image_series.series_id,
        study_uid=str(image_series.meta.get("study_instance_uid") or case.dataset.study_id),
        frame_of_reference_uid=target_for,
        identity=identity,
        slice_sop_uids=(
            image_series.frame_slice_sop_uids[frame]
            if frame is not None and image_series.frame_slice_sop_uids
            else image_series.slice_sop_uids or None
        ),
        image_sop_class_uid=image_series.sop_class_uid or None,
        tags=tags,
        operator=job.requested_by,
        label=label,
        description=description,
        series_description=applied.header.get("series_description", ""),
        charset=applied.charset,
    )
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    data = buf.getvalue()
    key = app.export_blobs_put(job.job_id, data)
    job.result_blob_key = key
    job.result = {
        "result_uid": str(ds.SOPInstanceUID),
        "structure_count": len(entries),
        "contour_count": sum(len(x.ContourSequence) for x in ds.ROIContourSequence),
        "bytes": len(data),
        "skipped": skipped,
        "exported_versions": exported_versions,
        "anonymized": identity is None,
        "referenced_series_uid": (
            image_series.frame_series_uids[frame] if frame is not None else image_series.series_id
        ),
        "frame_index": frame,
        "real_sop_references": bool(image_series.slice_sop_uids),
        "structure_set_label": str(ds.StructureSetLabel),
        "structure_set_description": str(getattr(ds, "StructureSetDescription", "")),
        "series_instance_uid": str(ds.SeriesInstanceUID),
        "tags_applied": tags,
        "profile": applied.profile,
        "profile_warnings": applied.warnings,
        "uid_root": _uid_root_label(),
        # 匯出紀錄要回答「哪位病人的東西離開了」—— 匿名匯出的檔案裡沒有，所以另外記來源序列的 PatientID
        "source_patient_id": image_series.meta.get("patient_id"),
        "sha256": hashlib.sha256(data).hexdigest(),
        **({"anonymize_forced_reason": forced_reason} if forced_reason else {}),
        **({"patient_id": identity["PatientID"]} if identity is not None else {}),
    }
    if save_to_library:
        # 直接進匯入管線（與上傳／DIMSE 同一條）→ 資料庫多一套 RS；病例的工作集不動
        from pathlib import Path

        if not getattr(app, "library_root", ""):
            raise ValueError("沒有設定資料庫目錄（RTGAIA_LIBRARY_ROOT），不能存入資料庫")
        await _progress(app, job, "import", 92)
        staging = Path(app.staging_root()) / f"export_{job.job_id}"
        staging.mkdir(parents=True, exist_ok=True)
        (staging / f"{ds.SOPInstanceUID}.dcm").write_bytes(data)
        sub = Job(
            job_id=job.job_id,
            case_id=job.case_id,
            kind="import",
            request={"staging_dir": str(staging), "source": f"export:{job.job_id}", "move": True},
            requested_by=job.requested_by,
            attempt_id=job.attempt_id,
            parent=job,  # 子步驟不寫進佇列（以前把這一列改寫成 kind=import／queued）
        )
        await run_import(app, sub)
        job.result["import"] = sub.result
        job.result["saved_to_library"] = True


async def _save_blob_to_library(app: Any, job: Job, data: bytes, sop_uid: str) -> None:
    """匯出結果直接進匯入管線（劑量運算的 RTDOSE 也走這條）。"""
    from pathlib import Path

    if not getattr(app, "library_root", ""):
        raise ValueError("沒有設定資料庫目錄（RTGAIA_LIBRARY_ROOT），不能存入資料庫")
    await _progress(app, job, "import", 92)
    staging = Path(app.staging_root()) / f"export_{job.job_id}"
    staging.mkdir(parents=True, exist_ok=True)
    (staging / f"{sop_uid}.dcm").write_bytes(data)
    sub = Job(
        job_id=job.job_id,
        case_id=job.case_id,
        kind="import",
        request={"staging_dir": str(staging), "source": f"export:{job.job_id}", "move": True},
        requested_by=job.requested_by,
        attempt_id=job.attempt_id,
        parent=job,  # 子步驟不寫進佇列
    )
    await run_import(app, sub)
    job.result["import"] = sub.result
    job.result["saved_to_library"] = True


async def _finish_prebuilt_rtdose(app: Any, job: Job) -> None:
    """劑量運算結果的 RTDOSE 已經由 API 行程組好放進 blob（暫存結果只在 API 的記憶體裡，worker 讀不到）；
    這裡只收尾：結果欄位、（要的話）進匯入管線。下載、匯出紀錄、送到節點都跟 RS 匯出同一套。"""
    key = str(job.request["prebuilt_blob_key"])
    data = app.export_blobs_get(key)
    job.result_blob_key = key
    job.result = dict(job.request.get("prebuilt_result") or {})
    job.result["format"] = "rtdose"
    if job.request.get("save_to_library"):
        await _save_blob_to_library(app, job, data, str(job.result.get("result_uid") or job.job_id))


async def run_import(app: Any, job: Job) -> None:
    """從暫存目錄（SCP 收的、C-GET 拿回的、伺服器目錄）匯入。

    同一條管線（暫存 → 驗證 → 去重 → 落地 → 重掃）。

    request：`{staging_dir, source, detail, move}`。完成後推 `catalog.changed`（所有連線、所有行程；API 讓索引失效）。
    """
    from pathlib import Path

    from .library.importer import Importer

    staging = Path(str(job.request["staging_dir"]))
    if not staging.is_dir():
        raise FileNotFoundError(f"暫存目錄不存在：{staging}")
    await _progress(app, job, "stage", 5)
    importer = Importer(app.library_root)
    batch = importer.open_batch(
        "server_path",
        {"source": job.request.get("source", "dimse"), **dict(job.request.get("detail") or {})},
        created_by=job.requested_by,
    )
    staged = await asyncio.to_thread(importer.stage_directory, batch, staging)
    await _progress(app, job, "validate", 20)
    index = await app.library_index_async()
    if staged:
        await asyncio.to_thread(
            importer.process, batch, index, move=bool(job.request.get("move", True)), finalize=False
        )
    await _progress(app, job, "index", 80)
    await app.library_index_async(rescan=True)
    importer.finish(batch)
    counts = batch.counts()
    job.result = {
        "series": batch.series_summary(),
        "counts": counts,
        "source": job.request.get("source", "dimse"),
        "detail": {k: v for k, v in dict(job.request.get("detail") or {}).items() if k != "dir"},
        "touched_patient_ids": batch.touched_patient_ids,
        "attention": [it.to_wire() for it in batch.items if it.outcome in ("rejected", "duplicate_diff")][:200],
    }
    # 搬走的暫存目錄清掉（move=True 時 process 只搬 accepted；其餘留著給人看 → 空了才刪）。
    # 複製（使用者指定的目錄）不碰來源：空目錄也是使用者的
    try:
        if bool(job.request.get("move", True)) and staging.exists() and not any(staging.rglob("*")):
            staging.rmdir()
    except OSError:
        pass
    await app.publish(
        "*",
        "catalog.changed",
        {"patient_ids": batch.touched_patient_ids, "job_id": job.job_id, "source": job.request.get("source", "dimse")},
    )


async def run_send(app: Any, job: Job) -> None:
    """C-STORE 送出到節點。request：`{node_id, series_uids?, study_uids?, patient_ids?, export_job_id?}`。

    `study_uids`／`patient_ids` 在目錄裡展開成該 study／病人的**全部**序列（影像與 RT 物件都送）。"""
    from pathlib import Path

    from . import dimse

    await app.dimse_settings_async(refresh=True)  # 逾時／我方 AET 以目前設定為準（獨立 worker 不訂閱匯流排）
    nodes = await app.nodes_async()
    node = await nodes.get(str(job.request["node_id"]))
    if not node.role_send or not node.host:
        raise ValueError(f"節點 {node.name} 沒有「可送出」角色（沒有 host／port）")
    paths: list[Path] = []
    patient_ids_out: list[str] = []
    if job.request.get("export_job_id"):
        export = await (await app.job_queue_async()).get(str(job.request["export_job_id"]))
        if export is None or export.result_blob_key is None:
            raise KeyError("匯出 job 不存在或沒有結果")
        if export.result.get("source_patient_id"):
            patient_ids_out.append(str(export.result["source_patient_id"]))
        data = app.export_blobs_get(export.result_blob_key)
        tmp = Path(app.staging_root()) / f"send_{job.job_id}"
        tmp.mkdir(parents=True, exist_ok=True)
        p = tmp / f"{export.job_id}.dcm"
        p.write_bytes(data)
        paths.append(p)
    index = await app.library_index_async()
    series_uids: list[str] = [str(u) for u in job.request.get("series_uids") or []]
    study_uids = {str(u) for u in job.request.get("study_uids") or []}
    patient_ids = {str(u) for u in job.request.get("patient_ids") or []}
    if study_uids or patient_ids:
        for entry in index.series.values():
            if entry.study_instance_uid in study_uids or entry.patient_id in patient_ids:
                if entry.series_instance_uid not in series_uids:
                    series_uids.append(entry.series_instance_uid)
        missing = [u for u in study_uids if not any(e.study_instance_uid == u for e in index.series.values())]
        missing += [p for p in patient_ids if not any(e.patient_id == p for e in index.series.values())]
        if missing:
            raise KeyError(f"目錄裡沒有：{missing[:3]}")
    for uid in series_uids:
        entry = index.series.get(uid)
        if entry is None:
            raise KeyError(f"目錄裡沒有序列 {uid}")
        paths.extend(entry.paths)
        if entry.patient_id and entry.patient_id not in patient_ids_out:
            patient_ids_out.append(entry.patient_id)
    if not paths:
        raise ValueError("沒有東西可送（series_uids／study_uids／patient_ids 或 export_job_id）")
    # 失敗也要留下「想送什麼、送去哪」—— 先寫進 result，後面成功再覆蓋計數
    job.result = {
        "series_count": len(series_uids),
        "series_uids": series_uids,
        "patient_ids": patient_ids_out,
        "node": node.to_wire(),
    }
    await _progress(app, job, "associate", 5)

    def progress(n: int, total: int) -> None:
        job.phase, job.percent = "store", 5 + int(90 * n / max(1, total))

    result = await asyncio.to_thread(dimse.store, node, paths, on_progress=progress)
    job.result = {**job.result, **result}
    if result["failed"] and result["sent"] == 0:
        raise RuntimeError(f"全部失敗：{result['failed'][:3]}")


async def run_retrieve(app: Any, job: Job) -> None:
    """從節點拉。request：`{node_id, study_uids?, series_uids?, method: move|get}`。

    * `move`：請對方送到我方 SCP（`move_destination_aet`）；資料到了 SCP 會自己開 import job。
    * `get`：資料在同一條 association 回來 → 暫存 → **接著就地匯入**（同 `run_import`）。
    """
    from pathlib import Path

    from . import dimse

    await app.dimse_settings_async(refresh=True)
    nodes = await app.nodes_async()
    node = await nodes.get(str(job.request["node_id"]))
    if not node.role_send or not node.host:
        raise ValueError(f"節點 {node.name} 沒有「可送出」角色（沒有 host／port），不能向它拉資料")
    study_uids = [str(u) for u in job.request.get("study_uids") or []]
    series_uids = [str(u) for u in job.request.get("series_uids") or []]
    method = str(job.request.get("method") or "move").lower()
    await _progress(app, job, "associate", 5)
    if method == "move":
        dest = node.move_destination_aet or dimse.our_ae_title()
        result = await asyncio.to_thread(
            dimse.move, node, study_uids=study_uids, series_uids=series_uids, destination_aet=dest
        )
        job.result = {
            **result,
            "method": "move",
            "destination_aet": dest,
            "note": "資料由我方 SCP 接收後另開 import job",
        }
    elif method == "get":
        out_dir = Path(app.staging_root()) / f"get_{job.job_id}"
        result = await asyncio.to_thread(
            dimse.get, node, study_uids=study_uids, series_uids=series_uids, out_dir=out_dir
        )
        await _progress(app, job, "import", 60)
        sub = Job(
            job_id=job.job_id,
            case_id=job.case_id,
            kind="import",
            request={"staging_dir": str(out_dir), "source": f"dimse-get:{node.ae_title}", "move": True},
            requested_by=job.requested_by,
            attempt_id=job.attempt_id,
            parent=job,  # 子步驟不寫進佇列（以前把這一列改寫成 kind=import／queued）
        )
        await run_import(app, sub)
        job.result = {**result, "method": "get", "import": sub.result}
    else:
        raise ValueError("method 必須是 move 或 get")


DEFERRED = object()
"""handler 回這個 → job 留在 running，由別的路徑收尾（plugin 回呼／輪詢）。"""


async def run_plugin(app: Any, job: Job) -> Any:
    """派給行程外 plugin。派工成功就 DEFERRED；plugin 打 `/done`、宿主輪詢或逾時才收尾。"""
    pm = await app.plugins_async()
    await pm.dispatch(job)
    return DEFERRED


async def run_service_call(app: Any, job: Job) -> Any:
    """把序列送到 DICOM 節點，然後**等它回傳**同一個 study 的 RT 物件到我方 SCP。

    request：`{node_id, series_uids, study_instance_uid, session_id, timeout_s, wanted_modalities?}`。
    送出用 `run_send` 的同一段程式（臨時 Job）；送完記 `sent_at` 回 DEFERRED，由 `PluginManager.tick()` 掃
    `sent_at` 之後完成的 import job（`result.series` 同 study、RT 模態）→ done，推 `service.received`。
    """
    send = Job(
        job_id=f"{job.job_id}-send",
        case_id=job.case_id,
        kind="send",
        request=dict(job.request),
        requested_by=job.requested_by,
        attempt_id=job.attempt_id,
        parent=job,  # 子步驟不寫進佇列（以前這一筆被寫成新的 queued 工作，worker 又送了一次）
    )
    try:
        await run_send(app, send)
    except Exception:
        job.result = {**job.result, "send": send.result}  # 想送什麼、送去哪
        raise
    job.request["sent_at"] = _now()
    job.request["send_result"] = send.result
    job.request.setdefault(
        "deadline_at",
        (datetime.now(UTC) + timedelta(seconds=int(job.request.get("timeout_s", 1800)))).isoformat(timespec="seconds"),
    )
    job.phase, job.percent = "waiting-for-node", 10

    def sent(fresh: Job) -> bool:
        check_attempt(fresh, job)
        if fresh.status in TERMINAL:
            raise JobFinishedElsewhere(f"{job.job_id} 已經是 {fresh.status}")
        for key in ("sent_at", "send_result", "deadline_at"):
            fresh.request[key] = job.request[key]
        fresh.phase, fresh.percent = job.phase, job.percent
        return True

    await app.mutate_job(job.job_id, sent)
    await app.notify_case(
        job.case_id, "job.progress", {"jobId": job.job_id, "phase": job.phase, "percent": job.percent}
    )
    return DEFERRED


HANDLERS = {
    "export": run_export,
    "import": run_import,
    "send": run_send,
    "retrieve": run_retrieve,
    "plugin": run_plugin,
    "service.call": run_service_call,
}


async def run_job(app: Any, job: Job) -> None:
    try:
        result = await HANDLERS[str(job.kind).split(":", 1)[0]](app, job)
        if result is DEFERRED:
            # 已派送給外部（plugin），之後由它自己的 deadline 與回呼／輪詢管 —— 不再持有租約，也就不會被回收重派
            job.lease_until = None

            def release(fresh: Job) -> bool:
                if fresh.status in TERMINAL:
                    return False  # 外部已經做完、回呼比這裡快
                check_attempt(fresh, job)
                return True

            await app.mutate_job(job.job_id, release, release_lease=True)
            return
        job.status, job.phase, job.percent = "done", "done", 100
    except Exception as exc:  # noqa: BLE001 - 失敗必須看得見
        job.status, job.phase = "failed", "failed"
        job.error = f"{type(exc).__name__}: {exc}"
    job.finished_at = _now()

    def finish(fresh: Job) -> bool:
        if fresh.status in TERMINAL:
            return False  # 別處已經結束了它（取消、逾時）：不蓋掉
        check_attempt(fresh, job)
        fresh.status, fresh.phase, fresh.percent = job.status, job.phase, job.percent
        fresh.result, fresh.result_blob_key = dict(job.result), job.result_blob_key
        fresh.error, fresh.finished_at = job.error, job.finished_at
        fresh.request.pop("token_sha256", None)  # plugin 的回呼 token 隨終態失效（以前派工失敗時還能回呼）
        return True

    if await app.mutate_job(job.job_id, finish) is None:
        log.info("Job %s was finished elsewhere before its worker; the worker's result was not written", job.job_id)
        return
    if job.kind in ("export", "send"):
        # 匯出紀錄。寫不進去不能讓已完成的匯出變失敗 —— 記 log，job 本身仍在 job 表可查
        try:
            await app.record_export(job)
        except Exception:  # noqa: BLE001
            log.exception("Failed to write the export record of %s", job.job_id)
    await app.notify_case(
        job.case_id,
        "job.progress" if job.status == "done" else "error",
        {"jobId": job.job_id, "phase": job.phase, "percent": job.percent}
        if job.status == "done"
        else {"code": "JOB_FAILED", "message": job.error or "", "jobId": job.job_id},
    )


WORKER_BACKOFF_MAX_SECONDS = 30.0
HEARTBEAT_FILE_EVERY_SECONDS = 5.0


def _health(app: Any) -> dict[str, Any]:
    h = getattr(app, "worker_health", None)
    if not isinstance(h, dict):
        h = {}
        try:
            app.worker_health = h
        except AttributeError:
            pass
    return h


def _touch_heartbeat_file(state: dict[str, float]) -> None:
    """獨立 worker 的心跳檔（容器健康檢查看它的 mtime）；`RTGAIA_WORKER_HEARTBEAT_FILE` 沒設就不寫。"""
    import os
    import time

    path = os.environ.get("RTGAIA_WORKER_HEARTBEAT_FILE", "").strip()
    now = time.time()
    if not path or now - state.get("touched", 0.0) < HEARTBEAT_FILE_EVERY_SECONDS:
        return
    state["touched"] = now
    try:
        with open(path, "a", encoding="ascii"):
            os.utime(path, None)
    except OSError:
        log.warning("Cannot write the worker heartbeat file %s", path)


async def worker_loop(app: Any, *, poll_seconds: float = 0.3) -> None:
    """領工作 → 執行 → 收尾，永遠不因單一工作或 DB 暫時故障而結束。

    以前只有 claim 包在 try 裡；`run_job` 的最後收尾（寫回結果、推通知）一丟例外，整個迴圈就結束，
    而獨立 worker 行程還在等 stop 訊號 —— 行程活著、不再領工作，也沒有人知道。現在每個工作邊界都接住例外、
    記 log 與 `worker_health`、指數退避後繼續；收尾沒寫進去的工作留在 running，由佇列的回收規則處理。
    `CancelledError` 照常往外丟（正常關機）。
    """
    import time

    worker_id = f"{socket.gethostname()}:{uuid.uuid4().hex[:6]}"
    health = _health(app)
    health.update({"worker_id": worker_id, "started_at": time.time(), "jobs": 0, "errors": 0, "busy_job": None})
    beat: dict[str, float] = {}
    failures = 0
    while True:
        health["last_tick"] = time.time()
        _touch_heartbeat_file(beat)
        try:
            queue = await app.job_queue_async()
            job = await queue.claim(worker_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - DB 暫時掛了：等一下再試
            _record_error(health, f"領工作失敗：{type(exc).__name__}: {exc}")
            failures += 1
            await asyncio.sleep(_backoff(poll_seconds, failures))
            continue
        if job is None:
            failures = 0
            await asyncio.sleep(poll_seconds)
            continue
        health["busy_job"] = job.job_id
        health["busy_since"] = time.time()
        beating = asyncio.create_task(_keep_lease(queue, job, health))
        try:
            await run_job(app, job)
            health["jobs"] = int(health.get("jobs", 0)) + 1
            failures = 0
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 收尾（寫回結果／通知）失敗：記下來、退避、繼續領
            log.exception("Job %s failed while finishing (the result or notification was not delivered)", job.job_id)
            _record_error(health, f"{job.job_id}：{type(exc).__name__}: {exc}")
            failures += 1
            await asyncio.sleep(_backoff(poll_seconds, failures))
        finally:
            beating.cancel()
            health["busy_job"] = None
            health.pop("busy_since", None)


async def _keep_lease(queue: Any, job: Job, health: dict[str, Any]) -> None:
    """執行期間續約。心跳回 False ＝ 租約已被回收（別的 worker 可能接手了）→ 記下來、停；
    結果寫回時會被 `StaleAttempt` 擋掉。心跳本身出錯（DB 暫時連不上）→ 下一輪再續 —— 以前一次出錯整個續約
    就停了，租約到期後工作被回收、由別的 worker 重跑（重送、重匯入）。"""
    if job.attempt_id is None or not hasattr(queue, "heartbeat"):
        return
    while True:
        await asyncio.sleep(max(0.01, LEASE_SECONDS / 3))
        if job.lease_until is None:  # 已派送給外部（DEFERRED）
            return
        try:
            alive = await queue.heartbeat(job.job_id, job.attempt_id, LEASE_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to renew the lease of job %s (will retry): %s", job.job_id, exc)
            continue
        if not alive:
            log.warning("The lease of job %s is no longer valid (attempt %s)", job.job_id, job.attempt_id)
            _record_error(health, f"{job.job_id}：租約已失效")
            return


def _backoff(poll_seconds: float, failures: int) -> float:
    return float(min(WORKER_BACKOFF_MAX_SECONDS, poll_seconds * (2 ** min(failures, 8))))


def _record_error(health: dict[str, Any], message: str) -> None:
    import time

    health["errors"] = int(health.get("errors", 0)) + 1
    health["last_error"] = message.split("\n")[0][:300]
    health["last_error_at"] = time.time()
