"""Tier 判定與網格決策。

> 這個設計把「記憶體決策放在後端」這條原則變成機制：**前端只回報自己放得下
> 多少，網格由後端決定。前端不得自行降採樣。**

## 裁決優先序

    使用者手動覆寫  >  後端否決  >  前端探針建議

後端**只能下調，不能上調**——它不知道客戶端真實算力。

## ⚠️ 412 的語意：原設計前後不一致，此處的處理方式

原設計一處寫 `→ 412 { reason: "software_rendering" | "no_webgl2" }`（標為
「Tier C」），另一處寫「**加入 Tier C 之後，不再有「拒絕啟動」的情況**」。
兩者字面矛盾。本實作的取法：

* 前端建議 Tier C，或誠實回報無 WebGL2 → **200，`assigned_tier="C"`**（不拒絕）
* 前端**建議 A/B 但回報的能力與之矛盾**（無 WebGL2／軟體渲染／探針 < 10 fps）
  → **412**，body 同時帶 `reason`、`diagnostics` 與 `assigned_tier="C"`

如此 412 存在且可測，又沒有人被拒絕服務：前端收到
412 就知道「我猜錯了，改走 CPU 路徑」，且不必再打一次請求。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from rtgaia_geom import DisplayGrid, Tier
from rtgaia_geom.grid import Grid, Int3

TierSource = Literal["probe", "backend", "manual"]

IMAGE_BUDGET_BYTES: dict[Tier, tuple[int, int]] = {
    # (單影像, 雙影像以上)，單位 byte
    "A": (1_200_000_000, 1_800_000_000),
    "B": (400_000_000, 550_000_000),
    "C": (1_000_000_000, 1_600_000_000),
}

MASK_BUDGET_BYTES: dict[Tier, tuple[int, int]] = {
    # ⚠️ outline 成為預設之後，Tier A/B 這一列在 GPU 上
    # 已經不對應任何東西（outline 的 GPU 常駐 ≈ 0）。真正需要配額的是
    # **CPU 端的 mask 體素常駐**（編輯與 marching squares 都要它）。
    # 因此此處一律當作 **CPU 端**配額解讀，三個 Tier 都適用。
    "A": (1_200_000_000, 800_000_000),
    "B": (300_000_000, 250_000_000),
    "C": (2_000_000_000, 1_600_000_000),
}

MIN_PROBE_FPS = {"A": 30.0, "B": 10.0}


@dataclass(frozen=True)
class ClientCapability:
    """`POST /grids` 的 `client_capability`。"""

    webgl2: bool = True
    max_texture_3d: int = 2048
    has_norm16: bool = True
    renderer_string: str = ""
    looks_software: bool = False
    probe_alloc_mb: int = 2800
    probe_fps: float = 60.0
    tier: Tier | None = None

    @classmethod
    def from_wire(cls, d: dict[str, Any] | None) -> ClientCapability:
        d = d or {}
        return cls(
            webgl2=bool(d.get("webgl2", True)),
            max_texture_3d=int(d.get("max_texture_3d", 2048)),
            has_norm16=bool(d.get("has_norm16", True)),
            renderer_string=str(d.get("renderer_string", "")),
            looks_software=bool(d.get("looks_software", False)),
            probe_alloc_mb=int(d.get("probe_alloc_mb", 2800)),
            probe_fps=float(d.get("probe_fps", 60.0)),
            tier=d.get("tier"),
        )

    @property
    def hard_capability_tier(self) -> Tier:
        """硬性能力上限。**使用者覆寫也不得超越它**。"""
        if not self.webgl2 or self.looks_software or self.probe_fps < 10.0:
            return "C"
        if self.probe_fps < MIN_PROBE_FPS["A"]:
            return "B"
        return "A"


@dataclass(frozen=True)
class TierDecision:
    assigned: Tier
    source: TierSource
    reason: str
    conflict: bool
    """True = 前端建議與其自報能力矛盾 → HTTP 412（見模組開頭）。"""
    diagnostics: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {
            "assigned_tier": self.assigned,
            "source": self.source,
            "reason": self.reason,
            "diagnostics": self.diagnostics,
        }


def decide_tier(cap: ClientCapability, *, manual_override: Tier | None = None) -> TierDecision:
    hard = cap.hard_capability_tier
    diagnostics = {
        "webgl2": cap.webgl2,
        "looks_software": cap.looks_software,
        "renderer_string": cap.renderer_string,
        "probe_fps": cap.probe_fps,
        "max_texture_3d": cap.max_texture_3d,
        "has_norm16": cap.has_norm16,
        "hard_capability_tier": hard,
        "suggested_tier": cap.tier,
    }
    if manual_override is not None:
        # 使用者覆寫最高，但不得超越硬性能力
        rank = {"C": 0, "B": 1, "A": 2}
        if rank[manual_override] > rank[hard]:
            return TierDecision(
                assigned=hard,
                source="backend",
                reason=f"手動覆寫 {manual_override} 超越硬性能力（{hard}），已回退",
                conflict=False,
                diagnostics=diagnostics,
            )
        return TierDecision(
            assigned=manual_override,
            source="manual",
            reason="使用者手動指定",
            conflict=False,
            diagnostics=diagnostics,
        )

    suggested = cap.tier
    if suggested in ("A", "B") and hard == "C":
        reason = (
            "no_webgl2" if not cap.webgl2 else "software_rendering" if cap.looks_software else "probe_below_threshold"
        )
        return TierDecision(
            assigned="C",
            source="backend",
            reason=reason,
            conflict=True,
            diagnostics=diagnostics,
        )
    if suggested is None:
        return TierDecision(hard, "probe", "前端未提供建議，以能力偵測為準", False, diagnostics)
    rank = {"C": 0, "B": 1, "A": 2}
    if rank[suggested] > rank[hard]:
        return TierDecision(hard, "backend", "後端下調至硬性能力上限", False, diagnostics)
    return TierDecision(suggested, "probe", "採用前端探針建議", False, diagnostics)


def _bytes_for(grid: Grid, factor: Int3, *, bytes_per_voxel: int) -> int:
    n = 1
    for i in range(3):
        n *= max(1, grid.size[i] // factor[i])
    return n * bytes_per_voxel


def choose_downsample(
    grids: list[Grid],
    *,
    tier: Tier,
    cap: ClientCapability,
    extra_resident_bytes: int = 0,
) -> tuple[Int3, dict[str, Any]]:
    """為**整組序列**選一個共用的降採樣倍率（這也是 `series_ids` 必填的原因）。

    🔴 **只降 x/y，最後才降 z。** 切面方向的解析度直接決定輪廓與編輯的品質，
    而 CT 的 z 本來就較粗（3 mm）——先降 z 會讓斜面階梯 artifact 惡化。
    """
    per_voxel = 2 if cap.has_norm16 else 4  # 缺 EXT_texture_norm16 → int16 以 float32 上傳
    if tier == "C":
        per_voxel = 2  # CPU 路徑沒有 texture，就是 int16 本身
    budget = IMAGE_BUDGET_BYTES[tier][0 if len(grids) <= 1 else 1]
    factor: list[int] = [1, 1, 1]
    ladder = [(0, 1), (1, 1), (0, 1), (1, 1), (2, 1)]  # x, y, x, y, z 依序加倍
    notes: dict[str, Any] = {"budget_bytes": budget, "bytes_per_voxel": per_voxel}

    def total() -> int:
        # `extra_resident_bytes`：不跟著降採樣的常駐物（劑量網格是 float32、本來就粗）
        return extra_resident_bytes + sum(
            _bytes_for(g, (factor[0], factor[1], factor[2]), bytes_per_voxel=per_voxel) for g in grids
        )

    steps = 0
    while total() > budget and steps < 12:
        axis, _ = ladder[steps % len(ladder)]
        factor[axis] *= 2
        steps += 1
    # texture 邊長上限（Tier A/B 才有意義）
    if tier in ("A", "B"):
        for axis in range(3):
            while max(g.size[axis] // factor[axis] for g in grids) > cap.max_texture_3d:
                factor[axis] *= 2
    notes["resident_bytes"] = total()
    notes["downsample_steps"] = steps
    return (factor[0], factor[1], factor[2]), notes


def display_grid_for(
    primary: Grid,
    others: list[Grid],
    *,
    tier: Tier,
    cap: ClientCapability,
    extra_resident_bytes: int = 0,
) -> tuple[DisplayGrid, dict[str, Any]]:
    """整組共用的 display grid（**不是每個序列一個**）。

    網格由**主序列**決定；其餘序列以 FrameGroup 的變換對齊到它，
    而不是各自重採樣成各自的網格。
    """
    factor, notes = choose_downsample([primary, *others], tier=tier, cap=cap, extra_resident_bytes=extra_resident_bytes)
    dg = DisplayGrid.derive(primary, downsample_factor=factor, dtype="int16")
    notes["mask_budget_bytes"] = MASK_BUDGET_BYTES[tier][0 if not others else 1]
    return dg, notes
