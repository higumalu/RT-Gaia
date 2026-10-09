"""RT-Gaia plugin 參考 SDK —— 契約 v1。

三個角色各拿一組東西：

| 角色 | 用什麼 |
|---|---|
| 寫 plugin | `PluginApp`（plugin 端點）、`RunContext`（取輸入、報進度、交結果）、`BundleBuilder` |
| 驗 plugin | `rtgaia-plugin-check <endpoint>`（`check.py`：模擬宿主跑一遍） |
| 宿主 | `contract.py` 驗證器與 `geometry.py` —— 與 check 工具同一份，
|  | 宿主收包的行為因此與開發者本機看到的一致 |
"""

from __future__ import annotations

from .bundle import BundleBuilder
from .contract import (
    BundleRejection,
    ContractError,
    check_bundle_semantics,
    load_schema,
    validate_bundle_structure,
    validate_manifest,
)
from .geometry import grid_from_json, grid_to_json, grids_equal, read_nifti, write_nifti
from .host_client import HostCallback
from .server import PluginApp, RunContext, actor_from_request, require_role

__all__ = [
    "BundleBuilder",
    "BundleRejection",
    "ContractError",
    "HostCallback",
    "PluginApp",
    "RunContext",
    "actor_from_request",
    "require_role",
    "check_bundle_semantics",
    "grid_from_json",
    "grid_to_json",
    "grids_equal",
    "load_schema",
    "read_nifti",
    "validate_bundle_structure",
    "validate_manifest",
    "write_nifti",
]
