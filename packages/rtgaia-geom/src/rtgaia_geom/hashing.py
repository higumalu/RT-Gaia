"""確定性雜湊。

網格 id 與 content_hash 都必須是「同樣的輸入 → 同樣的字串」，否則
I2–I4 失效偵測會誤判。因此浮點一律以固定格式規範化後才進雜湊。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

FLOAT_FORMAT = ".12g"
"""浮點規範化格式。

12 位有效數字足以區分任何真實的 spacing/origin/direction，又能吃掉
IEEE-754 最後一兩個 bit 的雜訊（例如同一個 direction 經不同運算路徑得出）。
"""


def canonicalize(value: Any) -> Any:
    """把任意巢狀結構轉成可確定性序列化的形式。"""
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"不可雜湊的浮點值: {value}")
        # -0.0 與 0.0 必須產生同一個字串
        normalized = format(value + 0.0, FLOAT_FORMAT)
        return "0" if normalized in ("-0", "0") else normalized
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [canonicalize(v) for v in value]
    if isinstance(value, dict):
        return {str(k): canonicalize(value[k]) for k in sorted(value, key=str)}
    if hasattr(value, "to_wire"):
        return canonicalize(value.to_wire())
    raise TypeError(f"不知道如何規範化 {type(value)!r}")


def stable_json(value: Any) -> str:
    return json.dumps(canonicalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any, *, prefix: str = "", length: int = 32) -> str:
    """結構化值的雜湊。prefix 讓 id 在日誌裡看得出型別。"""
    raw = hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()[:length]
    return f"{prefix}{raw}" if prefix else raw


def digest_bytes(data: bytes, *, prefix: str = "", length: int = 32) -> str:
    """體素資料的內容雜湊（content_hash）。"""
    raw = hashlib.sha256(data).hexdigest()[:length]
    return f"{prefix}{raw}" if prefix else raw


def payload_content_hash(
    *,
    offset_ijk: tuple[int, int, int],
    size_ijk: tuple[int, int, int],
    data: bytes,
    prefix: str = "",
    extra: object = None,
) -> str:
    """裁切後 payload 的內容雜湊 —— **位置必須進 hash**。

    🔴 只雜湊體素位元組是不夠的：mask 一律裁切到自己的 bounding box，
    因此**純平移的兩個 mask 在裁切後位元組完全相同**。4D 假體的相位 0
    與相位 5 就是這個情況（同一顆球差 2 個 voxel）。

    後果不只是「兩個相位長得一樣」：`content_hash` 是

    * 樂觀更新的衝突判準（`base_content_hash`）
    * 前端的快取鍵（「保留在 CPU 端」）

    位置不進 hash 就代表**快取可能回傳位置錯的 mask，而 `base_content_hash`
    比對會放過基於不同位置的編輯**。這個缺陷是前端 e2e 抓到的。
    """
    header = {"offset_ijk": list(offset_ijk), "size_ijk": list(size_ijk)}
    if extra is not None:
        header["extra"] = canonicalize(extra)  # type: ignore[assignment]
    seed = stable_json(header).encode("utf-8") + b"\x00"
    return digest_bytes(seed + data, prefix=prefix)
