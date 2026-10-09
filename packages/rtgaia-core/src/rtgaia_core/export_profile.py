"""匯出 profile（可以按照 Varian 等 TPS 的規則去訂）。

同一份 RTSTRUCT，各家 TPS 匯入時的限制不同；profile 是匯出前套在「每個 ROI」與「結構集標頭」上的一組規則，
**每一個改動都回報**（`warnings`），不默默改名。

* `varian`（預設，`RTGAIA_EXPORT_PROFILE`）—— 依 Varian Eclipse 的匯入慣例：
  - ROI 名稱（Eclipse Structure ID）：只留可列印 ASCII（其餘換成 `_`）、最長 16 字元、
    **不分大小寫**不可重複（撞了加 `_2`…）；改過的原名寫進 ROIDescription。
  - RTROIInterpretedType：只寫 DICOM 定義的詞；來源 RTSTRUCT 有就沿用，沒有才依名字推
    （BODY／External／Skin → EXTERNAL、PTV／CTV／GTV 開頭 → 對應類型、Couch／Table 開頭 → SUPPORT、
    Bolus 開頭 → BOLUS、其餘 ORGAN）；整套**恰好一個 EXTERNAL**（多的降為 ORGAN，並回報）——
    Eclipse 以它當劑量計算的體表。
  - 結構集標籤（16）、SeriesDescription（64）、結構集描述轉 ASCII；
    全部都是 ASCII 時不寫 SpecificCharacterSet（預設字元集）。
  ⚠️ 這些規則是依 Eclipse 的已知限制寫的，**要以院內 Eclipse 實機匯入驗證**。
* `generic` —— 加入 profile 之前的行為（UTF-8、名稱不截），加上 ROI 類型改用來源／名字推（不再一律 ORGAN）。
"""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

PROFILES = ("varian", "generic")

# PS3.3 C.8.8.8.1 RTROIInterpretedType 的定義詞
DICOM_ROI_TYPES = frozenset(
    {
        "EXTERNAL", "PTV", "CTV", "GTV", "TREATED_VOLUME", "IRRAD_VOLUME", "BOLUS", "AVOIDANCE", "ORGAN", "MARKER",
        "REGISTRATION", "ISOCENTER", "CONTRAST_AGENT", "CAVITY", "BRACHY_CHANNEL", "BRACHY_ACCESSORY", "BRACHY_SRC_APP",
        "BRACHY_CHNL_SHLD", "SUPPORT", "FIXATION", "DOSE_REGION", "CONTROL", "DOSE_MEASUREMENT",
    }
)  # fmt: skip
EXTERNAL_NAMES = frozenset({"BODY", "EXTERNAL", "SKIN", "OUTER_CONTOUR", "OUTERCONTOUR", "PATIENT", "BODY_CONTOUR"})
VARIAN_NAME_MAX = 16


def default_profile() -> str:
    p = os.environ.get("RTGAIA_EXPORT_PROFILE", "").strip().lower() or "varian"
    return p if p in PROFILES else "varian"


def infer_roi_type(name: str) -> str:
    n = re.sub(r"[\s\-]+", "_", name.strip().upper())
    if n in EXTERNAL_NAMES:
        return "EXTERNAL"
    for prefix in ("PTV", "CTV", "GTV"):
        if n.startswith(prefix):
            return prefix
    if n.startswith(("COUCH", "TABLE")):
        return "SUPPORT"
    if n.startswith("BOLUS"):
        return "BOLUS"
    return "ORGAN"


def roi_type(source_type: str | None, name: str) -> str:
    t = (source_type or "").strip().upper()
    return t if t in DICOM_ROI_TYPES else infer_roi_type(name)


def generation_algorithm(provenance_source: str | None) -> str:
    """模型產生的 → AUTOMATIC；使用者編輯／後處理 → SEMIAUTOMATIC；其餘沿用舊預設 SEMIAUTOMATIC。"""
    return "AUTOMATIC" if provenance_source == "model" else "SEMIAUTOMATIC"


def to_ascii(text: str, *, replacement: str = "_") -> str:
    """去重音（NFKD）後只留可列印 ASCII；其餘連續字元換成一個 `replacement`；DICOM 分隔字元 `\\` 也換掉。"""
    s = unicodedata.normalize("NFKD", str(text or ""))
    out, prev_bad = [], False
    for ch in s:
        if unicodedata.combining(ch):
            continue
        if 32 <= ord(ch) < 127 and ch != "\\":
            out.append(ch)
            prev_bad = False
        elif not prev_bad:
            out.append(replacement)
            prev_bad = True
    return "".join(out).strip()


@dataclass
class ProfileResult:
    profile: str
    entries: list[dict[str, Any]]
    header: dict[str, str]
    charset: str | None
    warnings: list[dict[str, Any]] = field(default_factory=list)


def apply_profile(profile: str, entries: list[dict[str, Any]], header: dict[str, str]) -> ProfileResult:
    """`entries`：每個 ROI `{structure_id, name, interpreted_type?, provenance_source?, …}`（原地不改，回傳新的）。
    `header`：`{label, description, series_description}`。"""
    if profile not in PROFILES:
        raise ValueError(f"未知的匯出 profile {profile!r}；可用：{', '.join(PROFILES)}")
    warnings: list[dict[str, Any]] = []
    out: list[dict[str, Any]] = []
    for e in entries:
        t = roi_type(e.get("interpreted_type"), e["name"])
        if (e.get("interpreted_type") or "").strip().upper() not in DICOM_ROI_TYPES and e.get("interpreted_type"):
            warnings.append(
                {
                    "structure_id": e["structure_id"],
                    "field": "RTROIInterpretedType",
                    "from": e.get("interpreted_type"),
                    "to": t,
                    "reason": "不是 DICOM 定義詞，依名字推",
                }
            )  # noqa: E501
        out.append(
            {
                **e,
                "interpreted_type": t,
                "generation_algorithm": generation_algorithm(e.get("provenance_source")),
                "roi_description": "",
            }
        )  # noqa: E501
    # 恰好一個 EXTERNAL（兩種 profile 都做：多個 EXTERNAL 對任何 TPS 都是矛盾）
    externals = [e for e in out if e["interpreted_type"] == "EXTERNAL"]
    if len(externals) > 1:
        keep = next(
            (e for e in externals if re.sub(r"\s+", "_", e["name"].strip().upper()) in EXTERNAL_NAMES), externals[0]
        )
        for e in externals:
            if e is not keep:
                e["interpreted_type"] = "ORGAN"
                warnings.append(
                    {
                        "structure_id": e["structure_id"],
                        "field": "RTROIInterpretedType",
                        "from": "EXTERNAL",
                        "to": "ORGAN",
                        "reason": f"只能有一個 EXTERNAL（保留 {keep['name']}）",
                    }
                )  # noqa: E501
    header = dict(header)
    charset: str | None = "ISO_IR 192"
    if profile == "varian":
        used: set[str] = set()
        for n, e in enumerate(out, start=1):
            original = e["name"]
            name = to_ascii(original) or f"ROI_{n}"
            reasons = []
            if name != original.strip():
                reasons.append("非 ASCII 字元")
            if len(name) > VARIAN_NAME_MAX:
                name = name[:VARIAN_NAME_MAX].rstrip()
                reasons.append(f"超過 {VARIAN_NAME_MAX} 字元")
            base, k = name, 2
            while name.upper() in used:
                suffix = f"_{k}"
                name = base[: VARIAN_NAME_MAX - len(suffix)] + suffix
                k += 1
            if name != base:
                reasons.append("與其他 ROI 重名（不分大小寫）")
            used.add(name.upper())
            if name != original:
                e["name"] = name
                e["roi_description"] = original[:1024]
                warnings.append(
                    {
                        "structure_id": e["structure_id"],
                        "field": "ROIName",
                        "from": original,
                        "to": name,
                        "reason": "、".join(reasons),
                    }
                )  # noqa: E501
        for key, limit in (("label", 16), ("series_description", 64), ("description", 1024)):
            if header.get(key):
                ascii_v = to_ascii(header[key])[:limit] or ("RTGAIA" if key == "label" else "")
                if ascii_v != header[key]:
                    warnings.append(
                        {
                            "structure_id": None,
                            "field": key,
                            "from": header[key],
                            "to": ascii_v,
                            "reason": "Varian：轉 ASCII",
                        }
                    )
                    header[key] = ascii_v
        charset = None
    return ProfileResult(profile=profile, entries=out, header=header, charset=charset, warnings=warnings)
