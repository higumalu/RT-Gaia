"""用物件 id 定位 session 只找請求者自己的。

結構 id 不是全域唯一（來自 ROI 名稱；新建的每個病例都從 `user_001` 編起）。以前 `by_structure`／`by_measurement`
掃所有 session、最近開的優先：Bob 剛開了另一位病人的病例，Alice 改名、刪除、編輯 `lesion` 就打到 Bob 的病例。
兩個假體 `axial_clean`、`gantry_tilt` 是不同的 study，都有 `lesion`。
"""

from __future__ import annotations

import pytest
from rtgaia_testbe import Session

HEADER = "X-RTGaia-Session"


def _names(driver: Session) -> dict[str, str]:
    return {e["structure_id"]: e["name"] for e in driver.structures()}


def _measurement(driver: Session, label: str) -> dict:
    body = {
        "measurementId": "m_same",
        "kind": "distance",
        "points": [0, 0, 0, 5, 0, 0],
        "frameOfReferenceUid": driver.primary_frame_of_reference_uid,
        "label": label,
    }
    return driver._post(f"/api/v1/measurements?study_id={driver.study_id}", body)


def test_ids_resolve_only_in_the_requesters_own_session() -> None:
    with Session(user="alice") as alice:
        bob = Session(client=alice._client, user="bob")
        carol = Session(client=alice._client, user="carol")
        alice.load("phantom:axial_clean")
        _measurement(alice, "alice")
        bob.load("phantom:gantry_tilt")  # 後開：以前「最近的 session 優先」就是它
        _measurement(bob, "bob")
        before = _names(bob)["lesion"]
        for d in (alice, bob):
            d._headers.pop(HEADER)  # 不帶標頭的 client（腳本、舊版）也不能打錯

        alice.update_structure("lesion", name="renamed by alice")
        assert _names(alice)["lesion"] == "renamed by alice"
        assert _names(bob)["lesion"] == before
        patched = alice._client.patch(
            "/api/v1/measurements/m_same", json={"label": "alice edited"}, headers=alice._headers
        ).json()
        assert patched["measurement"]["label"] == "alice edited"
        labels = {m["label"] for m in bob._get(f"/api/v1/measurements?study_id={bob.study_id}")}
        assert labels == {"bob"}

        bob.delete_structure("lesion")
        assert "lesion" in _names(alice) and "lesion" not in _names(bob)

        # 沒開任何病例的人：不會落到別人的 session
        r = carol._client.patch("/api/v1/structures/lesion", json={"name": "x"}, headers=carol._headers)
        assert r.status_code == 404
        r = carol._client.post(
            "/api/v1/transforms",
            json={"kind": "rigid", "matrix": [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]},
            headers=carol._headers,
        )
        assert r.status_code == 404
        r = carol._client.get("/api/v1/measurements", headers=carol._headers)
        assert r.status_code == 404


def test_same_user_with_two_cases_must_name_the_session() -> None:
    with Session(user="alice") as alice:
        first = alice.load("phantom:axial_clean")["session_id"]
        second = alice.load("phantom:gantry_tilt")["session_id"]
        assert first != second

        alice._headers.pop(HEADER)
        r = alice._client.patch("/api/v1/structures/lesion", json={"name": "which one?"}, headers=alice._headers)
        assert r.status_code == 409 and r.json()["code"] == "AMBIGUOUS_SESSION"
        assert sorted(r.json()["study_ids"]) == sorted(
            [
                "1.2.826.0.1.3680043.8.498.RTGAIA.TESTBE.STUDY.axial_clean",
                "1.2.826.0.1.3680043.8.498.RTGAIA.TESTBE.STUDY.gantry_tilt",
            ]
        )

        alice._headers[HEADER] = first  # 檢視器每個請求都帶自己的 session
        alice.update_structure("lesion", name="first case")
        alice._headers[HEADER] = second
        assert _names(alice)["lesion"] != "first case"  # second 那個病例沒被改
        alice.study_id = "1.2.826.0.1.3680043.8.498.RTGAIA.TESTBE.STUDY.axial_clean"
        assert _names(alice)["lesion"] == "first case"


def test_session_header_naming_someone_elses_session_is_not_found() -> None:
    with Session(user="alice") as alice:
        bob = Session(client=alice._client, user="bob")
        bob_session = bob.load("phantom:gantry_tilt")["session_id"]
        alice.load("phantom:axial_clean")
        alice._headers[HEADER] = bob_session
        r = alice._client.patch("/api/v1/structures/lesion", json={"name": "x"}, headers=alice._headers)
        assert r.status_code == 404
        assert _names(bob)["lesion"] != "x"


@pytest.mark.parametrize("path", ["/api/v1/structures/lesion/versions", "/api/v1/structures/lesion/mesh"])
def test_reads_also_stay_in_the_requesters_session(path: str) -> None:
    with Session(user="alice") as alice:
        bob = Session(client=alice._client, user="bob")
        alice.load("phantom:axial_clean")
        bob.load("phantom:gantry_tilt")
        alice._headers.pop(HEADER)
        a = alice._client.get(path, params={"mask_grid": alice.mask_grid_id}, headers=alice._headers)
        b = bob._client.get(path, params={"mask_grid": bob.mask_grid_id}, headers=bob._headers)
        assert a.status_code == 200 and b.status_code == 200
        assert a.content != b.content
