"""擬合出來的射束模型：存放、啟用、擬合工作（`beamfit` job）。

* **存放**：`app_setting` 的 `beam_models` 一筆，`items` 是 `{model, status, machines, fit, checks, job_id, …}`；
  `status` 是 `draft`（擬合完）→ `active`（admin 啟用；同能量、模式、MLC 與機器名稱的舊模型自動停用）→ `retired`。
  啟用過的不能刪、不能改（舊的劑量結果要說得出用了哪一版）。
* **擬合工作**（worker，`run_beamfit`）：`python -m rtgaia_dosecalc fit-model` 子行程（GPU），先驗模型與資料集寫成
  JSON 檔；讀 `progress.json` 寫回工作進度；完成 → 一筆草稿模型（擬合報告、對擬合與驗證資料集的逐點比對）。
  只能用內建或**已鎖定**的資料集（模型要說得出擬合自哪些固定的資料）。
* 劑量計算挑模型時（`dosecalc_jobs.prepare`）把這裡的模型一起交給 `beam_models.model_for`。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rtgaia_dosecalc import beam_data as bd
from rtgaia_dosecalc import beam_models

from .dosecalc_jobs import PROGRESS_EVERY_SECONDS, PrepareError, work_root

SETTINGS_KEY = "beam_models"
KIND = "beamfit"
STATUSES = ("draft", "active", "retired")
HISTORY_CHOICES = (250_000_000, 500_000_000, 1_000_000_000)
DEFAULT_HISTORIES = 500_000_000
MAX_DATASETS = 10


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


async def items(app: Any) -> list[dict[str, Any]]:
    doc = await (await app.settings_store_async()).get(SETTINGS_KEY)
    return list((doc or {}).get("items") or [])


async def save(app: Any, rows: list[dict[str, Any]], user: str) -> None:
    await (await app.settings_store_async()).put(SETTINGS_KEY, {"items": rows}, updated_by=user)


def find(rows: list[dict[str, Any]], model_id: str) -> dict[str, Any] | None:
    return next((r for r in rows if r["model"]["model_id"] == model_id), None)


def summary(rec: dict[str, Any]) -> dict[str, Any]:
    """清單用：模型的識別、狀態、擬合的資料集與比對結果的摘要（不帶逐點的比對）。"""
    m = rec["model"]
    return {
        "model_id": m["model_id"],
        "name": m["name"],
        "demo": bool(m.get("demo")),
        "energy_mv": m["energy_mv"],
        "fluence_mode": m["fluence_mode"],
        "mlc_devices": list(m.get("mlc_devices") or []),
        "mlc_family": m.get("mlc_family"),
        "status": rec["status"],
        "machines": list(rec.get("machines") or []),
        "fit": m.get("fit"),
        "checks": [
            {"dataset_id": c.get("dataset_id"), "role": c.get("role"), **(c.get("summary") or {})}
            for c in rec.get("checks") or []
        ],
        **{
            k: rec.get(k)
            for k in ("job_id", "created_by", "created_at", "activated_by", "activated_at", "retired_by", "retired_at")
        },
    }


def _match_key(rec: dict[str, Any]) -> tuple[Any, ...]:
    m = rec["model"]
    return (
        float(m["energy_mv"]),
        m["fluence_mode"],
        tuple(m.get("mlc_devices") or []),
        m.get("mlc_family") or "",
        tuple(sorted(str(x).strip().lower() for x in rec.get("machines") or [])),
    )


def activate(rows: list[dict[str, Any]], model_id: str, *, user: str) -> list[str]:
    """啟用一個草稿；能量、模式、MLC（裝置與種類）與機器名稱都一樣的其他啟用中模型改成停用（回傳被停用的 id）。"""
    target = find(rows, model_id)
    assert target is not None
    now = _now()
    retired = []
    for r in rows:
        if r is not target and r["status"] == "active" and _match_key(r) == _match_key(target):
            r.update(status="retired", retired_by=user, retired_at=now)
            retired.append(r["model"]["model_id"])
    target.update(status="active", activated_by=user, activated_at=now)
    return retired


# ── 擬合工作 ──────────────────────────────────────────────────────────────────


def _dataset(ref: str, user_sets: list[dict[str, Any]]) -> dict[str, Any]:
    builtin = {d["dataset_id"]: d for d in bd.builtin_datasets()}
    if ref in builtin:
        return builtin[ref]
    ds = next((d for d in user_sets if d["dataset_id"] == ref), None)
    if ds is None:
        raise PrepareError("NO_BEAM_DATA", [f"沒有射束資料 {ref}"])
    if ds["status"] != "locked":
        raise PrepareError("BEAM_DATA_NOT_LOCKED", [f"射束資料 {ds['name']} 還沒鎖定：擬合只用內建或已鎖定的資料"])
    return ds


def prepare_fit(body: dict[str, Any], user_sets: list[dict[str, Any]], models: list[dict[str, Any]]) -> dict[str, Any]:
    """請求 → 工作的 request（還沒有工作目錄）。不能做 → `PrepareError`。"""
    problems: list[str] = []
    prior_id = str(body.get("prior_model_id") or "")
    builtin = {m["model_id"]: m for m in beam_models.builtin_models()}
    prior = builtin.get(prior_id) or (find(models, prior_id) or {}).get("model")
    if prior is None:
        raise PrepareError("NO_BEAM_MODEL", [f"沒有射束模型 {prior_id or '?'}"])
    fit_ids = [str(x) for x in body.get("fit_datasets") or []]
    val_ids = [str(x) for x in body.get("validate_datasets") or []]
    if not fit_ids:
        problems.append("至少要一份擬合用的射束資料")
    if len(fit_ids) + len(val_ids) > MAX_DATASETS:
        problems.append(f"射束資料最多 {MAX_DATASETS} 份")
    if set(fit_ids) & set(val_ids):
        problems.append("同一份資料不能同時用來擬合與驗證")
    histories = body.get("histories", DEFAULT_HISTORIES)
    if histories not in HISTORY_CHOICES:
        problems.append(f"histories 要是 {'、'.join(f'{h:.0e}' for h in HISTORY_CHOICES)}")
    machines = [str(x).strip() for x in body.get("machines") or [] if str(x).strip()][:20]
    if problems:
        raise PrepareError("BAD_FIT_REQUEST", problems)
    fit_sets = [_dataset(r, user_sets) for r in fit_ids]
    val_sets = [_dataset(r, user_sets) for r in val_ids]
    for ds in [*fit_sets, *val_sets]:
        b = ds["beam"]
        if abs(float(b["energy_mv"]) - float(prior["energy_mv"])) > 0.01 or b["fluence_mode"] != prior["fluence_mode"]:
            problems.append(
                f"射束資料 {ds['name']} 是 {b['energy_mv']:g} MV {b['fluence_mode']}，模型是 "
                f"{prior['energy_mv']:g} MV {prior['fluence_mode']}"
            )
    if problems:
        raise PrepareError("BEAM_MISMATCH", problems)
    name = str(body.get("name") or "").strip()[:120] or f"{prior['name']} (fitted)"
    return {
        "prior": prior,
        "fit_datasets": fit_sets,
        "validate_datasets": val_sets,
        "histories": int(histories),
        "machines": machines,
        "name": name,
        "model_id": f"fit_{uuid.uuid4().hex[:10]}",
    }


def write_inputs(work: Path, spec: dict[str, Any]) -> dict[str, Any]:
    """先驗模型與資料集 → 工作目錄的 JSON 檔；回存進 job.request 的摘要（不帶整份資料）。"""
    inp = work / "in"
    inp.mkdir(parents=True, exist_ok=True)
    (inp / "prior.json").write_text(json.dumps(spec["prior"], ensure_ascii=False), encoding="utf-8")
    paths = {}
    for role in ("fit_datasets", "validate_datasets"):
        paths[role] = []
        for ds in spec[role]:
            f = inp / f"{ds['dataset_id']}.json"
            f.write_text(json.dumps(ds, ensure_ascii=False), encoding="utf-8")
            paths[role].append(str(f))
    return {
        "work_dir": str(work),
        "prior_model_id": spec["prior"]["model_id"],
        "fit_datasets": [d["dataset_id"] for d in spec["fit_datasets"]],
        "validate_datasets": [d["dataset_id"] for d in spec["validate_datasets"]],
        "histories": spec["histories"],
        "machines": spec["machines"],
        "name": spec["name"],
        "model_id": spec["model_id"],
        "paths": paths,
    }


def fit_command(req: dict[str, Any], out: Path) -> list[str]:
    """擬合子行程的命令列（`rtgaia-dosecalc fit-model`）。"""
    work = Path(req["work_dir"])
    args = [
        sys.executable, "-m", "rtgaia_dosecalc", "fit-model", "--model-json", str(work / "in" / "prior.json"),
        "--fit", *req["paths"]["fit_datasets"],
    ]  # fmt: skip
    if req["paths"]["validate_datasets"]:
        args += ["--validate", *req["paths"]["validate_datasets"]]
    return args + [
        "--data-dir", str(work_root()), "--histories", str(req["histories"]), "--model-id", req["model_id"],
        "--output", str(out),
    ]  # fmt: skip


async def run_beamfit(app: Any, job: Any) -> None:
    from .jobs import TERMINAL

    req = job.request
    work = Path(req["work_dir"])
    out = work / "out"
    if out.exists():
        shutil.rmtree(out)
    args = fit_command(req, out)
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, env=dict(os.environ)
    )
    queue = await app.job_queue_async()
    last: tuple[str, str] | None = None
    try:
        while True:
            try:
                await asyncio.wait_for(proc.wait(), timeout=PROGRESS_EVERY_SECONDS * 5)
                break
            except TimeoutError:
                pass
            fresh = await queue.get(job.job_id)
            if fresh is not None and fresh.status in TERMINAL:
                proc.kill()
                await proc.wait()
                return
            try:
                p = json.loads((out / "progress.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            key = (str(p.get("phase")), str(p.get("message") or ""))
            if key != last:
                last = key
                percent = 95 if key[0] == "checking" else (5 if key[0] == "fitting" else int(p.get("percent") or 0))

                def progress(f: Any, phase: str = f"{key[0]}:{key[1]}"[:120], pct: int = percent) -> bool:
                    if f.status in TERMINAL:
                        return False
                    f.phase, f.percent = phase, pct
                    return True

                await app.mutate_job(job.job_id, progress)
    except asyncio.CancelledError:
        proc.kill()
        raise
    stderr = (await proc.stderr.read()).decode("utf-8", "replace")[-2000:] if proc.stderr else ""
    if proc.returncode != 0:
        err = out / "error.json"
        message = json.loads(err.read_text(encoding="utf-8")).get("message") if err.exists() else stderr
        raise RuntimeError(f"射束模型擬合失敗：{message or f'exit {proc.returncode}'}")
    model = json.loads((out / "model.json").read_text(encoding="utf-8"))
    fit = json.loads((out / "fit.json").read_text(encoding="utf-8"))
    checks = json.loads((out / "checks.json").read_text(encoding="utf-8"))
    model["name"] = req["name"]
    rec = {
        "model": model,
        "status": "draft",
        "machines": req["machines"],
        "fit": fit,
        "checks": checks,
        "job_id": job.job_id,
        "created_by": job.requested_by,
        "created_at": _now(),
        "activated_by": None,
        "activated_at": None,
        "retired_by": None,
        "retired_at": None,
    }
    async with LOCK:
        rows = await items(app)
        rows.append(rec)
        await save(app, rows, job.requested_by)
    job.result = {**job.result, "beamfit": {"model_id": model["model_id"], "checks": summary(rec)["checks"]}}


LOCK = asyncio.Lock()
"""同一個行程裡 `beam_models` 的讀改寫用它串起來（API 的啟用與 worker 的新增）。"""
