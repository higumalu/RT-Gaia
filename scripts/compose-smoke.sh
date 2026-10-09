#!/usr/bin/env bash
# 全新 Compose 部署的 smoke：
#   index 有 root、主 JS 與 .wasm 可取且 MIME 正確、/healthz、建立管理者＋登入、GET /plugins、WS 升級、COOP／COEP、
#   偽造 Host 被拒。**只有 vite build 通過不算部署可用** —— 這支腳本才是。
#
#   RTGAIA_PUBLIC_URL=http://localhost:8088 RTGAIA_HTTP_PORT=8088 RTGAIA_SECRET=... \
#     docker compose -f deploy/docker-compose.yml up -d --build && scripts/compose-smoke.sh http://localhost:8088
set -euo pipefail
BASE="${1:-${RTGAIA_PUBLIC_URL:-http://localhost}}"
HOST_HDR="$(echo "$BASE" | sed -E 's#^https?://##; s#/.*$##')"
fail() { echo "❌ $*" >&2; exit 1; }
ok() { echo "✅ $*"; }
curl_() { curl -sS --max-time 30 "$@"; }

for _ in $(seq 1 60); do
  if curl_ -o /dev/null -w '%{http_code}' "$BASE/healthz" 2>/dev/null | grep -q '^200$'; then break; fi
  sleep 2
done
curl_ -o /dev/null -w '%{http_code}' "$BASE/healthz" | grep -q '^200$' || fail "/healthz 不是 200"
ok "healthz"
# 就緒（DB 連得上）；compose 的 worker 是獨立行程，API 的 /readyz 不看它
curl_ -o /dev/null -w '%{http_code}' "$BASE/readyz" | grep -q '^200$' || fail "/readyz 不是 200"
ok "readyz"

INDEX="$(curl_ "$BASE/")"
echo "$INDEX" | grep -q 'id="root"' || fail "index.html 沒有 #root"
ok "index.html"
JS="$(echo "$INDEX" | grep -oE 'src="[^"]+\.js"' | head -1 | sed -E 's/src="([^"]+)"/\1/')"
[ -n "$JS" ] || fail "index.html 找不到主 JS"
curl_ -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE$JS" | grep -Eq '^200 (application|text)/javascript' || fail "主 JS $JS 取不到或 MIME 錯"
ok "主 JS $JS"
curl_ -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/rtgaia_reslice.wasm" | grep -q '^200 application/wasm' || fail ".wasm 取不到或 MIME 不是 application/wasm"
ok "rtgaia_reslice.wasm"
# 手機「加到主畫面」的 manifest（nginx 要給對 MIME，Chrome 才讀它的名稱與圖示）
curl_ -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/manifest.webmanifest" | grep -q '^200 application/manifest+json' || fail "manifest.webmanifest 取不到或 MIME 錯"
curl_ -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/branding/rt-gaia-icon-192.png" | grep -q '^200 image/png' || fail "主畫面圖示 192 取不到"
ok "manifest.webmanifest"

HDRS="$(curl_ -I "$BASE/")"
echo "$HDRS" | grep -qi 'cross-origin-opener-policy: same-origin' || fail "缺 COOP"
echo "$HDRS" | grep -qi 'cross-origin-embedder-policy: require-corp' || fail "缺 COEP"
ok "COOP／COEP"

# hash 檔名的 asset 長效 immutable、而且 COOP／COEP 還在（location 有 add_header 時不繼承 server 層）；
# index.html 與 .wasm 每次確認；缺的 asset 回 404（不是 index.html 冒充 200）；gzip
JSH="$(curl_ -I -H 'Accept-Encoding: gzip' "$BASE$JS")"
echo "$JSH" | grep -qi 'cache-control: public, max-age=31536000, immutable' || fail "主 JS 沒有長效快取：$JSH"
echo "$JSH" | grep -qi 'cross-origin-embedder-policy: require-corp' || fail "主 JS 缺 COEP（/assets/ 的 add_header 沒有補）"
echo "$JSH" | grep -qi 'content-encoding: gzip' || fail "主 JS 沒有 gzip"
echo "$HDRS" | grep -qi 'cache-control: no-cache' || fail "index.html 應該 no-cache"
curl_ -I "$BASE/rtgaia_reslice.wasm" | grep -qi 'cache-control: no-cache' || fail ".wasm 沒有 hash 檔名，應該 no-cache"
curl_ -o /dev/null -w '%{http_code}' "$BASE/assets/does-not-exist-0000.js" | grep -q '^404$' || fail "缺的 asset 應該 404"
ok "快取標頭（assets immutable、index／wasm no-cache）、缺的 asset 404、gzip"

STATUS="$(curl_ "$BASE/api/v1/auth/status")"
echo "$STATUS" | grep -q '"mode"' || fail "/auth/status 回應異常：$STATUS"
if echo "$STATUS" | grep -Eq '"bootstrap_needed": *true'; then
  curl_ -f -c /tmp/rtgaia-smoke.cookies -H 'content-type: application/json' \
    -d '{"username":"smoke-admin","password":"Correct-Horse-Battery-Staple-42","display_name":"smoke"}' \
    "$BASE/api/v1/auth/bootstrap" >/dev/null || fail "bootstrap 失敗"
  ok "bootstrap 管理者"
fi
TOKEN="$(curl_ -f -H 'content-type: application/json' -d '{"username":"smoke-admin","password":"Correct-Horse-Battery-Staple-42"}' "$BASE/api/v1/auth/login" | sed -E 's/.*"token": *"([^"]+)".*/\1/')"
[ -n "$TOKEN" ] && [ "$TOKEN" != "$(curl_ "$BASE/api/v1/auth/login")" ] || fail "登入拿不到 token（帳號可能不是 smoke-admin）"
ok "登入"
curl_ -f -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/plugins" >/dev/null || fail "GET /plugins 失敗"
ok "GET /plugins"
curl_ -f -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/cases" >/dev/null || fail "GET /cases 失敗"
ok "GET /cases"

# WS 升級：只驗 101（不需要 websocket client）。用一個**明確的** session id：空資料庫沒有病例，
# `session/current` 會在握手前以 4404 關閉（HTTP 層看到 400）；明確 id 不存在時 API 仍接受連線（前端重連靠這個），
# 所以 101 才能證明 nginx 有把 Upgrade 轉到後端。curl 會一直讀 WS 串流直到 max-time；標頭回 101 就算成功。
WS_CODE="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE/api/v1/session/smoke-nonexistent/events?token=$TOKEN" 2>/dev/null || true)"
[ "$WS_CODE" = "101" ] || fail "WS 升級回 $WS_CODE（期望 101）"
ok "WS 升級"

# 偽造 Host → 400
BAD="$(curl_ -o /dev/null -w '%{http_code}' -H 'Host: untrusted.invalid' "$BASE/api/v1/auth/status")"
[ "$BAD" = "400" ] || fail "偽造 Host 應被拒（400），實際 $BAD"
ok "偽造 Host 被拒"
echo "🎉 compose smoke 全部通過（$BASE，Host $HOST_HDR）"
