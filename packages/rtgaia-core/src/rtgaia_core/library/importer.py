"""匯入管線。

所有來源共用同一條：

    接收 → 暫存區（.staging/<batch>/）→ 驗證（是 DICOM、有 SOP UID、模態在支援清單）
      → 去重（SOPInstanceUID ＋ sha256）→ 落地（blobs/<sha[:2]>/<sha>.dcm）→ 重新索引 → 完成

* **同 SOP UID 不同內容一律拒絕**（`duplicate_diff`），不覆寫 —— 那是資料事故，必須讓人看到。
* 檔名用 sha256（內容定址）：路徑不含 PHI、重複匯入自然去重、病人合併不必搬檔。
* 暫存區是隱藏目錄，索引掃描（`scan.iter_files`）會跳過它。
* 匯入批次的記錄在記憶體（不進 job 表）；暫存區在磁碟，重啟後可清。

**不在這裡做的**：整組序列的幾何驗證（DL2–DL12）—— 那需要整個序列到齊，在開啟病例時由載入器做；
匯入只驗「這個檔案是什麼」。
"""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from ..limits import limit
from .index import LibraryIndex
from .scan import IMAGE_MODALITIES, RT_MODALITIES, read_header

Outcome = Literal["staged", "accepted", "duplicate_same", "duplicate_diff", "rejected"]
Source = Literal["upload", "server_path"]
Status = Literal["open", "running", "done", "failed", "discarded"]

SUPPORTED_MODALITIES = frozenset(IMAGE_MODALITIES | RT_MODALITIES)
"""上傳只收這些；其餘 `rejected: unsupported modality`。（DIMSE 接收端會不同：收下並標記。）"""

STAGING_DIR = ".staging"
BLOBS_DIR = "blobs"
_ZIP_MAGIC = b"PK\x03\x04"
_DICM_OFFSET = 128


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class ImportItem:
    relative_path: str
    outcome: Outcome
    reason: str = ""
    sop_instance_uid: str = ""
    modality: str = ""
    size: int = 0
    stored_path: str = ""
    staged_path: str = ""
    series_instance_uid: str = ""
    study_instance_uid: str = ""
    transfer_syntax_uid: str = ""
    """收下的檔的壓縮格式（原樣存、不轉碼；解不了的在批次上列出來）。"""

    def to_wire(self) -> dict[str, Any]:
        return {
            "relative_path": self.relative_path,
            "outcome": self.outcome,
            "reason": self.reason,
            "sop_instance_uid": self.sop_instance_uid,
            "modality": self.modality,
            "size": self.size,
        }


@dataclass
class ImportBatch:
    batch_id: str
    source: Source
    detail: dict[str, Any]
    staging: Path
    created_by: str = "anonymous"
    status: Status = "open"
    created_at: str = field(default_factory=_now)
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    items: list[ImportItem] = field(default_factory=list)
    percent: int = 0
    phase: str = "open"
    touched_patient_ids: list[str] = field(default_factory=list)

    def series_summary(self) -> list[dict[str, Any]]:
        """（給 `service.call` 用）這批**收下**的序列——study／series UID、模態、張數。"""
        acc: dict[tuple[str, str, str], int] = {}
        for it in self.items:
            if it.outcome in ("accepted", "duplicate_same") and it.series_instance_uid:  # 🔴 Outcome 沒有 "stored"
                key = (it.study_instance_uid, it.series_instance_uid, it.modality)
                acc[key] = acc.get(key, 0) + 1
        return [
            {"study_instance_uid": k[0], "series_instance_uid": k[1], "modality": k[2], "count": n}
            for k, n in sorted(acc.items())
        ]

    def undecodable_series(self) -> list[dict[str, Any]]:
        """這批收下、但壓縮格式目前解不了的影像序列（照樣存著、可下載／轉送，只是檢視器開不了）。"""
        from ..pixel_codecs import can_decode, transfer_syntax_name, undecodable_reason
        from .scan import IMAGE_MODALITIES

        acc: dict[tuple[str, str, str], int] = {}
        for it in self.items:
            if it.outcome not in ("accepted", "duplicate_same") or it.modality not in IMAGE_MODALITIES:
                continue
            if it.transfer_syntax_uid and not can_decode(it.transfer_syntax_uid):
                key = (it.series_instance_uid, it.modality, it.transfer_syntax_uid)
                acc[key] = acc.get(key, 0) + 1
        return [
            {
                "series_instance_uid": k[0],
                "modality": k[1],
                "count": n,
                "transfer_syntax": transfer_syntax_name(k[2]),
                "reason": undecodable_reason(k[2]),
            }
            for k, n in sorted(acc.items())
        ]

    def counts(self) -> dict[str, int]:
        out = {
            "received": len(self.items),
            "staged": 0,
            "accepted": 0,
            "duplicate_same": 0,
            "duplicate_diff": 0,
            "rejected": 0,
        }
        for it in self.items:
            out[it.outcome] = out.get(it.outcome, 0) + 1
        return out

    def to_wire(self, *, items: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {
            "batch_id": self.batch_id,
            "source": self.source,
            "detail": self.detail,
            "created_by": self.created_by,
            "status": self.status,
            "phase": self.phase,
            "percent": self.percent,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "counts": self.counts(),
            "touched_patient_ids": list(self.touched_patient_ids),
            "undecodable": self.undecodable_series(),
        }
        if items:
            out["items"] = [it.to_wire() for it in self.items]
        return out


class Importer:
    """一個資料庫根目錄的匯入器。`root` ＝ `LibraryIndex` 掃的那個目錄。"""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.batches: dict[str, ImportBatch] = {}
        self._hash_cache: dict[str, str] = {}

    # ── 批次 ────────────────────────────────────────────────────────────────

    def open_batch(
        self, source: Source, detail: dict[str, Any] | None = None, *, created_by: str = "anonymous"
    ) -> ImportBatch:
        batch_id = f"imp_{uuid.uuid4().hex[:10]}"
        staging = self.root / STAGING_DIR / batch_id
        staging.mkdir(parents=True, exist_ok=True)
        b = ImportBatch(
            batch_id=batch_id, source=source, detail=dict(detail or {}), staging=staging, created_by=created_by
        )
        self.batches[batch_id] = b
        return b

    def get(self, batch_id: str) -> ImportBatch:
        try:
            return self.batches[batch_id]
        except KeyError as exc:
            raise KeyError(f"沒有匯入批次 {batch_id}") from exc

    def list(self) -> list[ImportBatch]:
        return sorted(self.batches.values(), key=lambda b: b.created_at, reverse=True)

    def discard(self, batch_id: str) -> ImportBatch:
        b = self.get(batch_id)
        if b.status == "running":
            raise ValueError("批次正在處理，不能丟棄")
        shutil.rmtree(b.staging, ignore_errors=True)
        b.status = "discarded"
        b.phase = "discarded"
        return b

    # ── 接收 ────────────────────────────────────────────────────────────────

    def receive(self, batch: ImportBatch, relative_path: str, data: bytes) -> list[ImportItem]:
        """把一個上傳的檔案放進暫存區。zip 就地解開（成員各自成為一個 item）。

        回傳這次新增的 items。**非 DICOM 在這裡就拒絕**（讀前 132 bytes 的 `DICM`），
        不佔暫存區。
        """
        if batch.status != "open":
            raise ValueError(f"批次 {batch.batch_id} 狀態是 {batch.status}，不再接收檔案")
        rel = _safe_relative(relative_path)
        if data[:4] == _ZIP_MAGIC or rel.lower().endswith(".zip"):
            return self._receive_zip(batch, rel, data)
        return [self._stage(batch, rel, data)]

    def _receive_zip(self, batch: ImportBatch, rel: str, data: bytes) -> list[ImportItem]:
        out: list[ImportItem] = []
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            item = ImportItem(relative_path=rel, outcome="rejected", reason="不是有效的 zip", size=len(data))
            batch.items.append(item)
            return [item]
        # 先看 zip 目錄的**宣告值**（成員數、展開總量、壓縮比），超限整包拒絕、一個成員都不解；
        # 再逐成員以宣告大小 +1 讀，實際比宣告長（造假的 header）就拒那個成員。
        infos = [i for i in zf.infolist() if not i.is_dir()]
        members_max = limit("RTGAIA_ZIP_MEMBERS_MAX")
        total_max = limit("RTGAIA_ZIP_TOTAL_MAX_BYTES")
        ratio_max = limit("RTGAIA_ZIP_RATIO_MAX")
        declared = sum(int(i.file_size) for i in infos)
        why = None
        if len(infos) > members_max:
            why = f"zip 成員 {len(infos)} 個超過上限 {members_max}"
        elif declared > total_max:
            why = f"zip 展開後 {declared} bytes 超過上限 {total_max}"
        elif len(data) > 0 and declared / len(data) > ratio_max:
            why = f"zip 壓縮比 {declared / len(data):.0f}:1 超過上限 {ratio_max}:1（疑似 zip bomb）"
        if why is not None:
            item = ImportItem(relative_path=rel, outcome="rejected", reason=why, size=len(data))
            batch.items.append(item)
            return [item]
        prefix = rel[:-4] if rel.lower().endswith(".zip") else rel
        actual_total = 0
        for info in infos:
            member = _safe_relative(info.filename)
            if not member:
                continue
            with zf.open(info) as f:
                payload = f.read(int(info.file_size) + 1)
            if len(payload) > info.file_size:
                item = ImportItem(
                    relative_path=f"{prefix}/{member}", outcome="rejected", reason="zip 成員實際大小與宣告不符", size=0
                )
                batch.items.append(item)
                out.append(item)
                continue
            actual_total += len(payload)
            if actual_total > total_max:
                item = ImportItem(
                    relative_path=f"{prefix}/{member}",
                    outcome="rejected",
                    reason=f"zip 展開累計超過上限 {total_max}",
                    size=0,
                )
                batch.items.append(item)
                out.append(item)
                break
            out.append(self._stage(batch, f"{prefix}/{member}", payload))
        if not out:
            item = ImportItem(relative_path=rel, outcome="rejected", reason="zip 裡沒有檔案", size=len(data))
            batch.items.append(item)
            out.append(item)
        return out

    def _stage(self, batch: ImportBatch, rel: str, data: bytes) -> ImportItem:
        if len(data) < _DICM_OFFSET + 4 or data[_DICM_OFFSET : _DICM_OFFSET + 4] != b"DICM":
            item = ImportItem(
                relative_path=rel, outcome="rejected", reason="不是 DICOM（沒有 DICM 前導）", size=len(data)
            )
            batch.items.append(item)
            return item
        # 實體路徑用 item 自己的亂數名，**原始檔名只是 metadata**。先前 `staging / rel`
        # 讓同批兩份不同內容的 `image.dcm` 互相覆寫——第一份在 DICOM 驗證前就消失（zip 重複成員同理）。
        # 不用內容雜湊當檔名：內容相同的兩個檔也該各自留一份，去重是後面 sha 落地那一步的職責。
        batch.staging.mkdir(parents=True, exist_ok=True)
        dst = batch.staging / f"{uuid.uuid4().hex}.dcm"
        dst.write_bytes(data)
        item = ImportItem(relative_path=rel, outcome="staged", size=len(data), staged_path=str(dst))
        batch.items.append(item)
        return item

    def stage_directory(self, batch: ImportBatch, directory: str | Path) -> int:
        """伺服器目錄來源：不複製進暫存區，直接以來源檔為 staged（落地時是複製而非搬移）。"""
        src = Path(directory).expanduser().resolve()
        if not src.is_dir():
            raise ValueError(f"不是目錄：{src}")
        n = 0
        for dirpath, dirnames, filenames in os.walk(src):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(filenames):
                if name.startswith("."):
                    continue
                p = Path(dirpath) / name
                rel = str(p.relative_to(src))
                try:
                    with p.open("rb") as f:
                        head = f.read(_DICM_OFFSET + 4)
                except OSError as exc:
                    batch.items.append(ImportItem(relative_path=rel, outcome="rejected", reason=f"讀不到：{exc}"))
                    continue
                if head[_DICM_OFFSET : _DICM_OFFSET + 4] != b"DICM":
                    batch.items.append(
                        ImportItem(
                            relative_path=rel,
                            outcome="rejected",
                            reason="不是 DICOM（沒有 DICM 前導）",
                            size=p.stat().st_size,
                        )
                    )
                    continue
                batch.items.append(
                    ImportItem(relative_path=rel, outcome="staged", size=p.stat().st_size, staged_path=str(p))
                )
                n += 1
        return n

    # ── 處理 ────────────────────────────────────────────────────────────────

    def process(
        self, batch: ImportBatch, index: LibraryIndex, *, move: bool | None = None, finalize: bool = True
    ) -> None:
        """驗證、去重、落地。同步、阻塞 —— 呼叫端用 `asyncio.to_thread`。

        `move`：上傳來源的暫存檔搬進 blobs；伺服器目錄來源複製（來源檔不動）。
        `finalize=False`：落地後**停在 `index` 階段不標 done** —— 呼叫端要先重掃索引再 `finish()`。
        🔴 否則前端一看到 done 就去查目錄樹，而索引還是舊的；下一批的去重也會拿到舊索引（實際踩過）。
        """
        if batch.status not in ("open",):
            raise ValueError(f"批次 {batch.batch_id} 狀態是 {batch.status}")
        move = (batch.source == "upload") if move is None else move
        batch.status = "running"
        batch.started_at = _now()
        batch.phase = "validate"
        staged = [it for it in batch.items if it.outcome == "staged"]
        seen_in_batch: dict[str, str] = {}
        touched: set[str] = set()
        try:
            for n, item in enumerate(staged):
                self._process_one(item, index, seen_in_batch, touched, move=move)
                batch.percent = int(90 * (n + 1) / max(1, len(staged)))
            batch.phase = "index"
            batch.touched_patient_ids = sorted(touched)
            if move:
                shutil.rmtree(batch.staging, ignore_errors=True)
            if finalize:
                self.finish(batch)
        except Exception as exc:  # noqa: BLE001 - 批次失敗必須看得見
            self.fail(batch, exc)
            raise

    @staticmethod
    def finish(batch: ImportBatch) -> None:
        batch.status = "done"
        batch.phase = "done"
        batch.percent = 100
        batch.finished_at = _now()

    @staticmethod
    def fail(batch: ImportBatch, exc: BaseException) -> None:
        batch.status = "failed"
        batch.phase = "failed"
        batch.error = f"{type(exc).__name__}: {exc}"
        batch.finished_at = _now()

    def _process_one(
        self, item: ImportItem, index: LibraryIndex, seen_in_batch: dict[str, str], touched: set[str], *, move: bool
    ) -> None:
        src = Path(item.staged_path)
        header = read_header(src)
        if header is None:
            item.outcome, item.reason = "rejected", "讀不出 DICOM 標頭或沒有 SeriesInstanceUID"
            return
        item.sop_instance_uid = header.sop_instance_uid
        item.modality = header.modality
        item.series_instance_uid = header.series_instance_uid
        item.study_instance_uid = header.study_instance_uid
        item.transfer_syntax_uid = header.transfer_syntax_uid
        if not header.sop_instance_uid:
            item.outcome, item.reason = "rejected", "沒有 SOPInstanceUID"
            return
        if header.modality not in SUPPORTED_MODALITIES:
            item.outcome, item.reason = "rejected", f"不支援的模態 {header.modality or '(空)'}"
            return
        digest = _sha256(src)
        # 先問庫（權威），再問同一批：庫裡有同內容 → duplicate_same，即使這一批稍早有人送了篡改版
        existing = index.series_of_sop(header.sop_instance_uid)
        if existing is not None:
            existing_path = next(
                (h.path for h in existing.instances if h.sop_instance_uid == header.sop_instance_uid), None
            )
            if existing_path and Path(existing_path).exists():
                if self._cached_sha(existing_path) == digest:
                    item.outcome, item.reason = "duplicate_same", "庫裡已有相同內容"
                else:
                    item.outcome, item.reason = "duplicate_diff", "庫裡已有同 SOPInstanceUID 但**內容不同** —— 不覆寫"
                return
        prev = seen_in_batch.get(header.sop_instance_uid)
        if prev is not None:
            item.outcome = "duplicate_same" if prev == digest else "duplicate_diff"
            item.reason = "同一批已有相同 SOPInstanceUID" + ("" if prev == digest else "，**內容不同**")
            return
        dst = self.root / BLOBS_DIR / digest[:2] / f"{digest}.dcm"
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            # 內容相同的檔已在 blobs（例如索引快取還沒更新）：視為已存在
            item.outcome, item.reason = "duplicate_same", "blobs 已有相同內容"
            return
        if move:
            shutil.move(str(src), str(dst))
        else:
            shutil.copy2(str(src), str(dst))
        seen_in_batch[header.sop_instance_uid] = digest
        item.outcome = "accepted"
        item.stored_path = str(dst)
        if header.patient_id:
            touched.add(header.patient_id)

    def _cached_sha(self, path: str) -> str:
        if path not in self._hash_cache:
            self._hash_cache[path] = _sha256(Path(path))
        return self._hash_cache[path]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _safe_relative(path: str) -> str:
    """去掉開頭斜線與 `..`，保留子目錄結構（zip 裡的目錄、`webkitRelativePath`）。"""
    parts = [p for p in path.replace("\\", "/").split("/") if p and p not in (".", "..")]
    return "/".join(parts)
