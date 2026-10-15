"""射束資料：通用 CSV 的解析、每種量測的檢查、資料集的檢查、內建公開資料、API 的狀態轉換與權限。"""

from __future__ import annotations

from pathlib import Path

import pytest
from rtgaia_core.auth import required_role_for
from rtgaia_dosecalc import beam_data as bd
from rtgaia_testbe import Session

CSV = """# 註解：Beyer 2013 Table 1 的格式
# kind: depth_dose
# quantity: pdd
# field_mm: 100 x 100
# ssd_mm: 1000
# unit: percent
# statistic: mean
# n: 3
depth_mm, value, uncertainty
15, 100.0
100, 66.4, 0.3

# kind: output_factor
# depth_mm: 50
# ssd_mm: 950
# reference_field_mm: 100
# collimation: jaw
30, 0.876
100, 1.000
400, 1.137

# kind: output_factor
# depth_mm: 100
# sad_mm: 1000
# columns: field_x_mm, field_y_mm, value
40, 200, 0.92
200, 40, 0.90

# kind: profile
# field_mm: 100
# ssd_mm: 1000
# depth_mm: 100
# axis: y
-60, 5.1
0, 100
60, 5.2

# kind: scalar
# quantity: mlc_transmission
# layer: distal
# depth_mm: 100
0.0041

# kind: absolute
# field_mm: 100
# ssd_mm: 1000
0.01
"""


def _dataset(**over):  # type: ignore[no-untyped-def]
    ms, problems = bd.parse_csv(CSV)
    assert problems == []
    body = {
        "name": "TrueBeam 6X (Beyer 2013)",
        "machine": {"manufacturer": "Varian", "model": "TrueBeam"},
        "beam": {"energy_mv": 6, "fluence_mode": "STANDARD"},
        "source": {"kind": "literature", "citation": "Beyer GP. JACMP 2013;14(1):273", "licence": "CC BY 3.0"},
        "measurements": ms,
    }
    body.update(over)
    return body


def test_csv_blocks_conditions_columns_and_header_rows() -> None:
    ms, problems = bd.parse_csv(CSV)
    assert problems == []
    assert [m["kind"] for m in ms] == ["depth_dose", "output_factor", "output_factor", "profile", "scalar", "absolute"]
    recs = []
    for m in ms:
        rec, p = bd.check_measurement(m)
        assert p == [], (m, p)
        recs.append(rec)
    pdd, of, of_rect, prof, trans, absolute = recs
    # 表頭列略過、不確定度可以缺
    assert pdd["points"] == [[15.0, 100.0, None], [100.0, 66.4, 0.3]]
    assert pdd["columns"] == ["depth_mm", "value", "uncertainty"]
    assert pdd["conditions"] == {"field_mm": [100.0, 100.0], "ssd_mm": 1000.0} and pdd["n"] == 3
    assert pdd["statistic"] == "mean" and pdd["unit"] == "percent"
    assert of["conditions"]["reference_field_mm"] == [100.0, 100.0] and of["unit"] == "ratio"
    assert of_rect["columns"] == ["field_x_mm", "field_y_mm", "value"] and of_rect["points"][0] == [40.0, 200.0, 0.92]
    assert prof["conditions"]["axis"] == "y"
    assert trans["quantity"] == "mlc_transmission" and trans["unit"] == "fraction" and trans["points"] == [[0.0041]]
    assert absolute["quantity"] == "gy_per_mu"
    assert bd.measurement_label(pdd) == "PDD 100×100 SSD 1000"
    assert bd.measurement_label(of_rect) == "OF d100 SAD 1000 X×Y"
    assert bd.measurement_label(trans) == "mlc_transmission d100 distal"


def test_csv_problems_name_the_line() -> None:
    _, p = bd.parse_csv("# field_mm: 100\n# kind: depth_dose\n10, 1\n10, abc\n")
    assert any("第 1 行" in x for x in p) and any("第 4 行" in x for x in p)
    _, p = bd.parse_csv("10, 1\n")
    assert p and "第 1 行" in p[0]


_DD: dict = {"kind": "depth_dose", "conditions": {"field_mm": "100", "ssd_mm": 1000}}
_PR: dict = {"kind": "profile", "conditions": {"field_mm": "100", "ssd_mm": 1000, "depth_mm": 50}, "points": [[0, 1]]}
_OF = {"kind": "output_factor", "conditions": {"depth_mm": 100, "ssd_mm": 900}}


@pytest.mark.parametrize(
    ("raw", "needle"),
    [
        ({"kind": "nope", "points": [[1]]}, "kind"),
        ({"kind": "depth_dose", "conditions": {"ssd_mm": 1000}, "points": [[10, 1]]}, "field_mm"),
        ({"kind": "depth_dose", "conditions": {"field_mm": "100"}, "points": [[10, 1]]}, "ssd_mm"),
        ({"kind": "depth_dose", "conditions": {"field_mm": "1e9", "ssd_mm": 1000}, "points": [[10, 1]]}, "寬 x 高"),
        ({**_DD, "points": [[20, 1], [10, 1]]}, "遞增"),
        ({**_DD, "points": [[-1, 1]]}, "負"),
        ({**_DD, "points": [[1, -1]]}, "負"),
        ({**_DD, "points": [[1, "x"]]}, "數字"),
        ({**_DD, "points": []}, "列"),
        ({"kind": "profile", "conditions": {"field_mm": "100", "ssd_mm": 1000}, "points": [[0, 1]]}, "depth_mm"),
        ({**_PR, "conditions": {**_PR["conditions"], "axis": "z"}}, "axis"),
        ({"kind": "scalar", "quantity": "spin", "points": [[1]]}, "quantity"),
        ({"kind": "scalar", "quantity": "dmax_mm", "points": [[1], [2]]}, "一列"),
        ({**_OF, "points": [[0, 1]]}, "射野"),
        ({"kind": "output_factor", "conditions": {**_OF["conditions"], "color": "red"}, "points": [[10, 1]]}, "不認得"),
        ({**_OF, "columns": ["a", "b"], "points": [[10, 1]]}, "欄位"),
    ],
)  # fmt: skip
def test_measurement_checks(raw: dict, needle: str) -> None:
    rec, p = bd.check_measurement(raw)
    assert rec is None and any(needle in x for x in p), p


def test_dataset_checks_and_demo_flag() -> None:
    draft, p = bd.check_dataset(_dataset())
    assert p == [] and draft is not None
    assert draft["demo"] is True and len(draft["measurements"]) == 6
    measured, _ = bd.check_dataset(_dataset(source={"kind": "measured"}))
    assert measured is not None and measured["demo"] is False
    for body, needle in (
        (_dataset(name=""), "名稱"),
        (_dataset(machine={}), "製造商"),
        (_dataset(beam={"energy_mv": 100}), "能量"),
        (_dataset(beam={"energy_mv": 6, "fluence_mode": "SRS"}), "fluence_mode"),
        (_dataset(source={"kind": "guess"}), "來源"),
        (_dataset(source={"kind": "literature"}), "出處"),
        (_dataset(measurements=[{"kind": "scalar", "quantity": "dmax_mm", "points": [[1], [2]]}]), "第 1 筆（scalar）"),
    ):
        d, problems = bd.check_dataset(body)
        assert d is None and any(needle in x for x in problems), (needle, problems)
    dup = _dataset()
    dup["measurements"] = [
        {**dup["measurements"][0], "measurement_id": "a"},
        {**dup["measurements"][1], "measurement_id": "a"},
    ]
    assert any("重複" in x for x in bd.check_dataset(dup)[1])


def test_builtin_public_datasets_are_valid_and_cited() -> None:
    builtin = bd.builtin_datasets()
    for ds in builtin:
        assert ds["status"] == "builtin" and ds["demo"] is True and ds["dataset_id"].startswith("pub-")
        assert (
            ds["source"]["kind"] == "literature"
            and ds["source"]["citation"]
            and ds["source"]["licence"].startswith("CC BY")
        )
        assert ds["measurements"]
    assert len({d["dataset_id"] for d in builtin}) == len(builtin)


def test_admin_only_writes() -> None:
    assert required_role_for("GET", "/api/v1/beam-data") == "viewer"
    assert required_role_for("POST", "/api/v1/beam-data/parse-csv") == "viewer"
    for method, path in (
        ("POST", "/api/v1/beam-data"),
        ("PUT", "/api/v1/beam-data/bd_1"),
        ("POST", "/api/v1/beam-data/bd_1/lock"),
        ("DELETE", "/api/v1/beam-data/bd_1"),
    ):
        assert required_role_for(method, path) == "admin", path


def _delete(s: Session, path: str):  # type: ignore[no-untyped-def]
    return s._unwrap(s._client.delete(path, headers=s._headers))


def test_api_lifecycle(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(tmp_path), user="admin") as s:
        base = "/api/v1/beam-data"
        builtin_ids = [d["dataset_id"] for d in bd.builtin_datasets()]
        assert [x["dataset_id"] for x in s._get(base)["datasets"]] == builtin_ids

        parsed = s._post(f"{base}/parse-csv", {"text": CSV})
        assert parsed["ok"] is True and len(parsed["measurements"]) == 6
        assert parsed["measurements"][0]["label"] == "PDD 100×100 SSD 1000"
        bad = s._post(f"{base}/parse-csv", {"text": "# kind: depth_dose\n10, 1\n"})
        assert bad["ok"] is False and any("第 1 筆（depth_dose）" in p for p in bad["problems"])

        body = _dataset(measurements=parsed["measurements"])
        rec = s._post(base, body)
        did = rec["dataset_id"]
        assert rec["status"] == "draft" and rec["created_by"] == "admin" and rec["demo"] is True
        assert rec["measurement_counts"] == {
            "depth_dose": 1,
            "output_factor": 2,
            "profile": 1,
            "scalar": 1,
            "absolute": 1,
        }
        # 量測的 id 保留（擬合引用的是它）
        mid = rec["measurements"][0]["measurement_id"]
        upd = s._put(f"{base}/{did}", {**body, "name": "v2", "measurements": rec["measurements"][:2]})
        assert upd["name"] == "v2" and upd["measurements"][0]["measurement_id"] == mid and upd["updated_by"] == "admin"
        with pytest.raises(RuntimeError, match="422"):
            s._put(f"{base}/{did}", {**body, "name": ""})
        locked = s._post(f"{base}/{did}/lock", {})
        assert locked["status"] == "locked" and locked["locked_by"] == "admin"
        for call in (
            lambda: s._put(f"{base}/{did}", body),
            lambda: s._post(f"{base}/{did}/lock", {}),
            lambda: _delete(s, f"{base}/{did}"),
        ):
            with pytest.raises(RuntimeError, match="422"):
                call()
        # 複製 → 草稿可以刪
        copy = s._post(base, {**body, "name": "copy", "derived_from": did})
        assert copy["derived_from"] == did
        assert _delete(s, f"{base}/{copy['dataset_id']}")["deleted"] == copy["dataset_id"]
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"{base}/nope")
        for b in builtin_ids[:1]:
            with pytest.raises(RuntimeError, match="422"):
                s._put(f"{base}/{b}", body)
        assert [x["status"] for x in s._get(base)["datasets"]][len(builtin_ids) :] == ["locked"]


def test_public_datasets_match_their_transcription() -> None:
    """內建資料集是 `scripts/build-public-beam-data.py` 從論文表格的轉錄產生的；改了轉錄或腳本要重產。"""
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[3]
    r = subprocess.run(
        [sys.executable, str(root / "scripts/build-public-beam-data.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    ids = {d["dataset_id"] for d in bd.builtin_datasets()}
    assert {"pub-beyer2013-6x", "pub-akino2020-6fff", "pub-gao2019-halcyon", "pub-lim2019-halcyon-mlc"} <= ids


def test_public_values_spot_checks() -> None:
    """幾個值對照論文原表（防止轉錄或選欄出錯）。"""
    ms = {m["measurement_id"]: m for d in bd.builtin_datasets() for m in d["measurements"]}
    assert ms["beyer2013-t1-pdd10-6x-10x10"]["points"] == [[100.0, 66.1, 0.058]]  # Table 1 Average
    assert ms["beyer2013-t2-of-6x"]["points"][0] == [30.0, 0.877, 0.0014]  # Table 2 3×3
    assert ms["akino2020-t2-of-6x"]["points"][0][:2] == [5.0, 0.545]  # Table 2 FS 5
    assert ms["gao2019-t5-of-square"]["points"][-1] == [280.0, 1.111]  # Table 5 28×28 1DS
    assert ms["gao2019-t4-dmax-10x10"]["points"] == [[12.5]]
    assert ms["lim2019-t3-transmission-distal-dmax"]["points"] == [[0.0041]]
    assert ms["lim2019-text-leaf-end-d10"]["points"] == [[-0.19]]
    assert (
        ms["tanaka2020-t4-penumbra-6fff-30-chamber"]["points"] == [[5.76, 0.08]]
        and ms["tanaka2020-t4-penumbra-6fff-30-chamber"]["n"] == 6
    )


def test_frontend_csv_round_trips() -> None:
    """前端「改成 CSV 編輯」寫出的文字（`apps/viewer/tests/beam-data.test.ts` 的期望值）解析回來內容不變。"""
    csv = "\n".join(
        [
            "# kind: depth_dose",
            "# quantity: pdd",
            "# field_mm: 100 x 100",
            "# ssd_mm: 1000",
            "# normalization: dmax",
            "# unit: percent",
            "# statistic: mean",
            "# n: 3",
            "# reference: Beyer 2013 Table 1",
            "# columns: depth_mm, value, uncertainty",
            "15, 100",
            "100, 66.4, 0.3",
            "",
            "# kind: scalar",
            "# quantity: mlc_transmission",
            "# layer: distal",
            "# depth_mm: 100",
            "# unit: fraction",
            "# columns: value",
            "0.0041",
        ]
    )
    raw, problems = bd.parse_csv(csv)
    assert problems == []
    pdd, trans = (bd.check_measurement(m)[0] for m in raw)
    assert pdd is not None and trans is not None
    assert pdd["conditions"] == {"field_mm": [100.0, 100.0], "ssd_mm": 1000.0, "normalization": "dmax"}
    assert pdd["points"] == [[15.0, 100.0, None], [100.0, 66.4, 0.3]] and pdd["n"] == 3
    assert pdd["reference"] == "Beyer 2013 Table 1" and pdd["statistic"] == "mean"
    assert trans["conditions"] == {"layer": "distal", "depth_mm": 100.0} and trans["points"] == [[0.0041]]
