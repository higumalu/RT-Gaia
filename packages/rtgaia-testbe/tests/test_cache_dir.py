"""體素快取搬出套件目錄、依大小上限 LRU 淘汰。"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import pytest
from rtgaia_testbe import phantoms
from rtgaia_testbe.phantoms import cache_root, evict_cache


@pytest.fixture
def isolated_env(monkeypatch, tmp_path: Path):  # type: ignore[no-untyped-def]
    for k in ("RTGAIA_DATA_DIR", "RTGAIA_LIBRARY_ROOT", "RTGAIA_CACHE_MAX_GB"):
        monkeypatch.delenv(k, raising=False)
    return tmp_path


def test_cache_root_priority(isolated_env: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    assert cache_root() == phantoms.CACHE_DIR  # 都沒設 → 舊位置
    monkeypatch.setenv("RTGAIA_LIBRARY_ROOT", str(isolated_env / "lib"))
    assert cache_root() == isolated_env / "lib" / ".cache"  # 隱藏目錄，掃描器跳過
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(isolated_env / "data"))
    assert cache_root() == isolated_env / "data" / "cache"  # DATA_DIR 優先


def test_volume_lands_in_data_dir_and_is_mmapped(isolated_env: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(isolated_env / "d"))
    ph = phantoms.build("axial_clean")
    vol = phantoms.volume(ph, ph.primary)
    files = list((isolated_env / "d" / "cache" / "volumes" / ph.dataset_id).glob("*.npy"))
    assert len(files) == 1 and files[0].stat().st_size > 0
    assert isinstance(vol, np.memmap)
    # 第二次直接讀快取（不重新產生）：檔案 mtime 不變
    before = files[0].stat().st_mtime_ns
    phantoms.volume(ph, ph.primary)
    assert files[0].stat().st_mtime_ns == before


def test_evict_lru_keeps_newest_and_the_file_just_written(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    (root / "volumes" / "x").mkdir(parents=True)
    paths = []
    for i in range(4):
        p = root / "volumes" / "x" / f"v{i}.npy"
        np.save(p, np.zeros(1000, dtype=np.uint8))  # 每個約 1128 bytes
        t = time.time() - (100 - i * 10)  # v0 最舊
        os.utime(p, (t, t))
        paths.append(p)
    total = sum(p.stat().st_size for p in paths)
    removed = evict_cache(root, max_bytes=total - 1, keep=paths[0])
    # 超過 1 byte → 刪一個最舊的；但 v0 被 keep 保護 → 刪 v1
    assert removed == [paths[1]]
    assert paths[0].exists() and not paths[1].exists()
    # 上限夠大 → 不刪
    assert evict_cache(root, max_bytes=total * 10) == []
    # 上限極小 → 刪到只剩 keep（其餘全刪）
    removed = evict_cache(root, max_bytes=0, keep=paths[3])
    assert set(removed) == {paths[0], paths[2]} and paths[3].exists()
