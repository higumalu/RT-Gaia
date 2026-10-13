"""GPU Monte Carlo 的物理資料表：Schneider 25 段材質（＋水、鎢）× 對數能量格子的截面與阻擋本領。

由 `g4tables/g4tables.cc` 在 OpenTOPAS 的官方映像裡產生（同一版 Geant4、同一套 G4EMLOW、同一個物理列表
G4EmStandardPhysics_option4 —— 跟參考引擎 OpenTOPAS 一樣），快取在資料目錄。表是「參考密度」下的每單位長度值；
體素的值 ＝ 表值 × 體素密度 ／ 參考密度（光子截面完全成立；阻擋本領的密度效應用參考密度的，
跟 TOPAS 的可變密度材質同一種近似）。
參考密度取每一段 HU 中點在 Schneider 曲線上的密度。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..ct_calibration import _SCHNEIDER_MATERIAL_BOUNDS, _SCHNEIDER_WEIGHTS, ELEMENTS, builtin_calibration, convert

SOURCE_DIR = Path(__file__).parent / "g4tables"
TABLES_VERSION = 3
"""表的內容或格式改了就加一（快取鍵的一部分）。"""
TUNGSTEN_DENSITY = 19.3
"""g/cm³：jaw 與 MLC 的鎢（Geant4 G4_W 的密度）。"""
DELTA_CUT_MEV = 0.1
"""δ 射線（Møller／Bhabha）的門檻：以上當離散事件、以下算進受限阻擋本領。"""
BREM_CUT_MEV = 0.05
"""制動輻射光子的門檻。"""
GRID = (0.001, 25.0, 400)
"""能量格子（MeV）：最低、最高、點數（對數等距）。"""
QUANTITIES = (
    "phot", "compt", "conv", "se", "moller", "brem_e", "tr_e", "sp", "bhabha", "brem_p", "tr_p",
    "eh_e", "xc_e", "a_e", "trs_e", "eh_p", "xc_p", "a_p", "trs_p", "zeff", "bohr",
)  # fmt: skip
"""kernel 的表順序（`transport.cu` 的 Q_*）。後面是混合式彈性散射的衍生量（`elastic`）與
能量損失漲落的係數 `bohr` ＝ 2π r_e² mc² n_e（MeV²／mm 每 MeV 的門檻，參考密度）。"""
C1 = 0.05
"""大角度彈性碰撞的平均自由程至少是 λ1 的這個比例（PENELOPE 的 C1）：越小越準、越慢。"""
ATOMIC = {  # Z、原子量（g/mol）
    "H": (1, 1.008), "C": (6, 12.011), "N": (7, 14.007), "O": (8, 15.999), "Mg": (12, 24.305), "P": (15, 30.974),
    "S": (16, 32.06), "Cl": (17, 35.45), "Ar": (18, 39.948), "Ca": (20, 40.078), "Na": (11, 22.990), "K": (19, 39.098),
    "Ti": (22, 47.867),
}  # fmt: skip
ME_MEV = 0.51099895
RE_MM = 2.8179403262e-12
ALPHA = 1 / 137.035999
NA = 6.02214076e23
_COLUMNS = (
    "e", "phot", "compt", "conv", "rayl", "se", "se_total", "moller", "brem_e", "tr_e",
    "sp", "bhabha", "brem_p", "tr_p", "annihil",
)  # fmt: skip
G4_DATA_ENV = {
    "G4LEDATA": "G4EMLOW8.8", "G4ENSDFSTATEDATA": "G4ENSDFSTATE3.0", "G4PARTICLEXSDATA": "G4PARTICLEXS4.2",
    "G4LEVELGAMMADATA": "PhotonEvaporation6.1.2", "G4RADIOACTIVEDATA": "RadioactiveDecay6.1.2",
    "G4NEUTRONHPDATA": "G4NDL4.7.1", "G4SAIDXSDATA": "G4SAIDDATA2.0", "G4INCLDATA": "G4INCL1.3",
    "G4ABLADATA": "G4ABLA3.3", "G4PIIDATA": "G4PII1.3", "G4REALSURFACEDATA": "RealSurface2.2",
    "G4CHANNELINGDATA": "G4CHANNELING2.0",
}  # fmt: skip


@dataclass
class Tables:
    energies: np.ndarray
    """(ne,) MeV。"""
    values: np.ndarray
    """(len(QUANTITIES), nmat, ne) float32：截面 1/mm、阻擋本領 MeV/mm，在參考密度下。"""
    rho_ref: np.ndarray
    """(nmat,) g/cm³。"""
    se_total: np.ndarray
    """(nmat, ne) 電子的總阻擋本領（MeV/mm，驗證與射程用）。"""
    mu_tungsten: np.ndarray
    """(ne,) 鎢（19.3 g/cm³）的光子總衰減係數 1/mm（光電＋康普頓＋成對＋雷利）：準直器的穿透。"""
    info: dict[str, Any]

    @property
    def lne0(self) -> float:
        return float(np.log(self.energies[0]))

    @property
    def dlne(self) -> float:
        return float(np.log(self.energies[1] / self.energies[0]))


def reference_densities() -> list[float]:
    """每一段 HU 中點在內建 Schneider 曲線上的密度（g/cm³）；最後一段（鈦）用曲線在那一點的值。"""
    b = np.asarray(_SCHNEIDER_MATERIAL_BOUNDS, dtype=np.float64)
    centers = (b[:-1] + b[1:]) / 2
    return [float(v) for v in convert(builtin_calibration(), centers.astype(np.float32)).density]


WATER = 25
"""材質編號：Schneider 25 段（0–24）之後是水（G4_WATER 的組成，MU 校正的水箱跟 TOPAS 一樣用它）。"""


def materials() -> list[tuple[str, float, dict[str, float]]]:
    """(名稱, 參考密度 g/cm³, 元素質量分率)：Schneider 25 段 ＋ 水。"""
    out = []
    for i, (w, rho) in enumerate(zip(_SCHNEIDER_WEIGHTS, reference_densities(), strict=True)):
        out.append((f"s{i}", rho, {e: f for e, f in zip(ELEMENTS, w, strict=True) if f > 0}))
    out.append(("water", 1.0, {"H": 0.111894, "O": 0.888106}))
    return out


def material_lines() -> list[str]:
    out = []
    for name, rho, comp in materials():
        out.append(f"material {name} {rho:.6g} {len(comp)} " + " ".join(f"{e} {f:g}" for e, f in comp.items()))
    out.append(f"material w {TUNGSTEN_DENSITY} 1 W 1")  # 準直器
    return out


def tables_key(image: str) -> str:
    src = (SOURCE_DIR / "g4tables.cc").read_bytes()
    doc = {
        "version": TABLES_VERSION, "image": image, "cuts": [DELTA_CUT_MEV, BREM_CUT_MEV], "grid": GRID,
        "materials": material_lines(), "source": hashlib.sha256(src).hexdigest(),
    }  # fmt: skip
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest()[:16]


def _docker(image: str, g4data: Path, mounts: list[tuple[Path, str, str]], script: str, stdin: str | None) -> str:
    cmd = ["docker", "run", "--rm", "-i", "--user", f"{os.getuid()}:{os.getgid()}", "--entrypoint", "sh"]
    cmd += ["-v", f"{g4data}:/Applications/G4Data:ro"]
    for host, ctr, mode in mounts:
        cmd += ["-v", f"{host}:{ctr}:{mode}"]
    for k, v in G4_DATA_ENV.items():
        cmd += ["-e", f"{k}=/Applications/G4Data/{v}"]
    cmd += [image, "-c", script]
    proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=3600)
    if proc.returncode != 0:
        raise RuntimeError(f"g4tables 失敗（exit {proc.returncode}）：{(proc.stderr or proc.stdout)[-1500:]}")
    return proc.stdout


def parse(text: str) -> dict[str, np.ndarray]:
    """g4tables 的輸出 → {材質名稱: (ne, 欄數) 陣列}，另附 `__rho__`。"""
    out: dict[str, Any] = {}
    rho: dict[str, float] = {}
    cur: str | None = None
    rows: list[list[float]] = []
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "material" and len(parts) == 3:
            cur, rows = parts[1], []
            rho[cur] = float(parts[2])
        elif parts[0] == "end" and cur is not None:
            out[cur] = np.asarray(rows, dtype=np.float64)
            cur = None
        elif cur is not None:
            try:
                vals = [float(v) for v in parts]
            except ValueError:
                continue
            if len(vals) == len(_COLUMNS):
                rows.append(vals)
    out["__rho__"] = rho
    return out


def build(cache_dir: Path, *, image: str, g4data: Path) -> Tables:
    """有快取就讀；沒有就在容器裡編譯 g4tables、跑一次、存起來（約一分鐘）。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = tables_key(image)
    path = cache_dir / f"tables-{key}.npz"
    if not path.exists():
        bdir = cache_dir / f"g4tables-build-{key}"
        if bdir.exists():
            shutil.rmtree(bdir)
        bdir.mkdir(parents=True)
        lo, hi, n = GRID
        stdin = "\n".join([f"cuts {DELTA_CUT_MEV} {BREM_CUT_MEV}", f"grid {lo} {hi} {n}", *material_lines()]) + "\n"
        script = (
            "set -e; cd /work && cmake -DGeant4_DIR=/Applications/GEANT4/geant4-install/lib/cmake/Geant4 /src "
            "> cmake.log 2>&1 && make -j8 > make.log 2>&1 && ./g4tables"
        )
        text = _docker(image, g4data, [(SOURCE_DIR, "/src", "ro"), (bdir, "/work", "rw")], script, stdin)
        parsed = parse(text)
        names = [m[0] for m in materials()]
        missing = [m for m in [*names, "w"] if m not in parsed]
        if missing:
            raise RuntimeError(f"g4tables 少了材質 {missing}")
        arr = np.stack([parsed[m] for m in names])  # (nmat, ne, ncol)
        np.savez(
            path, table=arr, tungsten=parsed["w"],
            rho=np.asarray([parsed["__rho__"][m] for m in names]), columns=np.asarray(_COLUMNS),
            info=json.dumps({"image": image, "key": key, "cuts_mev": [DELTA_CUT_MEV, BREM_CUT_MEV], "grid": GRID}),
        )  # fmt: skip
        shutil.rmtree(bdir, ignore_errors=True)
    return load(path)


def _solve_a(ratio: np.ndarray) -> np.ndarray:
    """Wentzel 分佈的屏蔽參數 A：2A[(1+A) ln(1+1/A) − 1] ＝ ratio（每次碰撞的〈1 − cos θ〉），對數空間二分法。"""
    lo, hi = np.full(ratio.shape, -40.0), np.full(ratio.shape, 6.0)
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        a = np.exp(mid)
        f = 2 * a * ((1 + a) * np.log1p(1 / a) - 1)
        hi = np.where(f > ratio, mid, hi)
        lo = np.where(f > ratio, lo, mid)
    return np.exp(0.5 * (lo + hi))


def mott_factor(x: np.ndarray, beta: np.ndarray, z: float, positron: bool) -> np.ndarray:
    """McKinley–Feshbach：Mott 對 Rutherford 的比值（低 Z）。x ＝ 1 − cos θ；sin(θ/2) ＝ √(x/2)。
    正子的 παZβ 項反號。"""
    sn = np.sqrt(np.clip(x / 2, 0.0, 1.0))
    sign = -1.0 if positron else 1.0
    return 1 - beta**2 * sn**2 + sign * np.pi * ALPHA * z * beta * sn * (1 - sn)


def mott_rmax(beta: np.ndarray, z: float) -> np.ndarray:
    return 1 + np.pi * ALPHA * z * beta / 4


def elastic(energies: np.ndarray, tr: np.ndarray, rho_ref: np.ndarray, positron: bool = False) -> dict[str, np.ndarray]:
    """混合式彈性散射（PENELOPE 的做法）：大角度碰撞逐次模擬（屏蔽 Rutherford／Wentzel，Molière 屏蔽）、
    小角度的累積成每一步一個偏轉。

    每個元素的截面：σ_el ＝ πk／(A(1+A))、σ1 ＝ 2πk [ln(1+1/A) − 1/(1+A)]，k ＝ Z(Z+1) r_e² (mc²／pcβ)²；
    材質的總和再乘一個係數，讓 λ1 等於 Geant4 表的值（含 Mott 修正）。有效屏蔽參數 A 由 λ_el／λ1 反推。
    大角度碰撞的平均自由程 λ_h ＝ max(λ_el, C1·λ1)；分界 x_c ＝ 1 − cos θ_c 讓 P(x > x_c) ＝ λ_el／λ_h；
    軟散射的 1／λ1 ＝ 總的 − 大角度那部分。回傳的截面是參考密度下的 1/mm。"""
    nmat, ne = tr.shape
    t = energies
    pc = np.sqrt(t * (t + 2 * ME_MEV))
    beta = pc / (t + ME_MEV)
    sig_el = np.zeros((nmat, ne))
    sig_1 = np.zeros((nmat, ne))
    zeff = np.zeros(nmat)
    for m, (_name, _rho, comp) in enumerate(materials()):
        num = den = 0.0
        for sym, frac in comp.items():
            z, amass = ATOMIC[sym]
            n = float(rho_ref[m]) * 1e-3 * frac / amass * NA  # 原子／mm³
            a = (
                (ALPHA**2 * z ** (2 / 3) / (4 * 0.885**2))
                * (ME_MEV / pc) ** 2
                * (1.13 + 3.76 * (ALPHA * z / beta) ** 2)
            )
            k = z * (z + 1) * RE_MM**2 * (ME_MEV / (pc * beta)) ** 2
            sig_el[m] += n * np.pi * k / (a * (1 + a))
            sig_1[m] += n * 2 * np.pi * k * (np.log1p(1 / a) - 1 / (1 + a))
            num += n * z * (z + 1) * z
            den += n * z * (z + 1)
        zeff[m] = num / den if den > 0 else 1.0
    f = np.where(sig_1 > 0, tr / np.maximum(sig_1, 1e-300), 1.0)
    sig_el *= f
    ratio = np.clip(tr / np.maximum(sig_el, 1e-300), 1e-12, 0.999)
    a_eff = _solve_a(ratio)
    inv_h = np.minimum(sig_el, tr / C1)
    q = inv_h / np.maximum(sig_el, 1e-300)
    xc = np.clip(2 * a_eff * (1 + a_eff) / (q + a_eff) - 2 * a_eff, 0.0, 2.0)
    # 大角度碰撞用 Mott 修正做拒絕抽樣（接受率 R(x)／R_max）：被接受的那部分的〈x〉要從總的 1／λ1 扣掉，
    # 剩下的給軟散射 —— 總 λ1 維持 Geant4 的值，大角度（反散射）變少、小角度擴散相對變多
    hard = np.zeros((nmat, ne))
    u = (np.arange(400) + 0.5) / 400  # 在 [F(x_c), 1] 均勻取點（反函數抽樣的變數）
    for m in range(nmat):
        a, x0 = a_eff[m][:, None], xc[m][:, None]
        fc = (1 + a) * (1 - 2 * a / (x0 + 2 * a))
        uu = fc + (1 - fc) * u[None, :]
        x = 2 * a * uu / (1 + a - uu)
        r = mott_factor(x, beta[:, None], zeff[m], positron) / mott_rmax(beta[:, None], zeff[m])
        hard[m] = inv_h[m] * (x * r).mean(axis=1)
    trs = np.maximum(tr - hard, 0.0)
    return {"eh": inv_h, "xc": xc, "a": a_eff, "trs": trs, "zeff": np.repeat(zeff[:, None], ne, axis=1)}


def load(path: Path) -> Tables:
    z = np.load(path, allow_pickle=False)
    arr = z["table"]
    cols = [str(c) for c in z["columns"]]
    energies = arr[0, :, cols.index("e")].astype(np.float64)
    rho = z["rho"].astype(np.float64)
    derived: dict[str, np.ndarray] = {}
    for tag in ("e", "p"):
        for k, v in elastic(energies, arr[:, :, cols.index(f"tr_{tag}")], rho, positron=tag == "p").items():
            derived[k if k == "zeff" else f"{k}_{tag}"] = v
    # Bohr：受限（< δ 門檻）碰撞的能量損失變異數 dΩ²/ds ＝ 2π r_e² mc² n_e · T_cut (1 − β²/2)／β²；這裡存前面的常數
    ne_mm3 = np.array(
        [
            float(rho[m]) * 1e-3 * NA * sum(f * ATOMIC[e][0] / ATOMIC[e][1] for e, f in comp.items())
            for m, (_name, _rho, comp) in enumerate(materials())
        ]
    )
    derived["bohr"] = np.repeat((2 * np.pi * RE_MM**2 * ME_MEV * ne_mm3)[:, None], len(energies), axis=1)
    values = np.stack([arr[:, :, cols.index(q)] if q in cols else derived[q] for q in QUANTITIES]).astype(np.float32)
    return Tables(
        energies=energies,
        values=np.ascontiguousarray(values),
        rho_ref=z["rho"].astype(np.float32),
        se_total=arr[:, :, cols.index("se_total")].astype(np.float32),
        mu_tungsten=z["tungsten"][:, [cols.index(c) for c in ("phot", "compt", "conv", "rayl")]]
        .sum(axis=1)
        .astype(np.float32),
        info=json.loads(str(z["info"])),
    )
