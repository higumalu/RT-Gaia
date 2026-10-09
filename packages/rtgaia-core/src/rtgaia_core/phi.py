"""PHI 落地規則：**PatientName 不以明文持久化**。

* 所有會落地或進快取的地方（`instance.header`、`patient` 表、目錄索引的磁碟快取、記憶體索引）只存
  `hash_patient_name()` 的結果：HMAC-SHA256（鍵見 `phi_key()`），前綴 `pnh1:`。用途只有「是不是同一個名字」。
* 搜尋只比 **PatientID**（名字不參與比對）。
* `--show-patient-names`（`RTGAIA_LIBRARY_SHOW_NAMES=1`）開著時，名字**當下從 DICOM 檔讀**（`read_patient_name()`），
  只放在行程記憶體裡；檔案本來就在資料目錄，這裡不增加任何副本。
* 匯出 RTSTRUCT 關閉匿名化時仍直接讀影像檔的 PatientName（不經 DB）。

鍵：`RTGAIA_PHI_KEY` > `RTGAIA_SECRET` 派生 > 開發用固定鍵。換鍵後舊雜湊不再相符 —— 雜湊不參與任何功能性比對，
只影響「同名」判斷，下一次重掃會以新鍵重算。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
from pathlib import Path

PREFIX = "pnh1:"
_DEV_KEY = b"rtgaia-dev-phi-key (set RTGAIA_PHI_KEY or RTGAIA_SECRET in production)"


def phi_key() -> bytes:
    raw = os.environ.get("RTGAIA_PHI_KEY", "").strip()
    if raw:
        return hashlib.sha256(b"rtgaia-phi-key:" + raw.encode("utf-8")).digest()
    secret = os.environ.get("RTGAIA_SECRET", "").strip()
    if secret:
        return hashlib.sha256(b"rtgaia-phi-from-secret:" + secret.encode("utf-8")).digest()
    return hashlib.sha256(_DEV_KEY).digest()


def normalize_person_name(name: str) -> str:
    """DICOM PN 正規化：去頭尾空白、轉大寫、連續空白合一、去掉結尾多餘的 `^`／`=`（`DOE^JOHN^^` ≡ `DOE^JOHN`）。"""
    s = re.sub(r"\s+", " ", str(name or "").strip().upper())
    return s.rstrip("^=").strip()


def hash_patient_name(name: str | None, key: bytes | None = None) -> str:
    norm = normalize_person_name(name or "")
    if not norm:
        return ""
    if is_patient_name_hash(norm.lower()):
        return norm.lower()  # 已經是雜湊（重跑轉換不會雙重雜湊）
    digest = hmac.new(key or phi_key(), norm.encode("utf-8"), hashlib.sha256).hexdigest()
    return PREFIX + digest[:32]


def is_patient_name_hash(value: str | None) -> bool:
    return bool(value) and str(value).startswith(PREFIX) and len(str(value)) == len(PREFIX) + 32


def read_patient_name(path: str | Path) -> str:
    """只讀那一個標籤（`stop_before_pixels` ＋ `specific_tags`）。讀不到回空字串，不拋例外。"""
    try:
        import pydicom

        ds = pydicom.dcmread(str(path), stop_before_pixels=True, specific_tags=["PatientName"])
        return str(getattr(ds, "PatientName", "") or "")
    except Exception:  # noqa: BLE001 — 顯示名字是加分項；檔案不見或壞了就不顯示
        return ""
