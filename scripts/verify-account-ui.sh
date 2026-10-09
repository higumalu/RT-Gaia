#!/usr/bin/env bash
# 帳號管理的前端流程驗證：建一個臨時資料庫（dev-db 那台 Postgres）、起認證開啟的堆疊（8093／5185）、
# 跑 scripts/verify-account-ui.mjs，結束後收掉堆疊並刪掉臨時資料庫。
#   ./scripts/verify-account-ui.sh [截圖目錄]
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${RTGAIA_PG_PORT:-5433}"
DB="rtgaia_v16_$$"
ADMIN_URL="postgresql://rtgaia:rtgaia@127.0.0.1:${PORT}/rtgaia"
WORK="$(mktemp -d)"
OUT="${1:-}"

uv run python -c "import asyncio, asyncpg
async def m():
    c = await asyncpg.connect('$ADMIN_URL'); await c.execute('CREATE DATABASE $DB'); await c.close()
asyncio.run(m())"

cleanup() {
  for p in 8093 5185; do
    PID=$(ss -ltnp 2>/dev/null | grep ":$p " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
    [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  done
  sleep 1
  uv run python -c "import asyncio, asyncpg
async def m():
    c = await asyncpg.connect('$ADMIN_URL'); await c.execute('DROP DATABASE IF EXISTS $DB WITH (FORCE)'); await c.close()
asyncio.run(m())" || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/library"
RTGAIA_DB_URL="postgresql+asyncpg://rtgaia:rtgaia@127.0.0.1:${PORT}/${DB}" RTGAIA_SECRET=verify-only-secret \
  RTGAIA_PUBLIC_URL=http://127.0.0.1:8093 RTGAIA_DATA_DIR="$WORK/data" RTGAIA_SCP=0 RTGAIA_PLUGIN_TICK_SECONDS=0 \
  nohup uv run rtgaia-testbe --port 8093 --host 127.0.0.1 --library "$WORK/library" > "$WORK/backend.log" 2>&1 &
(cd apps/viewer && RTGAIA_API=http://127.0.0.1:8093 RTGAIA_NO_WATCH=1 nohup npx vite --port 5185 --strictPort > "$WORK/vite.log" 2>&1 &)
for i in $(seq 1 120); do
  curl -s -m 1 http://127.0.0.1:8093/healthz >/dev/null 2>&1 && curl -s -m 1 http://127.0.0.1:5185/ >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -s -m 1 http://127.0.0.1:8093/healthz >/dev/null 2>&1; then
  tail -20 "$WORK/backend.log" >&2
  exit 1
fi

node scripts/verify-account-ui.mjs --url http://127.0.0.1:5185/ ${OUT:+--out-dir "$OUT"}
