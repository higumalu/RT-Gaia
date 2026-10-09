#!/usr/bin/env bash
# 一個指令把整套跑起來（後端 ＋ 前端），並自動處理兩件環境瑣事：
#
#   1. 選一個**沒被佔用**的 port 給測試後端（規格的預設 8080 在很多機器上已被用掉）
#   2. `fs.inotify.max_user_instances` 用完時自動關掉 vite 的檔案監看（沒有 HMR，
#      但至少跑得起來）；真正的修法是 `sudo sysctl fs.inotify.max_user_instances=512`
#
# 用法：
#   ./scripts/dev.sh                       # 不預載：開頁面就進資料選取頁（./data 是資料庫）
#   ./scripts/dev.sh phantom:overlap_set   # 指定假體（測試用）
#   ./scripts/dev.sh dicom:/path/to/case   # 真實 DICOM 病例目錄：CT／CBCT／RS／DOSE／REG 全進同一個 session
#                                          # （後端同時把 ./data 當資料庫索引，供資料選取頁搜尋）
#   WEB=build ./scripts/dev.sh             # 前端用打包版（vite build ＋ vite preview）：遠端／手機連線快很多
#                                          # （開發環境用它；改了前端要重新打包、重啟）
#
# 為什麼有 WEB=build：開發伺服器不打包、不壓縮，開頁要抓 ~280 個模組（7.7 MB），模組一層一層引用要一層一層等。
# 遠端連線（來回 ~170 ms、幾 Mbps）實測 20 秒以上還沒出畫面；打包版 13 個請求、0.3 MB、1.7 秒。
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="${1:-}"
FE_PORT="${FE_PORT:-5173}"
# 預設綁 0.0.0.0，方便從別台機器連。要收回只綁本機：HOST=127.0.0.1 ./scripts/dev.sh
HOST="${HOST:-0.0.0.0}"
# dev（預設，有 HMR）｜build（打包版）
WEB="${WEB:-dev}"

pick_port() {
  local start="$1"
  for candidate in $(seq "$start" $((start + 40))); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
      echo "$candidate"
      return
    fi
    exec 3>&- 2>/dev/null || true
  done
  echo "找不到可用的 port（從 $start 起算）" >&2
  exit 1
}

BE_PORT="${BE_PORT:-$(pick_port 8080)}"

# 🔴 前端 port 被佔就直接停，不要讓 vite 的 --strictPort 靜默失敗。
# 實際踩過：前一天的 vite 還在 0.0.0.0:5173 上、proxy 到舊版後端，新起的 vite 起不來
# 但腳本沒停，於是瀏覽器連到的是舊的那組——看起來像「新功能沒有出現」。
if (exec 3<>"/dev/tcp/127.0.0.1/$FE_PORT") 2>/dev/null; then
  exec 3>&- 2>/dev/null || true
  echo "❌ 前端 port $FE_PORT 已被佔用。可能是上一次的 dev.sh 還在跑：" >&2
  ss -ltnp 2>/dev/null | grep ":$FE_PORT " >&2 || true
  echo "   收掉它（kill <pid>）或改用 FE_PORT=5174 ./scripts/dev.sh" >&2
  exit 1
fi

inotify_headroom() {
  local limit used
  limit=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 999999)
  used=$(find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l)
  [ "$((limit - used))" -gt 8 ]
}

if inotify_headroom; then
  export RTGAIA_NO_WATCH=0
else
  echo "⚠️  fs.inotify.max_user_instances 幾乎用完 → vite 改用輪詢監看（每秒一次 stat，無 HMR）"
  echo "   輪詢不佔 inotify instance，因此「改了程式碼卻不生效」不會發生"
  echo "   永久修法：sudo sysctl -w fs.inotify.max_user_instances=512"
  export RTGAIA_NO_WATCH=1
fi

export RTGAIA_API="http://127.0.0.1:${BE_PORT}"

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
LAN_IP="${LAN_IP:-127.0.0.1}"

echo "後端  http://127.0.0.1:${BE_PORT}   （${SOURCE:+載入 ${SOURCE}}${SOURCE:-不預載，資料庫 ./data}）"
uv run rtgaia-testbe --port "$BE_PORT" --host "$HOST" --test-api ${SOURCE:+--load "$SOURCE"} &

for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:${BE_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:${BE_PORT}/healthz" >/dev/null || { echo "後端啟動失敗" >&2; exit 1; }

echo "前端  http://127.0.0.1:${FE_PORT}"
if [ "$HOST" = "0.0.0.0" ]; then
  echo "      http://${LAN_IP}:${FE_PORT}   ← 從別台機器用這個"
  echo
  echo "⚠️  測試後端沒有認證，且 _test/load 接受檔案系統路徑 —— 只放可信任內網。"
  echo "⚠️  非 localhost 的 http:// 不是 secure context → SharedArrayBuffer 不可用"
  echo "    （影響 Tier C 的 Worker 分塊；要完整測 Tier C 請用 localhost 或 HTTPS）。"
fi
echo
if [ "$WEB" = build ]; then
  echo "前端用打包版：vite build → vite preview（改了前端要重新跑這個指令）"
  (cd apps/viewer && npx vite build >/dev/null && RTGAIA_HOST="$HOST" npx vite preview --port "$FE_PORT" --strictPort) &
else
  (cd apps/viewer && RTGAIA_HOST="$HOST" npx vite --port "$FE_PORT" --strictPort) &
fi
wait
