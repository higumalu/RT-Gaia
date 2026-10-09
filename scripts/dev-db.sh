#!/usr/bin/env bash
# 本機開發用的 Postgres。一個 docker 容器、兩個資料庫：rtgaia（開發）與 rtgaia_test（pytest）。
#
#   ./scripts/dev-db.sh            # 起（已存在就啟動）並印出要 export 的 URL
#   ./scripts/dev-db.sh stop       # 停（資料保留在容器的 volume）
#   ./scripts/dev-db.sh destroy    # 連資料一起刪
#
# 🔴 預設用 5433 不用 5432：避開機器上可能已在跑、佔著 5432 的其他 Postgres。
set -euo pipefail
NAME="${RTGAIA_PG_CONTAINER:-rt-gaia-pg}"
PORT="${RTGAIA_PG_PORT:-5433}"
IMAGE="${RTGAIA_PG_IMAGE:-postgres:16}"
USER_="rtgaia"; PASS="rtgaia"

case "${1:-up}" in
  stop)    docker stop "$NAME" >/dev/null && echo "stopped $NAME"; exit 0 ;;
  destroy) docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "${NAME}-data" >/dev/null 2>&1 || true; echo "destroyed $NAME"; exit 0 ;;
  up) ;;
  *) echo "用法: $0 [up|stop|destroy]" >&2; exit 2 ;;
esac

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
    -e POSTGRES_USER="$USER_" -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB=rtgaia \
    -v "${NAME}-data:/var/lib/postgresql/data" "$IMAGE" >/dev/null
fi
# 🔴 官方映像第一次啟動會 initdb → 起一個暫時的 server → 關掉 → 再正式起來；
# 只等一次 pg_isready 會剛好撞到暫時那個。要等它連續兩次就緒，且 psql 要能重試。
ready=0
for _ in $(seq 1 120); do
  if docker exec "$NAME" pg_isready -U "$USER_" -d rtgaia >/dev/null 2>&1; then
    ready=$((ready + 1)); [ "$ready" -ge 2 ] && break
  else
    ready=0
  fi
  sleep 0.5
done
for _ in $(seq 1 20); do
  if docker exec "$NAME" psql -U "$USER_" -d rtgaia -tAc "SELECT 1 FROM pg_database WHERE datname='rtgaia_test'" 2>/dev/null | grep -q 1; then
    break
  fi
  if docker exec "$NAME" psql -U "$USER_" -d rtgaia -c "CREATE DATABASE rtgaia_test" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
cat <<MSG
Postgres 就緒（容器 $NAME，port $PORT）
  export RTGAIA_DB_URL=postgresql+asyncpg://${USER_}:${PASS}@127.0.0.1:${PORT}/rtgaia
  export RTGAIA_TEST_DB_URL=postgresql+asyncpg://${USER_}:${PASS}@127.0.0.1:${PORT}/rtgaia_test
MSG
