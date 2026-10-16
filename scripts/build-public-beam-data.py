#!/usr/bin/env python3
"""公開文獻的射束資料 → 內建資料集（`rtgaia_dosecalc/public_beam_data/*.json`）。

來源是 `packages/rtgaia-dosecalc/public_beam_data_src/transcribed.json`：六篇 CC BY 論文（五篇 JACMP、一篇 J Radiat Res）的表格，
從 Europe PMC 的 JATS XML 逐格取出（原樣，含原文的減號、印刷錯誤；見每張表的 notes）。這個腳本只做
**選欄與換單位**（cm → mm、% → 分率），每一筆量測的 `reference` 寫出表號、列、欄；少數計算（Beyer 表 4 三台
的平均與標準差、Akino 95% 信賴區間換成標準不確定度）在 `reference` 裡寫明算法。

    python3 scripts/build-public-beam-data.py           # 重新產生
    python3 scripts/build-public-beam-data.py --check   # 跟 repo 裡的不同 → 退出碼 1（測試用）
"""

# ruff: noqa: E501 — 每筆量測的出處（reference）是一整句資料，拆行反而難對照原文

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "packages/rtgaia-dosecalc/public_beam_data_src/transcribed.json"
OUT = ROOT / "packages/rtgaia-dosecalc/src/rtgaia_dosecalc/public_beam_data"

DASHES = "−–‐-"


def num(cell: str) -> float:
    """「0.545」「−0.19 mm」「0.41%」→ 數字（原文的各種減號都當負號）。"""
    s = cell.strip()
    for d in DASHES[:-1]:
        s = s.replace(d, "-")
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)", s)
    if not m:
        raise ValueError(f"不是數字：{cell!r}")
    return float(m.group(1))


def ci(cell: str) -> tuple[float, float]:
    """「(0.531‐0.560)」→ (0.531, 0.560)。"""
    parts = re.findall(r"\d+(?:\.\d+)?", cell)
    if len(parts) != 2:
        raise ValueError(f"不是信賴區間：{cell!r}")
    return float(parts[0]), float(parts[1])


def mean_sd_n(cell: str) -> tuple[float, float, int]:
    """「5.76 ± 0.08 (5.67–5.88) [N = 6]」→ (5.76, 0.08, 6)。"""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*±\s*(\d+(?:\.\d+)?).*\[N\s*=\s*(\d+)\]", cell)
    if not m:
        raise ValueError(f"不是 mean ± SD [N]：{cell!r}")
    return float(m.group(1)), float(m.group(2)), int(m.group(3))


def side_mm(cell: str) -> float:
    """「4×4」「10 × 10」（cm）→ 邊長 mm（正方形）。"""
    a, b = (float(x) for x in re.findall(r"\d+(?:\.\d+)?", cell))
    if a != b:
        raise ValueError(f"不是正方形：{cell!r}")
    return a * 10


def r6(x: float) -> float:
    return round(x, 6)


def paper(doc: dict[str, Any], key: str) -> dict[str, Any]:
    return next(p for p in doc["papers"] if p["key"] == key)


def table(p: dict[str, Any], label: str, index: int = 0) -> dict[str, Any]:
    return [t for t in p["tables"] if t["label"] == label][index]


def rows(t: dict[str, Any]) -> list[list[str]]:
    return t.get("rows_with_group_labels") or t["rows"]


def source(p: dict[str, Any], note: str = "") -> dict[str, Any]:
    lic = p["licence_text"]
    version = "4.0" if "4.0" in lic or "/4.0" in lic else "3.0"
    return {
        "kind": "literature",
        "citation": f"{p['citation']} doi:{p['doi']}",
        "licence": f"CC BY {version}",
        "url": f"https://doi.org/{p['doi']}",
        "note": note,
    }


def dataset(
    did: str,
    name: str,
    model: str,
    energy: float,
    mode: str,
    src: dict[str, Any],
    ms: list[dict[str, Any]],
    note: str = "",
) -> dict[str, Any]:
    return {
        "dataset_id": did,
        "name": name,
        "machine": {"manufacturer": "Varian", "model": model, "name": ""},
        "beam": {"energy_mv": energy, "fluence_mode": mode},
        "source": src,
        "measurements": ms,
        "note": note,
    }


# ── Beyer 2013（三台 TrueBeam：6X、15X、10FFF）──────────────────────────────


def beyer(doc: dict[str, Any]) -> list[dict[str, Any]]:
    p = paper(doc, "beyer2013")
    t1, t2 = table(p, "Table 1"), table(p, "Table 2")
    t4 = {"6": table(p, "Table 4", 0), "15": table(p, "Table 4", 1)}
    beams = (
        ("6", "6x", 6.0, "STANDARD", "6 MV"),
        ("15", "15x", 15.0, "STANDARD", "15 MV"),
        ("10 FFF", "10fff", 10.0, "FFF", "10 FFF"),
    )
    out = []
    for e1, tag, energy, mode, e2 in beams:
        ms: list[dict[str, Any]] = []
        for r in rows(t1):
            if r[0] != e1:
                continue
            quantity, field = r[1], r[2]
            side = side_mm(field)
            fid = f"{int(side / 10)}x{int(side / 10)}"
            ref = f"Beyer 2013 Table 1, {e1} MV {quantity} {field}, Average ± St. Dev. (3 machines)"
            avg, sd = num(r[6]), num(r[7])
            cond = {"field_mm": f"{side:g} x {side:g}", "detector": "IBA CC13"}
            if quantity.startswith("d_{max}"):
                ms.append(
                    {
                        "measurement_id": f"beyer2013-t1-dmax-{tag}-{fid}",
                        "kind": "scalar",
                        "quantity": "dmax_mm",
                        "conditions": cond,
                        "points": [[r6(avg * 10), r6(sd * 10)]],
                        "statistic": "mean",
                        "n": 3,
                        "reference": ref + "; cm → mm; SSD not stated in the paper",
                    }
                )
            elif quantity.startswith("PDD_{10}"):
                ms.append(
                    {
                        "measurement_id": f"beyer2013-t1-pdd10-{tag}-{fid}",
                        "kind": "depth_dose",
                        "quantity": "pdd",
                        "unit": "percent",
                        "conditions": {**cond, "ssd_mm": 1000, "normalization": "dmax"},
                        "points": [[100.0, avg, sd]],
                        "statistic": "mean",
                        "n": 3,
                        "reference": ref
                        + "; SSD not stated in the paper, assumed 100 cm (the profiles in the same paper are at 100 cm SSD)",
                    }
                )
            elif quantity.startswith("TPR_{20/10}"):
                ms.append(
                    {
                        "measurement_id": f"beyer2013-t1-tpr2010-{tag}-{fid}",
                        "kind": "scalar",
                        "quantity": "tpr20_10",
                        "conditions": cond,
                        "points": [[avg, sd]],
                        "statistic": "mean",
                        "n": 3,
                        "reference": ref
                        + "; derived by the authors from PDD20/PDD10 with TPR20,10 = 1.2661 PDD20,10 − 0.0595, not measured",
                    }
                )
            else:
                raise ValueError(f"Beyer 表 1 不認得的列：{r}")
        pts = [[side_mm(r[1]), num(r[5]), num(r[6])] for r in rows(t2) if r[0] in (f"{e1} MV", e1)]
        ms.append(
            {
                "measurement_id": f"beyer2013-t2-of-{tag}",
                "kind": "output_factor",
                "conditions": {
                    "ssd_mm": 950,
                    "depth_mm": 50,
                    "setup": "SAD",
                    "reference_field_mm": "100 x 100",
                    "detector": "IBA CC13",
                },
                "points": pts,
                "statistic": "mean",
                "n": 3,
                "reference": f"Beyer 2013 Table 2, {e2}, Average ± St. Dev. (3 machines); isocentric, 5 cm depth, 95 cm SSD (Methods)",
            }
        )
        if e1 in t4:
            t = t4[e1]
            for depth in sorted({r[0] for r in rows(t)}, key=float):
                tb = [r for r in rows(t) if r[0] == depth and r[1].startswith("TrueBeam")]
                assert len(tb) == 3, tb
                for side, ci_pen, ci_fw in ((100.0, 2, 3), (400.0, 4, 5)):
                    pen = [num(r[ci_pen]) for r in tb]
                    fw = [num(r[ci_fw]) * 10 for r in tb]
                    cond = {
                        "field_mm": f"{side:g} x {side:g}",
                        "ssd_mm": 1000,
                        "depth_mm": float(depth) * 10,
                        "axis": "x",
                        "detector": "IBA CC13",
                    }
                    ref = (
                        f"Beyer 2013 Table 4, {e2}, depth {depth} cm, {side / 10:g}×{side / 10:g} field, TrueBeam #1–#3"
                    )
                    fid = f"{int(side / 10)}x{int(side / 10)}-d{depth}"
                    ms.append(
                        {
                            "measurement_id": f"beyer2013-t4-penumbra-{tag}-{fid}",
                            "kind": "scalar",
                            "quantity": "penumbra_80_20_mm",
                            "conditions": cond,
                            "points": [[r6(statistics.mean(pen)), r6(statistics.stdev(pen))]],
                            "statistic": "mean",
                            "n": 3,
                            "reference": ref + " (mean and sample SD computed from the three machines; crossplane)",
                        }
                    )
                    ms.append(
                        {
                            "measurement_id": f"beyer2013-t4-fwhm-{tag}-{fid}",
                            "kind": "scalar",
                            "quantity": "fwhm_mm",
                            "conditions": cond,
                            "points": [[r6(statistics.mean(fw)), r6(statistics.stdev(fw))]],
                            "statistic": "mean",
                            "n": 3,
                            "reference": ref
                            + " field width (50%) (cm → mm; mean and sample SD computed from the three machines; crossplane)",
                        }
                    )
        out.append(
            dataset(
                f"pub-beyer2013-{tag}",
                f"TrueBeam {e2} (Beyer 2013)",
                "TrueBeam",
                energy,
                mode,
                source(
                    p,
                    "Three TrueBeam linacs at three sites; IBA CC13 0.125 cm³ chamber, IBA-Wellhofer scanning phantom.",
                ),
                ms,
            )
        )
    return out


# ── Akino 2020（12 台 TrueBeam 的小照野輸出因子）────────────────────────────


def akino(doc: dict[str, Any]) -> list[dict[str, Any]]:
    p = paper(doc, "akino2020")
    t = table(p, "Table 2")
    out = []
    for col, tag, energy, mode, label in (
        (1, "6x", 6.0, "STANDARD", "6 MV"),
        (3, "10x", 10.0, "STANDARD", "10 MV"),
        (5, "6fff", 6.0, "FFF", "6 MV FFF"),
        (7, "10fff", 10.0, "FFF", "10 MV FFF"),
    ):
        pts = []
        for r in rows(t):
            fs, med = num(r[0]), num(r[col])
            if r[col + 1].strip() in DASHES:
                pts.append([fs, med, None])
            else:
                lo, hi = ci(r[col + 1])
                pts.append([fs, med, r6((hi - lo) / 3.92)])
        m = {
            "measurement_id": f"akino2020-t2-of-{tag}",
            "kind": "output_factor",
            "conditions": {
                "ssd_mm": 1000,
                "depth_mm": 100,
                "reference_field_mm": "100 x 100",
                "collimation": "mlc",
                "detector": "various (Table 1), corrected with IAEA TRS-483 factors",
            },
            "points": pts,
            "statistic": "median",
            "n": None,
            "reference": f"Akino 2020 Table 2, {label}, median Ω; uncertainty = (95% CI width) / 3.92; 5 mm row from HD120 MLC machines only; jaws 8×8 mm² for 5 mm, MLC + 2 mm for 10–40 mm, = MLC above 40 mm",
        }
        out.append(
            dataset(
                f"pub-akino2020-{tag}",
                f"TrueBeam {label} small fields (Akino 2020)",
                "TrueBeam",
                energy,
                mode,
                source(
                    p,
                    "12 TrueBeam linacs at 11 institutions (10 STx with HD120 MLC, 2 with Millennium 120). The authors do not recommend these values for clinical use.",
                ),
                [m],
            )
        )
    return out


# ── Gao 2019（Halcyon）與 Lim 2019（Halcyon MLC）────────────────────────────


def gao(doc: dict[str, Any]) -> list[dict[str, Any]]:
    p = paper(doc, "gao2019")
    t4, t5 = table(p, "Table 4"), table(p, "Table 5")
    ms: list[dict[str, Any]] = []
    squares, rects = [], []
    for r in rows(t5):
        a, b = (float(x) * 10 for x in re.findall(r"\d+(?:\.\d+)?", r[0]))
        (squares if a == b else rects).append((a, b, num(r[1])))
    common = {
        "ssd_mm": 900,
        "depth_mm": 100,
        "reference_field_mm": "100 x 100",
        "collimation": "mlc",
        "detector": "Sun Nuclear SNC125c",
    }
    ms.append(
        {
            "measurement_id": "gao2019-t5-of-square",
            "kind": "output_factor",
            "conditions": common,
            "points": [[a, v] for a, _, v in squares],
            "statistic": "single",
            "reference": "Gao 2019 Table 5, 1DS column (square fields); SSD 90 cm, 10 cm depth, normalized to 10×10 (Methods)",
        }
    )
    ms.append(
        {
            "measurement_id": "gao2019-t5-of-rect",
            "kind": "output_factor",
            "columns": ["field_x_mm", "field_y_mm", "value"],
            "conditions": common,
            "points": [[a, b, v] for a, b, v in rects],
            "statistic": "single",
            "reference": "Gao 2019 Table 5, 1DS column (4 × 20 and 20 × 4 fields; printed as X × Y in cm)",
        }
    )
    head = t4["columns"]
    dmax = next(r for r in rows(t4) if r[0].startswith("d_{max}") and r[1] == "1DS")
    for i in range(2, len(head)):
        side = side_mm(head[i].replace("cm^{2}", ""))
        fid = f"{int(side / 10)}x{int(side / 10)}"
        ms.append(
            {
                "measurement_id": f"gao2019-t4-dmax-{fid}",
                "kind": "scalar",
                "quantity": "dmax_mm",
                "conditions": {"field_mm": f"{side:g} x {side:g}", "ssd_mm": 900, "detector": "Sun Nuclear SNC125c"},
                "points": [[r6(num(dmax[i]) * 10)]],
                "statistic": "single",
                "reference": f"Gao 2019 Table 4, d_max 1DS row, {head[i]} (cm → mm); PDD at 90 cm SSD",
            }
        )
    ms.append(
        {
            "measurement_id": "gao2019-tg51",
            "kind": "absolute",
            "conditions": {
                "field_mm": "100 x 100",
                "ssd_mm": 1000,
                "normalization": "dmax",
                "detector": "PTW 30013 Farmer",
            },
            "points": [[0.01]],
            "statistic": "single",
            "reference": "Gao 2019 Methods: TG-51 calibration to 1.00 cGy/MU in water at the depth of maximum dose, SSD 100 cm (10 × 10 reference field per TG-51)",
        }
    )
    return [
        dataset(
            "pub-gao2019-halcyon",
            "Halcyon 6 MV FFF (Gao 2019)",
            "Halcyon",
            6.0,
            "FFF",
            source(p, "One Halcyon at MD Anderson; PDD and output factors with a 1D scanner and SNC125c chamber."),
            ms,
        )
    ]


def lim(doc: dict[str, Any]) -> list[dict[str, Any]]:
    p = paper(doc, "lim2019")
    t1, t3, tx = table(p, "Table 1"), table(p, "Table 3"), table(p, "Text values (Results)")
    ms: list[dict[str, Any]] = []
    cond = {"ssd_mm": 1000, "detector": "PTW 30013 Farmer (solid water)"}
    for r in rows(t3):
        if not r[0].endswith("only"):
            continue
        layer = "distal" if r[0].startswith("Distal") else "proximal"
        for col, depth in ((1, None), (2, 100.0)):
            c = {**cond, "layer": layer, **({"depth_mm": depth} if depth else {"note": "at d_max"})}
            ms.append(
                {
                    "measurement_id": f"lim2019-t3-transmission-{layer}-{'d10' if depth else 'dmax'}",
                    "kind": "scalar",
                    "quantity": "mlc_transmission",
                    "conditions": c,
                    "points": [[r6(num(r[col]) / 100)]],
                    "statistic": "single",
                    "reference": f"Lim 2019 Table 3, {r[0]}, {t3['columns'][col]} (% → fraction); the dual-layer transmission is printed as negligible",
                }
            )
    for r in rows(tx):
        if r[0].startswith("Leaf end effect"):
            depth = 100.0 if "10 cm" in r[0] else None
            c = {**cond, "layer": "distal", **({"depth_mm": depth} if depth else {"note": "at d_max"})}
            ms.append(
                {
                    "measurement_id": f"lim2019-text-leaf-end-{'d10' if depth else 'dmax'}",
                    "kind": "scalar",
                    "quantity": "leaf_end_offset_mm",
                    "conditions": c,
                    "points": [[num(r[1])]],
                    "statistic": "single",
                    "reference": f"Lim 2019 Results: {r[3]} (sweeping gaps 2–20 mm, y-intercept after transmission correction)",
                }
            )
    spec = {r[0]: r[1] for r in rows(t1)}
    for key, quantity in (("Leaf end radius", "leaf_end_radius_mm"), ("Leaf height", "leaf_height_mm")):
        ms.append(
            {
                "measurement_id": f"lim2019-t1-{quantity.removesuffix('_mm').replace('_', '-')}",
                "kind": "scalar",
                "quantity": quantity,
                "conditions": {},
                "points": [[r6(num(spec[key]) * 10)]],
                "statistic": "single",
                "reference": f"Lim 2019 Table 1, {key}, Halcyon column (cm → mm); a vendor specification quoted by the paper, not a measurement",
            }
        )
    return [
        dataset(
            "pub-lim2019-halcyon-mlc",
            "Halcyon MLC (Lim 2019)",
            "Halcyon",
            6.0,
            "FFF",
            source(p, "One Halcyon; dual-layer MLC transmission and leaf-end effect."),
            ms,
        )
    ]


# ── Tanaka 2020（24 組 TrueBeam FFF 的側向分佈參數）──────────────────────────


def tanaka(doc: dict[str, Any]) -> list[dict[str, Any]]:
    p = paper(doc, "tanaka2020")
    t4 = table(p, "Table 4")
    detectors = {
        "CC13/PTW31010": ("chamber", "IBA CC13 or PTW 31010 chamber"),
        "All other detectors": ("other", "other detectors (diodes, diamond, small chambers)"),
    }
    out = []
    for tag, energy, label, tparams in (
        ("6fff", 6.0, "6 MV FFF", table(p, "Table 5")),
        ("10fff", 10.0, "10 MV FFF", table(p, "Table 6")),
    ):
        ms: list[dict[str, Any]] = []
        base = {"ssd_mm": 1000, "depth_mm": 100, "axis": "x", "collimation": "jaw"}
        for r in rows(t4):
            dtag, dname = detectors[r[0]]
            for i, head in enumerate(t4["columns"]):
                if not head.startswith(label + " beam /"):
                    continue
                side = float(re.findall(r"\d+", head.split("/")[1])[0])
                mean, sd, n = mean_sd_n(r[i])
                ms.append(
                    {
                        "measurement_id": f"tanaka2020-t4-penumbra-{tag}-{int(side)}-{dtag}",
                        "kind": "scalar",
                        "quantity": "penumbra_80_20_mm",
                        "conditions": {**base, "field_mm": f"{side:g} x {side:g}", "detector": dname},
                        "points": [[mean, sd]],
                        "statistic": "mean",
                        "n": n,
                        "reference": f"Tanaka 2020 Table 4, {r[0]}, {head}; crossline at 10 cm depth, profiles renormalized with the Fogliata factors",
                    }
                )
        for r in rows(tparams):
            dtag, dname = detectors[r[0]]
            for i, head in enumerate(tparams["columns"]):
                name = head.split("/")[0].strip()
                if name not in ("FWHM (mm)", "Unflatness (mm)", "Slope"):
                    continue
                quantity = {"FWHM (mm)": "fwhm_mm", "Unflatness (mm)": "unflatness", "Slope": "slope_percent_per_mm"}[
                    name
                ]
                side = float(re.findall(r"\d+", head.split("/")[1])[0])
                mean, sd, n = mean_sd_n(r[i])
                extra = (
                    "; unflatness = central-axis dose / off-axis dose (Tanaka eq. 1; the header prints “(mm)”)"
                    if quantity == "unflatness"
                    else (
                        "; slope between 1/3 and 2/3 of half the FWHM (Tanaka eq. 2)"
                        if quantity == "slope_percent_per_mm"
                        else ""
                    )
                )
                ms.append(
                    {
                        "measurement_id": f"tanaka2020-{tparams['label'].replace(' ', '').lower()}-{quantity.split('_')[0]}-{tag}-{int(side)}-{dtag}",
                        "kind": "scalar",
                        "quantity": quantity,
                        "conditions": {**base, "field_mm": f"{side:g} x {side:g}", "detector": dname},
                        "points": [[mean, sd]],
                        "statistic": "mean",
                        "n": n,
                        "reference": f"Tanaka 2020 {tparams['label']}, {r[0]}, {head}{extra}",
                    }
                )
        out.append(
            dataset(
                f"pub-tanaka2020-{tag}",
                f"TrueBeam {label} profiles (Tanaka 2020)",
                "TrueBeam",
                energy,
                "FFF",
                source(
                    p,
                    "24 TrueBeam data sets from 19 institutions, jaw-collimated fields, 100 cm SSD; values split by detector class.",
                ),
                ms,
            )
        )
    return out


NOTICE = """Public beam data shipped with RT-Gaia

The datasets in this directory reproduce tables from the open-access articles below, which are
distributed under Creative Commons Attribution licences (CC BY 3.0 or CC BY 4.0, as stated in each
dataset's `source.licence`). The values were taken cell by cell from the articles' JATS XML
(Europe PMC); scripts/build-public-beam-data.py selects columns and converts units, and each
measurement's `reference` names the table, row and column it comes from. Changes from the
originals: unit conversions, the means and sample standard deviations of Beyer 2013 Table 4, and
the conversion of Akino 2020 confidence intervals to standard uncertainties, all stated in the
`reference` fields. None of these data represent a particular machine; models fitted to them are
for demonstration only.

{citations}
"""


# ── Isono 2020（58 個機構的 MLC 穿透與 DLG：量測值）────────────────────────────


ISONO_UNITS = {"Millennium 120": 18, "HD120": 7}
"""Isono 2020 Table 2：TrueBeam 的台數（每個能量的台數沒有寫）。"""


def isono(doc: dict[str, Any]) -> list[dict[str, Any]]:
    p = paper(doc, "isono2020")
    t1, t4, t5 = table(p, "Table 1"), table(p, "Table 4"), table(p, "Table 5")
    # Table 4／5 的欄：能量、Millennium 120 TrueBeam、Millennium 120 C-Series、HD120 TrueBeam、HD120 C-Series
    col = {"Millennium 120": 1, "HD120": 3}
    spec = {(r[0], r[1]) if len(r) == 4 else (r[0], ""): r[-2:] for r in rows(t1)}
    thickness = {"Millennium 120": spec[("Leaf thickness (cm)", "")][0], "HD120": spec[("Leaf thickness (cm)", "")][1]}
    radius = {
        "Millennium 120": spec[("Tip radius of curvature (cm)", "")][0],
        "HD120": spec[("Tip radius of curvature (cm)", "")][1],
    }
    cond = {"ssd_mm": 900, "depth_mm": 100.0, "detector": "mostly 0.6 cm3 Farmer chambers (79% of institutions)"}
    out = []
    for mlc, slug in (("Millennium 120", "m120"), ("HD120", "hd120")):
        for energy, mode, label in ((6.0, "STANDARD", "6 MV"), (6.0, "FFF", "6 MV FFF")):
            tr = next(r for r in rows(t4) if r[0] == label)[col[mlc]]
            dl = next(r for r in rows(t5) if r[0] == label)[col[mlc]]
            (tr_m, tr_sd), (dl_m, dl_sd) = (tuple(num(x) for x in c.split("±")) for c in (tr, dl))
            n = ISONO_UNITS[mlc]
            tag = f"{slug}-{'6fff' if mode == 'FFF' else '6x'}"
            ms = [
                {
                    "measurement_id": f"isono2020-t5-dlg-{tag}",
                    "kind": "scalar",
                    "quantity": "dlg_mm",
                    "conditions": {**cond, "note": "sweeping gap (vendor-provided plan at 91% of institutions)"},
                    "columns": ["value", "uncertainty"],
                    "points": [[r6(dl_m), r6(dl_sd)]],
                    "statistic": "mean",
                    "n": n,
                    "reference": f"Isono 2020 Table 5, {label}, {mlc} TrueBeam column (mean ± SD across units; measured, not the TPS-customized values of Table 7); n = TrueBeam {mlc} units in Table 2",
                },
                {
                    "measurement_id": f"isono2020-t4-transmission-{tag}",
                    "kind": "scalar",
                    "quantity": "mlc_transmission",
                    "conditions": cond,
                    "columns": ["value", "uncertainty"],
                    "points": [[r6(tr_m / 100), r6(tr_sd / 100)]],
                    "statistic": "mean",
                    "n": n,
                    "reference": f"Isono 2020 Table 4, {label}, {mlc} TrueBeam column (% → fraction; mean ± SD across units); SSD 90 cm / 10 cm was the most common geometry (Table 3)",
                },
                {
                    "measurement_id": f"isono2020-t1-leaf-height-{tag}",
                    "kind": "scalar",
                    "quantity": "leaf_height_mm",
                    "conditions": {},
                    "points": [[r6(num(thickness[mlc]) * 10)]],
                    "statistic": "single",
                    "reference": f"Isono 2020 Table 1, Leaf thickness, {mlc} (cm → mm); a specification, not a measurement",
                },
                {
                    "measurement_id": f"isono2020-t1-leaf-end-radius-{tag}",
                    "kind": "scalar",
                    "quantity": "leaf_end_radius_mm",
                    "conditions": {},
                    "points": [[r6(num(radius[mlc]) * 10)]],
                    "statistic": "single",
                    "reference": f"Isono 2020 Table 1, Tip radius of curvature, {mlc} (cm → mm); a specification, not a measurement",
                },
            ]
            out.append(
                dataset(
                    f"pub-isono2020-{tag}",
                    f"TrueBeam {mlc} {label} MLC (Isono 2020)",
                    f"TrueBeam ({mlc})",
                    energy,
                    mode,
                    source(p, f"Survey of 58 institutions; TrueBeam {mlc}: {n} units. Measured sweeping-gap DLG and leaf transmission."),
                    ms,
                )
            )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--check", action="store_true", help="只比對，不寫")
    args = ap.parse_args()
    doc = json.loads(SRC.read_text(encoding="utf-8"))
    datasets = [*beyer(doc), *akino(doc), *gao(doc), *lim(doc), *tanaka(doc), *isono(doc)]
    files = {f"{d['dataset_id']}.json": json.dumps(d, ensure_ascii=False, indent=1) + "\n" for d in datasets}
    cites = sorted({f"- {p['citation']} https://doi.org/{p['doi']} ({source(p)['licence']})" for p in doc["papers"]})
    files["NOTICE"] = NOTICE.format(citations="\n".join(cites))
    if args.check:
        have = {f.name for f in OUT.glob("*")} if OUT.is_dir() else set()
        stale = sorted(
            n for n, text in files.items() if not (OUT / n).is_file() or (OUT / n).read_text(encoding="utf-8") != text
        )
        extra = sorted(have - set(files))
        if stale or extra:
            print(
                f"公開射束資料不是最新的：要重產 {stale}，多出來的 {extra}（python3 scripts/build-public-beam-data.py）"
            )
            return 1
        print(f"公開射束資料是最新的（{len(datasets)} 份）")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*"):
        if old.name not in files:
            old.unlink()
    for name, text in files.items():
        (OUT / name).write_text(text, encoding="utf-8")
    print(f"寫了 {len(datasets)} 份資料集到 {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
