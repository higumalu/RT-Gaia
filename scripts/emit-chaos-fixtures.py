#!/usr/bin/env python
"""產生 chaos 模式的實際訊框，供前端測試一對一驗證。

> **每一種模式都要有一個對應的前端測試。**

這個腳本讓那件事**不需要跑伺服器**：每個 chaos 模式各打一次測試後端（行程內
TestClient），把原始 bytes 存成 fixture。前端測試因此可以在 Node 下、離線、
確定性地驗證「拒絕」行為。
"""

from __future__ import annotations

import json
from pathlib import Path

import rtgaia_geom.provenance as _provenance
from rtgaia_testbe import Session

OUT = Path(__file__).resolve().parents[1] / "apps/viewer/tests/fixtures/chaos"

FROZEN_CREATED_AT = _provenance.datetime(2026, 1, 1, tzinfo=_provenance.UTC)
"""fixture 裡 `Provenance.created_at` 的固定值。

🔴 **不凍結的話 fixture 不可重現。** `created_at` 預設是 `datetime.now()`，
於是每跑一次腳本，八個 `.bin` 就有四個位元組不同 —— 而 fixture 是**進版控**的
（README「fixture 由後端產生」那一節），CI 要能靠「重跑後不得有 diff」擋住
「後端改了 wire 格式卻忘記重跑腳本」。時間戳讓那道檢查永遠是紅的，等於沒有。

`created_at` 對 chaos fixture 的用途（解碼與拒絕行為）完全沒有影響，
凍結它不會弱化任何一條斷言。
"""


def _freeze_clock() -> None:
    """把 `Provenance.created_at` 的來源固定住。

    `provenance.py` 的預設值是 `lambda: datetime.now(UTC).isoformat()`，
    `datetime` 是在**呼叫時**才從模組 globals 解析的，因此換掉模組屬性就夠了
    ——不必改產品程式碼，也不必事後重寫已編碼的訊框。
    """

    class _Frozen(_provenance.datetime):  # type: ignore[misc,name-defined]
        @classmethod
        def now(cls, tz: object = None) -> object:  # noqa: ARG003
            return FROZEN_CREATED_AT

    _provenance.datetime = _Frozen  # type: ignore[misc]


# chaos 模式 → (取哪個 payload, 前端該回報的 code, 一句話說明)
CASES: list[dict[str, object]] = [
    {
        "mode": "grid_mismatch",
        "target": "mask",
        "expect_code": "I3",
        "expected_behaviour": "拒絕合成並明確報錯，不得嘗試自動對齊",
    },
    {
        "mode": "fractional_offset",
        "target": "mask",
        "expect_code": "I1",
        "expected_behaviour": "拒絕載入（offset_ijk 必須是整數 voxel）",
    },
    {
        "mode": "missing_direction",
        "target": "image",
        "expect_code": "G4",
        "expected_behaviour": "拒絕載入，不得預設為單位矩陣",
    },
    {
        "mode": "truncate",
        "target": "image",
        "expect_code": "W6",
        "expected_behaviour": "偵測並報錯，不得渲染半張影像",
    },
    {
        "mode": "wrong_size",
        "target": "mask",
        "expect_code": "I9",
        "expected_behaviour": "拒絕載入（size_ijk 與實際資料量不符）",
    },
]


def main() -> None:
    _freeze_clock()
    OUT.mkdir(parents=True, exist_ok=True)
    session = Session()
    session.load("phantom:gantry_tilt")
    series_id = session.grid_set["frame_groups"][0]["series_id"]
    manifest: list[dict[str, object]] = []

    # 先存一份**乾淨**的樣本：反向保證（chaos 關掉後一切正常）
    for name, path, params in (
        ("clean_image", f"/api/v1/series/{series_id}/image", {"display_grid": session.display_grid_id, "lod": 2}),
        ("clean_mask", "/api/v1/structures/lesion/mask", {"mask_grid": session.mask_grid_id}),
    ):
        response = session._client.get(path, params=params)
        assert response.status_code == 200, response.text
        (OUT / f"{name}.bin").write_bytes(response.content)
        manifest.append(
            {
                "name": name,
                "mode": None,
                "target": name.split("_")[1],
                "file": f"{name}.bin",
                "expect_code": None,
                "expected_behaviour": "正常解碼（反向保證：chaos 關掉後不得有殘餘）",
                "bytes": len(response.content),
            }
        )

    for case in CASES:
        mode = str(case["mode"])
        session.chaos(reset=True)
        session.chaos(**{mode: True})
        if case["target"] == "image":
            path = f"/api/v1/series/{series_id}/image"
            params = {"display_grid": session.display_grid_id, "lod": 2}
        else:
            path = "/api/v1/structures/lesion/mask"
            params = {"mask_grid": session.mask_grid_id}
        response = session._client.get(path, params=params)
        assert response.status_code == 200, f"{mode}: {response.status_code} {response.text[:200]}"
        filename = f"{mode}.bin"
        (OUT / filename).write_bytes(response.content)
        manifest.append(
            {
                "name": mode,
                "mode": mode,
                "target": case["target"],
                "file": filename,
                "expect_code": case["expect_code"],
                "expected_behaviour": case["expected_behaviour"],
                "bytes": len(response.content),
            }
        )
    session.chaos(reset=True)

    # `stale_hash`、`latency`、`disconnect` 不是 payload 層的故障，記在 manifest
    # 裡標明由哪一種測試涵蓋，讓對照表不留空白。
    non_payload = [
        {
            "name": "stale_hash",
            "mode": "stale_hash",
            "target": "edit",
            "file": None,
            "expect_code": "HTTP 409",
            "expected_behaviour": "重取 mask ＋ 提示使用者；送出佇列丟棄待送 op、清空該結構 undo",
            "covered_by": "tests/edit.test.ts（SubmitQueue 的衝突流程）",
        },
        {
            "name": "latency",
            "mode": "latency",
            "target": "all",
            "file": None,
            "expect_code": None,
            "expected_behaviour": "載入指示、漸進式 lod、不得出現空白畫面",
            "covered_by": "packages/rtgaia-testbe/tests/test_chaos.py::test_latency_delays_every_response",
        },
        {
            "name": "disconnect",
            "mode": "disconnect",
            "target": "ws",
            "file": None,
            "expect_code": None,
            "expected_behaviour": "重連並重新同步（伺服器在 connect 時主動推 scene.replace）",
            "covered_by": "tests/push.test.ts（PushChannel 的重連）",
        },
        {
            "name": "push_limit",
            "mode": "push_limit",
            "target": "ws",
            "file": None,
            "expect_code": None,
            "expected_behaviour": (
                "scene.replace 超過推送上限 → 收到 {refetch: true} → 走 GET /sessions/{id}/scene，畫面照常更新"
            ),
            "covered_by": (
                "tests/push.test.ts（refetch 小訊息）＋ "
                "test_chaos.py::test_push_limit_sends_refetch_and_scene_is_on_http ＋ scripts/verify-push-refetch.mjs"
            ),
        },
    ]
    manifest.extend(non_payload)

    (OUT / "manifest.json").write_text(
        json.dumps({"cases": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"寫入 {OUT}（{len(manifest)} 個案例）")


if __name__ == "__main__":
    main()
