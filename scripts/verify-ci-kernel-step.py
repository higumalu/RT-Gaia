#!/usr/bin/env python3
"""把 ci.yml 裡「核心就位」那兩步的 shell 抽出來，在三種 artifact 佈局下實跑。

GitHub 的 `run:` 預設 shell 是 `bash -e {0}`，因此 `[ -f x ] && mv` 這種寫法
在測試失敗時會讓整個步驟以非零離開 —— 那個坑只有真的用 -e 跑過才會發現。
"""

import pathlib
import subprocess
import sys
import tempfile

import yaml

SO = "packages/rtgaia-geom/src/rtgaia_geom/_native/librtgaia_reslice.so"
WASM = "apps/viewer/public/rtgaia_reslice.wasm"

spec = yaml.safe_load(open(".github/workflows/ci.yml"))
steps = {}
for job, jspec in spec["jobs"].items():
    for st in jspec["steps"]:
        if isinstance(st, dict) and str(st.get("name", "")).startswith("核心就位"):
            steps[job] = st["run"]
assert set(steps) == {"python", "viewer"}, steps

LAYOUTS = {
    "nested（download-artifact 的實際行為）": [SO, WASM],
    "flat（萬一 action 改成扁平）": ["librtgaia_reslice.so", "rtgaia_reslice.wasm"],
    "missing（artifact 沒放進來 —— 必須失敗）": [],
}
EXPECT = {
    ("python", "nested（download-artifact 的實際行為）"): 0,
    ("python", "flat（萬一 action 改成扁平）"): 0,
    ("python", "missing（artifact 沒放進來 —— 必須失敗）"): 1,
    ("viewer", "nested（download-artifact 的實際行為）"): 0,
    ("viewer", "flat（萬一 action 改成扁平）"): 0,
    ("viewer", "missing（artifact 沒放進來 —— 必須失敗）"): 1,
}

failures = 0
for job, script in sorted(steps.items()):
    for label, files in LAYOUTS.items():
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            for f in files:
                p = root / f
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"\0" * 1234)
            sh = root / "step.sh"
            sh.write_text(script)
            r = subprocess.run(["bash", "-e", str(sh)], cwd=root, capture_output=True, text=True)
            want = EXPECT[(job, label)]
            ok = r.returncode == want
            failures += 0 if ok else 1
            print(f"[{'✓' if ok else '✗'}] {job:7s} {label}  exit={r.returncode} (want {want})")
            for line in (r.stdout + r.stderr).strip().splitlines():
                # 🔴 被測的步驟自己會印 `::error::` —— 那是它該做的事，但這支腳本
                # 跑在 GitHub 上時，那幾行會變成**這次執行的錯誤註記**，於是一個
                # 完全正常的綠燈掛著三個紅色錯誤。轉義掉工作流程指令的前綴。
                print(f"        {line.replace('::', '∷')}")
            if want == 0:
                # 成功時檔案必須真的在該在的位置
                need = [SO] if job == "python" else [SO, WASM]
                for f in need:
                    if not (root / f).is_file():
                        print(f"        ✗ 步驟成功了，但 {f} 不在位置上")
                        failures += 1

print()
print("全部符合預期" if failures == 0 else f"{failures} 項不符預期")
sys.exit(1 if failures else 0)
