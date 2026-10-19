"""Behavioural tests for the `openfy` manager's uninstall command.

The manager must forward the `--keep-*` flags to the native uninstaller
(they decide whether data and the admin credential survive) and must ask
before it destroys a Docker deployment.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MANAGER = REPO_ROOT / "scripts" / "linux" / "openfy"

_WORKING_BASH = None


def _find_bash():
    """Return a bash executable that actually works, or None."""
    global _WORKING_BASH
    if _WORKING_BASH is not None:
        return _WORKING_BASH
    candidates = [
        shutil.which("bash"),
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
    bash = _find_bash()
    if bash is None:
        pytest.skip("no working bash available")
    return bash


def _m(path):
    """Native path string for use inside bash (see test_bootstrap_installer)."""
    import tempfile
    native = os.path.abspath(path)
    if os.name != "nt":
        return Path(native).as_posix()
    tmp = os.path.abspath(tempfile.gettempdir())
    if os.path.normcase(native) == os.path.normcase(tmp) or os.path.normcase(native).startswith(
        os.path.normcase(tmp) + os.sep
    ):
        rel = os.path.relpath(native, tmp)
        return "/tmp/" + rel.replace(os.sep, "/")
    return Path(path).as_posix()


def _run_manager(tmp_path: Path, script: str, env=None, stdin=""):
    bash = _need_bash()
    merged = dict(os.environ)
    merged.update(env or {})
    return subprocess.run(
        [bash, "-c", script], capture_output=True, text=True, timeout=120,
        env=merged, cwd=str(REPO_ROOT), input=stdin,
    )


def _manager_env(tmp_path: Path, **overrides):
    env = {
        "OPENFY_INSTALL_DIR": _m(tmp_path / "opt" / "openfy"),
        "OPENFY_DATA_DIR_OVERRIDE": _m(tmp_path / "var" / "lib" / "openfy"),
        "OPENFY_CONFIG_DIR": _m(tmp_path / "etc" / "openfy"),
    }
    env.update(overrides)
    return env


def test_uninstall_forwards_keep_flags_to_the_native_uninstaller(tmp_path):
    # The keep flags decide whether the database and the admin credential
    # survive: the manager has to hand them to uninstall.sh.
    app = tmp_path / "opt" / "openfy"
    app.mkdir(parents=True)
    recorded = tmp_path / "args.txt"
    (app / "uninstall.sh").write_text(
        f'#!/bin/bash\necho "$@" > "{_m(recorded)}"\n', encoding="utf-8"
    )
    (app / "uninstall.sh").chmod(0o755)
    script = (
        'id() { if [ "$1" = "-u" ]; then echo 0; else echo "uid=0"; fi; }\n'
        f'source "{_m(MANAGER)}"\n'
        'cmd_uninstall --yes --keep-data --keep-config\n'
    )
    proc = _run_manager(tmp_path, script, env=_manager_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    args = recorded.read_text(encoding="utf-8")
    assert "--keep-data" in args, args
    assert "--keep-config" in args, args
    assert "--yes" in args, args


def test_uninstall_with_yes_passes_only_yes(tmp_path):
    # An empty argument would make the native uninstaller fail with
    # "unknown option ''".
    app = tmp_path / "opt" / "openfy"
    app.mkdir(parents=True)
    recorded = tmp_path / "args.txt"
    (app / "uninstall.sh").write_text(
        f'#!/bin/bash\necho "$@" > "{_m(recorded)}"\n', encoding="utf-8"
    )
    (app / "uninstall.sh").chmod(0o755)
    script = (
        'id() { if [ "$1" = "-u" ]; then echo 0; else echo "uid=0"; fi; }\n'
        f'source "{_m(MANAGER)}"\n'
        'cmd_uninstall --yes\n'
    )
    proc = _run_manager(tmp_path, script, env=_manager_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert recorded.read_text(encoding="utf-8").strip() == "--yes"


def test_uninstall_without_yes_does_not_add_it(tmp_path):
    app = tmp_path / "opt" / "openfy"
    app.mkdir(parents=True)
    recorded = tmp_path / "args.txt"
    (app / "uninstall.sh").write_text(
        f'#!/bin/bash\necho "$@" > "{_m(recorded)}"\n', encoding="utf-8"
    )
    (app / "uninstall.sh").chmod(0o755)
    script = (
        'id() { if [ "$1" = "-u" ]; then echo 0; else echo "uid=0"; fi; }\n'
        f'source "{_m(MANAGER)}"\n'
        'cmd_uninstall --keep-data\n'
    )
    proc = _run_manager(tmp_path, script, env=_manager_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    args = recorded.read_text(encoding="utf-8")
    assert "--yes" not in args, args
    assert "--keep-data" in args, args


_DOCKER_MOCK = """docker() {
  case "$1" in
    compose) echo "compose $*" >> "$DOCKER_LOG"; return 0 ;;
    volume)
      case "$2" in
        ls) echo "openfy_data" ;;
        rm) echo "volume rm $3" >> "$DOCKER_LOG" ;;
      esac ;;
    images) echo "ghcr.io/nethminayasas/openfy:1.2.3" ;;
    rmi) echo "rmi $2" >> "$DOCKER_LOG" ;;
  esac
  return 0
}
"""


def test_docker_uninstall_keeps_the_volume_with_keep_data(tmp_path):
    # `docker compose down -v` would delete the data volume even when the
    # user asked to keep it.
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services:\n  openfy:\n    image: ghcr.io/nethminayasas/openfy:1.2.3\n", encoding="utf-8")
    log = tmp_path / "docker.log"
    script = (
        f'{_DOCKER_MOCK}\n'
        f'source "{_m(MANAGER)}"\n'
        'docker_uninstall "true" "true" "true"\n'
    )
    proc = _run_manager(
        tmp_path, script,
        env=_manager_env(tmp_path, OPENFY_COMPOSE_FILE=_m(compose), DOCKER_LOG=_m(log)),
    )
    assert proc.returncode == 0, proc.stderr
    output = log.read_text(encoding="utf-8")
    first_line = output.splitlines()[0]
    assert "down" in first_line, output
    assert " -v" not in first_line, output
    assert "volume rm" not in output, output


def test_docker_uninstall_removes_the_volume_without_keep_data(tmp_path):
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services:\n  openfy:\n    image: ghcr.io/nethminayasas/openfy:1.2.3\n", encoding="utf-8")
    log = tmp_path / "docker.log"
    script = (
        f'{_DOCKER_MOCK}\n'
        f'source "{_m(MANAGER)}"\n'
        'docker_uninstall "false" "false" "true"\n'
    )
    proc = _run_manager(
        tmp_path, script,
        env=_manager_env(tmp_path, OPENFY_COMPOSE_FILE=_m(compose), DOCKER_LOG=_m(log)),
    )
    assert proc.returncode == 0, proc.stderr
    output = log.read_text(encoding="utf-8")
    first_line = output.splitlines()[0]
    assert "down" in first_line, output
    # The volume teardown is project-scoped: `docker compose down -v`.
    assert " -v" in first_line, output
    assert "volume rm" not in output, output


def test_docker_uninstall_rejects_unknown_options(tmp_path):
    # A typo like --keep-dat must not silently delete the data volume.
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services:\n  openfy:\n    image: ghcr.io/nethminayasas/openfy:1.2.3\n", encoding="utf-8")
    log = tmp_path / "docker.log"
    script = (
        'id() { if [ "$1" = "-u" ]; then echo 0; else echo "uid=0"; fi; }\n'
        f'{_DOCKER_MOCK}\n'
        f'source "{_m(MANAGER)}"\n'
        'cmd_uninstall --yes --keep-dat\n'
    )
    proc = _run_manager(
        tmp_path, script,
        env=_manager_env(tmp_path, OPENFY_COMPOSE_FILE=_m(compose), DOCKER_LOG=_m(log)),
    )
    assert proc.returncode != 0
    assert "unknown uninstall option" in proc.stderr
    assert not log.exists() or "compose" not in log.read_text(encoding="utf-8")


def test_docker_uninstall_asks_before_deleting(tmp_path):
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services:\n  openfy:\n    image: ghcr.io/nethminayasas/openfy:1.2.3\n", encoding="utf-8")
    log = tmp_path / "docker.log"
    script = (
        f'{_DOCKER_MOCK}\n'
        f'source "{_m(MANAGER)}"\n'
        'docker_uninstall "false" "false" "false"\n'
    )
    proc = _run_manager(
        tmp_path, script,
        env=_manager_env(tmp_path, OPENFY_COMPOSE_FILE=_m(compose), DOCKER_LOG=_m(log)),
        stdin="n\n",
    )
    assert proc.returncode == 0, proc.stderr
    assert "Aborted" in proc.stdout
    assert not log.exists() or "compose" not in log.read_text(encoding="utf-8")
