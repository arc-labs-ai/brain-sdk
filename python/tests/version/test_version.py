"""`brain_db_sdk.__version__` must be the version that actually shipped.

It silently was not: the package published as 0.3.1 while the attribute still
read 0.1.0, two releases behind. Nothing broke, no test failed — a user's
compatibility check or a bug report simply quoted a version that had not
existed for months. A hand-written constant drifts because release-please bumps
`pyproject.toml` and nothing links the two.

It is now read from the installed distribution's metadata, so there is one
place to bump. These tests pin both halves of that: that nothing has gone back
to hardcoding a literal, and that the version in the wheel's metadata is the
one `pyproject.toml` declares.
"""

from __future__ import annotations

import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

import brain_db_sdk

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
INIT = PACKAGE_ROOT / "src" / "brain_db_sdk" / "__init__.py"
PYPROJECT = PACKAGE_ROOT / "pyproject.toml"


def _declared_version() -> str:
    """The version in `pyproject.toml`, read as text.

    `tomllib` is 3.11+ and this package's floor is 3.10, so the suite cannot
    rely on it being importable on the version CI runs.
    """
    match = re.search(r'^version\s*=\s*"([^"]+)"', PYPROJECT.read_text(), re.MULTILINE)
    assert match, "pyproject.toml declares no version"
    return match.group(1)


def test_the_version_is_not_hardcoded() -> None:
    """The regression this file exists for. A literal assignment here is what
    drifted; anything deriving it from metadata cannot."""
    source = INIT.read_text()
    literal = re.search(r'^__version__\s*=\s*["\']', source, re.MULTILINE)
    assert literal is None, (
        "__version__ is assigned a string literal in __init__.py. It drifted from "
        "pyproject.toml once already — derive it from the installed distribution "
        "metadata instead, so release-please has one place to bump."
    )


def test_the_attribute_exists_and_looks_like_a_version() -> None:
    assert isinstance(brain_db_sdk.__version__, str)
    assert re.match(r"^\d+\.\d+\.\d+", brain_db_sdk.__version__), brain_db_sdk.__version__


def test_the_fallback_is_recognisable_as_one() -> None:
    """Running from an uninstalled source tree has no metadata to read. That
    must be obvious rather than look like a real release."""
    source = INIT.read_text()
    assert "0.0.0+unknown" in source, (
        "the PackageNotFoundError fallback should be an obviously-not-a-release "
        "version, so an uninstalled tree never looks like a shipped one"
    )


@pytest.mark.slow
def test_the_wheel_declares_the_version_pyproject_does(tmp_path: Path) -> None:
    """The claim that actually matters: what a user installs reports what the
    manifest says. Everything above is about the source tree; this is about the
    artifact.

    Skipped rather than failed when `build` is unavailable, matching
    `tests/py_typed` — an environment without a build backend should not look
    like a broken package.
    """
    try:
        import build  # noqa: F401
    except ImportError:  # pragma: no cover - depends on the environment
        pytest.skip("the `build` package is not installed")

    # S603: the argv is `sys.executable -m build` with a tmp_path outdir —
    # no shell, no caller input.
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(tmp_path)],
        cwd=PACKAGE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"wheel build failed:\n{result.stdout}\n{result.stderr}"

    wheels = list(tmp_path.glob("*.whl"))
    assert len(wheels) == 1, f"expected one wheel, got {wheels}"

    declared = _declared_version()
    with zipfile.ZipFile(wheels[0]) as wheel:
        metadata = next(n for n in wheel.namelist() if n.endswith(".dist-info/METADATA"))
        text = wheel.read(metadata).decode()
    assert f"\nVersion: {declared}\n" in text, (
        f"the wheel's metadata does not declare {declared}; "
        "__version__ reads this, so it would report the wrong number"
    )
