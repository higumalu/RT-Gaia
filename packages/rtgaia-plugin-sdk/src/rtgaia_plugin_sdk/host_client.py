"""宿主回呼 client。plugin 只透過它碰宿主；token 是 `RunRequest.callback.token`。"""

from __future__ import annotations

from typing import Any

import httpx


class HostCallback:
    def __init__(self, base_url: str, token: str, *, timeout_s: float = 120.0) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), headers={"Authorization": f"Bearer {token}"}, timeout=timeout_s
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HostCallback:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get_image_bytes(self) -> tuple[bytes, dict[str, str]]:
        r = self._client.get("/inputs/image")
        r.raise_for_status()
        return r.content, dict(r.headers)

    def list_structures(self) -> list[dict[str, Any]]:
        r = self._client.get("/inputs/structures")
        r.raise_for_status()
        return r.json()

    def get_structure_mask(self, structure_id: str, *, fmt: str = "nifti") -> bytes:
        r = self._client.get(f"/inputs/structures/{structure_id}", params={"format": fmt})
        r.raise_for_status()
        return r.content

    def progress(self, percent: float, phase: str | None = None) -> None:
        body: dict[str, Any] = {"percent": float(percent)}
        if phase:
            body["phase"] = phase
        self._client.post("/progress", json=body).raise_for_status()

    def results(self, bundle: dict[str, Any]) -> dict[str, Any]:
        r = self._client.post("/results", json=bundle)
        r.raise_for_status()
        return r.json()

    def done(self, *, status: str = "done", error: str | None = None) -> None:
        body: dict[str, Any] = {"status": status}
        if error:
            body["error"] = error
        self._client.post("/done", json=body).raise_for_status()

    def kv_get(self, key: str) -> Any | None:
        r = self._client.get(f"/kv/{key}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    def kv_put(self, key: str, value: Any) -> None:
        self._client.put(f"/kv/{key}", json=value).raise_for_status()

    def kv_delete(self, key: str) -> None:
        self._client.delete(f"/kv/{key}").raise_for_status()

    def audit(self, kind: str, payload: dict[str, Any]) -> None:
        self._client.post("/audit", json={"kind": kind, "payload": payload}).raise_for_status()
