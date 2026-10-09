#!/usr/bin/env python3
"""容量提醒與完整性巡檢的端到端驗收：起一個暫存堆疊（合成病例的資料庫放在暫存目錄、
`RTGAIA_DISK_WARN_PERCENT=50` 讓提醒一定出現、auth off），再叫 `scripts/verify-storage.mjs` 用 headless Chrome 走一遍。
**不碰使用者的資料**：被改掉的是暫存資料庫裡的檔。

用法：uv run --no-sync python scripts/verify-storage.py [--out-dir DIR]
前提：暫存目錄所在的磁碟使用率 ≥ 50%（不然提醒做不出來；會直接說）。退出碼：失敗 → 1。
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/rtgaia-testbe/tests"))
from synth_dicom import write_synth_case  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait(url: str, tries: int = 240) -> None:
    for _ in range(tries):
        try:
            if httpx.get(url, timeout=1).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"等不到 {url}")


def main() -> int:
    extra = sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="rtgaia-storage-") as tmp:
        usage = shutil.disk_usage(tmp)
        percent = 100 * (usage.total - usage.free) / max(1, usage.total)
        if percent < 50:
            print(f"暫存目錄的磁碟只用了 {percent:.0f}%，做不出超過門檻的提醒")
            return 1
        lib = Path(tmp) / "library"
        write_synth_case(lib)
        tamper = sorted(lib.rglob("CT.*.dcm"))[0]
        be, fe = free_port(), free_port()
        env = {
            **os.environ,
            "RTGAIA_AUTH": "off",
            "RTGAIA_DB_URL": "",
            "RTGAIA_DATA_DIR": str(Path(tmp) / "data"),
            "RTGAIA_SCP": "0",
            "RTGAIA_PLUGIN_TICK_SECONDS": "0",
            "RTGAIA_DISK_WARN_PERCENT": "50",
            "RTGAIA_STORAGE_TICK_SECONDS": "2",
            "RTGAIA_INTEGRITY_TICK_SECONDS": "0",
        }
        procs = [
            subprocess.Popen(
                [
                    str(ROOT / ".venv/bin/rtgaia-testbe"),
                    "--port",
                    str(be),
                    "--host",
                    "127.0.0.1",
                    "--library",
                    str(lib),
                ],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
            ),
            subprocess.Popen(
                ["npx", "vite", "--port", str(fe), "--strictPort"],
                cwd=ROOT / "apps/viewer",
                env={**env, "RTGAIA_API": f"http://127.0.0.1:{be}", "RTGAIA_NO_WATCH": "1"},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
            ),
        ]
        try:
            wait(f"http://127.0.0.1:{be}/healthz")
            wait(f"http://127.0.0.1:{fe}/")
            print(f"✓ 暫存堆疊：後端 {be}、前端 {fe}，資料庫 {lib}（磁碟 {percent:.0f}%）")
            r = subprocess.run(
                [
                    "node",
                    str(ROOT / "scripts/verify-storage.mjs"),
                    "--url",
                    f"http://127.0.0.1:{fe}/",
                    "--tamper",
                    str(tamper),
                    *extra,
                ],
                cwd=ROOT,
            )
            return r.returncode
        finally:
            for p in procs:
                p.terminate()
            for p in procs:
                try:
                    p.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    p.kill()


if __name__ == "__main__":
    sys.exit(main())
