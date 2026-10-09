"""在檢視器裡把同一個病例的影像組成時間軸、拆回多張影像、攤開成每一幀一張影像。

用途：把左邊欄位多個相位的影像組成 4D 觀看，在檢視器裡當影片播放、看／標記 ROI。

**不換病例**：時間軸怎麼組是病例選取的一部分（`CaseSelection.temporal_assemblies`／`temporal_overrides`／
`temporal_views`），改它 → 同一個 `case_id` 原地重組資料集（`AppState.reassemble_case`）。結構、版本、簽核、量測、
對位都留著；selection hash 不變（從資料頁用原本的選取開，回到的是組成後的這個病例）。

這裡只做**驗證與算出新的選取**（純函式、不碰 IO）；重組與推送在 API 層。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from rtgaia_geom import ContractViolation

from .loaders.case import ASSEMBLY_AXES, ASSEMBLY_KEY_PREFIX, CaseSelection, assembly_key


def _same_grid(a: Any, b: Any) -> bool:
    return (
        tuple(a.size) == tuple(b.size)
        and np.allclose(a.spacing, b.spacing, atol=1e-3)
        and np.allclose(a.origin, b.origin, atol=1e-2)
        and np.allclose(a.direction, b.direction, atol=1e-4)
    )


def _name(s: Any) -> str:
    desc = str((s.meta or {}).get("series_description") or "").strip()
    return " ".join(x for x in (str(s.modality), desc) if x) or s.series_id


def _selection(case: Any) -> CaseSelection:
    """病例目前的選取；primary 釘住目前這一張 —— 沒指定時開病例會自動挑（有 4D 組就用它），組成／拆開之後
    就可能換成另一張，顯示網格跟著換（結構的 MaskGrid 另外由 `keep_mask_grids` 保住）。"""
    if not case.selection_hash or not case.selection:
        raise ContractViolation("TA14", "只有從資料庫開的病例能在檢視器裡組成或拆開時間軸")
    sel = CaseSelection.from_wire(case.selection)
    sel.primary_series_uid = case.dataset.primary.series_id
    return sel


def compose_selection(
    case: Any, series_uids: list[str], labels: list[str] | None, axis: str, *, resample: bool = False
) -> tuple[dict[str, Any], str]:
    """把病例裡幾張**單張影像**照這個順序組成一條時間軸 → (新的選取, 時間軸 key)。

    規則：同一個 Frame of Reference、同樣的網格（大小、間距、位置、方向）才是同一個物件的時間軸；
    已經在別的時間軸裡的、序列內分幀的、劑量都不行。
    """
    sel = _selection(case)
    uids = [str(u) for u in series_uids]
    if len(uids) < 2:
        raise ContractViolation("TA10", "至少要選兩張影像才能組成時間軸")
    if len(set(uids)) != len(uids):
        raise ContractViolation("TA10", "同一張影像選了兩次")
    if axis not in ASSEMBLY_AXES:
        raise ContractViolation("TA10", "時間軸的種類只能是相位（phase）或時間（time）", axis=axis)
    if labels is not None and len(labels) != len(uids):
        raise ContractViolation("TA10", "每一幀的名稱數量要跟影像數量一樣")
    static = {s.series_id: s for s in case.dataset.image_series if s.temporal_group_id is None}
    in_timeline = {u for s in case.dataset.image_series for u in s.frame_series_uids}
    # 勾了重新取樣 → 選取裡、但自己開不起來的影像（例：缺一片 → 間距不均勻）也可以放進來，
    # 由載入器逐片內插到第一幀的網格；放不進去的由 API 層退回原選取（TA13）
    unloadable = {u for u in sel.image_series_uids if u not in static and u not in in_timeline} if resample else set()
    for u in uids:
        if u in unloadable:
            continue
        if u not in static:
            known = next((s for s in case.dataset.series if s.series_id == u), None)
            what = f"「{_name(known)}」" if known is not None else u
            raise ContractViolation(
                "TA11", f"影像{what}不是這個病例裡的單張影像（已經在時間軸裡、序列內分幀、或不是影像）", series=u
            )
    if uids[0] not in static:
        raise ContractViolation("TA11", "第一幀要是這個病例裡開得起來的影像（其他幀以它的網格為準）", series=uids[0])
    first = static[uids[0]]
    for u in uids[1:]:
        if u in unloadable:
            continue
        s = static[u]
        if s.frame_of_reference_uid != first.frame_of_reference_uid:
            raise ContractViolation(
                "TA12",
                f"「{_name(s)}」跟「{_name(first)}」不在同一個 Frame of Reference："
                "時間軸的每一幀要是同一次定位的同一個空間",
                series=u,
            )
        if not resample and not _same_grid(s.grid, first.grid):
            raise ContractViolation(
                "TA13",
                f"「{_name(s)}」的網格跟「{_name(first)}」不同：時間軸的每一幀要同樣的大小、間距、位置與方向",
                series=u,
            )
    key = assembly_key(uids)
    sel.temporal_assemblies = [a for a in sel.temporal_assemblies if assembly_key(a["series_uids"]) != key]
    assembly: dict[str, Any] = {
        "series_uids": uids,
        "labels": [str(v or "") for v in labels] if labels else None,
        "axis": axis,
    }
    if resample:
        assembly["resample"] = True  # 網格不同的幀重新取樣到第一幀的網格
    sel.temporal_assemblies.append(assembly)
    return sel.to_wire(), key


def frame_specific_structures(case: Any, temporal_group_id: str) -> int:
    """這條時間軸上只屬某一幀的結構有幾個（同一個結構畫在幾幀算幾個）。"""
    return sum(
        1 for st in case.structures.values() if st.temporal_group_id == temporal_group_id and st.frame_index is not None
    )


def dissolve_selection(case: Any, temporal_group_id: str) -> dict[str, Any]:
    """把一條時間軸拆回多張影像 → 新的選取。

    手動組成的 → 拿掉那一條；資料頁自動合併的 → `temporal_overrides[key] = "split"`
    （跟資料頁取消「合併成時間軸」一樣）。
    擋下的情況：序列內分幀（本來就是一個序列，拆不成多張）、有只屬某一幀的結構（拆開後沒有「幀」可以掛 ——
    要分開看每一幀用「攤開成 3D」，結構跟著作用中的那一幀）。
    """
    sel = _selection(case)
    if not any(g.temporal_group_id == temporal_group_id for g in case.temporal_groups):
        raise ContractViolation("TA15", "這個病例沒有這條時間軸", temporal_group_id=temporal_group_id)
    series = next((s for s in case.dataset.image_series if s.temporal_group_id == temporal_group_id), None)
    if series is None or len(set(series.frame_series_uids)) < 2:
        raise ContractViolation(
            "TA17", "這條時間軸來自同一個序列（序列內分幀），不能拆成多張影像；要分開看每一幀請用「攤開成 3D」"
        )
    n = frame_specific_structures(case, temporal_group_id)
    if n:
        raise ContractViolation(
            "TA16",
            f"這條時間軸上有 {n} 個只屬某一幀的結構，拆開後它們就沒有相位可以對應；要分開看每一幀請用「攤開成 3D」",
            count=n,
        )
    if temporal_group_id.startswith(ASSEMBLY_KEY_PREFIX):
        sel.temporal_assemblies = [
            a for a in sel.temporal_assemblies if assembly_key(a["series_uids"]) != temporal_group_id
        ]
    else:
        sel.temporal_overrides[temporal_group_id] = "split"
    sel.temporal_views.pop(temporal_group_id, None)
    return sel.to_wire()


MAX_EXPANDED_FRAMES = 100
"""攤開成 3D 最多幾幀：每一幀是左欄一列、scene.replace 裡一個圖層（約 1 KB），100 幀約 105 KB，
跟結構圖層一起仍在推送上限 256 KB 內；更長的（cine 150 幀）用每一格的「相位」選單看單一幀。"""


def view_selection(case: Any, temporal_group_id: str, mode: str) -> dict[str, Any]:
    """`expanded`：攤開成每一幀一張獨立影像；`timeline`：收回成一條時間軸。只改圖層，不改資料集。"""
    sel = _selection(case)
    tg = next((g for g in case.temporal_groups if g.temporal_group_id == temporal_group_id), None)
    if tg is None:
        raise ContractViolation("TA15", "這個病例沒有這條時間軸", temporal_group_id=temporal_group_id)
    if mode == "expanded":
        count = tg.frame_count or 1
        if count > MAX_EXPANDED_FRAMES:
            raise ContractViolation(
                "TA18",
                f"這條時間軸有 {count} 幀，攤開成 3D 最多 {MAX_EXPANDED_FRAMES} 幀；"
                "要看單一幀請用每一格的「相位」選單鎖定",
                count=count,
            )
        sel.temporal_views[temporal_group_id] = "expanded"
    elif mode == "timeline":
        sel.temporal_views.pop(temporal_group_id, None)
    else:
        raise ContractViolation("TA10", "mode 只能是 expanded 或 timeline", mode=mode)
    return sel.to_wire()


def resample_selection(case: Any, temporal_group_id: str, enabled: bool) -> dict[str, Any]:
    """網格跟第一幀不同的相位 —— `enabled` 重新取樣補進來／否則照舊排除（預設）。

    自動時間軸 → `temporal_resample` 加／拿掉這個 key；手動組成的 → 那一條的 `resample` 旗標。key 不變；
    幀號變了（插回中間的相位）由 `reassemble_case` 依序列 UID 對應。"""
    sel = _selection(case)
    if not any(g.temporal_group_id == temporal_group_id for g in case.temporal_groups):
        raise ContractViolation("TA15", "這個病例沒有這條時間軸", temporal_group_id=temporal_group_id)
    if temporal_group_id.startswith(ASSEMBLY_KEY_PREFIX):
        for a in sel.temporal_assemblies:
            if assembly_key(a["series_uids"]) == temporal_group_id:
                if enabled:
                    a["resample"] = True
                else:
                    a.pop("resample", None)
    elif enabled:
        sel.temporal_resample = list(dict.fromkeys([*sel.temporal_resample, temporal_group_id]))
        # 資料頁勾這一組時不一定把被排除的相位也選進來 → 補進選取（改回排除時留著無妨：被排除的相位不會單獨開）
        series = next((s for s in case.dataset.image_series if s.temporal_group_id == temporal_group_id), None)
        plan = (series.meta or {}).get("temporal") if series is not None else None
        extra = [str(x["series_uid"]) for x in (plan or {}).get("excluded") or [] if x.get("series_uid")]
        sel.image_series_uids = list(dict.fromkeys([*sel.image_series_uids, *extra]))
    else:
        sel.temporal_resample = [k for k in sel.temporal_resample if k != temporal_group_id]
    return sel.to_wire()
