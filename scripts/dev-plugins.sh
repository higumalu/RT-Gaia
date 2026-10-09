#!/usr/bin/env bash
# 開發用：起／停兩個範例 plugin（hello 8701、nnU-Net 8702）。結果檔與日誌放 .rtgaia/plugins/，不放 /tmp。
#   ./scripts/dev-plugins.sh start|stop|status
# nnU-Net 用 examples/plugin-nnunet 自己的 .venv（uv sync -p 3.12 --extra inference）；hello 用工作區 .venv。
# 🔴 工作區 `uv sync` 之後要 restart —— 舊行程的 venv 檔案會被換掉（2026-09-23：certifi 不見 → 全部 B7）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.rtgaia/plugins"; mkdir -p "$RUN/hello/artifacts" "$RUN/nnunet/artifacts" "$RUN/nnunet/data" "$RUN/logs"
start_one() { # name port workdir cmd...
  local name=$1 port=$2 dir=$3; shift 3
  if ss -ltn 2>/dev/null | grep -q ":$port "; then echo "$name: :$port 已在跑"; return; fi
  # 整組重新導向 ＋ exec：以前 `(cd … && nohup cmd > log &)` 的 `&` 把 `cd && nohup` 整串丟到背景，留下一個 bash 佔著
  # 呼叫端的 stdout（`dev-plugins.sh start | tail` 永遠不結束；同 perf/stack.sh）
  (cd "$dir" && exec nohup "$@") > "$RUN/logs/$name.log" 2>&1 < /dev/null &
  echo $! > "$RUN/$name.pid"
  for _ in $(seq 1 60); do curl -s -m 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -s -m 2 "http://127.0.0.1:$port/health" || echo "$name: 沒起來，見 $RUN/logs/$name.log"; echo
}
case "${1:-status}" in
  start)
    RTGAIA_PLUGIN_ARTIFACTS="$RUN/hello/artifacts" RTGAIA_PLUGIN_PUBLIC_URL=http://127.0.0.1:8701 \
      start_one hello 8701 "$ROOT/examples/plugin-hello-python" "$ROOT/.venv/bin/uvicorn" plugin:app --port 8701 --host 127.0.0.1
    RTGAIA_SEG_ENGINE="${RTGAIA_SEG_ENGINE:-totalseg}" RTGAIA_SEG_DEVICE="${RTGAIA_SEG_DEVICE:-gpu}" \
      RTGAIA_PLUGIN_ARTIFACTS="$RUN/nnunet/artifacts" RTGAIA_PLUGIN_DATA="$RUN/nnunet/data" RTGAIA_PLUGIN_PUBLIC_URL=http://127.0.0.1:8702 \
      start_one nnunet 8702 "$ROOT/examples/plugin-nnunet" uv run uvicorn plugin:app --port 8702 --host 127.0.0.1 ;;
  stop)
    for name in hello nnunet; do
      [ -f "$RUN/$name.pid" ] && kill "$(cat "$RUN/$name.pid")" 2>/dev/null && echo "$name 已停" || true
      rm -f "$RUN/$name.pid"
    done
    # 保險：依 port 收乾淨（不要用 pkill -f，會殺到自己的 shell）
    for port in 8701 8702; do
      pid=$( (ss -ltnp 2>/dev/null | grep ":$port " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1) || true)
      if [ -n "$pid" ]; then kill "$pid" && echo ":$port（pid $pid）已停"; fi
    done
    sleep 1 ;;
  status)
    for port in 8701 8702; do printf ":%s → " "$port"; curl -s -m 2 "http://127.0.0.1:$port/health" || echo "沒在跑"; echo; done ;;
  *) echo "用法：$0 start|stop|status"; exit 2 ;;
esac
