#!/usr/bin/env bash
# Demo 堆疊：錄 demo 影片與文件截圖用。只索引 data/demo（CC BY 公開資料），
# 用獨立的 Postgres 容器、資料目錄與 port —— 不碰開發庫、不碰開發環境的 8081／5173。
#
#   scripts/demo/stack.sh start    # Postgres 容器 → 後端 rtgaia-server（auth required）→ 前端打包版（vite preview）
#                                  # 第一次起會建 demo 帳號、重掃 data/demo
#   scripts/demo/stack.sh plugin   # nnU-Net plugin（TotalSegmentator、GPU）起在 :8722 並登錄到 demo 後端（plugin 那一幕用）
#   scripts/demo/stack.sh status
#   scripts/demo/stack.sh stop     # 關後端、前端；容器與資料留著
#   scripts/demo/stack.sh reset    # 連容器、volume、資料目錄一起刪（重錄前用；錄好的 media 保留）
#
# 帳號（密碼都是 $DEMO_PASSWORD）：admin（管理者）、physicist（contourer）、oncologist（approver）。
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
DIR=${RTGAIA_DEMO_DIR:-$ROOT/.rtgaia/demo}
LIB=${DEMO_LIBRARY:-$ROOT/data/demo}
PG_NAME=${DEMO_PG_CONTAINER:-rtgaia-demo-pg}
PG_PORT=${DEMO_PG_PORT:-5436}
BE_PORT=${DEMO_BE_PORT:-8096}
FE_PORT=${DEMO_FE_PORT:-5186}
PLUGIN_PORT=${DEMO_PLUGIN_PORT:-8722}
DEMO_PASSWORD=${DEMO_PASSWORD:-demo-password-2026}
DB_URL="postgresql+asyncpg://rtgaia:rtgaia@127.0.0.1:${PG_PORT}/rtgaia"
API="http://127.0.0.1:${BE_PORT}/api/v1"

pid_on() { ss -ltnp 2>/dev/null | grep ":$1 " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1; }

stop_procs() {
  for p in "$BE_PORT" "$FE_PORT" "$PLUGIN_PORT"; do
    local pid; pid=$(pid_on "$p")
    if [ -n "$pid" ]; then kill "$pid" && echo "stopped :$p (pid $pid)"; fi
  done
}

start_pg() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    docker start "$PG_NAME" >/dev/null
  else
    docker run -d --name "$PG_NAME" -p "127.0.0.1:${PG_PORT}:5432" \
      -e POSTGRES_USER=rtgaia -e POSTGRES_PASSWORD=rtgaia -e POSTGRES_DB=rtgaia \
      -v "${PG_NAME}-data:/var/lib/postgresql/data" postgres:16 >/dev/null
  fi
  local ok=0
  for _ in $(seq 1 120); do
    if docker exec "$PG_NAME" pg_isready -U rtgaia -d rtgaia >/dev/null 2>&1; then
      ok=$((ok + 1)); [ "$ok" -ge 2 ] && return 0
    fi
    sleep 0.5
  done
  echo "Postgres 容器沒起來：$PG_NAME" >&2; exit 1
}

start_backend() {
  [ -n "$(pid_on "$BE_PORT")" ] && { echo "後端已在 :$BE_PORT"; return; }
  mkdir -p "$DIR/data"
  [ -f "$DIR/secret" ] || head -c 32 /dev/urandom | base64 > "$DIR/secret"
  RTGAIA_AUTH=required RTGAIA_DB_URL="$DB_URL" RTGAIA_SECRET="$(cat "$DIR/secret")" \
  RTGAIA_PUBLIC_URL="http://127.0.0.1:${BE_PORT}" RTGAIA_LIBRARY_ROOT="$LIB" RTGAIA_DATA_DIR="$DIR/data" \
  RTGAIA_SCP=0 RTGAIA_TEST_API= \
    nohup uv run rtgaia-server --host 127.0.0.1 --port "$BE_PORT" --library "$LIB" --data-dir "$DIR/data" \
      > "$DIR/backend.log" 2>&1 < /dev/null &
  for _ in $(seq 1 240); do curl -sf -m 1 "http://127.0.0.1:${BE_PORT}/healthz" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "後端沒起來，見 $DIR/backend.log" >&2; exit 1
}

start_frontend() {
  [ -n "$(pid_on "$FE_PORT")" ] && { echo "前端已在 :$FE_PORT"; return; }
  # 打包到自己的目錄：不蓋掉 apps/viewer/dist（開發環境的 5173 在用）
  (cd apps/viewer && npx vite build --outDir "$DIR/web" --emptyOutDir > "$DIR/build.log" 2>&1)
  # 整組重新導向：`(cd … && cmd > log &)` 的背景子 shell 會一直佔著呼叫端的 stdout（接管線時 start 不會結束）
  (cd apps/viewer && RTGAIA_API="http://127.0.0.1:${BE_PORT}" exec nohup npx vite preview --outDir "$DIR/web" \
      --host 127.0.0.1 --port "$FE_PORT" --strictPort) > "$DIR/frontend.log" 2>&1 < /dev/null &
  for _ in $(seq 1 120); do curl -sf -m 1 "http://127.0.0.1:${FE_PORT}/" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "前端沒起來，見 $DIR/frontend.log" >&2; exit 1
}

start_plugin() {
  # examples/plugin-nnunet 自己的環境（PyTorch、TotalSegmentator；見該目錄 README「Run it locally」）
  [ -d examples/plugin-nnunet/.venv ] || { echo "先在 examples/plugin-nnunet 跑 uv sync -p 3.12 --extra inference" >&2; exit 1; }
  mkdir -p "$DIR/plugin-data" "$DIR/plugin-artifacts"
  [ -f "$DIR/plugin-token" ] || head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$DIR/plugin-token"
  if [ -z "$(pid_on "$PLUGIN_PORT")" ]; then
    (cd examples/plugin-nnunet && RTGAIA_SEG_ENGINE=totalseg RTGAIA_SEG_DEVICE=gpu \
      RTGAIA_PLUGIN_TOKEN="$(cat "$DIR/plugin-token")" RTGAIA_PLUGIN_PUBLIC_URL="http://127.0.0.1:${PLUGIN_PORT}" \
      RTGAIA_PLUGIN_ARTIFACTS="$DIR/plugin-artifacts" RTGAIA_PLUGIN_DATA="$DIR/plugin-data" \
      exec nohup uv run uvicorn plugin:app --host 127.0.0.1 --port "$PLUGIN_PORT") > "$DIR/plugin.log" 2>&1 < /dev/null &
    local up=0
    for _ in $(seq 1 240); do
      curl -sf -m 1 "http://127.0.0.1:${PLUGIN_PORT}/manifest" -H "authorization: Bearer $(cat "$DIR/plugin-token")" >/dev/null 2>&1 && { up=1; break; }
      sleep 0.5
    done
    [ "$up" = 1 ] || { echo "plugin 沒起來，見 $DIR/plugin.log" >&2; exit 1; }
  fi
  # 管理者登錄（已登錄就略過）。授權清單照 plugin manifest 的 soup 收（研究用途；見 examples/plugin-nnunet/README.md）
  local token
  token=$(curl -sf -X POST "$API/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$DEMO_PASSWORD\"}" | uv run python -c 'import json,sys; print(json.load(sys.stdin)["token"])')
  if curl -sf "$API/plugins" -H "authorization: Bearer $token" | grep -q "127.0.0.1:${PLUGIN_PORT}"; then
    # 已登錄：重抓 manifest（plugin 換版時重新釘 UI bundle 的 digest）
    local id
    id=$(curl -sf "$API/plugins" -H "authorization: Bearer $token" | uv run python -c "import json,sys; print(next(p['plugin_id'] for p in json.load(sys.stdin) if '127.0.0.1:${PLUGIN_PORT}' in str(p.get('endpoint',''))))")
    curl -sf -X POST "$API/plugins/$id/refresh" -H "authorization: Bearer $token" > "$DIR/plugin-register.json"
    echo "plugin 已登錄，重新讀取：$(head -c 160 "$DIR/plugin-register.json")"; return
  fi
  local licenses
  licenses=$(curl -sf "http://127.0.0.1:${PLUGIN_PORT}/manifest" -H "authorization: Bearer $(cat "$DIR/plugin-token")" | uv run python -c 'import json,sys; m=json.load(sys.stdin); print(json.dumps(sorted({s.get("license","") for s in m.get("soup",[]) if s.get("license")})))')
  curl -sf -X POST "$API/plugins" -H 'content-type: application/json' -H "authorization: Bearer $token" \
    -d "{\"endpoint\":\"http://127.0.0.1:${PLUGIN_PORT}\",\"token\":\"$(cat "$DIR/plugin-token")\",\"allow_licenses\":$licenses}" > "$DIR/plugin-register.json"
  echo "plugin 已登錄：$(head -c 200 "$DIR/plugin-register.json")"
}

seed() {
  # 第一次：建管理者 → 建兩個 demo 使用者 → 重掃 data/demo。之後再跑會因為已有帳號而略過。
  local status; status=$(curl -sf "$API/auth/status")
  if ! echo "$status" | grep -q '"bootstrap_needed": *true'; then echo "帳號已建立，略過"; return; fi
  local token
  token=$(curl -sf -X POST "$API/auth/bootstrap" -H 'content-type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$DEMO_PASSWORD\",\"display_name\":\"Admin\"}" \
    | uv run python -c 'import json,sys; print(json.load(sys.stdin)["token"])')
  for u in "physicist:contourer:Demo Physicist" "oncologist:approver:Demo Oncologist"; do
    IFS=: read -r name role display <<< "$u"
    curl -sf -X POST "$API/auth/users" -H 'content-type: application/json' -H "authorization: Bearer $token" \
      -d "{\"username\":\"$name\",\"password\":\"$DEMO_PASSWORD\",\"role\":\"$role\",\"display_name\":\"$display\",\"must_change_password\":false}" \
      >/dev/null
  done
  curl -sf -X POST "$API/library/rescan" -H "authorization: Bearer $token" > "$DIR/rescan.json"
  echo "帳號已建立（admin／physicist／oncologist），data/demo 已索引：$(cat "$DIR/rescan.json")"
}

case "${1:-}" in
start)
  [ -d "$LIB" ] || { echo "找不到 demo 資料：$LIB（下載方式見 scripts/demo/README.md）" >&2; exit 1; }
  mkdir -p "$DIR"
  start_pg; start_backend; start_frontend; seed
  echo "demo 前端 http://127.0.0.1:${FE_PORT}（後端 :${BE_PORT}、Postgres :${PG_PORT}）" ;;
plugin)
  start_plugin ;;
status)
  echo "Postgres: $(docker ps --filter "name=^${PG_NAME}$" --format '{{.Status}}')"
  echo "後端 :${BE_PORT} pid=$(pid_on "$BE_PORT")；前端 :${FE_PORT} pid=$(pid_on "$FE_PORT")" ;;
stop)
  stop_procs ;;
reset)
  stop_procs
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "${PG_NAME}-data" >/dev/null 2>&1 || true
  # 錄好的影片（$DIR/media）留著：reset 是為了重錄，不是丟掉上一次的成果
  rm -rf "$DIR/data" "$DIR/web" "$DIR/secret" "$DIR/rescan.json" "$DIR"/*.log "$DIR"/plugin-*
  echo "reset：容器、volume、$DIR 的資料目錄已刪（media 保留）" ;;
*)
  sed -n '2,12p' "$0"; exit 2 ;;
esac
