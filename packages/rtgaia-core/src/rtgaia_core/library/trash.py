"""資料庫刪除。

**不真的刪**：檔案搬到 `<library_root>/.rtgaia/trash/<時間>_<層級>_<鍵>/`（保留相對路徑）並寫 `manifest.json`
（誰、何時、哪一層、哪些序列、每個檔從哪搬到哪）。目錄重掃後那些序列就不在樹上；要救回把目錄搬回去再重掃。
永久清除留給之後的儲存分層／保留政策。
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

TRASH_DIR = Path(".rtgaia") / "trash"


def _safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)[:80] or "x"


def move_to_trash(
    root: str | Path,
    files: list[Path],
    *,
    level: str,
    key: str,
    series_uids: list[str],
    who: str,
) -> dict[str, Any]:
    """把 `files` 搬進垃圾桶目錄；回 `{trash_dir, moved, manifest}`。同一個檔重複出現只搬一次。"""
    root = Path(root)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    trash = root / TRASH_DIR / f"{stamp}_{level}_{_safe(key)}"
    trash.mkdir(parents=True, exist_ok=True)
    moved: list[dict[str, str]] = []
    seen: set[Path] = set()
    for src in files:
        src = Path(src)
        if src in seen or not src.exists():
            continue
        seen.add(src)
        try:
            rel = src.resolve().relative_to(root.resolve())
        except ValueError:
            rel = Path(src.name)
        dst = trash / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        moved.append({"from": str(src), "to": str(dst)})
        # 搬空的目錄順手清掉（不動 root 本身）
        parent = src.parent
        while parent != root and parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    manifest = {
        "level": level,
        "key": key,
        "series_uids": series_uids,
        "who": who,
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "files": moved,
    }
    (trash / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"trash_dir": str(trash), "moved": len(moved), "manifest": manifest}
