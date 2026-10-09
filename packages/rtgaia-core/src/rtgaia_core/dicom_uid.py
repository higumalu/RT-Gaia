"""匯出物件的 DICOM UID（UID root 可透過環境變數定義，預設用 pydicom 的）。

* `RTGAIA_UID_ROOT`：新 UID 的前綴。沒設 ＝ pydicom 的 `1.2.826.0.1.3680043.8.498.`（現況）；設 `2.25` ＝ UUID 派生
  （ISO/IEC 9834-8，不必申請）；設公司 OID（例 `1.3.6.1.4.1.<PEN>.1.`）＝ 正式商用。
* `RTGAIA_IMPLEMENTATION_CLASS_UID`：寫進 file meta 的 ImplementationClassUID。沒設 ＝ pydicom 的。
格式不合法（非數字、元件有前導 0、太長）→ `create_app()` 直接拒絕啟動，不默默產生壞 UID。
"""

from __future__ import annotations

import os
import re
import uuid

from pydicom.uid import PYDICOM_IMPLEMENTATION_UID, PYDICOM_ROOT_UID, generate_uid

IMPLEMENTATION_VERSION_NAME = "RTGAIA_0_1"
_UID_RE = re.compile(r"^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$")
MAX_ROOT_LEN = 40
"""前綴最長 40：pydicom 以雜湊補滿到 64 字元，至少留 24 位數的隨機性。"""


def _is_uid(value: str) -> bool:
    return bool(_UID_RE.match(value)) and len(value) <= 64


def uid_root() -> str | None:
    """None ＝ 用 `2.25.<UUID>`；否則是以 `.` 結尾的前綴。"""
    raw = os.environ.get("RTGAIA_UID_ROOT", "").strip()
    if not raw:
        return PYDICOM_ROOT_UID
    if raw.rstrip(".") == "2.25":
        return None
    return raw if raw.endswith(".") else raw + "."


def implementation_class_uid() -> str:
    return os.environ.get("RTGAIA_IMPLEMENTATION_CLASS_UID", "").strip() or PYDICOM_IMPLEMENTATION_UID


def uid_config_problems() -> list[str]:
    problems = []
    root = uid_root()
    if root is not None:
        body = root.rstrip(".")
        if not _is_uid(body):
            problems.append(f"RTGAIA_UID_ROOT 格式不對（只能是數字與點、元件不可有前導 0）：{root!r}")
        elif len(root) > MAX_ROOT_LEN:
            problems.append(
                f"RTGAIA_UID_ROOT 太長（{len(root)} > {MAX_ROOT_LEN}），產生的 UID 會超過 64 字元或隨機性不足"
            )
    impl = implementation_class_uid()
    if not _is_uid(impl):
        problems.append(f"RTGAIA_IMPLEMENTATION_CLASS_UID 格式不對：{impl!r}")
    return problems


def new_uid() -> str:
    problems = uid_config_problems()
    if problems:
        raise ValueError("；".join(problems))
    return str(generate_uid(prefix=uid_root()))


def describe() -> str:
    root = uid_root()
    if root is None:
        return "2.25.<UUID>"
    return f"{root}（pydicom）" if root == PYDICOM_ROOT_UID else root


def as_dicom_uid(value: str) -> str:
    """寫進 DICOM 的 UID 一定合法。

    合法（只有數字與點、元件沒有前導 0、≤ 64 字元）→ 原樣；否則（假體的內部 id `…RTGAIA.TESTBE.FOR.axial`、
    合成切片 UID 加了序號超過 64 字元）→ **確定性**的 `2.25.<UUID5>`（同一個內部 id 永遠對到同一個 UID，
    同一次匯出裡 FoR／study／series 的引用彼此一致）。內部 id 不改 —— 跨語言的 fixture 與前端靠它。"""
    if _is_uid(value):
        return value
    return f"2.25.{uuid.uuid5(_RTGAIA_NAMESPACE, value).int}"


_RTGAIA_NAMESPACE = uuid.UUID("6f1c2a40-9b3e-5d8a-a7c1-2e4f60b8d913")
"""`as_dicom_uid` 的 UUID5 命名空間（固定 —— 換了就換掉所有假體匯出的 UID）。"""
