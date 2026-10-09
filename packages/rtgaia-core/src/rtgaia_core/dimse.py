"""DIMSE。

* **SCU**（我方發起）：`echo`、`find`（Study Root C-FIND）、`store`（C-STORE 逐檔）、`move`（C-MOVE 到我方 SCP）、
  `get`（C-GET：資料在同一條 association 回來，寫進暫存區）。
  全是同步阻塞的 pynetdicom 呼叫 —— 在 worker job 或 `to_thread` 跑。
* **SCP**（我方接收）：`ReceiveServer`：每條 association 一個暫存目錄，收到的 instance 寫檔、回 success；
  association 結束（或閒置）→ 呼叫 `on_batch(dir, meta)`（→ 進 `import` job）。
  **不支援的 SOP Class 預設也收下**（回 success、標 unsupported），避免對方整個傳輸失敗（與上傳的「拒絕」不同）；
  設定 `unsupported_sop_policy=reject` 則該 instance 回 0x0122。
* **接收驗證**：`is_allowed(calling_aet, ip)` 回 False → A-ASSOCIATE-RJ
  （calling AE title not recognised）。
* 我方 AE Title／port／逾時來自 `settings.DimseSettings`（`configure()`；環境變數是預設、DB 覆寫）。
  TLS 欄位保留、第一版不做。
* 授權：pynetdicom MIT。Conformance Statement 見 `docs/dicom-conformance.md`。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pydicom
from pydicom.dataset import Dataset

DEFAULT_AE_TITLE = "RTGAIA"
DEFAULT_SCP_PORT = 11112
ASSOC_IDLE_SECONDS = 5.0
HANDOFF_RETRY_SECONDS = 30.0
"""交批失敗（佇列暫時寫不進去）多久重試一次。"""

log = logging.getLogger(__name__)
"""接收端：association 沒結束但這麼久沒新 instance → 視為一批結束。

🔴 不能只靠 EVT_RELEASED：C-MOVE 的子操作 association 有些實作（含 pynetdicom 自己）送完不會馬上 release，
會拖到 network timeout（60 s）；一批 CT 的切片間隔是毫秒級，5 秒安靜就是結束。`ReceiveServer` 內建一條掃描執行緒。"""

# 我方接受／送出的 SOP Class；其餘接收時標 unsupported
ACCEPTED_SOP_CLASSES: dict[str, str] = {
    "1.2.840.10008.5.1.4.1.1.2": "CT Image Storage",
    "1.2.840.10008.5.1.4.1.1.2.1": "Enhanced CT Image Storage",
    "1.2.840.10008.5.1.4.1.1.4": "MR Image Storage",
    "1.2.840.10008.5.1.4.1.1.4.1": "Enhanced MR Image Storage",
    "1.2.840.10008.5.1.4.1.1.128": "PET Image Storage",
    "1.2.840.10008.5.1.4.1.1.481.3": "RT Structure Set Storage",
    "1.2.840.10008.5.1.4.1.1.481.2": "RT Dose Storage",
    "1.2.840.10008.5.1.4.1.1.481.5": "RT Plan Storage",
    "1.2.840.10008.5.1.4.1.1.66.1": "Spatial Registration Storage",
    "1.2.840.10008.5.1.4.1.1.66.3": "Deformable Spatial Registration Storage",
    "1.2.840.10008.5.1.4.1.1.7": "Secondary Capture Image Storage",
}


_cfg: Any = None
"""目前生效的 `DimseSettings`（`configure()` 設）；沒設就用環境變數。"""


def configure(settings: Any) -> None:
    """套用一份 `DimseSettings`：AE Title、逾時、接收端策略之後的呼叫都用它。"""
    global _cfg
    _cfg = settings


def current_settings() -> Any:
    from .settings import DimseSettings

    return _cfg if _cfg is not None else DimseSettings.from_env(has_db=False)


def our_ae_title() -> str:
    if _cfg is not None:
        return str(_cfg.ae_title)
    return (os.environ.get("RTGAIA_AE_TITLE") or DEFAULT_AE_TITLE).strip()[:16] or DEFAULT_AE_TITLE


def our_scp_port() -> int:
    if _cfg is not None:
        return int(_cfg.scp_port)
    try:
        return int(os.environ.get("RTGAIA_SCP_PORT") or DEFAULT_SCP_PORT)
    except ValueError:
        return DEFAULT_SCP_PORT


@dataclass
class Node:
    node_id: str
    name: str
    ae_title: str
    host: str
    port: int
    our_calling_aet: str | None = None
    move_destination_aet: str | None = None
    tls: bool = False
    supports: dict[str, Any] = field(default_factory=dict)
    created_by: str = ""
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    last_echo_at: str | None = None
    last_echo_ok: bool | None = None
    # 角色 —— 同一個節點可以既是我們送出的目標（它當 SCP）也是送進來的來源（它當 SCU）
    role_send: bool = True
    role_receive: bool = True
    inbound_ip: str | None = None
    """只接受來自這個 IP 的 C-STORE（選配；None ＝ 只認 AE Title）。"""
    description: str = ""
    max_pdu: int = 0
    """我方宣告的最大 PDU（bytes）；0 ＝ pynetdicom 預設（16382）。有些舊系統要小一點、有些高速網路要大一點。"""
    transfer_syntaxes: list[str] = field(default_factory=list)
    """對這個節點提議的 Transfer Syntax（UID，依偏好順序）；空 ＝ 預設（Explicit LE、Implicit LE…）。
    只接受 Implicit VR LE 的舊系統就設 `[Implicit VR Little Endian]`。"""

    def to_wire(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "name": self.name,
            "ae_title": self.ae_title,
            "host": self.host,
            "port": self.port,
            "our_calling_aet": self.our_calling_aet or our_ae_title(),
            "move_destination_aet": self.move_destination_aet or our_ae_title(),
            "tls": self.tls,
            "supports": self.supports,
            "roles": {"send": self.role_send, "receive": self.role_receive},
            "inbound_ip": self.inbound_ip,
            "description": self.description,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "last_echo_at": self.last_echo_at,
            "last_echo_ok": self.last_echo_ok,
            "max_pdu": self.max_pdu,
            "transfer_syntaxes": list(self.transfer_syntaxes),
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any], *, node_id: str | None = None, created_by: str = "") -> Node:
        aet = str(d.get("ae_title") or "").strip()
        host = str(d.get("host") or "").strip()
        if not aet or len(aet) > 16 or not aet.isascii():
            raise ValueError("ae_title 必填且 ≤ 16 個 ASCII 字元")
        roles = dict(d.get("roles") or {})
        role_send = bool(roles.get("send", True))
        role_receive = bool(roles.get("receive", True))
        if not (role_send or role_receive):
            raise ValueError("至少要勾一個角色（可送出／可接收）")
        try:
            port = int(d.get("port") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("port 必須是整數") from exc
        if role_send:
            # 可送出：要連得到它
            if not host:
                raise ValueError("可送出的節點要有 host")
            if not 1 <= port <= 65535:
                raise ValueError("port 必須在 1–65535")
        elif port and not 1 <= port <= 65535:
            raise ValueError("port 必須在 1–65535")
        inbound_ip = str(d.get("inbound_ip") or "").strip() or None
        try:
            max_pdu = int(d.get("max_pdu") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("max_pdu 必須是整數") from exc
        if max_pdu != 0 and not MIN_PDU <= max_pdu <= MAX_PDU:
            raise ValueError(f"max_pdu 要是 0（預設）或 {MIN_PDU}–{MAX_PDU} bytes")
        ts = [str(u).strip() for u in (d.get("transfer_syntaxes") or []) if str(u).strip()]
        unknown = [u for u in ts if u not in ALLOWED_TRANSFER_SYNTAXES]
        if unknown:
            raise ValueError(f"不支援的 Transfer Syntax：{', '.join(unknown)}")
        return cls(
            node_id=node_id or f"node_{uuid.uuid4().hex[:8]}",
            name=str(d.get("name") or aet),
            ae_title=aet,
            host=host,
            port=port,
            our_calling_aet=(str(d["our_calling_aet"]).strip()[:16] or None) if d.get("our_calling_aet") else None,
            move_destination_aet=(str(d["move_destination_aet"]).strip()[:16] or None)
            if d.get("move_destination_aet")
            else None,
            tls=bool(d.get("tls", False)),
            supports=dict(d.get("supports") or {}),
            created_by=created_by,
            role_send=role_send,
            role_receive=role_receive,
            inbound_ip=inbound_ip,
            description=str(d.get("description") or ""),
            max_pdu=max_pdu,
            transfer_syntaxes=ts,
        )


# ── SCU ──────────────────────────────────────────────────────────────────────

MIN_PDU = 4096
MAX_PDU = 1 << 22  # 4 MiB
ALLOWED_TRANSFER_SYNTAXES = (
    "1.2.840.10008.1.2.1",  # Explicit VR Little Endian
    "1.2.840.10008.1.2",  # Implicit VR Little Endian
    "1.2.840.10008.1.2.2",  # Explicit VR Big Endian（退役，但老系統還有）
    "1.2.840.10008.1.2.1.99",  # Deflated Explicit VR Little Endian
)


RECEIVE_TRANSFER_SYNTAXES = (
    "1.2.840.10008.1.2",  # Implicit VR Little Endian
    "1.2.840.10008.1.2.1",  # Explicit VR Little Endian
    "1.2.840.10008.1.2.1.99",  # Deflated Explicit VR Little Endian
    "1.2.840.10008.1.2.2",  # Explicit VR Big Endian
)
"""我方 SCP 接收（C-STORE、C-MOVE 回送、C-GET 回送）只接受**未壓縮**的 Transfer Syntax —— 對方若是壓縮檔，
依 DICOM 協商它必須先解壓再送（多數 PACS 會），送不了就是該子操作失敗、拉回 job 記失敗數。這樣 JPEG Lossless／JPEG-LS
這類我們解不了的格式不會從網路進來；只有上傳／目錄匯入可能帶進來（照樣存、標「無法解碼」）。"""


def _contexts(node: Node) -> list[str] | None:
    """這個節點要提議的 Transfer Syntax（`add_requested_context` 的第二個參數）；None ＝ pynetdicom 預設。"""
    return list(node.transfer_syntaxes) or None


def _request(ae: Any, node: Node, abstract_syntax: Any) -> None:
    """提議一個 presentation context，Transfer Syntax 用節點的偏好。"""
    ts = _contexts(node)
    if ts:
        ae.add_requested_context(abstract_syntax, ts)
    else:
        ae.add_requested_context(abstract_syntax)


def _associate(ae: Any, node: Node, **kwargs: Any) -> Any:
    """所有 SCU 都經這裡連線：帶上節點的 PDU 上限。"""
    if node.max_pdu:
        kwargs["max_pdu"] = int(node.max_pdu)
    return ae.associate(node.host, node.port, ae_title=node.ae_title, **kwargs)


def _ae(calling: str | None) -> Any:
    from pynetdicom import AE

    cfg = current_settings()
    ae = AE(ae_title=calling or our_ae_title())
    ae.acse_timeout = int(cfg.acse_timeout)
    ae.dimse_timeout = int(cfg.dimse_timeout)
    ae.network_timeout = int(cfg.network_timeout)
    # 🔴 沒設的話 pynetdicom 連線**無限等**：對關機／防火牆丟包的節點 ECHO 會卡約 2 分鐘，UI 像壞掉
    ae.connection_timeout = int(getattr(cfg, "connect_timeout", 5) or 5)
    return ae


def echo(node: Node) -> dict[str, Any]:
    """C-ECHO；回 `{ok, latency_ms, error}`。"""
    from pynetdicom.sop_class import Verification

    ae = _ae(node.our_calling_aet)
    _request(ae, node, Verification)
    t0 = time.perf_counter()
    assoc = _associate(ae, node)
    if not assoc.is_established:
        elapsed = round((time.perf_counter() - t0) * 1000, 1)
        limit = int(getattr(current_settings(), "connect_timeout", 5))
        timed_out = elapsed >= limit * 1000 * 0.9
        return {
            "ok": False,
            "latency_ms": elapsed,
            "error": (
                f"連不上 {node.host}:{node.port}（TCP 逾時 {limit} 秒：主機關機或防火牆丟包）"
                if timed_out
                else "association 被拒或連線失敗（AE Title／host／port 或防火牆）"
            ),
        }
    try:
        status = assoc.send_c_echo()
        ok = bool(status) and int(status.Status) == 0x0000
        return {
            "ok": ok,
            "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
            "error": None if ok else f"status {getattr(status, 'Status', None)}",
        }
    finally:
        assoc.release()


PROBE_STORAGE_CLASSES = (
    "1.2.840.10008.5.1.4.1.1.2",  # CT
    "1.2.840.10008.5.1.4.1.1.481.3",  # RTSTRUCT
    "1.2.840.10008.5.1.4.1.1.481.2",  # RTDOSE
    "1.2.840.10008.5.1.4.1.1.481.5",  # RTPLAN
    "1.2.840.10008.5.1.4.1.1.66.1",  # REG
)


def probe(node: Node) -> dict[str, Any]:
    """一條 association 同時提出 Verification、Study Root FIND／MOVE／GET 與幾個 storage context，
    看對方接受哪些 → `supports`（echo／find／move／get／store）。連不上回 `ok=False`。"""
    from pynetdicom.sop_class import (
        StudyRootQueryRetrieveInformationModelFind,
        StudyRootQueryRetrieveInformationModelGet,
        StudyRootQueryRetrieveInformationModelMove,
        Verification,
    )

    wanted = {
        "echo": str(Verification),
        "find": str(StudyRootQueryRetrieveInformationModelFind),
        "move": str(StudyRootQueryRetrieveInformationModelMove),
        "get": str(StudyRootQueryRetrieveInformationModelGet),
    }
    ae = _ae(node.our_calling_aet)
    for uid in wanted.values():
        _request(ae, node, uid)
    for uid in PROBE_STORAGE_CLASSES:
        _request(ae, node, uid)
    t0 = time.perf_counter()
    assoc = _associate(ae, node)
    if not assoc.is_established:
        return {
            "ok": False,
            "latency_ms": None,
            "supports": {},
            "error": "association 失敗（AE Title／host／port 或防火牆）",
        }
    try:
        accepted = {str(cx.abstract_syntax) for cx in assoc.accepted_contexts}
        supports = {k: (uid in accepted) for k, uid in wanted.items()}
        supports["store"] = any(uid in accepted for uid in PROBE_STORAGE_CLASSES)
        latency = round((time.perf_counter() - t0) * 1000, 1)
        # 協商接受 FIND 不代表查得動（權限、索引、AE 白名單…）—— 真的送一個不會命中的 STUDY 查詢
        find_test = _probe_find(assoc) if supports["find"] else None
        return {
            "ok": True,
            "latency_ms": latency,
            "supports": supports,
            "accepted_count": len(accepted),
            "find_test": find_test,
            "error": None,
        }
    finally:
        assoc.release()


PROBE_STUDY_UID = "1.2.826.0.1.3680043.8.498.99999999999999999999"
"""探測用的 StudyInstanceUID：不會命中任何東西（UID 在我們的測試根下），查詢本身應該成功、0 筆。"""


def _probe_find(assoc: Any) -> dict[str, Any]:
    from pynetdicom.sop_class import StudyRootQueryRetrieveInformationModelFind

    ds = Dataset()
    ds.QueryRetrieveLevel = "STUDY"
    ds.StudyInstanceUID = PROBE_STUDY_UID
    ds.PatientID = ""
    ds.StudyDate = ""
    matches = 0
    final: int | None = None
    try:
        for status, identifier in assoc.send_c_find(ds, StudyRootQueryRetrieveInformationModelFind):
            if status is None:
                break
            code = int(status.Status)
            if code in (0xFF00, 0xFF01):
                matches += 1 if identifier is not None else 0
            else:
                final = code
    except Exception as exc:  # noqa: BLE001 - 探測失敗要回報，不是拋
        return {"ok": False, "status": None, "matches": matches, "error": str(exc)}
    ok = final == 0x0000
    return {
        "ok": ok,
        "status": None if final is None else f"0x{final:04X}",
        "matches": matches,
        "error": None if ok else ("沒有回應（逾時或連線中斷）" if final is None else f"C-FIND 回 0x{final:04X}"),
    }


_FIND_KEYS = {
    "patient": ["PatientID", "PatientName", "PatientBirthDate", "PatientSex", "NumberOfPatientRelatedStudies"],
    "study": [
        "PatientID",
        "PatientName",
        "StudyInstanceUID",
        "StudyDate",
        "StudyDescription",
        "AccessionNumber",
        "ModalitiesInStudy",
        "NumberOfStudyRelatedSeries",
        "NumberOfStudyRelatedInstances",
    ],
    "series": [
        "StudyInstanceUID",
        "SeriesInstanceUID",
        "Modality",
        "SeriesDescription",
        "SeriesNumber",
        "SeriesDate",
        "NumberOfSeriesRelatedInstances",
    ],
}


FIND_MAX_RESULTS = 500
"""一次 C-FIND 最多收幾筆；超過就送 C-CANCEL 停掉（大 PACS 用模糊條件一查幾萬筆，會把 UI 與記憶體拖垮）。"""


def find(node: Node, level: str, query: dict[str, Any], *, max_results: int = FIND_MAX_RESULTS) -> list[dict[str, Any]]:
    """Study Root C-FIND。`level` ∈ patient|study|series；`query` 的鍵是 DICOM 關鍵字（例：PatientID、StudyDate）。"""
    return find_capped(node, level, query, max_results=max_results)[0]


def find_capped(
    node: Node, level: str, query: dict[str, Any], *, max_results: int = FIND_MAX_RESULTS
) -> tuple[list[dict[str, Any]], bool]:
    """同 `find`，另回「是不是被截斷了」：收到 `max_results` 筆就送 C-CANCEL。"""
    from pynetdicom.sop_class import StudyRootQueryRetrieveInformationModelFind

    level = level.lower()
    if level not in _FIND_KEYS:
        raise ValueError("level 必須是 patient／study／series")
    ds = Dataset()
    ds.QueryRetrieveLevel = {"patient": "PATIENT", "study": "STUDY", "series": "SERIES"}[level]
    for key in _FIND_KEYS[level]:
        setattr(ds, key, query.get(key, ""))
    for key, value in query.items():
        if hasattr(ds, key) or key in _FIND_KEYS[level]:
            setattr(ds, key, value)
    ae = _ae(node.our_calling_aet)
    _request(ae, node, StudyRootQueryRetrieveInformationModelFind)
    assoc = _associate(ae, node)
    if not assoc.is_established:
        raise ConnectionError("association 失敗")
    out: list[dict[str, Any]] = []
    truncated = False
    msg_id = 1
    try:
        for status, identifier in assoc.send_c_find(ds, StudyRootQueryRetrieveInformationModelFind, msg_id=msg_id):
            if status is None:
                break
            if int(status.Status) in (0xFF00, 0xFF01) and identifier is not None:
                if len(out) >= max_results:
                    if not truncated:
                        truncated = True
                        cx = next(
                            c
                            for c in assoc.accepted_contexts
                            if str(c.abstract_syntax) == str(StudyRootQueryRetrieveInformationModelFind)
                        )
                        assoc.send_c_cancel(msg_id, cx.context_id)
                    continue  # 取消送出後還在路上的結果丟掉，等對方的最後狀態（Cancel 0xFE00）
                out.append({k: _plain(identifier.get(k)) for k in _FIND_KEYS[level] if k in identifier})
    finally:
        assoc.release()
    return out, truncated


def _plain(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, pydicom.multival.MultiValue):
        return [str(x) for x in v]
    return str(v.value if hasattr(v, "value") else v)


def store(node: Node, paths: list[Path], *, on_progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    """C-STORE 逐檔送出；回 `{sent, failed:[{path, status}], skipped_unsupported}`。"""
    from pynetdicom import StoragePresentationContexts, build_context

    ae = _ae(node.our_calling_aet)
    ts = _contexts(node)
    ae.requested_contexts = (
        [build_context(cx.abstract_syntax, ts) for cx in StoragePresentationContexts[:120]]
        if ts
        else StoragePresentationContexts[:120]
    )
    assoc = _associate(ae, node)
    if not assoc.is_established:
        raise ConnectionError("association 失敗")
    sent = 0
    failed: list[dict[str, Any]] = []
    try:
        for n, p in enumerate(paths):
            ds = pydicom.dcmread(str(p))
            try:
                status = assoc.send_c_store(ds)
                if status and int(status.Status) == 0x0000:
                    sent += 1
                else:
                    failed.append({"path": str(p), "status": getattr(status, "Status", None)})
            except Exception as exc:  # noqa: BLE001 - 單檔失敗記下來，繼續
                failed.append({"path": str(p), "status": str(exc)})
            if on_progress:
                on_progress(n + 1, len(paths))
    finally:
        assoc.release()
    return {"sent": sent, "failed": failed, "total": len(paths)}


def move(node: Node, *, study_uids: list[str], series_uids: list[str], destination_aet: str) -> dict[str, Any]:
    """C-MOVE：請對方把資料送到 `destination_aet`（我方 SCP，對方要先登錄它）。回對方的 completed／failed 計數。"""
    from pynetdicom.sop_class import StudyRootQueryRetrieveInformationModelMove

    ae = _ae(node.our_calling_aet)
    _request(ae, node, StudyRootQueryRetrieveInformationModelMove)
    assoc = _associate(ae, node)
    if not assoc.is_established:
        raise ConnectionError("association 失敗")
    completed = failed = warning = 0
    try:
        for ds in _retrieve_identifiers(study_uids, series_uids):
            for status, _ in assoc.send_c_move(ds, destination_aet, StudyRootQueryRetrieveInformationModelMove):
                if status is None:
                    break
                completed = int(getattr(status, "NumberOfCompletedSuboperations", completed) or completed)
                failed = int(getattr(status, "NumberOfFailedSuboperations", failed) or failed)
                warning = int(getattr(status, "NumberOfWarningSuboperations", warning) or warning)
    finally:
        assoc.release()
    return {"completed": completed, "failed": failed, "warning": warning}


def get(node: Node, *, study_uids: list[str], series_uids: list[str], out_dir: Path) -> dict[str, Any]:
    """C-GET：資料在同一條 association 回來（我方當 storage SCP 角色），寫進 `out_dir`。"""
    from pynetdicom import StoragePresentationContexts, build_role, evt
    from pynetdicom.sop_class import StudyRootQueryRetrieveInformationModelGet

    out_dir.mkdir(parents=True, exist_ok=True)
    received: list[str] = []

    def on_store(event: Any) -> int:
        ds = event.dataset
        ds.file_meta = event.file_meta
        path = out_dir / f"{ds.SOPInstanceUID}.dcm"
        ds.save_as(str(path), enforce_file_format=True)
        received.append(str(path))
        return 0x0000

    ae = _ae(node.our_calling_aet)
    _request(ae, node, StudyRootQueryRetrieveInformationModelGet)
    roles = []
    for cx in StoragePresentationContexts[:110]:
        _request(ae, node, cx.abstract_syntax)
        roles.append(build_role(cx.abstract_syntax, scp_role=True))
    assoc = _associate(ae, node, ext_neg=roles, evt_handlers=[(evt.EVT_C_STORE, on_store)])
    if not assoc.is_established:
        raise ConnectionError("association 失敗")
    completed = failed = 0
    try:
        for ds in _retrieve_identifiers(study_uids, series_uids):
            for status, _ in assoc.send_c_get(ds, StudyRootQueryRetrieveInformationModelGet):
                if status is None:
                    break
                completed = int(getattr(status, "NumberOfCompletedSuboperations", completed) or completed)
                failed = int(getattr(status, "NumberOfFailedSuboperations", failed) or failed)
    finally:
        assoc.release()
    return {"completed": completed, "failed": failed, "received": len(received), "dir": str(out_dir)}


def _retrieve_identifiers(study_uids: list[str], series_uids: list[str]) -> list[Dataset]:
    out: list[Dataset] = []
    for uid in study_uids:
        ds = Dataset()
        ds.QueryRetrieveLevel = "STUDY"
        ds.StudyInstanceUID = uid
        out.append(ds)
    for uid in series_uids:
        ds = Dataset()
        ds.QueryRetrieveLevel = "SERIES"
        ds.SeriesInstanceUID = uid
        out.append(ds)
    if not out:
        raise ValueError("要給 study_uids 或 series_uids")
    return out


# ── SCP ──────────────────────────────────────────────────────────────────────

OnBatch = Callable[[Path, dict[str, Any]], None]
"""一批收完（association 結束或閒置）→ (暫存目錄, meta)。

meta：calling_aet、remote、received、unsupported、started_at。"""


IsAllowed = Callable[[str, str], tuple[bool, str | None]]
"""(calling_aet, remote_ip) → (允許？, node_id)。None ＝ 全部接受。"""


class ReceiveServer:
    """我方 storage SCP。每條 association 一個暫存子目錄；結束就交給 `on_batch`。

    * `is_allowed`：接收驗證；拒絕的 association 回 A-ASSOCIATE-RJ，計入 `rejected_total`。
    * `unsupported_policy`：`store`（收下標記）或 `reject`（回 0x0122）。
    * `idle_seconds`：閒置多久算一批結束。

    交批：每個 instance 寫進暫存區就回 0x0000，所以**暫存區裡的每一批都一定要進匯入佇列**。
    `on_batch` 失敗（佇列寫不進去）→ 記 log、記在 `status()`，由清掃執行緒每 `HANDOFF_RETRY_SECONDS` 重試；
    交出去之後在批次目錄旁寫 `<batch>.queued`。行程重啟（或接收端重起）時，清掃執行緒先把暫存區裡**沒有** `.queued`
    的批次交出去 —— 以前交批錯誤被吞掉、沒有 log，對方以為送成功，資料停在暫存區沒人知道。
    `on_batch` 會等佇列寫入完成，只在 pynetdicom 的執行緒與清掃執行緒呼叫，不在 event loop 上呼叫。
    """

    def __init__(
        self,
        *,
        staging_root: Path,
        on_batch: OnBatch,
        ae_title: str | None = None,
        port: int | None = None,
        host: str = "0.0.0.0",
        is_allowed: IsAllowed | None = None,
        unsupported_policy: str = "store",
        idle_seconds: float = ASSOC_IDLE_SECONDS,
        network_timeout: int = 60,
    ) -> None:
        self.staging_root = Path(staging_root)
        self.on_batch = on_batch
        self.ae_title = ae_title or our_ae_title()
        self.port = port or our_scp_port()
        self.host = host
        self.is_allowed = is_allowed
        self.unsupported_policy = unsupported_policy
        self.idle_seconds = float(idle_seconds)
        self.network_timeout = int(network_timeout)
        self._server: Any = None
        self._batches: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self.received_total = 0
        self.rejected_total = 0
        self.last_rejected: dict[str, Any] | None = None
        self.last_batch: dict[str, Any] | None = None
        self.started_at: str | None = None
        self._unhanded: dict[str, tuple[Path, dict[str, Any]]] = {}
        """交批失敗、等重試的批次：batch_id → (目錄, meta)。"""
        self.handoff_failures = 0
        self.last_handoff_error: str | None = None
        self.recovered_total = 0

    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        from pynetdicom import AE, AllStoragePresentationContexts, build_context, evt
        from pynetdicom.sop_class import Verification

        ae = AE(ae_title=self.ae_title)
        ae.supported_contexts = [
            build_context(cx.abstract_syntax, list(RECEIVE_TRANSFER_SYNTAXES)) for cx in AllStoragePresentationContexts
        ]
        ae.add_supported_context(Verification)
        ae.maximum_pdu_size = 0
        ae.network_timeout = self.network_timeout
        handlers = [
            (evt.EVT_REQUESTED, self._on_requested),
            (evt.EVT_C_STORE, self._on_store),
            (evt.EVT_RELEASED, self._on_end),
            (evt.EVT_ABORTED, self._on_end),
            (evt.EVT_CONN_CLOSE, self._on_end),
        ]
        self._server = ae.start_server((self.host, self.port), block=False, evt_handlers=handlers)
        self.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        self._stop_sweeper = threading.Event()
        self._sweeper = threading.Thread(target=self._sweep_loop, name="rtgaia-scp-sweeper", daemon=True)
        self._sweeper.start()

    def _sweep_loop(self) -> None:
        try:
            self.recover_orphans()
        except Exception:  # noqa: BLE001 - 清掃執行緒不能因此結束
            log.exception("DICOM receiver: recovering unqueued batches failed")
        last_retry = time.time()
        while not self._stop_sweeper.wait(1.0):
            try:
                self.sweep_idle()
                if self._unhanded and time.time() - last_retry >= HANDOFF_RETRY_SECONDS:
                    last_retry = time.time()
                    self.retry_unhanded()
            except Exception:  # noqa: BLE001
                log.exception("DICOM receiver: sweeping idle associations failed")

    def stop(self) -> None:
        if getattr(self, "_stop_sweeper", None) is not None:
            self._stop_sweeper.set()
        if self._server is not None:
            self._server.shutdown()
            self._server = None
        # 還沒結束的批次留在暫存區（沒有 `.queued`）：下次啟動時清掃執行緒交出去。
        # 不在這裡交：`stop()` 可能在 event loop 上被呼叫，而交批要等那個 loop 把 job 寫進佇列（會互等）。
        with self._lock:
            self._batches.clear()

    @staticmethod
    def _requestor(event: Any) -> tuple[str, str]:
        """(calling AET, 遠端 IP)。EVT_REQUESTED 時 `requestor.ae_title` 還沒設，要從 primitive 拿。"""
        req = event.assoc.requestor
        primitive = getattr(req, "primitive", None)
        aet = str(getattr(primitive, "calling_ae_title", None) or req.ae_title or "").strip()
        return aet, str(req.address or "")

    def _on_requested(self, event: Any) -> None:
        if self.is_allowed is None:
            return
        aet, ip = self._requestor(event)
        try:
            ok, node_id = self.is_allowed(aet, ip)
        except Exception:  # noqa: BLE001 - 驗證本身壞了（DB 掛）：拒絕，別放行
            ok, node_id = False, None
        if ok:
            key = id(event.assoc)
            with self._lock:
                self._node_of = getattr(self, "_node_of", {})
                self._node_of[key] = node_id
            return
        self.rejected_total += 1
        self.last_rejected = {
            "calling_aet": aet,
            "remote": ip,
            "at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        # 0x01 永久拒絕、0x01 service user、0x03 calling AE title not recognised
        event.assoc.acse.send_reject(0x01, 0x01, 0x03)

    def _batch_for(self, event: Any) -> dict[str, Any]:
        key = id(event.assoc)
        with self._lock:
            meta = self._batches.get(key)
            if meta is None:
                batch_id = f"scp_{uuid.uuid4().hex[:10]}"
                d = self.staging_root / batch_id
                d.mkdir(parents=True, exist_ok=True)
                meta = {
                    "batch_id": batch_id,
                    "dir": d,
                    "calling_aet": str(event.assoc.requestor.ae_title).strip(),
                    "remote": f"{event.assoc.requestor.address}:{event.assoc.requestor.port}",
                    "node_id": getattr(self, "_node_of", {}).get(key),
                    "received": 0,
                    "unsupported": 0,
                    "started_at": datetime.now(UTC).isoformat(timespec="seconds"),
                    "last_at": time.time(),
                }
                self._batches[key] = meta
            return meta

    def _on_store(self, event: Any) -> int:
        meta = self._batch_for(event)
        ds = event.dataset
        ds.file_meta = event.file_meta
        sop_class = str(getattr(ds, "SOPClassUID", ""))
        meta["last_at"] = time.time()
        if sop_class not in ACCEPTED_SOP_CLASSES:
            meta["unsupported"] += 1
            if self.unsupported_policy == "reject":
                meta["rejected"] = meta.get("rejected", 0) + 1
                return 0x0122  # SOP Class not supported（只這一個 instance 失敗，association 繼續）
            # 預設收下、標記；不讓對方的傳輸失敗
        name = f"{getattr(ds, 'SOPInstanceUID', uuid.uuid4().hex)}.dcm"
        ds.save_as(str(meta["dir"] / name), enforce_file_format=True)
        meta["received"] += 1
        self.received_total += 1
        return 0x0000

    def _on_end(self, event: Any) -> None:
        key = id(event.assoc)
        with self._lock:
            meta = self._batches.pop(key, None)
            getattr(self, "_node_of", {}).pop(key, None)
        if meta is not None:
            self._finish(meta)

    def _finish(self, meta: dict[str, Any]) -> None:
        if meta["received"] == 0:
            try:
                Path(meta["dir"]).rmdir()
            except OSError:
                pass
            return
        public = {k: v for k, v in meta.items() if k not in ("dir", "last_at")}
        self.last_batch = {**public, "finished_at": datetime.now(UTC).isoformat(timespec="seconds")}
        try:  # meta 留一份在旁邊：交批失敗、行程重啟後補交時還知道是誰送的
            meta_file = self.staging_root / f"{meta['batch_id']}.json"
            meta_file.write_text(json.dumps(public, default=str), encoding="utf-8")
        except OSError:
            log.warning("DICOM receiver: could not write the metadata of batch %s", meta["batch_id"], exc_info=True)
        self._hand_off(str(meta["batch_id"]), Path(meta["dir"]), public)

    def _hand_off(self, batch_id: str, directory: Path, meta: dict[str, Any]) -> bool:
        """交給匯入佇列；失敗不弄掛接收端，記下來等重試。成功就在旁邊寫 `<batch>.queued`。"""
        try:
            self.on_batch(directory, meta)
        except Exception as exc:  # noqa: BLE001
            log.exception("DICOM receiver: batch %s was not queued for import; will retry", batch_id)
            with self._lock:
                self._unhanded[batch_id] = (directory, meta)
            self.handoff_failures += 1
            self.last_handoff_error = f"{type(exc).__name__}: {exc}"
            return False
        with self._lock:
            self._unhanded.pop(batch_id, None)
        try:
            (self.staging_root / f"{batch_id}.queued").write_text(
                datetime.now(UTC).isoformat(timespec="seconds"), encoding="utf-8"
            )
        except OSError:
            log.warning("DICOM receiver: could not mark batch %s as queued", batch_id, exc_info=True)
        return True

    def retry_unhanded(self) -> int:
        """重試交批失敗的批次；回交出去了幾批。"""
        with self._lock:
            waiting = list(self._unhanded.items())
        return sum(1 for batch_id, (d, meta) in waiting if self._hand_off(batch_id, d, meta))

    def recover_orphans(self) -> int:
        """暫存區裡沒有 `.queued` 的批次（上次交批失敗、行程中途停掉）→ 交出去；`.queued`／`.json` 的目錄已經不在
        （匯入完清掉了）→ 標記也清掉。回補交了幾批。"""
        if not self.staging_root.is_dir():
            return 0
        with self._lock:
            open_dirs = {str(m["dir"]) for m in self._batches.values()}
            waiting = set(self._unhanded)
        recovered = 0
        for d in sorted(self.staging_root.glob("scp_*")):
            if d.is_dir():
                batch_id = d.name
                if (self.staging_root / f"{batch_id}.queued").exists() or str(d) in open_dirs or batch_id in waiting:
                    continue
                try:
                    meta = json.loads((self.staging_root / f"{batch_id}.json").read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    meta = {"batch_id": batch_id}
                meta["recovered"] = True
                log.warning("DICOM receiver: queueing batch %s left in the staging area", batch_id)
                if self._hand_off(batch_id, d, meta):
                    recovered += 1
            elif d.suffix in (".queued", ".json") and not (self.staging_root / d.stem).exists():
                d.unlink(missing_ok=True)
        self.recovered_total += recovered
        return recovered

    def sweep_idle(self, idle_seconds: float | None = None) -> int:
        """把閒置太久的 association 當一批結束（對方忘了 release 的保險）。回結束了幾批。"""
        idle = self.idle_seconds if idle_seconds is None else idle_seconds
        now = time.time()
        with self._lock:
            stale = [k for k, m in self._batches.items() if now - m["last_at"] > idle]
            metas = [self._batches.pop(k) for k in stale]
        for m in metas:
            self._finish(m)
        return len(metas)

    def status(self) -> dict[str, Any]:
        return {
            "ae_title": self.ae_title,
            "port": self.port,
            "running": self.running,
            "started_at": self.started_at,
            "host": self.host,
            "received_total": self.received_total,
            "rejected_total": self.rejected_total,
            "last_rejected": self.last_rejected,
            "last_batch": self.last_batch,
            "open_associations": len(self._batches),
            "unqueued_batches": len(self._unhanded),
            "handoff_failures": self.handoff_failures,
            "last_handoff_error": self.last_handoff_error,
            "recovered_total": self.recovered_total,
            "verify_callers": self.is_allowed is not None,
            "unsupported_policy": self.unsupported_policy,
            "idle_seconds": self.idle_seconds,
            "accepted_sop_classes": ACCEPTED_SOP_CLASSES,
        }
