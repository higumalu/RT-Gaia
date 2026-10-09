#!/usr/bin/env python3
"""CI 的效能門檻：效能預算裡**後端那一半**，Tier C 那一欄。

前端的純計算（重切、LUT、輪廓）在 `apps/viewer/tests/perf/budget.perf.ts`（`npm run test:perf`）；這裡量要經過後端的：

| 項目 | 預算（Tier C） | 怎麼量 |
|---|---|---|
| 首張畫面可見（lod 2） | < 4 s | `POST /sessions` 開始 → lod 2 影像回來（冷：DICOM 第一次讀、沒有體素快取） |
| 全解析度常駐（lod 0） | < 10 s | 同一個起點 → lod 0 影像回來 |
| 單結構後處理往返 | < 1.5 s | 一個 40 × 40 × 16 體素的結構做 `smooth`（3 次中位數） |

影像是合成的 512 × 512 × 160 CT（synth4d 的胸腔體模，0.98 × 0.98 × 2.5 mm），每次重產、
資料目錄是全新的暫存目錄（量的是冷的情況）。
後端在同一個行程（`rtgaia_testbe.Session` 的 TestClient）—— 沒有網路，跟瀏覽器量的不完全一樣，但能抓到後端的回歸。

  uv run python scripts/perf/ci_gate.py [--slack 1.5]       # 超過預算 × slack → 退出碼 1；結果表印在最後
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

BUDGETS_S = {
    "首張畫面可見（lod 2）": 4.0,
    "全解析度常駐（lod 0）": 10.0,
    "單結構後處理往返（smooth）": 1.5,
}


def _write_ct(root: Path) -> str:
    from rtgaia_testbe.fixtures import synth4d

    geom = synth4d.Geom(size=(512, 512, 160), spacing=(0.98, 0.98, 2.5), origin=(-250.0, -250.0, -200.0))
    case = synth4d.Case(
        case_id="perfgate",
        title="CI 效能門檻",
        modality="CT",
        pattern="static",
        source=["scripts/perf/ci_gate.py"],
        root=root,
    )
    written = synth4d._write_ct_series(
        case,
        key="ct",
        number=1,
        description="perf gate CT",
        for_uid=synth4d.uid("for", "perfgate"),
        values=synth4d._phase_volume(0.0, geom),
        image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
        geom=geom,
        role="ct",
    )
    return written.series_uid


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--slack", type=float, default=float(os.environ.get("RTGAIA_PERF_SLACK", "1") or 1))
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="rtgaia-perfgate-") as tmp:
        lib = Path(tmp) / "lib"
        t = time.perf_counter()
        uid = _write_ct(lib)
        print(f"合成 CT 512×512×160：{time.perf_counter() - t:.1f} s", flush=True)
        os.environ["RTGAIA_DATA_DIR"] = str(Path(tmp) / "data")
        os.environ.pop("RTGAIA_LIBRARY_ROOT", None)
        from rtgaia_testbe import Session

        measured: dict[str, float] = {}
        with Session(library_root=str(lib), user="perf") as s:
            t0 = time.perf_counter()
            s.load_case({"image_series_uids": [uid]}, webgl2=False, tier="C")
            _h, lod2 = s.image(uid, lod=2)
            measured["首張畫面可見（lod 2）"] = time.perf_counter() - t0
            _h, lod0 = s.image(uid, lod=0)
            measured["全解析度常駐（lod 0）"] = time.perf_counter() - t0
            assert lod0.size > lod2.size > 0
            st = s.create_structure("PerfBlob")["structure_id"]
            zz, yy, xx = np.mgrid[0:16, 0:40, 0:40]
            blob = (((xx - 20) / 18.0) ** 2 + ((yy - 20) / 18.0) ** 2 + ((zz - 8) / 7.0) ** 2 <= 1).astype(np.uint8)
            s.edit(st, offset_ijk=(236, 236, 72), array=blob)
            runs = []
            for _ in range(3):
                t1 = time.perf_counter()
                s.postprocess(st, "smooth")
                runs.append(time.perf_counter() - t1)
            measured["單結構後處理往返（smooth）"] = statistics.median(runs)
    failed = []
    print(f"\n效能門檻（後端、Tier C；slack × {args.slack:g}）")
    for item, budget in BUDGETS_S.items():
        got = measured[item]
        ok = got < budget * args.slack
        if not ok:
            failed.append(item)
        print(f"  {'✓' if ok else '✗'} {item:<24} {got:6.2f} s   預算 {budget:g} s")
    if failed:
        print(f"超過預算：{'、'.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
