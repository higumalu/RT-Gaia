#!/usr/bin/env python3
"""影像傳輸有沒有卡住 event loop —— 量 `/healthz` 在大 CT 並發載入時的延遲。

背景：影像讀取與降採樣在執行緒，但 transform 重採樣、`tobytes`、content hash、zstd 壓縮還在 async route 的執行緒上；
大 volume 或多人同時載入時，同一個 event loop 上的其他 HTTP／WS 工作會被延後。這支腳本量化它：

  1. 從資料庫挑最大的 CT（或 `--series`），`POST /sessions` 開一個病例
  2. 暖身：抓一次 lod 0（第一次讀 DICOM 在執行緒裡、而且會進快取 —— 量的是「暖」的情況）
  3. 同時抓 `--concurrency` 個 lod 0；期間每 20 ms 打一次 `/healthz`，記錄延遲
  4. 印出 healthz 的 p50／p95／最大、影像請求的時間

  scripts/perf/stack.sh start
  uv run python scripts/perf/loop_latency.py [--api http://127.0.0.1:8091] [--series UID] [--concurrency 4]
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from pathlib import Path

import httpx


def largest_ct(root: Path) -> tuple[str, int]:
    from rtgaia_core.library.index import LibraryIndex

    index = LibraryIndex.scan(root)
    best = max(
        (
            e
            for e in index.image_series()
            if e.modality == "CT" and e.instances and e.instances[0].number_of_frames in (None, 1)
        ),
        key=lambda e: e.instance_count * int(e.instances[0].rows or 0) * int(e.instances[0].columns or 0),
    )
    return best.series_instance_uid, best.instance_count


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8091")
    ap.add_argument("--library", default=str(Path(__file__).resolve().parents[2] / "data"))
    ap.add_argument("--series", default=None)
    ap.add_argument("--concurrency", type=int, default=4)
    args = ap.parse_args()
    uid = args.series
    if uid is None:
        uid, n = largest_ct(Path(args.library))
        print(f"最大的 CT：{uid}（{n} 片）")
    async with httpx.AsyncClient(base_url=args.api, timeout=300) as c:
        r = await c.post("/api/v1/sessions", json={"image_series_uids": [uid], "manual_tier": "A"})
        r.raise_for_status()
        cur = (await c.get("/api/v1/sessions/current")).json()
        dg = cur["gridSet"]["display_grid"]["display_grid_id"]
        url = f"/api/v1/series/{uid}/image?display_grid={dg}&lod=0"
        t = time.perf_counter()
        warm = await c.get(url)
        warm.raise_for_status()
        print(f"暖身 lod 0：{(time.perf_counter() - t) * 1000:.0f} ms、{len(warm.content) / 1e6:.1f} MB（壓縮後）")

        stop = asyncio.Event()
        lat: list[float] = []

        async def probe() -> None:
            while not stop.is_set():
                t0 = time.perf_counter()
                await c.get("/healthz")
                lat.append((time.perf_counter() - t0) * 1000)
                await asyncio.sleep(0.02)

        async def load() -> float:
            t0 = time.perf_counter()
            (await c.get(url)).raise_for_status()
            return (time.perf_counter() - t0) * 1000

        p = asyncio.create_task(probe())
        await asyncio.sleep(0.2)
        base = list(lat)
        times = await asyncio.gather(*(load() for _ in range(args.concurrency)))
        stop.set()
        await p
        during = lat[len(base) :]
        ordered = sorted(during)
        p95 = ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]
        print(f"閒置 healthz：中位 {statistics.median(base):.1f} ms（{len(base)} 次）")
        print(
            f"{args.concurrency} 個 lod 0 並發期間 healthz：中位 {statistics.median(during):.1f} ms、"
            f"p95 {p95:.1f} ms、最大 {max(during):.1f} ms（{len(during)} 次）"
        )
        print(f"影像請求：{', '.join(f'{x:.0f}' for x in sorted(times))} ms")


if __name__ == "__main__":
    asyncio.run(main())
