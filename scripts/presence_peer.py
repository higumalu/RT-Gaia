#!/usr/bin/env python3
"""presence 驗證用的「另一個人」—— `verify-presence.mjs` 叫它（`RTGAIA_AUTH=off` 的量測堆疊）。

用瀏覽器開病例時送的同一個 `POST /sessions` body 開同一個病例（`X-RTGaia-User: <user>`）、
連上自己的 WS（presence 只算有連線的）、回報正在編輯第一個結構，
印一行 JSON（`{session_id, structure_id, name}`）後保持連線，直到 stdin 關掉或逾時。

  uv run python scripts/presence_peer.py --api http://127.0.0.1:8091 --user lin --body body.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

import httpx
import websockets


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8091")
    ap.add_argument("--user", default="lin")
    ap.add_argument("--body", required=True, help="POST /sessions 的 body（JSON 檔）")
    ap.add_argument("--timeout", type=float, default=180.0)
    args = ap.parse_args()
    headers = {"X-RTGaia-User": args.user}
    body = json.loads(open(args.body, encoding="utf-8").read())
    async with httpx.AsyncClient(base_url=args.api, headers=headers, timeout=120) as c:
        r = await c.post("/api/v1/sessions", json=body)
        r.raise_for_status()
        opened = r.json()
        sid = opened["session_id"]
        ws_url = args.api.replace("http", "ws", 1) + f"/api/v1/session/{sid}/events"
        async with websockets.connect(ws_url, additional_headers=headers) as ws:
            structures = (await c.get(f"/api/v1/studies/{opened['study_id']}/structures")).json()
            rows = structures if isinstance(structures, list) else structures.get("structures", [])
            target = rows[0]
            sid_target = target["structure_id"]
            (await c.put(f"/api/v1/sessions/{sid}/editing", json={"structure_id": sid_target})).raise_for_status()
            print(json.dumps({"session_id": sid, "structure_id": sid_target, "name": target["name"]}), flush=True)

            async def drain() -> None:
                async for _ in ws:
                    pass

            async def stdin_closed() -> None:
                await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)

            done, pending = await asyncio.wait(
                [asyncio.create_task(drain()), asyncio.create_task(stdin_closed())],
                timeout=args.timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
        await c.post(f"/api/v1/sessions/{sid}/release")


if __name__ == "__main__":
    asyncio.run(main())
