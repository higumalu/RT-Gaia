"""CT 校正曲線：內建 Schneider 2000 的數值（對照論文公式）、材質分段、範圍外計數、使用者點表的檢查與內插、
比對規則（最具體的贏、對不到退回通用曲線並說明）、啟用時停掉同規則的舊曲線、API 的狀態轉換與權限。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from rtgaia_core import ct_calibration as cc
from rtgaia_core.auth import required_role_for
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

# ── 內建曲線 ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("hu", "rho"),
    [
        (-1000, 0.00121),  # 空氣
        (-500, 0.00121 + 0.001029700665188 * 500),  # 肺
        (0, 1.018),  # 水附近
        (20, 1.03),  # 固定段
        (50, 1.003 + 0.001169 * 50),
        (1000, 1.017 + 0.000592 * 1000),  # 骨
        (2500, 2.201 + 0.0005 * 500),
        (2995, 4.54),  # 鈦
    ],
)
def test_schneider_density_matches_paper_formula(hu: float, rho: float) -> None:
    cal = cc.builtin_calibration()
    assert cc.density_of(cal, np.array([hu]))[0] == pytest.approx(rho, rel=1e-9)


def test_schneider_is_continuous_except_known_jump() -> None:
    """段與段之間連續（差 < 0.002 g/cm³），只有 101 HU 那一段是論文本身的跳躍（軟組織 → 骨的兩條直線）。"""
    cal = cc.builtin_calibration()
    for s in cal["density"]["sections"][1:-1]:
        b = s["hu_lo"]
        left, right = cc.density_of(cal, np.array([b - 1e-6, b]))
        if b == 101:
            assert left - right == pytest.approx(0.044, abs=0.001)
        else:
            assert abs(left - right) < 0.002, b


def test_materials_cover_range_and_compositions_sum_to_one() -> None:
    mats = cc.schneider_materials()
    assert len(mats) == 25 and mats[0]["hu_lo"] == -1000 and mats[-1]["hu_hi"] == 2996
    assert all(a["hu_hi"] == b["hu_lo"] for a, b in zip(mats, mats[1:], strict=False))
    for m in mats:
        assert sum(m["composition"].values()) == pytest.approx(1.0, abs=0.002), m["name"]
    assert [m["class"] for m in mats][:2] == ["air", "lung"] and mats[-1]["class"] == "metal"
    assert set(mats[-1]["composition"]) == {"Ti"}
    idx = cc.material_index_of(np.array([-1000, -951, -950, -500, 0, 100, 1000, 2994, 2995, 5000]))
    assert idx.tolist() == [0, 0, 1, 1, 5, 8, 18, 23, 24, 24]


def test_convert_counts_out_of_range_and_nan_is_air() -> None:
    cal = cc.builtin_calibration()
    hu = np.array([[-1200.0, -1000.0, 0.0], [1000.0, 4000.0, np.nan]])
    out = cc.convert(cal, hu)
    assert out.density.dtype == np.float32 and out.density.shape == hu.shape
    assert out.info["clamped_low"] == 1 and out.info["clamped_high"] == 1
    assert out.density[0, 0] == pytest.approx(0.00121) and out.density[1, 1] == pytest.approx(4.54)
    assert out.density[1, 2] == pytest.approx(0.00121), "網格外（NaN）當空氣"
    assert out.info["demo"] is True and out.info["material_classes"]["metal"] == 1


def test_sampled_curve_includes_section_edges() -> None:
    c = cc.sampled_curve(cc.builtin_calibration())
    assert c["hu"][0] == -1000 and c["hu"][-1] == 2995
    assert 101 in c["hu"] and any(100.99 < h < 101 for h in c["hu"]), "跳躍兩側都取，畫得出來"
    assert len(c["hu"]) == len(c["density"]) == len(c["material"])


# ── 使用者曲線與比對 ──────────────────────────────────────────────────────────


def _curve(**over):  # type: ignore[no-untyped-def]
    body = {
        "name": "CIRS 062M 120 kV",
        "points": [[-1000, 0.001], [0, 1.0], [1000, 1.6], [3000, 2.8]],
        "match": {"manufacturer": "Siemens", "model": "SOMATOM go.Up", "kvp": 120},
    }
    body.update(over)
    return body


def test_user_curve_checks() -> None:
    draft, problems = cc.check_user_curve(_curve())
    assert draft is not None and problems == []
    assert cc.density_of(draft, np.array([500.0]))[0] == pytest.approx(1.3)
    bad = [
        _curve(name=""),
        _curve(points=[[0, 1.0]]),
        _curve(points=[[0, 1.0], [0, 1.1]]),
        _curve(points=[[0, 1.0], [100, 1100.0]]),  # kg/m³
        _curve(points=[[0, 1.0], ["x", 1.1]]),
        _curve(match={"kvp": 500}),
        _curve(match={}),
    ]
    for b in bad:
        d, p = cc.check_user_curve(b)
        assert d is None and p, b


def _active(user: str = "admin", **over) -> dict:  # type: ignore[no-untyped-def]
    draft, _ = cc.check_user_curve(_curve(**over))
    assert draft is not None
    rec = cc.new_record(draft, user=user)
    rec.update(status="active", activated_at=over.pop("activated_at", "2026-10-12T00:00:00+00:00"))
    return rec


def test_resolve_picks_most_specific_then_latest_and_falls_back() -> None:
    scanner = {"manufacturer": "SIEMENS", "model": "SOMATOM go.Up", "kvp": 120.0}
    by_model = _active(match={"model": "SOMATOM go.Up"})
    by_all = _active(match={"manufacturer": "Siemens", "model": "SOMATOM go.Up", "kvp": 120})
    other_kvp = _active(match={"model": "SOMATOM go.Up", "kvp": 80})
    r = cc.resolve([by_model, by_all, other_kvp], scanner)
    assert r["calibration"] is by_all and r["fallback"] is False
    # 同樣具體 → 最晚啟用的
    newer = _active(match={"manufacturer": "Siemens", "model": "SOMATOM go.Up", "kvp": 120})
    newer["activated_at"] = "2026-10-13T00:00:00+00:00"
    assert cc.resolve([by_all, newer], scanner)["calibration"] is newer
    # 草稿、停用的不算；kVp 不明時有 kVp 規則的不符合
    by_all["status"] = "retired"
    assert cc.resolve([by_all], scanner)["fallback"] is True
    r2 = cc.resolve([other_kvp], {**scanner, "kvp": None})
    assert r2["fallback"] is True and r2["calibration"]["calibration_id"] == cc.BUILTIN_ID
    assert "SOMATOM go.Up" in r2["reason"] and "kVp 不明" in r2["reason"]


def test_activate_retires_same_rule() -> None:
    old = _active(match={"model": "A"})
    draft, _ = cc.check_user_curve(_curve(match={"model": "a"}))
    assert draft is not None
    new = cc.new_record(draft, user="admin")
    keep = _active(match={"model": "B"})
    retired = cc.activate([old, new, keep], new["calibration_id"], user="boss")
    assert retired == [old["calibration_id"]]
    assert old["status"] == "retired" and new["status"] == "active" and keep["status"] == "active"
    assert new["activated_by"] == "boss"


def test_admin_only_writes() -> None:
    assert required_role_for("GET", "/api/v1/ct-calibrations") == "viewer"
    assert required_role_for("POST", "/api/v1/ct-calibrations/preview") == "viewer"
    for method, path in (
        ("POST", "/api/v1/ct-calibrations"),
        ("POST", "/api/v1/ct-calibrations/ctc_1/activate"),
        ("POST", "/api/v1/ct-calibrations/ctc_1/retire"),
        ("DELETE", "/api/v1/ct-calibrations/ctc_1"),
    ):
        assert required_role_for(method, path) == "admin", path


# ── API ───────────────────────────────────────────────────────────────────────


def _delete(s: Session, path: str):  # type: ignore[no-untyped-def]
    return s._unwrap(s._client.delete(path, headers=s._headers))


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth-ctcal"))


def test_api_lifecycle_and_series_resolution(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="admin") as s:
        s.load_case({"image_series_uids": [synth.plan_ct.series_uid]}, webgl2=False, tier="C")
        base = "/api/v1/ct-calibrations"
        listed = s._get(base)["calibrations"]
        assert [x["calibration_id"] for x in listed] == [cc.BUILTIN_ID] and listed[0]["demo"] is True
        builtin = s._get(f"{base}/{cc.BUILTIN_ID}")
        assert len(builtin["materials"]) == 25 and builtin["curve"]["hu"][0] == -1000

        # 合成 CT：Manufacturer RT-Gaia、機型 SOMATOM synthetic、沒有 KVP → 對不到 → 通用曲線
        ct = synth.plan_ct.series_uid
        r = s._get(f"/api/v1/series/{ct}/ct-calibration")
        assert r["fallback"] is True and r["scanner"]["model"] == "SOMATOM synthetic" and r["scanner"]["kvp"] is None
        assert r["calibration"]["calibration_id"] == cc.BUILTIN_ID

        # 預覽不存；新增草稿 → 還是對不到（草稿不算）→ 啟用 → 對到
        pv = s._post(f"{base}/preview", {"points": [[-1000, 0.001], [2000, 2.0]]})
        assert pv["ok"] is True and pv["hu_range"] == [-1000, 2000]
        assert s._post(f"{base}/preview", {"points": [[0, 1.0]]})["ok"] is False
        body = {
            "name": "synth",
            "points": [[-1000, 0.001], [0, 1.0], [2000, 2.0]],
            "match": {"model": "SOMATOM synthetic"},
        }
        draft = s._post(base, body)
        cid = draft["calibration_id"]
        assert draft["status"] == "draft" and draft["created_by"] == "admin"
        assert s._get(f"/api/v1/series/{ct}/ct-calibration")["fallback"] is True
        act = s._post(f"{base}/{cid}/activate", {})
        assert act["status"] == "active" and act["retired"] == []
        r = s._get(f"/api/v1/series/{ct}/ct-calibration")
        assert r["fallback"] is False and r["calibration"]["calibration_id"] == cid

        # 狀態轉換：啟用過的不能刪、不能再啟用；停用 → 又退回通用曲線
        with pytest.raises(RuntimeError, match="422"):
            _delete(s, f"{base}/{cid}")
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"{base}/{cid}/activate", {})
        s._post(f"{base}/{cid}/retire", {})
        assert s._get(f"/api/v1/series/{ct}/ct-calibration")["fallback"] is True
        # 草稿可以刪；內建的不能動；壞的點表 422；劑量不是 CT
        d2 = s._post(base, {**body, "name": "draft2"})["calibration_id"]
        assert _delete(s, f"{base}/{d2}")["deleted"] == d2
        for path in (f"{base}/{cc.BUILTIN_ID}/activate", f"{base}/{cc.BUILTIN_ID}/retire"):
            with pytest.raises(RuntimeError, match="422"):
                s._post(path, {})
        with pytest.raises(RuntimeError, match="422"):
            s._post(base, {**body, "points": [[0, 1]]})
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"{base}/nope")
        assert [x["status"] for x in s._get(base)["calibrations"]] == ["builtin", "retired"]
