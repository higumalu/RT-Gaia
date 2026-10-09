"""內容定址的 blob store。

* `put(bytes) -> key`、`get(key)`、`exists(key)`、`delete(key)`。key 由呼叫端給（結構版本用 `content_hash`，
  已含位置與體素）或由內容 sha256 算。相同內容自然去重 —— 畫一筆再畫回去，兩個版本共用一個 blob。
* 檔案系統實作：`<root>/<namespace>/<key[:2]>/<key>.zst`，zstd 壓縮、tmp＋rename 原子寫入。S3 之後是第二個實作。
* 這**不是**快取（`cache_root()` 才是）：刪掉就是資料遺失。
  位置：`RTGAIA_DATA_DIR/blobs` → `RTGAIA_LIBRARY_ROOT/.rtgaia/blobs` → `./.rtgaia/blobs`。
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Protocol

import zstandard as zstd


class BlobStore(Protocol):
    def put(self, data: bytes, *, namespace: str = "masks", key: str | None = None) -> str: ...
    def get(self, key: str, *, namespace: str = "masks") -> bytes: ...
    def exists(self, key: str, *, namespace: str = "masks") -> bool: ...
    def delete(self, key: str, *, namespace: str = "masks") -> bool: ...


def blob_root() -> Path:
    data_dir = os.environ.get("RTGAIA_DATA_DIR", "").strip()
    if data_dir:
        return Path(data_dir).expanduser() / "blobs"
    library_root = os.environ.get("RTGAIA_LIBRARY_ROOT", "").strip()
    if library_root:
        return Path(library_root).expanduser() / ".rtgaia" / "blobs"
    return Path.cwd() / ".rtgaia" / "blobs"


_KEY_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")


def _safe_key(key: str) -> str:
    """key 只能是 `[A-Za-z0-9._-]`、不得以 `.` 開頭 —— **拒絕**而不是替換：替換會讓兩個不同的 key 撞成同一個檔。"""
    if not key or key[0] == "." or any(c not in _KEY_CHARS for c in key):
        raise ValueError(f"不合法的 blob key {key!r}")
    return key


class FsBlobStore:
    def __init__(self, root: str | Path | None = None, *, level: int = 3) -> None:
        self.root = Path(root) if root is not None else blob_root()
        self._c = zstd.ZstdCompressor(level=level)
        self._d = zstd.ZstdDecompressor()

    def path(self, key: str, *, namespace: str = "masks") -> Path:
        k = _safe_key(key)
        return self.root / _safe_key(namespace) / k[:2] / f"{k}.zst"

    def put(self, data: bytes, *, namespace: str = "masks", key: str | None = None) -> str:
        key = key or hashlib.sha256(data).hexdigest()
        p = self.path(key, namespace=namespace)
        if p.exists():
            return key
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{p.name}.partial")
        tmp.write_bytes(self._c.compress(data))
        tmp.replace(p)
        return key

    def get(self, key: str, *, namespace: str = "masks") -> bytes:
        p = self.path(key, namespace=namespace)
        if not p.exists():
            raise KeyError(f"blob {namespace}/{key} 不存在")
        return self._d.decompress(p.read_bytes())

    def exists(self, key: str, *, namespace: str = "masks") -> bool:
        return self.path(key, namespace=namespace).exists()

    def delete(self, key: str, *, namespace: str = "masks") -> bool:
        p = self.path(key, namespace=namespace)
        if p.exists():
            p.unlink()
            return True
        return False

    def stats(self) -> dict[str, int]:
        n = 0
        size = 0
        for p in self.root.rglob("*.zst"):
            n += 1
            size += p.stat().st_size
        return {"files": n, "bytes": size}
