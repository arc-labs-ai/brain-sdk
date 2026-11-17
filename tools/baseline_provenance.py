#!/usr/bin/env python3
"""Read the committed-versus-working-tree state recorded beside a baseline."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Provenance:
    status: str
    commit: str | None
    date: str | None

    @property
    def is_safe(self) -> bool:
        return self.status == "committed"

    def summary(self, source: Path) -> str:
        commit = self.commit or "unknown commit"
        date = f", date: {self.date}" if self.date else ""
        if self.status == "uncommitted":
            return f"UNCOMMITTED / DIRTY source tree (commit: {commit}{date}; source: {source})"
        if self.status == "committed":
            return f"committed source tree (commit: {commit}{date}; source: {source})"
        return f"UNKNOWN provenance (commit: {commit}{date}; source: {source})"


def read_provenance(path: Path) -> Provenance:
    try:
        text = path.read_text()
    except OSError:
        return Provenance("unknown", None, None)

    commit_match = re.search(r"^commit:\s*(\S+)", text, re.MULTILINE)
    date_match = re.search(r"^date:\s*(\S+)", text, re.MULTILINE)
    commit = commit_match.group(1) if commit_match else None
    date = date_match.group(1) if date_match else None
    if commit and ("uncommitted" in commit.lower() or "dirty" in commit.lower()):
        status = "uncommitted"
    elif commit:
        status = "committed"
    else:
        status = "unknown"
    return Provenance(status, commit, date)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} SOURCE.txt", file=sys.stderr)
        raise SystemExit(2)
    source = Path(sys.argv[1])
    print(read_provenance(source).summary(source))
