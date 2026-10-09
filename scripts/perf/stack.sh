#!/usr/bin/env bash
# 量測用堆疊：auth off、port 8091/5183。用法：stack.sh start|stop|load；PERF_TEST_API=1 才掛 /_test（預設**不掛**，跟正式配置一樣）
# PERF_ALL_DOSES=1 stack.sh load：連 case.json 的 extra_dose_uids 一起載（劑量運算的驗證要兩個分次劑量）
set -u
cd "$(dirname "$0")/../.."
SCR=${RTGAIA_PERF_DIR:-$PWD/.rtgaia/perf}; mkdir -p "$SCR"
case "${1:-}" in
start)
  # RTGAIA_PUBLIC_URL：plugin 回呼與抓輸入用的對外位址（沒設就是預設 8080 —— 2026-09-30 驗 nnU-Net 時 plugin 去 8080 抓影像拿到 404）
  RTGAIA_AUTH=off RTGAIA_DB_URL= RTGAIA_PUBLIC_URL=http://127.0.0.1:8091 RTGAIA_LIBRARY_ROOT=$PWD/data RTGAIA_DATA_DIR=$SCR/perf-data RTGAIA_PLUGIN_TICK_SECONDS=0 RTGAIA_SCP=0 \
    nohup uv run rtgaia-testbe --port 8091 --host 127.0.0.1 --library $PWD/data ${PERF_TEST_API:+--test-api} > $SCR/perf-backend.log 2>&1 < /dev/null &
  # 整組重新導向：`(cd … && cmd > log &)` 的背景子 shell 會一直佔著呼叫端的 stdout（`stack.sh start | tail` 永遠不結束）
  (cd apps/viewer && RTGAIA_API=http://127.0.0.1:8091 RTGAIA_NO_WATCH=1 exec nohup npx vite --port 5183 --strictPort) > $SCR/perf-vite.log 2>&1 < /dev/null &
  for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:8091/healthz >/dev/null 2>&1 && curl -s -m 1 http://127.0.0.1:5183/ >/dev/null 2>&1 && break; sleep 0.5; done
  echo started ;;
load)
  # 病例寫在本機設定檔（不進版控）：$RTGAIA_PERF_DIR/case.json，或 PERF_CASE 指的檔；格式見 scripts/perf/case.example.json（公開 demo 病例）
  CASE=${PERF_CASE:-$SCR/case.json}
  [ -f "$CASE" ] || { echo "沒有 $CASE：複製 scripts/perf/case.example.json 改成你要開的病例"; exit 1; }
  PERF_CASE_FILE=$CASE uv run python - <<'PY'
import json, os
from rtgaia_testbe import Session
case = json.load(open(os.environ["PERF_CASE_FILE"], encoding="utf-8"))
doses = case.get("dose_uids", []) + (case.get("extra_dose_uids", []) if os.environ.get("PERF_ALL_DOSES") else [])
s = Session(base_url="http://127.0.0.1:8091", user="anonymous")
out = s.load_case({
    "primary_series_uid": case["primary_series_uid"],
    "image_series_uids": case.get("image_series_uids") or [case["primary_series_uid"]],
    "structure_set_uids": case.get("structure_set_uids", []),
    "dose_uids": doses,
    "registration_uids": case.get("registration_uids", []),
})
print("loaded", out["case_id"], "structures", len(s.structures()))
PY
  ;;
stop)
  for p in 8091 5183; do PID=$(ss -ltnp 2>/dev/null | grep ":$p " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1); [ -n "$PID" ] && kill $PID; done; echo stopped ;;
esac
