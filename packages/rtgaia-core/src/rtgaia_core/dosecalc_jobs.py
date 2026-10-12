"""劑量計算工作：從病例準備計算封包 → `dosecalc` job → 引擎子行程 → 結果載回成暫存劑量。

* **準備**（API 行程，`prepare`）：讀 RTPLAN（`rtgaia_dosecalc.from_rtplan`，不支援的拒算並列原因）；
  CT 要是計畫那個空間的 CT；CT 校正曲線依機型與 kVp 對（對不到用內建的通用曲線並標出）；射束模型依能量與模式挑；
  劑量網格預設用 TPS 劑量的網格（病例裡有引用這份計畫、同一個空間的劑量時），沒有就照 CT 的範圍 2.5 mm。
  封包寫到 `RTGAIA_DATA_DIR/dosecalc/<job>/in`。
* **執行**（worker，`run_dosecalc`）：`python -m rtgaia_dosecalc run` 子行程；每秒讀 `progress.json` 寫回工作進度並推
  `job.progress`；工作在別處結束（取消）就把子行程殺掉。結果留在 `…/<job>/out`（worker 與 API 要共用資料目錄）。
* **載回**（API，`routes_dosecalc`）：結果 → 暫存劑量（只有發起的人看得到，跟劑量運算的暫存結果同一套），
  逐射束的另外各一個、預設隱藏；衍生資訊寫引擎、CT 曲線、射束模型、不確定度摘要 —— 存成 RTDOSE 時進
  `DerivationDescription`。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

import numpy as np
from rtgaia_dosecalc import beam_models, engines
from rtgaia_dosecalc import ct_calibration as cc
from rtgaia_dosecalc.from_rtplan import read_delivery
from rtgaia_dosecalc.package import CalcInput, CalcResult, read_progress
from rtgaia_geom import Grid

from .blobs import blob_root

DEFAULT_SPACING_MM = 2.5
MAX_DOSE_VOXELS = 16_000_000
PROGRESS_EVERY_SECONDS = 1.0


class PrepareError(ValueError):
    def __init__(self, code: str, problems: list[str]) -> None:
        super().__init__("；".join(problems))
        self.code = code
        self.problems = problems


def work_root() -> Path:
    return blob_root().parent / "dosecalc"


def engine_choice(requested: str | None) -> str:
    avail = {e["name"]: e for e in engines.available()}
    name = requested or engines.GEANT4
    e = avail.get(name)
    if e is None:
        raise PrepareError("NO_ENGINE", [f"沒有引擎 {name}"])
    if not e.get("ready"):
        raise PrepareError("ENGINE_NOT_READY", [str(e.get("reason") or f"引擎 {name} 不能用")])
    return name


def plan_entry(session: Any, plan_sop_uid: str) -> dict[str, Any]:
    p = next((x for x in session.dataset.plans if str(x.get("sop_instance_uid") or "") == plan_sop_uid), None)
    if p is None:
        raise PrepareError("NO_PLAN", ["病例裡沒有這份計畫"])
    return p


def prepare(
    session: Any,
    *,
    plan_sop_uid: str,
    engine: str,
    calibrations: list[dict[str, Any]],
    options: dict[str, Any],
) -> tuple[CalcInput, dict[str, Any]]:
    """回 `(封包, 摘要)`；不能算 → `PrepareError`（列出全部原因）。"""
    plan = plan_entry(session, plan_sop_uid)
    delivery, problems = read_delivery(plan["path"])
    if delivery is None:
        raise PrepareError("PLAN_NOT_SUPPORTED", problems)
    for_uid = str(plan.get("frame_of_reference_uid") or "")
    ct = next(
        (
            s
            for s in session.dataset.image_series
            if s.frame_of_reference_uid == for_uid and str(s.modality).upper() == "CT"
        ),
        None,
    )
    if ct is None:
        raise PrepareError("NO_CT", ["病例裡沒有這份計畫所在空間的 CT（劑量要在計畫 CT 上算）"])
    scanner = cc.scanner_of(ct.source_path or None)
    resolved = cc.resolve(calibrations, scanner)
    models = []
    for b in delivery.beams:
        m, why = beam_models.model_for(b.energy_mv, b.fluence_mode, options.get("beam_model_id"))
        if m is None:
            problems.append(f"{b.name}：{why}")
        else:
            models.append(m)
    if problems:
        raise PrepareError("NO_BEAM_MODEL", problems)
    if len({m["model_id"] for m in models}) > 1:
        raise PrepareError("MIXED_BEAMS", ["計畫裡的射束要用不同的射束模型：v1 一次只算一個模型"])
    model = models[0]
    tps = next(
        (
            s
            for s in session.dataset.series
            if s.kind == "dose"
            and not isinstance((s.params or {}).get("derived"), dict)
            and plan_sop_uid in [str(u) for u in (s.params or {}).get("referenced_plan_sop_uids") or []]
            and s.frame_of_reference_uid == for_uid
            and str((s.params or {}).get("summation_type") or "").upper() in ("PLAN", "")
        ),
        None,
    )
    dose_grid = tps.grid if tps is not None and options.get("grid", "tps") == "tps" else ct_extent_grid(ct.grid)
    if dose_grid.voxel_count > MAX_DOSE_VOXELS:
        raise PrepareError("GRID_TOO_LARGE", [f"劑量網格太大（{dose_grid.voxel_count:,} 個體素）"])
    hu = np.asarray(ct.image(ct.grid, 0), dtype=np.float32)
    inp = CalcInput(
        engine=engine,
        delivery=delivery,
        ct_hu=hu,
        ct_grid=ct.grid,
        dose_grid=dose_grid,
        calibration=resolved["calibration"],
        beam_model=model,
        options={k: v for k, v in options.items() if k in ("histories", "seed", "workers", "target_uncertainty")},
        meta={"plan_sop_uid": plan_sop_uid, "ct_series_id": ct.series_id},
    )
    summary = {
        "plan_sop_uid": plan_sop_uid,
        "plan_label": delivery.plan_label,
        "beams": [
            {"number": b.number, "name": b.name, "mu": b.mu, "control_points": len(b.control_points)}
            for b in delivery.beams
        ],
        "fractions": delivery.fractions,
        "total_mu": delivery.total_mu,
        "ct_series_id": ct.series_id,
        "scanner": scanner,
        "calibration": cc.summary(resolved["calibration"]),
        "calibration_fallback": resolved["fallback"],
        "calibration_reason": resolved["reason"],
        "beam_model": {k: model[k] for k in ("model_id", "name", "demo", "energy_mv", "fluence_mode")},
        "dose_grid": "tps" if tps is not None and options.get("grid", "tps") == "tps" else "ct",
        "dose_grid_voxels": dose_grid.voxel_count,
        "tps_dose_series_id": tps.series_id if tps is not None else None,
        "engine": engine,
    }
    return inp, summary


def ct_extent_grid(ct: Grid, spacing: float = DEFAULT_SPACING_MM) -> Grid:
    """跟 CT 同方向、包住整個 CT 的網格；間距 `spacing`（太大就放寬到 5 mm）。"""
    extent = (np.asarray(ct.size, dtype=np.float64) - 1) * np.asarray(ct.spacing, dtype=np.float64)
    for s in (spacing, 3.0, 4.0, 5.0):
        size = tuple(int(np.floor(e / s + 1e-6)) + 1 for e in extent)
        if int(np.prod(size)) <= MAX_DOSE_VOXELS:
            break
    return Grid(
        size=size,
        spacing=(s,) * 3,
        origin=ct.origin,
        direction=ct.direction,
        frame_of_reference_uid=ct.frame_of_reference_uid,
    )  # type: ignore[arg-type]


# ── 執行（worker）──────────────────────────────────────────────────────────────


async def run_dosecalc(app: Any, job: Any) -> None:
    from .jobs import TERMINAL

    work = Path(job.request["work_dir"])
    out = work / "out"
    if out.exists():
        shutil.rmtree(out)  # 重試：上一次的半成品不留
    env = dict(os.environ)
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "rtgaia_dosecalc", "run", "--input", str(work / "in"), "--output", str(out),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, env=env,
    )  # fmt: skip
    last: tuple[str, float] | None = None
    queue = await app.job_queue_async()
    try:
        while True:
            try:
                await asyncio.wait_for(proc.wait(), timeout=PROGRESS_EVERY_SECONDS)
                break
            except TimeoutError:
                pass
            fresh = await queue.get(job.job_id)
            if fresh is not None and fresh.status in TERMINAL:
                proc.kill()  # 取消了（或在別處結束）
                await proc.wait()
                return
            p = read_progress(out)
            if p is not None and (p.get("phase"), p.get("percent")) != last:
                last = (str(p.get("phase")), float(p.get("percent") or 0))
                job.phase, job.percent = f"calculating:{last[0]}", int(min(99, last[1]))

                def progress(f: Any, phase: str = job.phase, percent: int = job.percent) -> bool:
                    if f.status in TERMINAL:
                        return False
                    f.phase, f.percent = phase, percent
                    return True

                await app.mutate_job(job.job_id, progress)
                await app.notify_case(
                    job.case_id, "job.progress", {"jobId": job.job_id, "phase": job.phase, "percent": job.percent}
                )
    except asyncio.CancelledError:
        proc.kill()
        raise
    stderr = (await proc.stderr.read()).decode("utf-8", "replace")[-2000:] if proc.stderr else ""
    if proc.returncode != 0:
        err = out / "error.json"
        message = (
            json.loads(err.read_text(encoding="utf-8")).get("message")
            if err.exists()
            else stderr or f"exit {proc.returncode}"
        )
        raise RuntimeError(f"劑量計算失敗：{message}")
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    job.result = {
        **job.result,
        "dosecalc": {
            k: result.get(k)
            for k in ("engine", "engine_version", "seconds", "histories", "beams", "uncertainty", "notes")
        },
    }


# ── 載回 ──────────────────────────────────────────────────────────────────────


def read_result(job: Any) -> CalcResult:
    return CalcResult.read(Path(job.request["work_dir"]) / "out")


def uncertainty_summary(dose: np.ndarray, unc: np.ndarray) -> dict[str, Any]:
    """不確定度摘要：劑量 ≥ 50% 最大值的體素裡的平均與最大（臨床上看的是高劑量區）。"""
    finite = np.isfinite(dose) & np.isfinite(unc)
    if not finite.any() or float(np.nanmax(dose)) <= 0:
        return {"mean_rel_50": None, "max_rel_50": None}
    hi = finite & (dose >= 0.5 * float(np.nanmax(dose)))
    u = unc[hi]
    return {"mean_rel_50": float(u.mean()) if u.size else None, "max_rel_50": float(u.max()) if u.size else None}
