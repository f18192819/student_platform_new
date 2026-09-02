"""Commit project source changes when Codex finishes a work turn.

The corresponding Git post-commit hook performs the push. Keeping the two
steps separate prevents this Codex hook from staging local attachments or
runtime state with ``git add -A``.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path, PurePosixPath


REPO_ROOT = Path(__file__).resolve().parents[2]


SOURCE_ROOTS = {
    "backend", "docs", "frontend", "frontend-tests", "public", "scripts", "src",
}
SOURCE_FILES = {
    ".gitignore", ".gitattributes", "README.md", "app.py", "index.html",
    "octopus-service.yaml", "package-lock.json", "package.json", "pyproject.toml",
    "requirements.txt", "tsconfig.app.json", "tsconfig.json", "tsconfig.node.json",
    "vite.config.ts",
}


def git(*args: str) -> subprocess.CompletedProcess[str]:
  return subprocess.run(
    ["git", *args],
    cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def finish(message: str | None = None) -> None:
    result: dict[str, object] = {"continue": True}
    if message:
        result["systemMessage"] = message
    print(json.dumps(result, ensure_ascii=False))


def is_source_path(value: str) -> bool:
    path = PurePosixPath(value.replace("\\", "/"))
    return value in SOURCE_FILES or (bool(path.parts) and path.parts[0] in SOURCE_ROOTS)


def stage_source_changes() -> subprocess.CompletedProcess[str]:
    # Tracked changes are safe. New files require an explicit source location.
    tracked = git("add", "-u")
    if tracked.returncode:
        return tracked

    untracked = git("ls-files", "--others", "--exclude-standard")
    if untracked.returncode:
        return untracked
    paths = [line.strip() for line in untracked.stdout.splitlines() if is_source_path(line.strip())]
    return git("add", "--", *paths) if paths else tracked


def main() -> None:
    try:
        event = json.load(sys.stdin)
    except Exception:
        event = {}
    if event.get("hook_event_name") != "Stop":
        finish()
        return

    repository = git("rev-parse", "--show-toplevel")
    if repository.returncode:
        finish("自动上传已跳过：当前目录不是 Git 仓库。")
        return

    staged = stage_source_changes()
    if staged.returncode:
        finish("自动暂存失败：" + staged.stderr.strip())
        return
    if git("diff", "--cached", "--quiet").returncode == 0:
        finish()
        return

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    commit = git("commit", "-m", f"codex: auto sync {timestamp}")
    if commit.returncode:
        finish("自动提交失败：" + commit.stderr.strip())
        return
    finish("代码已自动提交，Git post-commit hook 正在上传。")


if __name__ == "__main__":
    main()
