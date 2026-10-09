"""壓縮影像能不能解碼（只解碼不轉碼）。

解碼靠 pydicom 的 pixel data plugin：Pillow（JPEG baseline／extended、JPEG 2000）、pylibjpeg ＋ pylibjpeg-openjpeg
（JPEG 2000）、pylibjpeg-rle（RLE）—— 全部 MIT／HPND。**JPEG Lossless（Process 14）與 JPEG-LS 目前沒有解碼器**：
寬鬆授權的選項只有 GDCM（python-gdcm），但它的 wheel 內含 EOL 的 OpenSSL 1.1.1，要不要收是 SOUP 決定；
GPL 的 pylibjpeg-libjpeg 不收。解不了的序列在資料頁標出來、載入時給清楚的原因，不轉碼。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from pydicom.uid import UID


@lru_cache(maxsize=64)
def transfer_syntax_name(uid: str) -> str:
    """`1.2.840.10008.1.2.4.90` → `JPEG 2000 Image Compression (Lossless Only)`；不認識回 UID 本身。"""
    if not uid:
        return ""
    name = UID(uid).name
    return name if name and name != uid else uid


@lru_cache(maxsize=64)
def can_decode(uid: str) -> bool:
    """未壓縮（或沒記錄）一律可以；壓縮的看有沒有可用的解碼 plugin。"""
    if not uid:
        return True
    u = UID(uid)
    if not u.is_transfer_syntax:
        return True
    if not u.is_compressed:
        return True
    try:
        from pydicom.pixels import get_decoder

        return bool(get_decoder(u).is_available)
    except (NotImplementedError, ValueError):
        return False


def undecodable_reason(*uids: str) -> str:
    """解不了時給使用者看的一句話（索引、開病例、載入、匯入四個地方同一句；英文由 API 邊界翻）。"""
    name = "、".join(transfer_syntax_name(u) for u in uids)
    return f"壓縮格式 {name} 沒有可用的解碼器，這個序列無法載入"


def decode_status(transfer_syntax_uids: set[str] | list[str]) -> dict[str, Any]:
    """一個序列的解碼狀態：`transfer_syntax`（名稱，多種以「、」連接）、`decodable`、`decode_error`（解不了時的原因）。"""
    uids = sorted({u for u in transfer_syntax_uids if u})
    bad = [u for u in uids if not can_decode(u)]
    names = [transfer_syntax_name(u) for u in uids]
    return {
        "transfer_syntax": "、".join(names),
        "decodable": not bad,
        "decode_error": None if not bad else undecodable_reason(*bad),
    }
