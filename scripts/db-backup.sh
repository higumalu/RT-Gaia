#!/usr/bin/env bash
# 開發庫備份（不排程，手動跑）。
#   scripts/db-backup.sh [標籤]          → .rtgaia/db-backups/<庫>-<時間>-<標籤>.dump（pg_dump -Fc，不進版控）
#   scripts/db-backup.sh --list          → 列出現有備份
#   還原（先確認！會覆蓋目前內容）：docker exec -i rt-gaia-pg pg_restore -U rtgaia -d rtgaia --clean --if-exists < 檔案
# 規則：動開發庫之前（migration、清理、復原、任何破壞性操作）先跑一次。
set -euo pipefail
NAME="${RTGAIA_PG_CONTAINER:-rt-gaia-pg}"
DB="${RTGAIA_BACKUP_DB:-rtgaia}"
USER_="rtgaia"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.rtgaia/db-backups"
mkdir -p "$DIR"
if [ "${1:-}" = "--list" ]; then
  ls -lh "$DIR"
  exit 0
fi
LABEL="$(printf '%s' "${1:-manual}" | tr -c 'A-Za-z0-9._-' '_')"
OUT="$DIR/$DB-$(date +%Y%m%d-%H%M%S)-$LABEL.dump"
docker exec "$NAME" pg_dump -U "$USER_" -d "$DB" -Fc > "$OUT.partial"
mv "$OUT.partial" "$OUT"
# 檢查備份讀得回來（列目錄）
docker exec -i "$NAME" pg_restore --list < "$OUT" > /dev/null
echo "備份完成：$OUT（$(du -h "$OUT" | cut -f1)）"
