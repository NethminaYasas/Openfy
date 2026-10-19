"""Tests for scripts/linux/openfy deployment modes (systemd/docker/manual)."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

try:
    from tests.test_openfy_manager import MANAGER, _need_bash
except ImportError:  # pragma: no cover - alternate import root
    from test_openfy_manager import MANAGER, _need_bash

REPO_ROOT = Path(__file__).resolve().parents[2]


def _posix(path):
    return Path(path).as_posix()


def _run_script(*args, timeout=60):
    bash = _need_bash()
    return subprocess.run(
        [bash, str(MANAGER), *args], capture_output=True, text=True, timeout=timeout,
    )


def _run_snippet(snippet, timeout=60):
    bash = _need_bash()
    return subprocess.run([bash, "-c", snippet], capture_output=True, text=True, timeout=timeout)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    (root / "server" / "app").mkdir(parents=True)
    (root / "server" / "app" / "main.py").write_text("app = None\n", encoding="utf-8")
    return root


def _compose_file(tmp_path):
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services: {}\n", encoding="utf-8")
    return compose


_DOCKER_STUB = """
docker() {
    echo "DOCKER:$*" >> "$REC"
    local joined=" $* "
    case "$joined" in
        *" ps --status running -q "*) [[ "${FAKE_RUNNING}" == "1" ]] && echo "cid-running"; return 0 ;;
        *" ps -a -q "*) [[ "${FAKE_ANY}" == "1" ]] && echo "cid-existing"; return 0 ;;
    esac
    return 0
}
python3() { return 0; }
"""


def test_help_documents_deployment_flags():
    proc = _run_script("--help")
    assert proc.returncode == 0, proc.stderr
    for flag in ("--systemd", "--docker", "--manual", "--host", "--port", "--timeout"):
        assert flag in proc.stdout, f"{flag} missing from --help output"
    assert "set -euo pipefail" not in proc.stdout, "usage() sed range leaks script code"


def test_unknown_flag_and_command_exit_nonzero():
    proc = _run_script("start", "--bogus")
    assert proc.returncode != 0
    assert "unknown option" in proc.stderr.lower()
    proc = _run_script("status", "--nope")
    assert proc.returncode != 0
    proc = _run_script("bogus-cmd")
    assert proc.returncode != 0
    assert "unknown command" in proc.stderr.lower()


def test_shell_syntax_clean():
    bash = _need_bash()
    proc = subprocess.run([bash, "-n", str(MANAGER)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_detection_precedence_with_stubs(tmp_path, repo):
    work = _posix(tmp_path)
    snippet = f"""
source "{MANAGER.as_posix()}"
UNIT_FILE="{work}/unit.service"
: > "$UNIT_FILE"
systemctl() {{ :; }}
docker() {{ :; }}
OPENFY_DEPLOYMENT=docker
echo "explicit=$(resolve_deployment_mode systemd)"
echo "env=$(resolve_deployment_mode)"
unset OPENFY_DEPLOYMENT
echo "auto-systemd=$(resolve_deployment_mode)"
UNIT_FILE="{work}/missing.service"
export OPENFY_COMPOSE_FILE="{work}/docker-compose.yml"
: > "$OPENFY_COMPOSE_FILE"
export OPENFY_REPO_ROOT="{work}/empty"
mkdir -p "$OPENFY_REPO_ROOT"
echo "auto-docker=$(resolve_deployment_mode)"
unset OPENFY_COMPOSE_FILE
export OPENFY_REPO_ROOT="{_posix(repo)}"
echo "auto-manual=$(resolve_deployment_mode)"
export OPENFY_REPO_ROOT="{work}/empty"
mode="$(resolve_deployment_mode 2> "{work}/detect.err")" && echo "no-detect=unexpected:$mode" || echo "no-detect=exit"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    for expected in (
        "explicit=systemd",
        "env=docker",
        "auto-systemd=systemd",
        "auto-docker=docker",
        "auto-manual=manual",
        "no-detect=exit",
    ):
        assert expected in proc.stdout, proc.stdout
    err = (tmp_path / "detect.err").read_text(encoding="utf-8", errors="replace")
    assert "cannot detect" in err


def _manual_snippet(tmp_path, repo, extra, kill_rc, ps_cmd, pid_value="987654"):
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    rec = tmp_path / "record.txt"
    pidfile = data / "openfy.pid"
    pidfile.write_text(f"{pid_value}\n", encoding="utf-8")
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_REPO_ROOT="{_posix(repo)}"
export OPENFY_DATA_DIR="{_posix(data)}"
export OPENFY_PYTHON=fake_python
REC="{_posix(rec)}"
: > "$REC"
kill() {{ echo "KILL:$*" >> "$REC"; return {kill_rc}; }}
ps() {{ echo "{ps_cmd}"; }}
python3() {{ return 0; }}
fake_python() {{ return 0; }}
{extra}
"""
    return snippet, rec, pidfile


def test_manual_stop_cleans_stale_pid_and_start_proceeds(tmp_path, repo):
    extra = f"""
kill() {{
    echo "KILL:$*" >> "$REC"
    local joined=" $* "
    case "$joined" in
        *" -0 987654 "*) return 1 ;;
    esac
    return 0
}}
_manual_spawn() {{ echo 4242; }}
manual_stop
echo "stop-rc=$?"
[[ -f "{_posix(tmp_path / 'data' / 'openfy.pid')}" ]] && echo "pidfile=present" || echo "pidfile=removed"
manual_start
echo "start-rc=$?"
echo "pid=$(cat "{_posix(tmp_path / 'data' / 'openfy.pid')}")"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=1, ps_cmd="unrelated-process",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "stop-rc=0" in proc.stdout
    assert "pidfile=removed" in proc.stdout
    assert "start-rc=0" in proc.stdout
    assert "Openfy started" in proc.stdout
    assert pidfile.read_text(encoding="utf-8").strip() == "4242"
    recorded = rec.read_text(encoding="utf-8")
    assert "-TERM" not in recorded and "-KILL" not in recorded


def test_manual_start_already_running_exits_zero(tmp_path, repo):
    extra = """
_manual_spawn() { echo "SPAWNED" >> "$REC"; echo 111; }
manual_start
echo "start-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0,
        ps_cmd="python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "already running" in proc.stdout
    assert "start-rc=0" in proc.stdout
    assert pidfile.read_text(encoding="utf-8").strip() == "987654"
    assert "SPAWNED" not in rec.read_text(encoding="utf-8")


def test_manual_start_already_running_preserves_endpoint(tmp_path, repo):
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    endpoint = data / "openfy.endpoint"
    endpoint.write_text("127.0.0.1 9123\n", encoding="utf-8")
    extra = """
_manual_spawn() { echo "SPAWNED" >> "$REC"; echo 111; }
manual_start
echo "start-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0,
        ps_cmd="python3 -m uvicorn app.main:app --host 127.0.0.1 --port 9123",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "already running" in proc.stdout
    assert "start-rc=0" in proc.stdout
    assert endpoint.read_text(encoding="utf-8").strip() == "127.0.0.1 9123"
    assert "SPAWNED" not in rec.read_text(encoding="utf-8")


def test_manual_start_clears_foreign_pid_and_launches(tmp_path, repo):
    extra = """
_manual_spawn() { echo "SPAWNED" >> "$REC"; echo 777; }
manual_start
echo "start-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0, ps_cmd="bash some-other-script.sh",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "start-rc=0" in proc.stdout
    assert "stale" in (proc.stdout + proc.stderr).lower()
    assert pidfile.read_text(encoding="utf-8").strip() == "777"
    assert "SPAWNED" in rec.read_text(encoding="utf-8")


def test_manual_stop_never_signals_foreign_pid(tmp_path, repo):
    extra = """
manual_stop
echo "stop-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0, ps_cmd="bash some-other-script.sh",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "stop-rc=0" in proc.stdout
    assert not pidfile.exists()
    recorded = rec.read_text(encoding="utf-8")
    assert "-TERM" not in recorded and "-KILL" not in recorded
    assert "-0 987654" in recorded


def test_manual_stop_not_running_exits_zero(tmp_path, repo):
    data = tmp_path / "data-none"
    rec = tmp_path / "record-none.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_REPO_ROOT="{_posix(repo)}"
export OPENFY_DATA_DIR="{_posix(data)}"
REC="{_posix(rec)}"
: > "$REC"
kill() {{ echo "KILL:$*" >> "$REC"; return 0; }}
python3() {{ return 0; }}
manual_stop
echo "stop-rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "not running" in proc.stdout
    assert "stop-rc=0" in proc.stdout
    assert rec.read_text(encoding="utf-8").strip() == ""


@pytest.mark.parametrize(
    "running,any_exists,expect_argv,forbid",
    [
        (0, 0, "up -d", None),
        (0, 1, "start", "up -d"),
        (1, 1, None, "up -d"),
    ],
)
def test_docker_start_argv(tmp_path, running, any_exists, expect_argv, forbid):
    compose = _compose_file(tmp_path)
    rec = tmp_path / "docker-record.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_COMPOSE_FILE="{_posix(compose)}"
REC="{_posix(rec)}"
: > "$REC"
FAKE_RUNNING={running}
FAKE_ANY={any_exists}
{_DOCKER_STUB}
docker_start
echo "rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "rc=0" in proc.stdout
    lines = rec.read_text(encoding="utf-8").splitlines()
    prefix = f"DOCKER:compose -f {_posix(compose)}"
    if running == 1:
        assert "already running" in proc.stdout
    if expect_argv:
        assert f"{prefix} {expect_argv}" in lines, lines
    if forbid:
        assert not any(line == f"{prefix} {forbid}" for line in lines), lines
    assert not any("--build" in line for line in lines), lines
    assert not any(line.endswith(" down") for line in lines), lines


def test_docker_stop_uses_stop_and_never_down(tmp_path):
    compose = _compose_file(tmp_path)
    rec = tmp_path / "docker-record.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_COMPOSE_FILE="{_posix(compose)}"
REC="{_posix(rec)}"
: > "$REC"
FAKE_RUNNING=1
FAKE_ANY=1
{_DOCKER_STUB}
docker_stop
echo "rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    lines = rec.read_text(encoding="utf-8").splitlines()
    prefix = f"DOCKER:compose -f {_posix(compose)}"
    assert f"{prefix} stop" in lines, lines
    assert not any(line == f"{prefix} down" for line in lines), lines
    assert not any("--build" in line for line in lines), lines


def test_docker_stop_not_running_exits_zero(tmp_path):
    compose = _compose_file(tmp_path)
    rec = tmp_path / "docker-record.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_COMPOSE_FILE="{_posix(compose)}"
REC="{_posix(rec)}"
: > "$REC"
FAKE_RUNNING=0
FAKE_ANY=0
{_DOCKER_STUB}
docker_stop
echo "rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "not running" in proc.stdout
    lines = rec.read_text(encoding="utf-8").splitlines()
    prefix = f"DOCKER:compose -f {_posix(compose)}"
    assert not any(line == f"{prefix} stop" for line in lines), lines
    assert not any(line == f"{prefix} down" for line in lines), lines


def test_docker_missing_is_a_clear_error(tmp_path):
    compose = _compose_file(tmp_path)
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_COMPOSE_FILE="{_posix(compose)}"
PATH=/nonexistent
docker_start
"""
    proc = _run_snippet(snippet)
    assert proc.returncode != 0
    assert "docker is not installed" in proc.stderr


def test_control_reports_chosen_mode(tmp_path):
    compose = _compose_file(tmp_path)
    rec = tmp_path / "docker-record.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_COMPOSE_FILE="{_posix(compose)}"
REC="{_posix(rec)}"
: > "$REC"
FAKE_RUNNING=1
FAKE_ANY=1
{_DOCKER_STUB}
cmd_control start --docker
echo "rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "[openfy] Deployment mode: docker" in proc.stdout
    assert "rc=0" in proc.stdout


def test_manual_start_fails_when_launched_pid_is_dead(tmp_path, repo):
    extra = """
_manual_spawn() { echo 333333; }
manual_start --host 127.0.0.1 --port 9111 --timeout 2
echo "start-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=1, ps_cmd="unrelated-process",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode != 0
    combined = proc.stdout + proc.stderr
    assert "exited during startup" in combined
    assert "last 20 lines" in combined
    assert "Openfy started" not in proc.stdout
    assert not pidfile.exists()


def test_docker_start_health_timeout_exits_nonzero(tmp_path):
    compose = _compose_file(tmp_path)
    rec = tmp_path / "docker-record.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_COMPOSE_FILE="{_posix(compose)}"
REC="{_posix(rec)}"
: > "$REC"
FAKE_RUNNING=0
FAKE_ANY=0
{_DOCKER_STUB}
python3() {{ return 1; }}
docker_start --timeout 1
echo "rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode != 0
    assert "did not become healthy" in proc.stderr
    assert "logs --tail=100" in proc.stderr
    assert "rc=0" not in proc.stdout


def test_manual_endpoint_persisted_and_used_by_status(tmp_path, repo):
    data = tmp_path / "data"
    endpoint = data / "openfy.endpoint"
    extra = f"""
rm -f "{_posix(data / 'openfy.pid')}"
_manual_spawn() {{ echo 555; }}
manual_start --host 127.0.0.1 --port 9123
echo "start-rc=$?"
echo "endpoint=$(cat "{_posix(endpoint)}")"
manual_status
echo "status-rc=$?"
_alive_calls=0
_pid_alive() {{ _alive_calls=$((_alive_calls + 1)); [[ ${{_alive_calls}} -le 1 ]]; }}
manual_stop
echo "stop-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0,
        ps_cmd="python3 -m uvicorn app.main:app --host 127.0.0.1 --port 9123",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "start-rc=0" in proc.stdout
    assert "endpoint=127.0.0.1 9123" in proc.stdout
    assert "URL: http://127.0.0.1:9123" in proc.stdout
    assert "Health: healthy at http://127.0.0.1:9123/health" in proc.stdout
    assert "stop-rc=0" in proc.stdout
    assert not endpoint.exists()
    assert not pidfile.exists()


def test_manual_stop_refuses_kill_when_identity_changes(tmp_path, repo):
    extra = """
_identity_calls=0
_process_identity_ok() { _identity_calls=$((_identity_calls + 1)); [[ ${_identity_calls} -eq 1 ]]; }
_pid_alive() { return 0; }
manual_stop --timeout 0
echo "stop-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0, ps_cmd="",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode != 0
    assert "refusing to send SIGKILL" in proc.stderr
    assert pidfile.exists()
    recorded = rec.read_text(encoding="utf-8")
    assert "-TERM 987654" in recorded
    assert "-KILL" not in recorded


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_manual_start_secures_log_pid_and_endpoint(tmp_path, repo):
    data = tmp_path / "data"
    extra = f"""
rm -f "{_posix(data / 'openfy.pid')}"
_manual_spawn() {{ echo 556; }}
manual_start --port 9110
echo "start-rc=$?"
"""
    snippet, rec, pidfile = _manual_snippet(
        tmp_path, repo, extra, kill_rc=0,
        ps_cmd="python3 -m uvicorn app.main:app --host 0.0.0.0 --port 9110",
    )
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "start-rc=0" in proc.stdout
    assert "http://127.0.0.1:9110" in proc.stdout
    assert (data / "openfy.endpoint").read_text(encoding="utf-8").strip() == "0.0.0.0 9110"
    for name in ("openfy.log", "openfy.pid", "openfy.endpoint"):
        mode = stat.S_IMODE((data / name).stat().st_mode)
        assert mode == 0o600, f"{name} mode is {oct(mode)}"


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_manual_start_creates_data_dir_private(tmp_path, repo):
    data = tmp_path / "fresh-data"
    rec = tmp_path / "record-fresh.txt"
    snippet = f"""
source "{MANAGER.as_posix()}"
export OPENFY_REPO_ROOT="{_posix(repo)}"
export OPENFY_DATA_DIR="{_posix(data)}"
export OPENFY_PYTHON=fake_python
REC="{_posix(rec)}"
: > "$REC"
kill() {{ echo "KILL:$*" >> "$REC"; return 0; }}
ps() {{ echo "python3 -m uvicorn app.main:app"; }}
python3() {{ return 0; }}
fake_python() {{ return 0; }}
_manual_spawn() {{ echo 557; }}
manual_start --port 9112
echo "start-rc=$?"
"""
    proc = _run_snippet(snippet)
    assert proc.returncode == 0, proc.stderr
    assert "start-rc=0" in proc.stdout
    mode = stat.S_IMODE(data.stat().st_mode)
    assert mode == 0o700, f"data dir mode is {oct(mode)}"
