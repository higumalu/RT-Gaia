"""目錄表。

* `instance` 以**路徑**為主鍵（掃描器是路徑導向的；同一個 SOP 在兩個目錄各一份的舊版型仍成立），`header` 是
  `InstanceHeader.to_json()` 整份 —— 從 DB 重建 `LibraryIndex` 只需要它。
* `series`／`study`／`patient`／`series_ref` 是**派生表**：由 `LibraryIndex` 的 `resolve_links()` 重算後整批換掉；
  搜尋欄位（`roi_names`、`plan_label`、`search_text`）在這裡，SQL 查詢之後直接可用。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import BigInteger, Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class PatientRow(Base):
    __tablename__ = "patient"
    patient_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    patient_name_hash: Mapped[str] = mapped_column(Text, default="")
    """migration 0015：PatientName 的 HMAC；明文不落地。"""


class StudyRow(Base):
    __tablename__ = "study"
    study_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    patient_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("patient.patient_id", ondelete="CASCADE"), index=True
    )
    study_date: Mapped[str] = mapped_column(String(8), default="")
    study_description: Mapped[str] = mapped_column(Text, default="")


class SeriesRow(Base):
    __tablename__ = "series"
    series_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    study_uid: Mapped[str] = mapped_column(String(128), ForeignKey("study.study_uid", ondelete="CASCADE"), index=True)
    patient_id: Mapped[str] = mapped_column(String(64), index=True)
    modality: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # image | rtstruct | rtplan | rtdose | reg | other
    frame_of_reference_uid: Mapped[str] = mapped_column(String(128), default="", index=True)
    series_date: Mapped[str] = mapped_column(String(8), default="")
    series_time: Mapped[str] = mapped_column(String(16), default="")
    series_description: Mapped[str] = mapped_column(Text, default="")
    series_number: Mapped[str] = mapped_column(String(16), default="")
    sop_class_uid: Mapped[str] = mapped_column(String(128), default="")
    manufacturer: Mapped[str] = mapped_column(Text, default="")
    manufacturer_model_name: Mapped[str] = mapped_column(Text, default="")
    instance_count: Mapped[int] = mapped_column(Integer, default=0)
    refs: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    links: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    structure_set_label: Mapped[str] = mapped_column(Text, default="")
    plan_label: Mapped[str] = mapped_column(Text, default="")
    roi_names: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    search_text: Mapped[str] = mapped_column(Text, default="")


class InstanceRow(Base):
    __tablename__ = "instance"
    path: Mapped[str] = mapped_column(Text, primary_key=True)
    series_uid: Mapped[str] = mapped_column(String(128), index=True)
    sop_uid: Mapped[str] = mapped_column(String(128), default="", index=True)
    mtime_ns: Mapped[int] = mapped_column(BigInteger)
    size: Mapped[int] = mapped_column(BigInteger)
    instance_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    header: Mapped[dict[str, Any]] = mapped_column(JSONB)


class SeriesRefRow(Base):
    __tablename__ = "series_ref"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_series_uid: Mapped[str] = mapped_column(String(128), index=True)
    to_series_uid: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(
        String(32)
    )  # rtstruct->image | plan->rtstruct | plan->image | dose->plan | dose->image | reg->fixed | reg->moving
    resolved: Mapped[bool] = mapped_column(Boolean, default=True)
    to_frame_of_reference_uid: Mapped[str] = mapped_column(String(128), default="")


Index(
    "ix_series_search_text",
    SeriesRow.search_text,
    postgresql_using="gin",
    postgresql_ops={"search_text": "gin_trgm_ops"},
)


class UserRow(Base):
    """本地帳號。`role` ∈ viewer | contourer | approver | admin。"""

    __tablename__ = "app_user"
    user_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(Text, default="")
    role: Mapped[str] = mapped_column(String(16), default="contourer")
    password_hash: Mapped[str] = mapped_column(Text)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(32))
    created_by: Mapped[str] = mapped_column(String(64), default="")
    last_login_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # migration 0018：臨時密碼 → 下次登入必須改；改密碼時間（比它早簽的 token 作廢）
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    password_changed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    preferences: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    """migration 0020：介面偏好（版面、側欄寬度、密度、語言…），跨電腦跟著帳號走。值是前端序列化好的字串。"""


# ── 病例工作狀態 ──────────────────────────────────


class CaseRow(Base):
    __tablename__ = "rt_case"
    case_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    study_id: Mapped[str] = mapped_column(String(128), index=True)
    source: Mapped[str] = mapped_column(Text, default="")
    selection_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    selection: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[str] = mapped_column(String(32))


class StructureSetRow(Base):
    """工作集：某使用者在某 FoR 的結構集。匯入集不存（由 RTSTRUCT 重組）。"""

    __tablename__ = "structure_set"
    case_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True
    )
    structure_set_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="work")
    label: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str] = mapped_column(String(64), default="")
    frame_of_reference_uid: Mapped[str] = mapped_column(String(128), default="")
    image_series_uid: Mapped[str] = mapped_column(String(128), default="")
    image_label: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(32))
    """使用者寫的描述（migration 0014）。"""
    description: Mapped[str] = mapped_column(Text, default="", server_default="")


class CaseFrameGroupRow(Base):
    __tablename__ = "case_frame_group"
    case_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True
    )
    frame_of_reference_uid: Mapped[str] = mapped_column(String(128), primary_key=True)
    frame_group: Mapped[dict[str, Any]] = mapped_column(JSONB)


class StructureRow(Base):
    __tablename__ = "structure"
    case_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True
    )
    structure_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    frame_key: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    color_rgb: Mapped[list[int]] = mapped_column(JSONB)
    frame_of_reference_uid: Mapped[str] = mapped_column(String(128))
    tg263_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    interpreted_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    """migration 0017：RTROIInterpretedType。"""
    status: Mapped[str] = mapped_column(String(16))
    default_visible: Mapped[bool] = mapped_column(Boolean, default=True)
    temporal_group_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    structure_set_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    """來源結構集 id（RTSTRUCT series UID 或 `path:<檔名>`）。"""
    head_version_id: Mapped[str] = mapped_column(String(32))
    created_by: Mapped[str] = mapped_column(String(64), default="")
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[str] = mapped_column(String(32))
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # migration 0016：暫存區／封存區。刪除的結構**留在這張表**（版本也在）；
    # 暫存區 ＝ deleted_at 有值且 archived_at 為空
    # （`RTGAIA_TRASH_DAYS` 天後清除），封存區 ＝ 刪除時已簽核（archived_at 有值，只有 admin 能動，不自動清）。
    deleted_by: Mapped[str] = mapped_column(String(64), default="", server_default="")
    deleted_set_label: Mapped[str] = mapped_column(Text, default="", server_default="")
    archived_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    archive_note: Mapped[str] = mapped_column(Text, default="", server_default="")


class StructureVersionRow(Base):
    __tablename__ = "structure_version"
    version_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"))
    structure_id: Mapped[str] = mapped_column(String(128))
    frame_key: Mapped[int] = mapped_column(Integer)
    seq: Mapped[int] = mapped_column(Integer)
    parent_version_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    kind: Mapped[str] = mapped_column(String(16))
    content_hash: Mapped[str] = mapped_column(String(64))
    offset_ijk: Mapped[list[int]] = mapped_column(JSONB)
    size_ijk: Mapped[list[int]] = mapped_column(JSONB)
    voxel_count: Mapped[int] = mapped_column(Integer, default=0)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[str] = mapped_column(String(32))
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    client_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")


class ReviewEventRow(Base):
    __tablename__ = "review_event"
    event_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    event: Mapped[dict[str, Any]] = mapped_column(JSONB)


class CaseTransformRow(Base):
    __tablename__ = "case_transform"
    case_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True
    )
    transform_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB)


class CaseMeasurementRow(Base):
    __tablename__ = "case_measurement"
    case_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True
    )
    measurement_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    body: Mapped[dict[str, Any]] = mapped_column(JSONB)


# ── job 與稽核 ─────────────────────────────────────


class JobRow(Base):
    __tablename__ = "job"
    job_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(32), index=True)
    # export|import|send|retrieve|plugin:<id>（放寬到 64，migration 0011）
    kind: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), index=True)
    phase: Mapped[str] = mapped_column(String(32), default="queued")
    percent: Mapped[int] = mapped_column(Integer, default=0)
    request: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    result_blob_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_by: Mapped[str] = mapped_column(String(64), default="")
    requested_at: Mapped[str] = mapped_column(String(32))
    started_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    finished_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # 租約與 attempt（migration 0023）
    lease_until: Mapped[str | None] = mapped_column(String(32), nullable=True)
    attempt_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 寫入版本（migration 0025）；`update` 比對它，被別人寫過就 JobChanged
    version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class AuditEventRow(Base):
    """append-only：migration 0004 的 trigger 拒絕 UPDATE／DELETE。"""

    __tablename__ = "audit_event"
    event_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    at: Mapped[str] = mapped_column(String(32), index=True)
    user: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(128))
    status: Mapped[int] = mapped_column(Integer)
    object_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    object_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    case_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    remote_addr: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class PushOutboxRow(Base):
    """事件匯流排 outbox：NOTIFY 只帶 id，payload 在這裡（NOTIFY 上限 8000 bytes）。一小時後清。"""

    __tablename__ = "push_outbox"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    target: Mapped[str] = mapped_column(String(64))
    message_type: Mapped[str] = mapped_column(String(32))
    origin: Mapped[str | None] = mapped_column(String(16), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[str] = mapped_column(String(32), index=True)


class DicomNodeRow(Base):
    """DIMSE 節點：對方的 AE Title／host／port、我方呼叫用的 AET、C-MOVE 目的地。"""

    __tablename__ = "dicom_node"
    node_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    ae_title: Mapped[str] = mapped_column(String(16))
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer)
    our_calling_aet: Mapped[str | None] = mapped_column(String(16), nullable=True)
    move_destination_aet: Mapped[str | None] = mapped_column(String(16), nullable=True)
    tls: Mapped[bool] = mapped_column(Boolean, default=False)
    supports: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[str] = mapped_column(String(32))
    last_echo_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_echo_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # 角色與接收驗證
    role_send: Mapped[bool] = mapped_column(Boolean, default=True)
    role_receive: Mapped[bool] = mapped_column(Boolean, default=True)
    inbound_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    # migration 0021：PDU 上限（0 ＝ pynetdicom 預設）與 Transfer Syntax 偏好（空 ＝ 預設）
    max_pdu: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    transfer_syntaxes: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")


class StorageLocationRow(Base):
    """migration 0022：每個 DICOM 檔在哪一層、sha256 基準、最後驗證結果。"""

    __tablename__ = "storage_location"
    path: Mapped[str] = mapped_column(Text, primary_key=True)
    sop_instance_uid: Mapped[str] = mapped_column(String(128), default="", index=True)
    tier: Mapped[str] = mapped_column(String(16), default="hot")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    stored_at: Mapped[str] = mapped_column(String(32), default="")
    verified_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    verify_status: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    detail: Mapped[str] = mapped_column(Text, default="")


class AppSettingRow(Base):
    """服務設定：鍵值；`value` 是 JSON 物件（如 `dimse` → `DimseSettings.to_wire()` 的子集）。"""

    __tablename__ = "app_setting"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[str] = mapped_column(String(32))


class PluginRow(Base):
    """plugin 登錄：endpoint、登錄 bearer、manifest 快照、狀態。

    這是宿主的表，plugin 不能自建表。
    """

    __tablename__ = "plugin"
    plugin_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    endpoint: Mapped[str] = mapped_column(Text)
    token: Mapped[str] = mapped_column(Text, default="")
    manifest: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(24), default="active")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    allow_licenses: Mapped[list[str]] = mapped_column(JSONB, default=list)
    registered_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[str] = mapped_column(String(32))
    last_seen_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    health_failures: Mapped[int] = mapped_column(Integer, default=0)
    # migration 0012
    artifact_origins: Mapped[list[str]] = mapped_column(JSONB, default=list)
    ui_digest: Mapped[str | None] = mapped_column(Text, nullable=True)


class AuditOutboxRow(Base):
    """稽核待送（migration 0013）：`audit_event` 寫不進去時先落這裡，背景重送；兩邊都失敗才讓請求 503。

    先前失敗只在記憶體 tail 標 `persist_error`（最多 200 筆、重啟就沒了）——業務變更成功、稽核永遠缺一筆。
    """

    __tablename__ = "audit_outbox"
    event_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    event: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[str] = mapped_column(String(32), index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class ExportRecordRow(Base):
    """匯出紀錄（migration 0019）：每次資料離開系統一筆。欄位見 `rtgaia_core.export_records.ExportRecord`。"""

    __tablename__ = "export_record"
    export_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(32), index=True, default="")
    kind: Mapped[str] = mapped_column(String(16))
    target: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    requested_by: Mapped[str] = mapped_column(String(64), index=True, default="")
    requested_at: Mapped[str] = mapped_column(String(32), index=True)
    finished_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    patient_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    node_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str] = mapped_column(Text, default="")
    version_ids: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    sop_uids_out: Mapped[list[str]] = mapped_column(JSONB, default=list)
    series_uids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    blob_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    blob_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    profile: Mapped[str | None] = mapped_column(String(32), nullable=True)
    anonymized: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    source_export_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    resend_of: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    counts: Mapped[dict[str, int]] = mapped_column(JSONB, default=dict)
    resend_spec: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    __table_args__ = (Index("ix_export_record_patient_ids", "patient_ids", postgresql_using="gin"),)
