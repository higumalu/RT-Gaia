"""身分。

* **本地帳號**：`app_user` 表（Alembic 0002），密碼 argon2id。OIDC／LDAP 之後接在同一個 `Principal` 後面。
* **登入憑證**：HMAC-SHA256 簽的短效 token，放 HttpOnly cookie `rtgaia_session`（或 `Authorization: Bearer`）。
  簽章金鑰 `RTGAIA_SECRET`；沒設就每次啟動隨機 —— 重啟後大家要重新登入（開發可接受；部署要設）。
* **模式** `RTGAIA_AUTH`：`required`（有 DB 時預設）或 `off`（沒有 DB 時預設）。
  `off` 的身分退回 `X-RTGaia-User` 標頭 stub，角色由 `X-RTGaia-Role` 給、缺省 admin —— 現有測試與純假體開發不必登入。
* **角色** viewer < contourer < approver < admin：GET 都可；開病例／協商網格／重切／3D 出圖（不改臨床資料）也是 viewer；
  其餘非 GET 至少 contourer；`/review` 至少 approver；`/auth/users` admin。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any, Literal

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

Role = Literal["viewer", "contourer", "approver", "admin"]
ROLE_RANK: dict[str, int] = {"viewer": 0, "contourer": 1, "approver": 2, "admin": 3}
ROLES: tuple[str, ...] = tuple(ROLE_RANK)

COOKIE_NAME = "rtgaia_session"
TOKEN_TTL_SECONDS = 12 * 3600
MAX_FAILED_LOGINS = 5
LOCKOUT_SECONDS = 15 * 60
MIN_PASSWORD_LENGTH = 12
"""至少 12 字、連續 5 次失敗鎖 15 分鐘。三個都可用環境變數調（見下面三個函式）；
既有帳號在下一次改密碼時才套用新長度。"""


def _env_int(name: str, default: int, minimum: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return max(minimum, int(raw)) if raw else default
    except ValueError:
        return default


def password_min_length() -> int:
    return _env_int("RTGAIA_PASSWORD_MIN_LENGTH", MIN_PASSWORD_LENGTH, 8)


class PreferencesTooLarge(ValueError):
    """偏好設定合併後超過總量上限（UTF-8 bytes）。在持鎖的交易裡判斷。"""


def max_failed_logins() -> int:
    return _env_int("RTGAIA_LOGIN_MAX_FAILURES", MAX_FAILED_LOGINS, 1)


def lockout_seconds() -> int:
    return _env_int("RTGAIA_LOGIN_LOCKOUT_MINUTES", LOCKOUT_SECONDS // 60, 1) * 60


def password_policy() -> dict[str, int]:
    return {
        "min_length": password_min_length(),
        "max_failures": max_failed_logins(),
        "lockout_minutes": lockout_seconds() // 60,
    }


_TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"


def generate_temp_password(length: int = 16) -> str:
    """一次性臨時密碼（批次匯入沒給密碼時）：去掉易混淆的 0/O、1/l/I；長度至少滿足政策。"""
    n = max(length, password_min_length())
    return "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(n))


_hasher = PasswordHasher()


@dataclass(frozen=True)
class Principal:
    user_id: str
    username: str
    display_name: str
    role: str
    source: Literal["local", "stub"] = "local"
    must_change_password: bool = False
    """管理者建立／重設或批次匯入的臨時密碼 → 登入後必須先改密碼（伺服器端擋其他 API）。"""

    def to_wire(self) -> dict[str, Any]:
        return {
            "user_id": self.user_id,
            "username": self.username,
            "display_name": self.display_name,
            "role": self.role,
            "source": self.source,
            "must_change_password": self.must_change_password,
        }

    def at_least(self, role: str) -> bool:
        return ROLE_RANK.get(self.role, -1) >= ROLE_RANK[role]


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


_COMMON = frozenset({"password", "passw0rd", "1234567890", "123456789012", "qwertyuiop", "rtgaia", "changeme", "admin"})


def password_problems(password: str, username: str = "") -> list[str]:
    """長度（`password_min_length()`）、不可包含帳號、不可全同一字元、不可是常見密碼。"""
    out = []
    n = password_min_length()
    if len(password) < n:
        out.append(f"密碼至少 {n} 個字元")
    u = username.strip().lower()
    if len(u) >= 3 and u in password.lower():
        out.append("密碼不可包含帳號")
    if password and len(set(password)) == 1:
        out.append("密碼不可全是同一個字元")
    if password.lower() in _COMMON or any(
        password.lower().startswith(c) and len(password) - len(c) <= 2 for c in _COMMON
    ):
        out.append("密碼太常見")
    return out


def load_secret() -> bytes:
    raw = os.environ.get("RTGAIA_SECRET", "").strip()
    if raw:
        return hashlib.sha256(raw.encode("utf-8")).digest()
    return secrets.token_bytes(32)


def make_token(user_id: str, secret: bytes, *, now: float | None = None, ttl: int = TOKEN_TTL_SECONDS) -> str:
    t = now if now is not None else time.time()
    payload = {
        "uid": user_id,
        # 改密碼後，比 password_changed_at 早簽的 token 作廢（毫秒：同一秒內也分得出先後）
        "iat_ms": int(t * 1000),
        "exp": int(t + ttl),
        "nonce": secrets.token_hex(4),
    }
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).rstrip(b"=")
    sig = base64.urlsafe_b64encode(hmac.new(secret, body, hashlib.sha256).digest()).rstrip(b"=")
    return f"{body.decode('ascii')}.{sig.decode('ascii')}"


def parse_token(token: str, secret: bytes, *, now: float | None = None) -> str | None:
    """回 user_id；簽章不對或過期回 None。"""
    claims = parse_token_claims(token, secret, now=now)
    return None if claims is None else claims[0]


def parse_token_claims(token: str, secret: bytes, *, now: float | None = None) -> tuple[str, int] | None:
    """回 (user_id, iat 毫秒)；舊 token 沒有 → 0（任何一次改密碼之後都作廢）。"""
    try:
        body_s, sig_s = token.split(".", 1)
        body = body_s.encode("ascii")
        expected = base64.urlsafe_b64encode(hmac.new(secret, body, hashlib.sha256).digest()).rstrip(b"=")
        if not hmac.compare_digest(expected, sig_s.encode("ascii")):
            return None
        padded = body + b"=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if int(payload.get("exp", 0)) < (now if now is not None else time.time()):
            return None
        return str(payload["uid"]), int(payload.get("iat_ms", 0))
    except Exception:  # noqa: BLE001 - 任何形狀不對都當無效
        return None


def _is_plugin_callback(path: str) -> bool:
    parts = path.split("/")
    # /api/v1/plugins/{id}/jobs/{job}/...
    return len(parts) >= 7 and parts[:4] == ["", "api", "v1", "plugins"] and parts[5] == "jobs" and len(parts) > 7


def _is_plugin_use(path: str) -> bool:
    """使用者側：run／取消／KV（角色由路由依 manifest.required_role 再判）。"""
    parts = path.split("/")
    return len(parts) >= 6 and parts[:4] == ["", "api", "v1", "plugins"] and parts[5] in ("run", "jobs", "kv")


def required_role_for(method: str, path: str) -> str | None:
    """路徑 → 最低角色；None ＝ 不需身分（healthz、auth、docs）。"""
    if path.startswith("/api/v1/auth/users"):
        return "admin"  # 帳號管理是 auth 底下唯一要身分的路徑
    if path.startswith("/api/v1/settings") or path.startswith("/api/v1/dimse/scp/"):
        return "admin"  # 服務設定：看與改都是 admin
    if path.startswith("/api/v1/archive"):
        return "admin"  # 封存區只有管理者能看、改、刪
    if path.startswith("/api/v1/storage/integrity"):
        return "admin"  # 完整性巡檢（看、跑、重設基準）是系統管理；容量 status 所有人都能看
    if path.startswith("/api/v1/trash/library"):
        return "admin"  # 資料頁移除的 DICOM：跟 DELETE /catalog 一樣只有管理者
    if method == "DELETE" and path.startswith("/api/v1/catalog/"):
        return "admin"  # 從資料庫移除資料（2026-09-15）：只有管理者
    if (
        path.startswith("/api/v1/dimse/nodes")
        and method not in ("GET", "HEAD", "OPTIONS")
        and not path.endswith(("/echo", "/probe", "/find", "/retrieve", "/send"))
    ):
        return "admin"  # 節點設定是系統設定；echo／probe／find／retrieve／send 是使用
    if path in ("/healthz", "/readyz", "/docs", "/openapi.json", "/redoc") or path.startswith("/api/v1/auth/"):
        return None
    if _is_plugin_callback(path) or path == "/api/v1/plugins/register":
        return None  # plugin 回呼以 job token 認、自我登錄以 registration token 認
    if path.startswith("/api/v1/plugins") and method not in ("GET", "HEAD", "OPTIONS") and not _is_plugin_use(path):
        return "admin"  # 登錄／改／刪／refresh 是系統設定
    if not path.startswith("/api/v1/"):
        return None
    if method in ("GET", "HEAD", "OPTIONS"):
        return "viewer"
    if path.endswith("/review"):
        return "approver"
    # 不改臨床資料的 POST：開病例、協商網格、高畫質重切、3D 出圖
    # DVH 匯出只是登記一筆稽核（檔案在瀏覽器產生），看得到 DVH 的人就能匯出
    if path == "/api/v1/sessions" or path.endswith(
        ("/grids", "/reslice", "/render3d", "/render3d/pick", "/dvh/export")
    ):
        return "viewer"
    # 劑量運算的暫存結果只有自己看得到、關掉就沒了 —— 看得到劑量的人就能算、能丟；
    # 存成 RTDOSE（/dose/{id}/save）跟 RS 匯出同門檻
    if "/dose-ops" in path and path.startswith("/api/v1/studies/"):
        return "viewer"
    return "contourer"
