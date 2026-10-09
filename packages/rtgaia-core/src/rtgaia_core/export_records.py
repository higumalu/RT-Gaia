"""匯出紀錄（`export_record`）：每一次「資料離開系統」一筆 —— 下載 RTSTRUCT、存入資料庫、C-STORE 送出。

* 一筆紀錄 ＝ 一個**結束的** `export`／`send` job（`export_id` 就是 `job_id`）；
  job 結束時由 `run_job` 寫入，成功與失敗都記。
* 為什麼不直接查 `job` 表：job 是執行佇列（欄位跟著執行需求變、`result` 是自由 JSON），紀錄是**要長期回答問題**的：
  「這位病人的東西什麼時候、誰、以哪些版本、送去哪裡」。所以欄位固定、可依病人／病例／人查，並記下重送所需的一切。
* **重送**：送出（push）紀錄 → 同一組內容再送一次（預設同一節點，可換）；RTSTRUCT 紀錄 → 把**當時產生的那份檔案**
  （blob，不重新產生）送到指定節點。新的那筆 `resend_of` 指回原紀錄。
* 記憶體實作在這裡；Postgres 實作在 `rtgaia_server.db.export_records`（migration 0019，並從既有 job 回填）。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

KINDS = ("rtstruct", "rtdose", "push")
TARGETS = ("download", "library", "c-store")


@dataclass
class ExportRecord:
    export_id: str
    case_id: str
    kind: str
    """`rtstruct`（產生 RTSTRUCT）｜`rtdose`（劑量運算存成 RTDOSE）｜`push`（C-STORE 送出）。"""
    target: str
    """`download`｜`library`（存入資料庫）｜`c-store`。"""
    status: str
    requested_by: str
    requested_at: str
    finished_at: str | None = None
    patient_ids: list[str] = field(default_factory=list)
    node_id: str | None = None
    node_label: str | None = None
    label: str = ""
    version_ids: dict[str, str] = field(default_factory=dict)
    sop_uids_out: list[str] = field(default_factory=list)
    series_uids: list[str] = field(default_factory=list)
    blob_key: str | None = None
    blob_sha256: str | None = None
    profile: str | None = None
    anonymized: bool | None = None
    source_export_id: str | None = None
    """送出的是某次 RTSTRUCT 匯出的檔案 → 那筆的 id。"""
    resend_of: str | None = None
    error: str | None = None
    counts: dict[str, int] = field(default_factory=dict)
    resend_spec: dict[str, Any] = field(default_factory=dict)
    """送出紀錄：再送一次需要的 request（`series_uids`／`study_uids`／`patient_ids`／`export_job_id`）。"""

    def to_wire(self) -> dict[str, Any]:
        out = asdict(self)
        out.pop("resend_spec")
        out["download_url"] = (
            f"/api/v1/jobs/{self.export_id}/download" if self.blob_key and self.status == "done" else None
        )
        out["resendable"] = resend_problem(self) is None
        return out


def resend_problem(rec: ExportRecord) -> str | None:
    """None ＝ 可以重送；否則是給人看的理由（端點回 409）。"""
    if rec.kind in ("rtstruct", "rtdose"):
        if rec.status != "done" or not rec.blob_key:
            return "這次匯出沒有產生檔案（失敗的匯出請重新匯出）"
        return None
    if not rec.resend_spec:
        return "這筆紀錄沒有保存送出內容（升級前的紀錄），請從資料頁重新送"
    return None


def _node_label(node: dict[str, Any] | None) -> str | None:
    if not node:
        return None
    return f"{node.get('name', '')}（{node.get('ae_title', '')}@{node.get('host', '')}:{node.get('port', '')}）"


def record_from_job(job: dict[str, Any], *, patient_ids: list[str] | None = None) -> ExportRecord | None:
    """結束的 job（`Job.to_wire()` 形狀加上 `request`、`result_blob_key`）→ 紀錄；不是匯出類的 job → None。

    migration 0019 回填也用這支（輸入是 job 表的列），所以只吃 plain dict。"""
    kind = str(job.get("kind") or "")
    status = str(job.get("status") or "")
    if kind not in ("export", "send") or status not in ("done", "failed"):
        return None
    request = dict(job.get("request") or {})
    result = dict(job.get("result") or {})
    common = {
        "export_id": str(job["job_id"]),
        "case_id": str(job.get("case_id") or ""),
        "status": status,
        "requested_by": str(job.get("requested_by") or ""),
        "requested_at": str(job.get("requested_at") or ""),
        "finished_at": job.get("finished_at"),
        "error": job.get("error"),
        "resend_of": request.get("resend_of"),
    }
    if kind == "export":
        pids = patient_ids if patient_ids is not None else [p for p in [result.get("source_patient_id")] if p]
        counts = {k: int(result[k]) for k in ("structure_count", "contour_count", "bytes") if k in result}
        is_dose = request.get("format") == "rtdose"
        if is_dose:
            counts = {"bytes": int(result["bytes"])} if "bytes" in result else {}
        return ExportRecord(
            **common,
            kind="rtdose" if is_dose else "rtstruct",
            target="library" if request.get("save_to_library") else "download",
            patient_ids=list(pids),
            label=str(
                (result.get("derived_text") or request.get("derived_text") or "")
                if is_dose
                else (result.get("structure_set_label") or "")
            ),
            version_ids=dict(result.get("exported_versions") or {}),
            sop_uids_out=[result["result_uid"]] if result.get("result_uid") else [],
            series_uids=[result["series_instance_uid"]] if result.get("series_instance_uid") else [],
            blob_key=job.get("result_blob_key"),
            blob_sha256=result.get("sha256"),
            profile=result.get("profile"),
            anonymized=result.get("anonymized"),
            counts=counts,
        )
    node = result.get("node") if isinstance(result.get("node"), dict) else None
    series = [str(u) for u in (result.get("series_uids") or request.get("series_uids") or [])]
    counts = {k: (len(v) if isinstance(v, list) else int(v)) for k, v in result.items() if k in ("sent", "failed")}
    if "series_count" in result:
        counts["series_count"] = int(result["series_count"])
    pids = patient_ids if patient_ids is not None else [str(p) for p in result.get("patient_ids") or []]
    source = request.get("export_job_id")
    n = counts.get("series_count", len(series))
    label = "RTSTRUCT 匯出檔" if source and not series else f"{n} 個序列" + ("＋RTSTRUCT" if source else "")
    return ExportRecord(
        **common,
        kind="push",
        target="c-store",
        patient_ids=pids,
        node_id=str(request.get("node_id") or "") or None,
        node_label=_node_label(node) or result.get("node_label"),
        label=label,
        series_uids=series,
        source_export_id=str(source) if source else None,
        counts=counts,
        resend_spec={
            k: request.get(k) for k in ("series_uids", "study_uids", "patient_ids", "export_job_id") if request.get(k)
        },
    )


class MemoryExportRecords:
    def __init__(self) -> None:
        self.records: dict[str, ExportRecord] = {}

    async def put(self, rec: ExportRecord) -> ExportRecord:
        self.records[rec.export_id] = rec
        return rec

    async def get(self, export_id: str) -> ExportRecord:
        try:
            return self.records[export_id]
        except KeyError as exc:
            raise KeyError(f"沒有匯出紀錄 {export_id}") from exc

    async def list(
        self,
        *,
        case_id: str | None = None,
        patient_id: str | None = None,
        requested_by: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[ExportRecord]:
        out = [
            r
            for r in self.records.values()
            if (case_id is None or r.case_id == case_id)
            and (patient_id is None or patient_id in r.patient_ids)
            and (requested_by is None or r.requested_by == requested_by)
            and (kind is None or r.kind == kind)
            and (status is None or r.status == status)
        ]
        return sorted(out, key=lambda r: r.requested_at, reverse=True)[:limit]
