"""Tests for scripts/linux/openfy manager (TUI + CLI)."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MANAGER = REPO_ROOT / "scripts" / "linux" / "openfy"

_WORKING_BASH = None


def _find_bash():
    global _WORKING_BASH
    if _WORKING_BASH is not None:
        return _WORKING_BASH
    import shutil as _sh
    candidates = [
        _sh.which("bash"),
        r"C:\Program Files\Git\bin\bash.exe",
        "/bin/bash",
        "/usr/bin/bash",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            probe = subprocess.run(
                [candidate, "-c", "exit 0"],
                capture_output=True, text=True, timeout=30,
            )
            if probe.returncode == 0:
                _WORKING_BASH = candidate
                return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def _need_bash():
    import pytest
    bash = _find_bash()
    if bash is None:
        pytest.skip("no working bash available")
    return bash


def test_manager_exists_with_lf_endings():
    assert MANAGER.is_file(), "scripts/linux/openfy is missing"
    raw = MANAGER.read_bytes()
    assert b"\r" not in raw, "openfy must use Unix (LF) line endings"
    assert raw.startswith(b"#!/bin/bash"), "openfy must start with a bash shebang"


def test_manager_is_executable():
    try:
        proc = subprocess.run(
            ["git", "ls-files", "-s", "scripts/linux/openfy"],
            capture_output=True, text=True, timeout=30,
            cwd=str(REPO_ROOT),
        )
        mode = proc.stdout.split()[0] if proc.stdout.strip() else ""
    except (OSError, subprocess.SubprocessError):
        mode = ""
    if mode:
        assert mode == "100755", f"openfy git mode is {mode}, expected 100755"
    elif os.name == "posix":
        assert os.stat(MANAGER).st_mode & stat.S_IXUSR
    else:
        import pytest
        pytest.skip("cannot verify executable bit on this platform")


def test_manager_shell_syntax():
    bash = _need_bash()
    proc = subprocess.run([bash, "-n", str(MANAGER)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_manager_help_and_unknown_command():
    bash = _need_bash()
    proc = subprocess.run(
        [bash, str(MANAGER), "--help"], capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    assert "openfy status" in proc.stdout or "status" in proc.stdout
    proc = subprocess.run(
        [bash, str(MANAGER), "bogus-cmd"], capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    assert "unknown command" in proc.stderr.lower()


def test_manager_validates_port_and_username():
    bash = _need_bash()
    for args in (["port", "0"], ["port", "99999"], ["port", "abc"], ["port", "08080"]):
        proc = subprocess.run(
            [bash, str(MANAGER)] + args, capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode != 0, f"invalid port accepted: {args}"
    proc = subprocess.run(
        [bash, str(MANAGER), "set-username", "bad user!"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0


def test_manager_sourcing_has_no_side_effects():
    bash = _need_bash()
    proc = subprocess.run(
        [bash, "-c", f'source "{MANAGER.as_posix()}"; echo "sourced-ok"'],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    assert "sourced-ok" in proc.stdout


@pytest.mark.parametrize("active", [True, False])
@pytest.mark.parametrize("healthy", [True, False])
def test_rotation_confirms_health_before_reporting_live(tmp_path, active, healthy):
    installer = tmp_path / "install.sh"
    installer.write_text("#!/bin/bash\necho ROTATED\n", encoding="utf-8")
    installer.chmod(0o755)
    (tmp_path / "openfy.service").write_text("ExecStart=python -m uvicorn app.main:app --port 9123\n")
    proc = subprocess.run(
        [_need_bash(), "-c", f"""source "{MANAGER.as_posix()}"
APP_DIR="{tmp_path.as_posix()}"
UNIT_FILE="${{APP_DIR}}/openfy.service"
require_root() {{ return 0; }}
systemctl() {{ return {0 if active else 1}; }}
python3() {{ echo "PROBE:$*"; return {0 if healthy else 1}; }}
cmd_rotate
"""], capture_output=True, text=True, timeout=30,
    )
    assert "ROTATED" in proc.stdout
    assert ("New credential is live" in proc.stdout) == (active and healthy)
    if active:
        assert "http://localhost:9123/health" in proc.stdout
        if healthy:
            assert proc.returncode == 0, proc.stderr
            assert proc.stdout.index("PROBE:") < proc.stdout.index("New credential is live")
        else:
            assert proc.returncode != 0
            assert "not responding" in proc.stderr
    else:
        assert "PROBE:" not in proc.stdout
