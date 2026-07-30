"""The PEP 561 marker must exist, and must reach the built wheel.

Without `py.typed` in the *installed* package, a downstream type checker is
required to ignore every annotation this SDK carries — `mypy` and `pyright`
both treat the package as untyped and fall back to `Any`. Every annotation in
`wire/types.py`, every `Optional`, every return type: invisible.

That failure is completely silent. Nothing here breaks, no test fails, the
package installs and runs; a user simply gets no type information and has no
way to tell whether that is intentional. The SDK shipped without the marker
until this file was written.

Checking the source file exists is not enough — the marker is a data file, not
a module, and a build backend only includes it when told to. So the second test
builds an actual wheel and looks inside it, which is the only claim that
matters.
"""

from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
MARKER = PACKAGE_ROOT / "src" / "brain_db_sdk" / "py.typed"


def test_the_marker_exists_in_the_source_tree() -> None:
    assert MARKER.is_file(), (
        f"{MARKER} is missing. Without it PEP 561 requires every type checker to "
        "ignore this package's annotations, so none of its typing reaches users."
    )


def test_the_build_backend_is_told_to_ship_the_marker() -> None:
    """A fast check that fails at edit time rather than at publish time.

    Read as text rather than parsed: `tomllib` is 3.11+, and this package's
    floor — the version this very suite runs on in CI — is 3.9.
    """
    config = (PACKAGE_ROOT / "pyproject.toml").read_text()
    section = config.split("[tool.hatch.build.targets.wheel]", 1)
    assert len(section) == 2, "pyproject.toml has no [tool.hatch.build.targets.wheel]"
    body = section[1].split("\n[", 1)[0]
    assert "py.typed" in body, (
        "pyproject.toml does not list py.typed under "
        "[tool.hatch.build.targets.wheel].artifacts, so it may not reach the wheel."
    )


@pytest.mark.slow
def test_the_marker_reaches_the_built_wheel(tmp_path: Path) -> None:
    """The claim that actually matters: it is in the artifact users install.

    Skipped rather than failed when `build` is unavailable — this is the only
    test in the suite that needs a build backend, and an environment without
    one should not look like a broken package.
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
    names = zipfile.ZipFile(wheels[0]).namelist()
    assert "brain_db_sdk/py.typed" in names, (
        "py.typed is not in the built wheel, so an installed copy of this package "
        f"is untyped to every downstream checker. Wheel contains: {sorted(names)[:20]}"
    )
