"""Python 驅動 API。

> 給你在 REPL 或腳本裡直接把東西推到畫面上。
> **同一份 driver 也用於前端 e2e 測試** —— 不要另外寫一套測試驅動器。

```python
from rtgaia_testbe import Session

s = Session("http://localhost:8080")     # 前端連上同一個 session 即會即時更新
s.load("phantom:gantry_tilt")
s.push_mask("Parotid_L", arr)
s.set_camera(view_plane_normal=(0, .5, .866), view_up=(0, .866, -.5), slab_mm=3)
s.chaos(grid_mismatch=True)
assert s.expected()["structures"]["sphere_25mm"]["volume_cc"] == 65.45
```

`Session()` 不給 base_url 時會**在同一個行程內**跑一個 app，因此 pytest 不需要
起伺服器；給 base_url 則走真的 HTTP，前端 e2e 用這個。
"""

from __future__ import annotations

import base64
from typing import Any, Literal
from urllib.parse import quote

import numpy as np

MeasurementKind = Literal["distance", "area", "roi3d", "point", "angle", "cobb", "curve", "landmark"]


class Session:
    """測試後端的客戶端。

    ⚠️ 與 `rtgaia_core.state.Session`（**伺服器端**的 session）同名但不同物。
    `from rtgaia_testbe import Session` 指的是這一個。
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 60.0,
        library_root: str | None = None,
        db_url: str | None = None,
        user: str | None = None,
        app: Any = None,
        auth: str | None = None,
        client: Any = None,
    ) -> None:
        """`user`：每個請求帶 `X-RTGaia-User`（`RTGAIA_AUTH=off` 的身分 stub）。
        `auth`：`create_app(auth=…)`（`"off"` 讓 DB 模式的測試不必登入）。
        driver 建的 app 一律 `test_api=True`（`/_test/*` 是驅動腳本的入口；生產 app 預設沒有）。
        `app`／`client`：與另一個 driver 共用同一個行程內 app／**同一個 TestClient**（🔴 多身分測試必須共用 client：
        每個 TestClient context 是自己的 event loop，asyncpg 連線跨 loop 會炸）；身分以 `set_bearer()` 逐 driver 帶。"""
        self.base_url = base_url.rstrip("/") if base_url else None
        self._headers: dict[str, str] = {"X-RTGaia-User": user} if user else {}
        self._owns_client = client is None
        if client is not None:
            self._client: Any = client
            self._app = getattr(client, "app", None)
        elif base_url:
            import httpx

            self._client = httpx.Client(base_url=self.base_url, timeout=timeout)
        else:
            from fastapi.testclient import TestClient

            from ..api import create_app

            # `public_url`：required 模式必填；TestClient 的 Host 是 `testserver`，白名單由它推導
            self._app = (
                app
                if app is not None
                else create_app(
                    library_root=library_root,
                    db_url=db_url,
                    auth=auth,
                    test_api=True,
                    public_url="http://testserver",
                )
            )
            self._client = TestClient(self._app)
        self.session_id: str | None = None
        self.study_id: str | None = None
        self._scene: dict[str, Any] = {}
        self._entered = False

    # ── HTTP ────────────────────────────────────────────────────────────────

    def _get(self, path: str, **params: Any) -> Any:
        r = self._client.get(path, params={k: v for k, v in params.items() if v is not None}, headers=self._headers)
        return self._unwrap(r)

    def _post(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        r = self._client.post(path, json=payload or {}, headers=self._headers)
        return self._unwrap(r)

    def _put(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        r = self._client.put(path, json=payload or {}, headers=self._headers)
        return self._unwrap(r)

    # ── 身分 ────────────────────────────────────────────────────────

    def set_bearer(self, token: str | None) -> None:
        """之後的請求帶 `Authorization: Bearer`（優先於 cookie）。"""
        if token:
            self._headers["Authorization"] = f"Bearer {token}"
        else:
            self._headers.pop("Authorization", None)

    def login(self, username: str, password: str) -> dict[str, Any]:
        """`POST /auth/login`；成功後這個 driver 以 Bearer 帶身分（不依賴共用 client 的 cookie jar）。"""
        out = self._post("/api/v1/auth/login", {"username": username, "password": password})
        self.set_bearer(out["token"])
        self._client.cookies.clear()
        return out

    def bootstrap(self, username: str, password: str, display_name: str = "") -> dict[str, Any]:
        out = self._post(
            "/api/v1/auth/bootstrap", {"username": username, "password": password, "display_name": display_name}
        )
        self.set_bearer(out["token"])
        self._client.cookies.clear()
        return out

    def me(self) -> dict[str, Any]:
        return self._get("/api/v1/auth/me")

    def create_user(
        self,
        username: str,
        password: str,
        role: str = "contourer",
        display_name: str = "",
        *,
        must_change_password: bool = False,
    ) -> dict[str, Any]:
        return self._post(
            "/api/v1/auth/users",
            {
                "username": username,
                "password": password,
                "role": role,
                "display_name": display_name,
                # 產品預設「管理者建的帳號首次登入要改密碼」；測試帳號預設不要（要驗那條路徑時明確傳 True）
                "must_change_password": must_change_password,
            },
        )

    @staticmethod
    def _unwrap(response: Any) -> Any:
        if response.status_code >= 400:
            try:
                detail = response.json()
            except Exception:  # noqa: BLE001
                detail = response.text
            raise RuntimeError(f"HTTP {response.status_code}: {detail}")
        if response.headers.get("content-type", "").startswith("application/vnd.rtgaia"):
            from rtgaia_geom import decode

            return decode(response.content)
        return response.json()

    # ── 載入與狀態 ──────────────────────────────────────────────────────────

    def _bind_session(self, session_id: str) -> None:
        """之後的請求帶 `X-RTGaia-Session`（跟檢視器一樣）：用結構／量測 id 定位的端點只在這個 session 裡找。"""
        self.session_id = session_id
        self._headers["X-RTGaia-Session"] = session_id

    def load(self, source: str = "phantom:axial_clean", **capability: Any) -> dict[str, Any]:
        out = self._post(
            "/api/v1/_test/load",
            {"source": source, "client_capability": capability or None},
        )
        self._bind_session(out["session_id"])
        self.study_id = out["study_id"]
        self._scene = out["scene"]
        return out

    def load_case(self, selection: dict[str, Any], **capability: Any) -> dict[str, Any]:
        """`POST /api/v1/sessions` —— 由資料庫選取建立 session。"""
        out = self._post("/api/v1/sessions", {**selection, "client_capability": capability or None})
        self._bind_session(out["session_id"])
        self.study_id = out["study_id"]
        self._scene = out["scene"]
        return out

    def library(self) -> dict[str, Any]:
        return self._get("/api/v1/library")

    def library_patients(self, q: str | None = None) -> list[dict[str, Any]]:
        return self._get("/api/v1/library/patients", q=q)

    def library_series(self, **filters: Any) -> dict[str, Any]:
        """`patient_id` / `date_from` / `date_to` / `description` / `modality`。"""
        return self._get("/api/v1/library/series", **filters)

    def rescan_library(self) -> dict[str, Any]:
        return self._post("/api/v1/library/rescan")

    # ── 目錄樹 ────────────────────────────────────────────────────

    def catalog_patients(self, **filters: Any) -> dict[str, Any]:
        """`q` / `patient_id` / `date_from` / `date_to` / `modality` / `has` / `page` / `size`。"""
        return self._get("/api/v1/catalog/patients", **filters)

    def catalog_studies(self, patient_id: str, **filters: Any) -> list[dict[str, Any]]:
        return self._get(f"/api/v1/catalog/patients/{patient_id}/studies", **filters)

    def catalog_series(self, study_uid: str, **filters: Any) -> dict[str, Any]:
        return self._get(f"/api/v1/catalog/studies/{study_uid}/series", **filters)

    def catalog_rt(self, image_series_uid: str, **filters: Any) -> list[dict[str, Any]]:
        return self._get(f"/api/v1/catalog/series/{image_series_uid}/rt", **filters)

    def catalog_detail(self, series_uid: str) -> dict[str, Any]:
        return self._get(f"/api/v1/catalog/series/{series_uid}")

    def catalog_search(self, **filters: Any) -> dict[str, Any]:
        return self._get("/api/v1/catalog/search", **filters)

    # ── 匯入 ──────────────────────────────────────────────────────

    def import_open(self, detail: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._post("/api/v1/import/batches", {"source": "upload", "detail": detail or {}})

    def import_put(self, batch_id: str, relative_path: str, data: bytes) -> dict[str, Any]:
        r = self._client.put(
            f"/api/v1/import/batches/{batch_id}/files",
            content=data,
            headers={
                **self._headers,
                "X-Relative-Path": quote(relative_path),
                "content-type": "application/octet-stream",
            },
        )
        return self._unwrap(r)

    def import_complete(self, batch_id: str) -> dict[str, Any]:
        return self._post(f"/api/v1/import/batches/{batch_id}/complete")

    def import_get(self, batch_id: str, *, items: bool = True) -> dict[str, Any]:
        return self._get(f"/api/v1/import/batches/{batch_id}", items=str(items).lower())

    def import_list(self) -> list[dict[str, Any]]:
        return self._get("/api/v1/import/batches")

    def import_discard(self, batch_id: str) -> dict[str, Any]:
        r = self._client.delete(f"/api/v1/import/batches/{batch_id}", headers=self._headers)
        return self._unwrap(r)

    def import_server_path(self, path: str) -> dict[str, Any]:
        return self._post("/api/v1/import/server-path", {"path": path})

    def wait_import(self, batch_id: str, *, timeout: float = 30.0) -> dict[str, Any]:
        """輪詢到批次結束（done／failed／discarded）。"""
        import time

        deadline = time.time() + timeout
        while True:
            b = self.import_get(batch_id)
            if b["status"] in ("done", "failed", "discarded"):
                return b
            if time.time() > deadline:
                raise TimeoutError(f"匯入批次 {batch_id} 在 {timeout}s 內未結束：{b['status']}/{b['phase']}")
            time.sleep(0.1)

    def catalog_delete(self, level: str, key: str, *, force: bool = False) -> dict[str, Any]:
        r = self._client.delete(
            f"/api/v1/catalog/{level}/{key}", params={"force": "true"} if force else None, headers=self._headers
        )
        return self._unwrap(r)

    def catalog_download(self, level: str, key: str, *, compress: bool = False) -> bytes:
        r = self._client.get(
            f"/api/v1/catalog/{level}/{key}/download",
            params={"compress": "true"} if compress else None,
            headers=self._headers,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text}")
        return r.content

    def grids(self, **capability: Any) -> dict[str, Any]:
        """重新協商 Tier 與網格。回傳 `GridSet`。"""
        series_ids = [s["series_id"] for s in self.grid_set["frame_groups"]]
        return self._post(
            f"/api/v1/studies/{self._study}/grids",
            {
                "primary_series_id": series_ids[0],
                "series_ids": series_ids,
                "client_capability": capability or None,
            },
        )

    @property
    def _study(self) -> str:
        if not self.study_id:
            raise RuntimeError("先 load() 一個假體")
        return self.study_id

    @property
    def state(self) -> dict[str, Any]:
        return self._get("/api/v1/_test/state")

    @property
    def grid_set(self) -> dict[str, Any]:
        return self.state["gridSet"]

    @property
    def case_id(self) -> str:
        """目前 session 的病例 id（`scene.caseId`）。"""
        return str(self._scene["caseId"])

    @property
    def display_grid_id(self) -> str:
        return str(self.grid_set["display_grid"]["display_grid_id"])

    @property
    def mask_grid_id(self) -> str:
        return str(self.grid_set["mask_grid"]["mask_grid_id"])

    @property
    def primary_frame_of_reference_uid(self) -> str:
        return str(self.grid_set["display_grid"]["grid"]["frame_of_reference_uid"])

    def expected(self) -> dict[str, Any]:
        """目前假體的 `expected.json`。"""
        return self._get("/api/v1/_test/expected")

    def phantoms(self) -> list[dict[str, Any]]:
        return self._get("/api/v1/_test/phantoms")

    def health(self) -> dict[str, Any]:
        return self._get("/healthz")

    # ── 影像與結構 ──────────────────────────────────────────────────────────

    def image(self, series_id: str | None = None, *, lod: int = 0, frame: int | None = None):
        series_id = series_id or self.grid_set["frame_groups"][0]["series_id"]
        header, raw = self._get(
            f"/api/v1/series/{series_id}/image",
            display_grid=self.display_grid_id,
            lod=lod,
            frame=frame,
        )
        size = header["size_ijk"]
        # dtype 由 header 決定：影像 int16、劑量 float32
        dtype = {"int16": np.int16, "float32": np.float32, "uint8": np.uint8}[header.get("dtype", "int16")]
        arr = np.frombuffer(raw, dtype=dtype).reshape(size[2], size[1], size[0])
        return header, arr

    def structures(self) -> list[dict[str, Any]]:
        return self._get(f"/api/v1/studies/{self._study}/structures")

    def mask(self, structure_id: str, *, frame: int | None = None):
        header, raw = self._get(f"/api/v1/structures/{structure_id}/mask", mask_grid=self.mask_grid_id, frame=frame)
        size = header["size_ijk"]
        arr = np.frombuffer(raw, dtype=np.uint8).reshape(size[2], size[1], size[0])
        return header, arr

    def mesh(self, structure_id: str, *, lod: int = 0, frame: int | None = None):
        header, raw = self._get(
            f"/api/v1/structures/{structure_id}/mesh",
            mask_grid=self.mask_grid_id,
            lod=lod,
            frame=frame,
        )
        nv, nt = int(header["vertex_count"]), int(header["triangle_count"])
        vertices = np.frombuffer(raw, dtype=np.float32, count=nv * 3).reshape(nv, 3)
        triangles = np.frombuffer(raw, dtype=np.uint32, offset=nv * 12, count=nt * 3).reshape(nt, 3)
        return header, vertices, triangles

    def push_mask(
        self,
        structure_id: str,
        array: np.ndarray,
        *,
        name: str | None = None,
        color_rgb: tuple[int, int, int] = (255, 255, 0),
        offset_ijk: tuple[int, int, int] = (0, 0, 0),
        frame: int | None = None,
        frame_of_reference_uid: str | None = None,
    ) -> dict[str, Any]:
        """numpy bool/uint8 → 注入一個結構，**自動裁切成 bbox**。

        陣列排列是 `(k, j, i)`，與 `mask()` 回傳的一致。
        """
        arr = np.ascontiguousarray(np.asarray(array).astype(np.uint8))
        return self._post(
            "/api/v1/_test/mask",
            {
                "structure_id": structure_id,
                "name": name or structure_id,
                "color_rgb": list(color_rgb),
                "shape": list(arr.shape),
                "offset_ijk": list(offset_ijk),
                "frame_index": frame,
                "frame_of_reference_uid": frame_of_reference_uid,
                "data_b64": base64.b64encode(arr.tobytes()).decode("ascii"),
            },
        )

    def edit(
        self,
        structure_id: str,
        *,
        offset_ijk: tuple[int, int, int],
        array: np.ndarray,
        base_content_hash: str | None = None,
        view_reference: dict[str, Any] | None = None,
        client_seq: int = 1,
        client_id: str = "driver",
        frame: int | None = None,
    ) -> dict[str, Any]:
        """`POST /edit`。`view_reference` 未給時以當前軸向平面代入。"""
        arr = np.ascontiguousarray(np.asarray(array).astype(np.uint8))
        if base_content_hash is None:
            header, _ = self.mask(structure_id, frame=frame)
            base_content_hash = str(header["content_hash"])
        return self._post(
            f"/api/v1/structures/{structure_id}/edit",
            {
                "mask_grid_id": self.mask_grid_id,
                "frame_index": frame,
                "base_content_hash": base_content_hash,
                "client_seq": client_seq,
                "client_id": client_id,
                "offset_ijk": list(offset_ijk),
                "size_ijk": [arr.shape[2], arr.shape[1], arr.shape[0]],
                "data": base64.b64encode(arr.tobytes()).decode("ascii"),
                "view_reference": view_reference or self.view_reference(),
            },
        )

    def postprocess(self, structure_id: str, op: str, *, frame: int | None = None, **params: Any) -> dict[str, Any]:
        header, _raw = self._post(
            f"/api/v1/structures/{structure_id}/postprocess",
            {
                "op": op,
                "params": params,
                "mask_grid_id": self.mask_grid_id,
                "frame_index": frame,
            },
        )
        return header

    def create_structure(self, name: str, **kwargs: Any) -> dict[str, Any]:
        return self._post(f"/api/v1/studies/{self._study}/structures", {"name": name, **kwargs})

    def update_structure(self, structure_id: str, **patch: Any) -> dict[str, Any]:
        return self._unwrap(self._client.patch(f"/api/v1/structures/{structure_id}", json=patch, headers=self._headers))

    def delete_structure(self, structure_id: str) -> None:
        r = self._client.delete(f"/api/v1/structures/{structure_id}", headers=self._headers)
        if r.status_code >= 400:
            self._unwrap(r)

    def copy_structure(self, structure_id: str, **body: Any) -> dict[str, Any]:
        return self._post(f"/api/v1/structures/{structure_id}/copy", body)

    # ── 結構集與合併 ────────────────────────────────────────

    def structure_sets(self, case_id: str | None = None) -> list[dict[str, Any]]:
        return self._get(f"/api/v1/cases/{case_id or self.case_id}/structure-sets")

    def merge_into_mine(
        self, structure_ids: list[str], *, on_conflict: dict[str, str] | None = None, target: str = "mine"
    ) -> dict[str, Any]:
        """把別的集的結構合併進我的工作集（`target="mine"`）；
        回 `{target, merged:[{source_structure_id, action, structure_id}]}`。"""
        return self._post(
            f"/api/v1/cases/{self.case_id}/structure-sets/{target}/merge",
            {"structure_ids": structure_ids, "on_conflict": on_conflict or {}},
        )

    def claim(self, structure_id: str) -> str:
        """測試常用：把匯入集的一個結構合併進我的工作集，回**新的** structure_id（匯入集唯讀，要改先合併）。"""
        out = self.merge_into_mine([structure_id])
        return str(out["merged"][0]["structure_id"])

    # ── 版本鏈 ──────────────────────────────────────────────────────

    def versions(self, structure_id: str, *, frame: int | None = None) -> dict[str, Any]:
        return self._get(f"/api/v1/structures/{structure_id}/versions", frame=frame)

    def version_mask(self, structure_id: str, version_id: str):  # type: ignore[no-untyped-def]
        return self._get(f"/api/v1/structures/{structure_id}/versions/{version_id}/mask", mask_grid=self.mask_grid_id)

    def revert(self, structure_id: str, version_id: str, *, frame: int | None = None, note: str = "") -> dict[str, Any]:
        return self._post(
            f"/api/v1/structures/{structure_id}/revert",
            {"version_id": version_id, "frame_index": frame, "mask_grid_id": self.mask_grid_id, "note": note},
        )

    def review(self, statuses: dict[str, str], note: str = "") -> dict[str, Any]:
        return self._post(f"/api/v1/studies/{self._study}/review", {"structure_statuses": statuses, "note": note})

    def ops(self) -> list[dict[str, Any]]:
        return self._get("/api/v1/ops")

    # ── 視角、圖層、量測 ────────────────────────────────────────────────────

    def view_reference(
        self,
        *,
        plane_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
        view_plane_normal: tuple[float, float, float] = (0.0, 0.0, 1.0),
        view_up: tuple[float, float, float] = (0.0, -1.0, 0.0),
        slab_mm: float = 0.0,
        temporal_group_id: str | None = None,
        frame_index: int | None = None,
    ) -> dict[str, Any]:
        return {
            "frame_of_reference_uid": self.primary_frame_of_reference_uid,
            "display_grid_id": self.display_grid_id,
            "plane_origin": list(plane_origin),
            "view_plane_normal": list(view_plane_normal),
            "view_up": list(view_up),
            "slab_thickness_mm": slab_mm,
            "temporal_group_id": temporal_group_id,
            "frame_index": frame_index,
        }

    def set_camera(
        self,
        *,
        view_plane_normal: tuple[float, float, float] = (0.0, 0.0, 1.0),
        view_up: tuple[float, float, float] = (0.0, -1.0, 0.0),
        plane_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
        slab_mm: float = 0.0,
        viewport_id: str = "axial",
        frame_index: int | None = None,
    ) -> dict[str, Any]:
        """從腳本驅動視角，**含斜面**（`camera.set`）。"""
        return self._post(
            "/api/v1/_test/push",
            {
                "type": "camera.set",
                "payload": {
                    "viewportId": viewport_id,
                    "viewReference": self.view_reference(
                        plane_origin=plane_origin,
                        view_plane_normal=view_plane_normal,
                        view_up=view_up,
                        slab_mm=slab_mm,
                        frame_index=frame_index,
                    ),
                },
            },
        )

    def set_layer(self, target: str, **patch: Any) -> dict[str, Any]:
        """改圖層屬性（visible / opacity / renderStyle / order / color）。"""
        return self._post(
            "/api/v1/_test/push",
            {"type": "layer.update", "payload": {"layerId": target, **patch}},
        )

    def push_measurement(
        self,
        *,
        kind: MeasurementKind,
        points: list[tuple[float, float, float]],
        label: str,
        measurement_id: str | None = None,
        view_reference: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """建立一個量測。`points` 為 **LPS mm 世界座標**，非索引座標。

        `result` 刻意**不由驅動端給**：`result` 永遠由 `points` 重算，
        不得獨立儲存為真相。
        """
        measurement_id = measurement_id or f"m{len(self.state.get('measurements') or {}) + 1}"
        if kind == "area" and view_reference is None:
            view_reference = self.view_reference()
        return self._post(
            "/api/v1/_test/push",
            {
                "type": "layer.add",
                "payload": {
                    "kind": "measurement",
                    "contentRef": measurement_id,
                    "frameOfReferenceUid": self.primary_frame_of_reference_uid,
                    "measurement": {
                        "measurementId": measurement_id,
                        "kind": kind,
                        "label": label,
                        "frameOfReferenceUid": self.primary_frame_of_reference_uid,
                        "points": [list(p) for p in points],
                        "viewReference": view_reference,
                    },
                },
            },
        )

    def push_scene(self) -> dict[str, Any]:
        return self._post("/api/v1/_test/push", {"type": "scene.replace"})

    # ── 變換、重切、3D、匯出 ────────────────────────────────────────────────

    def create_transform(
        self,
        *,
        matrix_column_major: list[float],
        fixed_series_id: str | None = None,
        moving_series_id: str | None = None,
        kind: str = "rigid",
        apply_to_frame_group: bool = False,
    ) -> dict[str, Any]:
        """`apply_to_frame_group=True`：換掉 moving 序列的 FrameGroup 並推 scene.replace。"""
        return self._post(
            "/api/v1/transforms",
            {
                "kind": kind,
                "matrix": list(matrix_column_major),
                "fixed_series_id": fixed_series_id,
                "moving_series_id": moving_series_id,
                "apply_to_frame_group": apply_to_frame_group,
            },
        )

    # ── 量測 ────────────────────────────────────────────────

    def measurements(self) -> list[dict[str, Any]]:
        return self._get("/api/v1/measurements")

    def create_measurement(self, measurement: dict[str, Any]) -> dict[str, Any]:
        """回傳建立後的 `kind='measurement'` layer。"""
        return self._post("/api/v1/measurements", measurement)

    def update_measurement(self, measurement_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self._unwrap(
            self._client.patch(f"/api/v1/measurements/{measurement_id}", json=patch, headers=self._headers)
        )

    def delete_measurement(self, measurement_id: str) -> None:
        r = self._client.delete(f"/api/v1/measurements/{measurement_id}", headers=self._headers)
        if r.status_code >= 400:
            self._unwrap(r)

    def dvh(
        self,
        series_id: str,
        structure_ids: list[str],
        *,
        bins: int = 200,
        reference_gy: float | None = None,
        frame: int | None = None,
    ) -> dict[str, Any]:
        """`GET /api/v1/dose/{series_id}/dvh`。"""
        return self._get(
            f"/api/v1/dose/{series_id}/dvh",
            structure_ids=",".join(structure_ids),
            bins=bins,
            reference_gy=reference_gy,
            frame=frame,
        )

    def reslice(
        self,
        *,
        view_reference: dict[str, Any] | None = None,
        output_size_px: tuple[int, int] = (256, 256),
        interpolator: str = "bspline",
        px_mm: float | None = None,
    ):
        header, raw = self._post(
            f"/api/v1/studies/{self._study}/reslice",
            {
                "display_grid_id": self.display_grid_id,
                "view_reference": view_reference or self.view_reference(),
                "output_size_px": list(output_size_px),
                "interpolator": interpolator,
                "px_mm": px_mm,
            },
        )
        arr = np.frombuffer(raw, dtype=np.float32).reshape(header["height"], header["width"])
        return header, arr

    def render3d(
        self,
        *,
        layers: list[dict[str, Any]] | None = None,
        camera: dict[str, Any] | None = None,
        output_size_px: tuple[int, int] = (256, 256),
        crop: dict[str, Any] | None = None,
        zoom: float = 1.0,
        technique: str | None = None,
        mapper: str = "auto",
        distance_mm: float | None = None,
        interactive: bool = False,
    ):
        """`distance_mm`：相機距離；MIP 把它換成正交縮放（沒給 → 不縮放，舊行為）；VTK 用它擺相機（沒給 → 500）。
        `interactive`：拖曳中的那張（有 mesh 時不畫 volume）。"""
        series_id = self.grid_set["frame_groups"][0]["series_id"]
        header, png = self._post(
            f"/api/v1/studies/{self._study}/render3d",
            {
                "display_grid_id": self.display_grid_id,
                "camera": {
                    **(camera or self.view_reference()),
                    **({"distance_mm": distance_mm} if distance_mm is not None else {}),
                    "fov_deg": 30.0,
                },
                "technique": technique,
                "mapper": mapper,
                "interactive": interactive,
                "zoom": zoom,
                "crop": crop,
                "output_size_px": list(output_size_px),
                "layers": layers
                or [
                    {
                        "renderer": "volume-3d",
                        "series_id": series_id,
                        "window": {"center": 400.0, "width": 1800.0},
                        "opacity": 1.0,
                    }
                ],
            },
        )
        return header, png

    def render3d_pick(
        self,
        x: int,
        y: int,
        *,
        layers: list[dict[str, Any]],
        camera: dict[str, Any] | None = None,
        output_size_px: tuple[int, int] = (256, 256),
        distance_mm: float | None = None,
    ) -> dict[str, Any]:
        """反向 pick：同一組場景參數，點 (x, y) 像素 → `{hit, world}`。"""
        return self._post(
            f"/api/v1/studies/{self._study}/render3d/pick",
            {
                "display_grid_id": self.display_grid_id,
                "camera": {
                    **(camera or self.view_reference()),
                    **({"distance_mm": distance_mm} if distance_mm is not None else {}),
                    "fov_deg": 30.0,
                },
                "output_size_px": list(output_size_px),
                "layers": layers,
                "pick": {"x": x, "y": y},
            },
        )

    def export_rtstruct(self, structure_ids: list[str] | None = None) -> dict[str, Any]:
        return self._post(
            f"/api/v1/studies/{self._study}/export",
            {"format": "rtstruct", "structure_ids": structure_ids},
        )

    def job(self, job_id: str) -> dict[str, Any]:
        return self._get(f"/api/v1/jobs/{job_id}")

    def wait_for_job(self, job_id: str, *, timeout: float = 30.0) -> dict[str, Any]:
        import time

        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.job(job_id)
            if job.get("status") in ("done", "failed"):
                return job
            time.sleep(0.05)
        raise TimeoutError(f"job {job_id} 逾時")

    def download_job(self, job_id: str) -> bytes:
        r = self._client.get(f"/api/v1/jobs/{job_id}/download", headers=self._headers)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text}")
        return bytes(r.content)

    # ── 故障注入 ────────────────────────────────────────────────────────────

    def chaos(self, **modes: Any) -> dict[str, Any]:
        """開故障注入。`s.chaos(reset=True)` 全部關掉。"""
        return self._post("/api/v1/_test/chaos", modes)

    def chaos_state(self) -> dict[str, Any]:
        return self._get("/api/v1/_test/chaos")

    def close(self) -> None:
        if not self._owns_client:
            return
        if self._entered:
            self._entered = False
            self._client.__exit__(None, None, None)
            return
        close = getattr(self._client, "close", None)
        if close:
            close()

    def __enter__(self) -> Session:
        # 🔴 行程內模式一定要進 TestClient 的 context：不進的話 Starlette 會**每個請求開一個新的 event loop**，
        # asyncpg 的連線綁在第一個 loop 上，第二個請求就 "attached to a different loop"（實際踩過）。
        # 進了 context 也才會跑 lifespan（shutdown 時 dispose 引擎）。
        if self.base_url is None and self._owns_client and not self._entered:
            self._client.__enter__()
            self._entered = True
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
