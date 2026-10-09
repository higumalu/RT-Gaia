"""🔴 故障注入 —— 讓不變式真的被測到。

> 不變式 I1–I4 要求前端**拒絕**不合法的資料。**若測試後端永遠守規矩，
> 那些拒絕邏輯就是死碼**——會在正式環境第一次遇到問題時才發現寫錯。

| 模式 | 注入什麼 | 應驗證的前端行為 |
|---|---|---|
| `grid_mismatch` | mask 的網格 id 與會話不符 | 拒絕合成並明確報錯，不得自動對齊（I3） |
| `fractional_offset` | 非整數 `offset_ijk` | 拒絕載入（I1） |
| `missing_direction` | header 省略 `direction` | 拒絕載入，不得預設為單位矩陣 |
| `stale_hash` | `POST /edit` 一律回 409 | 重取 mask ＋ 提示使用者 |
| `latency` | 所有回應延遲 N ms | 載入指示、漸進式 lod、不得空白畫面 |
| `truncate` | payload 少於 header 宣告的長度 | 偵測並報錯，不得渲染半張影像 |
| `disconnect` | 隨機斷開 WS | 重連並重新同步 |
| `wrong_size` | `size_ijk` 與實際資料量不符 | 拒絕載入 |
| `push_limit` | WS 推送上限調成 N bytes | `scene.replace` 超過 → 收到「重抓」小訊息 → 走 HTTP 拿場景，畫面照常更新 |

**每一種模式都要有一個對應的前端測試**。

## 為什麼注入點在這裡，而不是在 `rtgaia-geom` 裡加旗標

幾何核心是正式後端**共用**的那一份。一旦它認識「可以違反
契約」這個概念，那個開關就會跟著進正式後端。因此注入一律在**序列化之後**動手
腳：`rtgaia-geom` 產生合法的 payload，chaos 再把它弄壞。
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from typing import Any

from rtgaia_geom.codec import _PREAMBLE, MAGIC, VERSION

MODES = (
    "grid_mismatch",
    "fractional_offset",
    "missing_direction",
    "stale_hash",
    "latency",
    "truncate",
    "disconnect",
    "wrong_size",
    "push_limit",
)


@dataclass
class ChaosConfig:
    grid_mismatch: bool = False
    fractional_offset: bool = False
    missing_direction: bool = False
    stale_hash: bool = False
    truncate: bool = False
    wrong_size: bool = False
    disconnect: bool = False
    latency_ms: int = 0
    push_limit_bytes: int = 0
    """> 0 → WS 推送上限改成這個數（`PushHub.limit`）；0 ＝ `MAX_MESSAGE_BYTES`。"""
    disconnect_probability: float = 0.25
    seed: int | None = None
    _rng: random.Random = field(default_factory=random.Random, repr=False)

    def __post_init__(self) -> None:
        if self.seed is not None:
            self._rng = random.Random(self.seed)

    @property
    def active(self) -> list[str]:
        out = [m for m in MODES if m not in ("latency", "push_limit") and getattr(self, m, False)]
        if self.latency_ms:
            out.append(f"latency:{self.latency_ms}")
        if self.push_limit_bytes:
            out.append(f"push_limit:{self.push_limit_bytes}")
        return out

    def to_wire(self) -> dict[str, Any]:
        return {
            **{m: bool(getattr(self, m, False)) for m in MODES if m not in ("latency", "push_limit")},
            "latency_ms": self.latency_ms,
            "push_limit_bytes": self.push_limit_bytes,
            "disconnect_probability": self.disconnect_probability,
            "active": self.active,
        }

    def update(self, patch: dict[str, Any]) -> ChaosConfig:
        for key, value in patch.items():
            if key == "latency":
                self.latency_ms = int(value)
            elif key in ("push_limit", "push_limit_bytes"):
                self.push_limit_bytes = int(value or 0)
            elif key in ("latency_ms", "disconnect_probability", "seed"):
                setattr(self, key, type(getattr(self, key) or 0)(value) if value is not None else value)
            elif key in MODES:
                setattr(self, key, bool(value))
            else:
                raise KeyError(f"未知的 chaos 模式 {key!r}。可用：{', '.join(MODES)}")
        return self

    def reset(self) -> ChaosConfig:
        for m in MODES:
            if m not in ("latency", "push_limit"):
                setattr(self, m, False)
        self.latency_ms = 0
        self.push_limit_bytes = 0
        return self

    def should_disconnect(self) -> bool:
        return self.disconnect and self._rng.random() < self.disconnect_probability


def corrupt_frame(frame: bytes, cfg: ChaosConfig) -> bytes:
    """對已編好的 payload 訊框動手腳。回傳新的訊框。"""
    if not any((cfg.grid_mismatch, cfg.fractional_offset, cfg.missing_direction, cfg.wrong_size, cfg.truncate)):
        return frame
    magic, version, _res, header_len = _PREAMBLE.unpack_from(frame, 0)
    if magic != MAGIC or version != VERSION:
        return frame
    start = _PREAMBLE.size
    header = json.loads(frame[start : start + header_len].decode("utf-8"))
    body = frame[start + header_len :]

    if cfg.grid_mismatch:
        # I3：把網格 id 換成一個同族但不同的值
        for key in ("grid_ref", "display_grid_id", "mask_grid_id"):
            if key in header and isinstance(header[key], str):
                header[key] = header[key][:3] + "chaos_mismatch"
    if cfg.fractional_offset:
        # I1：整數 offset 變成非整數
        if isinstance(header.get("offset_ijk"), list) and header["offset_ijk"]:
            header["offset_ijk"] = [header["offset_ijk"][0] + 0.5, *header["offset_ijk"][1:]]
    if cfg.missing_direction:
        for grid_key in ("grid", "source_grid"):
            g = header.get(grid_key)
            if isinstance(g, dict):
                g.pop("direction", None)
        if isinstance(header.get("direction"), list):
            header.pop("direction")
    if cfg.wrong_size:
        # size_ijk 與實際資料量不符（比實際大一格）
        if isinstance(header.get("size_ijk"), list) and header["size_ijk"]:
            header["size_ijk"] = [header["size_ijk"][0] + 1, *header["size_ijk"][1:]]
    if cfg.truncate:
        # body 少於 header 宣告的長度。**header 的 body_bytes 保持原值**，
        # 否則前端只會看到一個「比較短但自洽」的 payload，什麼都測不到。
        body = body[: max(1, len(body) // 2)]

    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _PREAMBLE.pack(MAGIC, VERSION, 0, len(header_bytes)) + header_bytes + body


def corrupt_json(payload: dict[str, Any], cfg: ChaosConfig) -> dict[str, Any]:
    """對純 JSON 回應（`GridSet`、結構清單、mesh header）動手腳。"""
    if not (cfg.grid_mismatch or cfg.missing_direction or cfg.fractional_offset):
        return payload
    out = json.loads(json.dumps(payload))

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if cfg.missing_direction and "direction" in node and "spacing" in node:
                node.pop("direction")
            if cfg.grid_mismatch:
                for key in ("mask_grid_id", "display_grid_id", "grid_ref"):
                    if isinstance(node.get(key), str):
                        node[key] = node[key][:3] + "chaos_mismatch"
            if cfg.fractional_offset:
                for key in ("crop_offset_ijk", "offset_ijk"):
                    v = node.get(key)
                    if isinstance(v, list) and v:
                        node[key] = [v[0] + 0.5, *v[1:]]
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(out)
    return out
