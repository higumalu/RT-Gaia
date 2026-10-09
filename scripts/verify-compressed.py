#!/usr/bin/env python3
"""壓縮影像的端到端驗收：真的起一個後端、真的經 HTTP。

  1. 在暫存目錄做一個資料庫：同一個 64×64×3 CT 存三份 —— JPEG 2000 Lossless、RLE Lossless、JPEG Lossless（Process 14，
     沒有解碼器；像素是假的封裝碼流）
  2. 起 `rtgaia-testbe --library <暫存>`（auth off、沒有 DB、隨機 port）
  3. `GET /library/series`：三個序列都有 `transfer_syntax`；J2K／RLE `decodable: true`，
     JPEG Lossless `false` ＋ `decode_error`
  4. `POST /sessions` 開 J2K 與 RLE 的序列 → 影像 lod 0 的體素與未壓縮的原始值一模一樣
  5. 開 JPEG Lossless 的序列 → 失敗，錯誤訊息講明是哪種壓縮沒有解碼器（英文模式也是英文）
  6. 經 HTTP 上傳一批 JPEG Lossless（新的 series UID）→ 照樣收下（原樣存），批次的 `undecodable` 列出它與原因

用法：uv run --no-sync python scripts/verify-compressed.py
退出碼：任一步失敗 → 1。
"""

from __future__ import annotations

import copy
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import numpy as np
import pydicom
from pydicom.encaps import encapsulate
from pydicom.uid import JPEG2000Lossless, JPEGLosslessSV1, RLELossless, generate_uid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/rtgaia-testbe/tests"))
from synth_dicom import write_synth_case  # noqa: E402


def step(msg: str) -> None:
    print(f"✓ {msg}")


def make_library(root: Path) -> dict[str, tuple[str, np.ndarray]]:
    synth = write_synth_case(root / "_synth")
    template = pydicom.dcmread(sorted(synth.plan_ct.directory.glob("CT.*.dcm"))[0])
    jj, ii = np.meshgrid(np.arange(64), np.arange(64), indexing="ij")
    out: dict[str, tuple[str, np.ndarray]] = {}
    for name, syntax in (("j2k", JPEG2000Lossless), ("rle", RLELossless), ("jpegll", JPEGLosslessSV1)):
        series_uid = generate_uid()
        d = root / name
        d.mkdir()
        hu = np.stack([((ii * 7 + jj * 13 + k * 101) % 2000) - 1000 for k in range(3)]).astype(np.int16)
        for k in range(3):
            ds = copy.deepcopy(template)
            ds.SeriesInstanceUID = series_uid
            ds.SeriesDescription = f"COMPRESSED {name.upper()}"
            ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
            ds.InstanceNumber = k + 1
            ds.Rows = ds.Columns = 64
            ds.ImagePositionPatient = [0.0, 0.0, float(k) * 2.0]
            ds.PixelData = (hu[k] + 1024).astype(np.uint16).tobytes()
            if syntax == JPEGLosslessSV1:
                ds.file_meta.TransferSyntaxUID = syntax
                ds.PixelData = encapsulate([b"\xff\xd8\xff\xc3" + b"\x00" * 16 + b"\xff\xd9"])
                ds["PixelData"].VR = "OB"
            else:
                ds.compress(syntax)
            ds.save_as(d / f"CT.{k:03d}.dcm", enforce_file_format=True)
        out[name] = (series_uid, hu)
    # 合成病例的其他東西不要（只留三個壓縮序列）
    import shutil

    shutil.rmtree(root / "_synth")
    return out


def walk_series(node: object) -> list[dict]:
    """`/library/series` 回的是 patient → study → series 的樹；把所有序列攤平。"""
    out: list[dict] = []
    if isinstance(node, dict):
        if "series_instance_uid" in node and "modality" in node:
            out.append(node)
        for v in node.values():
            out.extend(walk_series(v))
    elif isinstance(node, list):
        for v in node:
            out.extend(walk_series(v))
    return out


def selection(uid: str) -> dict:
    return {
        "primary_series_uid": uid,
        "image_series_uids": [uid],
        "structure_set_uids": [],
        "dose_uids": [],
        "registration_uids": [],
    }


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="rtgaia-compressed-") as tmp:
        lib = Path(tmp) / "library"
        lib.mkdir()
        series = make_library(lib)
        step(f"暫存資料庫：{', '.join(f'{k}={v[0][-8:]}' for k, v in series.items())}")
        port = free_port()
        env = {
            **os.environ,
            "RTGAIA_AUTH": "off",
            "RTGAIA_DB_URL": "",
            "RTGAIA_DATA_DIR": str(Path(tmp) / "data"),
            "RTGAIA_SCP": "0",
            "RTGAIA_PLUGIN_TICK_SECONDS": "0",
        }
        proc = subprocess.Popen(
            [
                str(ROOT / ".venv/bin/rtgaia-testbe"),
                "--port",
                str(port),
                "--host",
                "127.0.0.1",
                "--library",
                str(lib),
                "--test-api",
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        try:
            base = f"http://127.0.0.1:{port}"
            # 後端沒說語言時回英文；這支的斷言是中文原文，所以預設要繁中（英文模式的檢查自己帶 en）
            client = httpx.Client(
                base_url=base, timeout=120, headers={"X-RTGaia-User": "qa", "Accept-Language": "zh-TW"}
            )
            for _ in range(120):
                try:
                    if client.get("/healthz").status_code == 200:
                        break
                except httpx.HTTPError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("後端沒起來")

            rows = {s["series_instance_uid"]: s for s in walk_series(client.get("/api/v1/library/series").json())}
            for name, (uid, _) in series.items():
                r = rows[uid]
                if not r.get("transfer_syntax"):
                    raise AssertionError(f"{name} 沒有 transfer_syntax：{r}")
                want = name != "jpegll"
                if r.get("decodable") is not want:
                    raise AssertionError(f"{name} decodable 應是 {want}：{r}")
            bad = rows[series["jpegll"][0]]
            if "沒有可用的解碼器" not in (bad.get("decode_error") or ""):
                raise AssertionError(f"JPEG Lossless 要有原因：{bad}")
            step(f"資料庫清單：J2K／RLE 可解碼；JPEG Lossless 標「無法解碼」（{bad['transfer_syntax']}）")

            from rtgaia_testbe import Session

            for name in ("j2k", "rle"):
                uid, hu = series[name]
                s = Session(base_url=base, user="qa")
                s.load_case(selection(uid))
                _, vol = s.image(uid, lod=0)
                if vol.shape != hu.shape or not np.array_equal(vol, hu):
                    raise AssertionError(f"{name} 體素與原始值不同：shape {vol.shape} vs {hu.shape}")
                step(f"{name.upper()} 序列開得起來，lod 0 體素與未壓縮的一模一樣（{vol.shape}）")

            uid = series["jpegll"][0]
            body = selection(uid)
            r = client.post("/api/v1/sessions", json=body)
            if r.status_code < 400 or "沒有可用的解碼器" not in r.text:
                raise AssertionError(f"JPEG Lossless 應開不起來且說明原因：{r.status_code} {r.text[:300]}")
            r_en = client.post("/api/v1/sessions", json=body, headers={"Accept-Language": "en"})
            if "No decoder is available" not in r_en.text:
                raise AssertionError(f"英文模式的原因應是英文：{r_en.text[:300]}")
            step(f"JPEG Lossless 開不起來（HTTP {r.status_code}），原因講明壓縮格式；英文模式也是英文")

            # 6：上傳路徑也要告訴使用者（先不支援解碼，但要把例外講清楚）
            s = Session(base_url=base, user="qa")
            batch = s.import_open({"note": "undecodable"})
            new_uid = generate_uid()
            for f in sorted((lib / "jpegll").glob("CT.*.dcm")):
                ds = pydicom.dcmread(f)
                ds.SeriesInstanceUID = new_uid
                ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
                buf = __import__("io").BytesIO()
                ds.save_as(buf, enforce_file_format=True)
                s.import_put(batch["batch_id"], f"up/{f.name}", buf.getvalue())
            s.import_complete(batch["batch_id"])
            for _ in range(120):
                got = s.import_get(batch["batch_id"])
                if got["status"] in ("done", "failed"):
                    break
                time.sleep(0.25)
            und = got.get("undecodable") or []
            if got["status"] != "done" or [u["series_instance_uid"] for u in und] != [new_uid]:
                raise AssertionError(f"上傳批次應完成並列出無法解碼的序列：{got['status']} {und}")
            if got["counts"].get("accepted") != 3:
                raise AssertionError(f"檔案應照樣收下：{got['counts']}")
            en = client.get(f"/api/v1/import/batches/{batch['batch_id']}", headers={"Accept-Language": "en"}).json()
            if "No decoder is available" not in (en.get("undecodable") or [{}])[0].get("reason", ""):
                raise AssertionError(f"英文模式的原因應是英文：{en.get('undecodable')}")
            step("上傳 JPEG Lossless：3 檔照樣收下，批次列出無法解碼的序列與原因（英文模式也是英文）")
        finally:
            proc.terminate()
            proc.wait(timeout=20)
    print("全部通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
