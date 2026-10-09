"""Fail when tracked files cite the private design documents.

The specification, roadmap and development history are not part of this repository, so section
numbers ("§4.6", "Appendix D"), document paths and work-batch labels would point readers at
documents they cannot open. Comments should state the reason itself instead.

Product error codes such as G4, DL6 or B3 are not checked here: they look like item numbers but
are part of the public behaviour.

    uv run python scripts/check-internal-refs.py
"""

from __future__ import annotations

import re
import subprocess
import sys

PATTERNS = [
    (re.compile(r"§\s?\d"), "spec section"),
    (re.compile(r"第\s?[0-9一二三四五六七八九十百零]+\s?批"), "work batch"),
    (re.compile(r"docs/internal|\.rtgaia/internal"), "internal document path"),
    (re.compile(r"(規格|附錄)\s?[A-D]\.?\d"), "spec appendix"),
    (re.compile(r"roadmap\s?§|路線圖第|原話"), "internal planning reference"),
]

# Generated, binary or third-party content, and this file itself.
SKIP = re.compile(r"^(data/|docs/assets/)|\.(png|gif|jpg|mp4|bin|wasm|dcm|gz|lock)$|package-lock\.json$")
SELF = "scripts/check-internal-refs.py"


def main() -> int:
    files = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines()
    hits: list[str] = []
    for path in files:
        if path == SELF or SKIP.search(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.readlines()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for number, line in enumerate(lines, 1):
            for pattern, label in PATTERNS:
                if pattern.search(line):
                    hits.append(f"{path}:{number}: {label}: {line.strip()[:120]}")
                    break
    if hits:
        print("\n".join(hits))
        print(f"\n{len(hits)} line(s) cite private design documents; describe the reason instead.")
        return 1
    print("No references to private design documents.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
