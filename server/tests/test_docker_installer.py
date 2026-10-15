"""Exercise the Docker quick installer with an isolated Docker command stub."""

import json
import os
from pathlib import Path
import subprocess

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALLER = REPO_ROOT / "install-docker.sh"
CREDENTIAL = "of1_" + "a" * 60


@pytest.fixture
def docker_stub(tmp_path):
    binary = tmp_path / "bin"
    binary.mkdir()
    docker = binary / "docker"
    docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["DOCKER_TEST_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[:1] == ["run"]:
    if os.environ.get("DOCKER_TEST_FAIL") == "credential":
        print("invalid")
    else:
        print("of1_" + "a" * 60)
if os.environ.get("DOCKER_TEST_FAIL") in args:
    sys.exit(1)
''')
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"], DOCKER_TEST_LOG=str(log))
    return env, log


def run_installer(tmp_path, env, *args):
    return subprocess.run(
        ["bash", str(INSTALLER), *args], cwd=tmp_path, env=env,
        text=True, capture_output=True, timeout=30,
    )


def test_fresh_install_and_repeat_preserve_state(tmp_path, docker_stub):
    env, log = docker_stub
    # Verify quoting and invocation through process substitution too.
    target = tmp_path / "custom directory" / "openfy"
    result = subprocess.run(
        ["bash", "-c", 'bash <(cat "$1") "$2"', "bash", str(INSTALLER), str(target)],
        cwd=tmp_path, env=env, text=True, capture_output=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert CREDENTIAL in result.stdout
    assert (target / "data").is_dir()
    assert (target / ".env").stat().st_mode & 0o777 == 0o600
    config = yaml.safe_load((target / "docker-compose.yml").read_text())
    assert config == yaml.safe_load((REPO_ROOT / "docker-compose.quick.yml").read_text())
    assert (target / ".env").read_text() == (REPO_ROOT / "docker.env.example").read_text().replace(
        "OPENFY_ADMIN_HASH=\n", f"OPENFY_ADMIN_HASH={CREDENTIAL}\n",
    )
    service = config["services"]["openfy"]
    assert service["image"] == "ghcr.io/nethminayasas/openfy:${OPENFY_VERSION:-latest}"
    assert service["volumes"] == ["./data:/data"]
    assert service["environment"]["OPENFY_DATABASE_URL"] == "sqlite:////data/openfy.db"
    assert service["env_file"] == [".env"]
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert [call[0] for call in calls].count("run") == 1
    assert calls[-2][-1] == "pull"
    assert calls[-1][-5:] == ["up", "-d", "--wait", "--wait-timeout", "120"]

    (target / "data" / "existing.db").write_bytes(b"keep data")
    for name in [".env", "docker-compose.yml"]:
        with (target / name).open("a") as file:
            file.write("\n# custom configuration\n")
    original = {name: (target / name).read_bytes() for name in [".env", "docker-compose.yml", "data/existing.db"]}
    result = run_installer(tmp_path, env, str(target))
    assert result.returncode == 0, result.stderr
    assert CREDENTIAL not in result.stdout
    assert "preserved" in result.stdout
    assert all((target / name).read_bytes() == content for name, content in original.items())
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert [call[0] for call in calls].count("run") == 1
    assert not list(target.glob(".openfy-install.*"))


@pytest.mark.parametrize("failure", ["info", "version", "credential", "pull", "up"])
def test_failure_stops_without_claiming_success(tmp_path, docker_stub, failure):
    env, log = docker_stub
    env["DOCKER_TEST_FAIL"] = failure
    result = run_installer(tmp_path, env)
    assert result.returncode != 0
    assert "Openfy is ready" not in result.stdout
    target = tmp_path / "openfy"
    assert not list(target.glob(".openfy-install.*"))
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    if failure in ["info", "version", "credential", "pull"]:
        assert not any("up" in call for call in calls)
    if failure in ["info", "version", "credential"]:
        assert not (target / ".env").exists()


def test_help_does_not_require_docker_or_create_directory(tmp_path):
    result = run_installer(tmp_path, dict(os.environ), "--help")
    assert result.returncode == 0
    assert "Usage:" in result.stdout
    assert not (tmp_path / "openfy").exists()
