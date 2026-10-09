#!/usr/bin/env python3
"""fixture 是否與後端同步 —— 以「有沒有**有意義的**差別」判定。

## 為什麼不能用 `git diff --exit-code`

那道檢查原本是「重跑 emit 腳本後不得有 diff」，而它在 CI 上失敗過兩次，
**兩次都不是因為漏跑腳本**：

    -            1.0                        ← 本機
    +            0.9999999999999716          ← GitHub runner
    -          -6.237918514405692
    +          -6.237918514405693
    -        "distance_mm": -15.980762113533158
    +        "distance_mm": -15.980762113533157

第一次以為只是 `np.linalg.inv`（LAPACK 實作不同），於是把那兩處的輸出量化到
1e-10。剩下的兩行推翻了那個理論：`to_primary_world` 是純矩陣乘、`distance_mm`
是內積，**任何 numpy 的矩陣乘或內積都可能差 1 ULP**（BLAS kernel、FMA、
向量化路徑在不同 CPU 上不同）。

而量化本質上是**機率性**的：兩個差 1 ULP 的值只要跨在量化邊界上，量化後仍然
不同。要一個浮點管線在不同機器上逐位元組相同，不是調參數就能達成的事。

**該修的是檢查本身。** 這道檢查真正要抓的是「後端改了幾何卻忘記重跑 emit
腳本」——不是浮點的最後一位。因此改成結構比對 ＋ 數值容差。

## 容差的選法

    |a - b| <= ATOL + RTOL * max(|a|, |b|)

`ATOL = 1e-9` 對齊前端逐條斷言的容差（`geometry-consistency.test.ts` 的 `TOL`）：
**前端容忍得了的差別，這裡也容忍**——比它大的才是真的變化。`RTOL = 1e-12`
處理大數值：座標可以到 ~350 mm，那裡 1 ULP 是 5.7e-14，固定容差會顯得太緊。

反過來說：小於 1e-9 的真實變化這裡會漏掉 —— 但那樣的變化**前端的斷言也分辨
不出來**，依這個專案自己的定義它就不是有意義的變化。兩道檢查因此是一致的。

## 什麼東西逐位元組比

chaos 的 `.bin` 是整數 payload（wire 框架 ＋ 體素），沒有浮點運算，因此**必須**
逐位元組相同。實測在 CI 上也確實相同。

## 重跑

    uv run python scripts/check-fixture-sync.py --self-test   # 檢查器自己的測試
    uv run python scripts/emit-geometry-fixture.py
    uv run python scripts/emit-chaos-fixtures.py
    uv run python scripts/check-fixture-sync.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path("apps/viewer/tests/fixtures")

# 見模組 docstring 的「容差的選法」
ATOL = 1e-9
RTOL = 1e-12


def close(a: float, b: float) -> bool:
    return abs(a - b) <= ATOL + RTOL * max(abs(a), abs(b))


def diff_json(old: Any, new: Any, path: str = "") -> list[str]:
    """結構相同、字串／整數相等、浮點在容差內 —— 回傳有意義的差別。"""
    where = path or "(root)"

    # bool 必須先判：Python 的 bool 是 int 的子類別
    if isinstance(old, bool) or isinstance(new, bool):
        return [] if old is new else [f"{where}: {old!r} → {new!r}"]

    if isinstance(old, (int, float)) and isinstance(new, (int, float)):
        # 整數對整數要完全相等（bytes 計數、size、體素值都不是量測結果）
        if isinstance(old, int) and isinstance(new, int):
            return [] if old == new else [f"{where}: {old} → {new}"]
        if close(float(old), float(new)):
            return []
        return [f"{where}: {old!r} → {new!r}（差 {abs(float(new) - float(old)):.3g}）"]

    if type(old) is not type(new):
        return [f"{where}: 型別改變 {type(old).__name__} → {type(new).__name__}"]

    if isinstance(old, dict):
        out: list[str] = []
        for key in sorted(set(old) - set(new)):
            out.append(f"{where}.{key}: 欄位消失")
        for key in sorted(set(new) - set(old)):
            out.append(f"{where}.{key}: 新增欄位（值 {new[key]!r}）")
        for key in sorted(set(old) & set(new)):
            out += diff_json(old[key], new[key], f"{path}.{key}" if path else key)
        return out

    if isinstance(old, list):
        if len(old) != len(new):
            return [f"{where}: 長度 {len(old)} → {len(new)}"]
        out = []
        for n, (a, b) in enumerate(zip(old, new, strict=True)):
            out += diff_json(a, b, f"{path}[{n}]")
        return out

    return [] if old == new else [f"{where}: {old!r} → {new!r}"]


def committed(rel: Path) -> bytes | None:
    """HEAD 版本的內容；檔案在 HEAD 不存在時回 None。"""
    r = subprocess.run(
        ["git", "show", f"HEAD:{rel.as_posix()}"],
        cwd=ROOT,
        capture_output=True,
    )
    return r.stdout if r.returncode == 0 else None


# emit 腳本不產生它 —— 它是給人看的說明。兩側都要排除，否則它會被誤報成
# 「進版控但重跑後不存在」（第一版就是這樣，只排除了磁碟那一側）。
NOT_GENERATED = {"README.md"}


def tracked_fixture_paths() -> list[Path]:
    r = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", FIXTURES.as_posix()],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return [Path(line) for line in r.stdout.splitlines() if line.strip() and Path(line).name not in NOT_GENERATED]


def check() -> int:
    problems: list[str] = []

    on_disk = {p.relative_to(ROOT) for p in (ROOT / FIXTURES).rglob("*") if p.is_file() and p.name not in NOT_GENERATED}
    in_head = set(tracked_fixture_paths())

    for rel in sorted(in_head - on_disk):
        problems.append(f"{rel}: 進版控但重跑後不存在（fixture 被移除了？）")
    for rel in sorted(on_disk - in_head):
        problems.append(f"{rel}: 重跑後產生了新檔案，但沒有進版控 —— 請 git add")

    for rel in sorted(on_disk & in_head):
        old_bytes = committed(rel)
        new_bytes = (ROOT / rel).read_bytes()
        if old_bytes is None:
            problems.append(f"{rel}: 取不到 HEAD 版本")
            continue
        if rel.suffix == ".json":
            try:
                deltas = diff_json(json.loads(old_bytes), json.loads(new_bytes))
            except json.JSONDecodeError as exc:
                problems.append(f"{rel}: JSON 解析失敗 {exc}")
                continue
            problems += [f"{rel}: {d}" for d in deltas]
        elif old_bytes != new_bytes:
            # 整數 payload，沒有浮點運算 → 必須逐位元組相同
            if len(old_bytes) != len(new_bytes):
                detail = f"長度 {len(old_bytes)} → {len(new_bytes)} bytes"
            else:
                at = next(n for n, (a, b) in enumerate(zip(old_bytes, new_bytes, strict=True)) if a != b)
                detail = f"{len(new_bytes)} bytes，第一個不同的位元組在 offset {at}"
            problems.append(f"{rel}: 位元組不同（{detail}）")

    if not problems:
        print(f"✓ fixture 與後端同步（比對 {len(on_disk & in_head)} 個檔案）")
        return 0

    print("::error::fixture 與後端不同步。請重跑 scripts/emit-*.py 並提交結果。")
    for p in problems[:60]:
        print(f"  {p}")
    if len(problems) > 60:
        print(f"  …另有 {len(problems) - 60} 項")
    return 1


# ── 檢查器自己的測試 ────────────────────────────────────────────────────────
#
# 🔴 **一道會擋 CI 的檢查必須自己被測過。** 這個檔案的整個存在理由是「哪些差別
# 算有意義」，而那條線畫錯的兩種後果都很糟：畫太鬆會放過真的漂移（就是它要防
# 的東西），畫太緊會讓 CI 永遠是紅的（就是它取代的那個實作）。
SELF_TESTS: list[tuple[str, Any, Any, bool]] = [
    ("完全相同", {"a": 1.5}, {"a": 1.5}, True),
    ("1 ULP（實際在 CI 上發生的）", {"a": -6.237918514405692}, {"a": -6.237918514405693}, True),
    ("1.0 vs 0.9999999999999716", {"a": 1.0}, {"a": 0.9999999999999716}, True),
    ("0.0 vs 2.8e-14", {"a": 0.0}, {"a": 2.842170943040401e-14}, True),
    ("大數值的 1 ULP", {"a": 350.00000000000006}, {"a": 350.0}, True),
    ("1e-9 剛好在容差邊上", {"a": 0.0}, {"a": 9e-10}, True),
    ("🔴 真的變化 1e-6", {"a": 0.0}, {"a": 1e-6}, False),
    ("🔴 真的變化 1e-3", {"a": 12.5}, {"a": 12.501}, False),
    ("🔴 整數不吃容差", {"bytes": 49644}, {"bytes": 49645}, False),
    ("🔴 欄位新增（例：mask_grid_id）", {"a": 1}, {"a": 1, "mask_grid_id": None}, False),
    ("🔴 欄位消失", {"a": 1, "b": 2}, {"a": 1}, False),
    ("🔴 長度改變", {"a": [1, 2]}, {"a": [1, 2, 3]}, False),
    ("🔴 型別改變", {"a": "1.0"}, {"a": 1.0}, False),
    ("🔴 字串改變（UID 改名那次）", {"uid": "RTATLAS.X"}, {"uid": "RTGAIA.X"}, False),
    ("巢狀容差", {"a": {"b": [{"c": 1.0}]}}, {"a": {"b": [{"c": 1.0000000000001}]}}, True),
    ("🔴 巢狀真變化", {"a": {"b": [{"c": 1.0}]}}, {"a": {"b": [{"c": 1.1}]}}, False),
    ("null 相等", {"a": None}, {"a": None}, True),
    ("🔴 null → 值", {"a": None}, {"a": 0.0}, False),
    ("bool 不被當成整數", {"a": True}, {"a": True}, True),
    ("🔴 bool 改變", {"a": True}, {"a": False}, False),
]


def self_test() -> int:
    failures = 0
    for label, old, new, expect_same in SELF_TESTS:
        deltas = diff_json(old, new)
        same = not deltas
        ok = same == expect_same
        failures += 0 if ok else 1
        mark = "✓" if ok else "✗"
        print(f"[{mark}] {label}：{'無差別' if same else deltas[0]}")
    print()
    if failures:
        print(f"{failures} 項不符預期")
        return 1
    print(f"全部 {len(SELF_TESTS)} 項符合預期")
    return 0


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else check())
