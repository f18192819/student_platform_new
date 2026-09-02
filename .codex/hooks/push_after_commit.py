"""Push the current main branch after a successful local commit."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    result = subprocess.run(
        ["git", "push", "origin", "HEAD:main"],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip() or "unknown Git push error"
        print("[auto-upload] 上传失败：" + message, file=sys.stderr)
        return 0
    print("[auto-upload] 已上传到 origin/main.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
