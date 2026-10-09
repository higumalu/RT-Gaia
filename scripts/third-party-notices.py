"""Generate THIRD_PARTY_NOTICES.md from the lock files and the installed package metadata.

Run from the repository root after `uv sync --all-packages` and `npm ci` in apps/viewer:

    uv run python scripts/third-party-notices.py            # rewrite THIRD_PARTY_NOTICES.md
    uv run python scripts/third-party-notices.py --check    # exit 1 if the file is out of date

Sources:
- Python: `uv export --all-packages --no-dev --frozen` (what `deploy/Dockerfile` installs), licenses from the
  installed distributions (License-Expression, then License, then trove classifiers).
- Frontend: non-dev entries of `apps/viewer/package-lock.json` (what the production bundle contains).
- Rust: `cargo metadata` of `packages/rtgaia-reslice` (normal dependencies only).
Licenses that need a closer look (copyleft or unknown) are listed in their own section.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from importlib import metadata
from pathlib import Path

from packaging.markers import Marker
from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD_PARTY_NOTICES.md"
REVIEW = re.compile(r"\b(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|CC-BY-NC|Unknown)\b", re.IGNORECASE)

# Trove classifiers → SPDX, for distributions that declare nothing better.
CLASSIFIERS = {
    "Apache Software License": "Apache-2.0",
    "BSD License": "BSD",
    "MIT License": "MIT",
    "MIT No Attribution License (MIT-0)": "MIT-0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
    "The Unlicense (Unlicense)": "Unlicense",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0",
}

# Markers are evaluated for the runtime image (python:3.12 on Linux), not for the interpreter running this script.
IMAGE_ENV = {
    "python_version": "3.12",
    "python_full_version": "3.12.0",
    "implementation_name": "cpython",
    "platform_python_implementation": "CPython",
    "sys_platform": "linux",
    "platform_system": "Linux",
    "os_name": "posix",
}

CONTAINERS = [
    ("python:3.12-slim-bookworm", "Runtime image (API, worker, DICOM receiver)",
     "PSF-2.0 (Python); Debian packages under their own licenses"),
    ("nginx:1.27-alpine", "`web` image (static frontend, reverse proxy)",
     "BSD-2-Clause (nginx); Alpine packages under their own licenses"),
    ("postgres:16", "Database service in `deploy/docker-compose.yml`", "PostgreSQL License"),
    ("rust:1.83-bookworm, node:22-bookworm", "Build stages only; not part of the shipped images",
     "MIT / Apache-2.0 (Rust), MIT (Node.js)"),
]


def python_packages() -> list[tuple[str, str, str, str]]:
    exported = subprocess.run(
        ["uv", "export", "--all-packages", "--no-dev", "--frozen", "--format", "requirements-txt",
         "--no-hashes", "--no-header", "--no-annotate", "--no-emit-workspace"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    rows = []
    for line in exported.splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "-")):
            continue
        req = Requirement(line)
        if req.marker is not None and not Marker(str(req.marker)).evaluate(IMAGE_ENV):
            continue
        version = next(iter(req.specifier)).version
        rows.append((req.name, version, *python_license(req.name)))
    return sorted(rows, key=lambda r: r[0].lower())


def python_license(name: str) -> tuple[str, str]:
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        return "Unknown (not installed; run uv sync --all-packages)", ""
    meta = dist.metadata
    url = meta.get("Home-page") or ""
    for entry in meta.get_all("Project-URL") or []:
        label, _, link = entry.partition(",")
        if label.strip().lower() in {"homepage", "home", "source", "source code", "repository"}:
            url = link.strip()
            break
    expression = (meta.get("License-Expression") or "").strip()
    if expression:
        return expression, url
    declared = (meta.get("License") or "").strip()
    if declared and "\n" not in declared and len(declared) <= 60 and declared.upper() != "UNKNOWN":
        return declared, url
    found = [CLASSIFIERS.get(c.split(" :: ")[-1], c.split(" :: ")[-1])
             for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    found = [f for f in found if f != "OSI Approved"]
    if found:
        return " OR ".join(dict.fromkeys(found)), url
    return "Unknown (see the project's license file)", url


def npm_packages() -> list[tuple[str, str, str, str]]:
    lock = json.loads((ROOT / "apps/viewer/package-lock.json").read_text())
    rows = []
    for path, entry in lock["packages"].items():
        if not path or entry.get("dev") or entry.get("devOptional"):
            continue
        name = path.split("node_modules/")[-1]
        rows.append((name, entry.get("version", ""), entry.get("license") or "Unknown", f"https://www.npmjs.com/package/{name}"))
    return sorted(rows, key=lambda r: r[0].lower())


def rust_packages() -> list[tuple[str, str, str, str]]:
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin/cargo")
    meta = json.loads(subprocess.run(
        [cargo, "metadata", "--format-version", "1", "--manifest-path", "packages/rtgaia-reslice/Cargo.toml"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    by_id = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    seen, stack = set(), [root]
    while stack:
        for dep in nodes[stack.pop()]["deps"]:
            if any(k["kind"] is None for k in dep["dep_kinds"]) and dep["pkg"] not in seen:
                seen.add(dep["pkg"])
                stack.append(dep["pkg"])
    rows = [(by_id[i]["name"], by_id[i]["version"], by_id[i].get("license") or "Unknown",
             by_id[i].get("repository") or "") for i in seen]
    return sorted(rows, key=lambda r: r[0].lower())


def table(rows: list[tuple[str, str, str, str]], empty: str = "None.") -> list[str]:
    if not rows:
        return [empty, ""]
    lines = ["| Component | Version | License | Source |", "|---|---|---|---|"]
    for name, version, lic, url in rows:
        source = f"<{url}>" if url else ""
        lines.append(f"| {name} | {version} | {lic} | {source} |")
    return [*lines, ""]


def render() -> str:
    py, js, rs = python_packages(), npm_packages(), rust_packages()
    ecosystems = (("Python", py), ("npm", js), ("Rust", rs))
    review = [(kind, *r) for kind, rows in ecosystems for r in rows if REVIEW.search(r[2])]
    out = [
        "# Third-party notices",
        "",
        "RT-Gaia is released under the MIT License (see [LICENSE](LICENSE)). It depends on the third-party",
        "components listed below, each under its own license. This file is generated by",
        "`scripts/third-party-notices.py` from the lock files and the installed package metadata; regenerate it",
        "after changing dependencies. It is a summary for convenience, not legal advice: the license text shipped",
        "with each component is authoritative.",
        "",
        "## Python packages in the server image",
        "",
        "Installed by `uv sync --all-packages --no-dev --frozen` (see `deploy/Dockerfile`); versions as resolved for",
        "the Python 3.12 runtime image.",
        "",
        *table(py),
        "## JavaScript packages in the frontend bundle",
        "",
        "Production dependencies of `apps/viewer` (development tooling is not shipped).",
        "",
        *table(js),
        "## Rust crates in the reslice kernel",
        "",
        "`packages/rtgaia-reslice` is compiled to WebAssembly (browser) and to a native library (server).",
        "",
        *table(rs, "The kernel has no third-party crate dependencies."),
        "## Container base images",
        "",
        "| Image | Used for | License |",
        "|---|---|---|",
        *[f"| `{image}` | {use} | {lic} |" for image, use, lic in CONTAINERS],
        "",
        "## Not bundled",
        "",
        "- **Example plugins** under `examples/` have their own dependencies. `examples/plugin-nnunet` installs",
        "  nnU-Net, PyTorch and TotalSegmentator at plugin build time and downloads model weights at run time;",
        "  some TotalSegmentator tasks are licensed for non-commercial use only. Check the upstream licenses",
        "  before deploying a plugin.",
        "- **Demo and test data** are not part of the repository. Public datasets used for demonstrations are",
        "  credited in the README.",
        "",
        "## Licenses to review",
        "",
        "Copyleft or undetermined licenses among the components above (dependencies are linked dynamically",
        "or used as separate programs; review before redistribution):",
        "",
    ]
    if review:
        out += ["| Ecosystem | Component | Version | License |", "|---|---|---|---|"]
        out += [f"| {kind} | {name} | {version} | {lic} |" for kind, name, version, lic, _ in review]
    else:
        out.append("None.")
    return "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if THIRD_PARTY_NOTICES.md is out of date")
    args = parser.parse_args()
    text = render()
    if args.check:
        if not OUT.exists() or OUT.read_text() != text:
            print("THIRD_PARTY_NOTICES.md is out of date; run: uv run python scripts/third-party-notices.py")
            return 1
        return 0
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
