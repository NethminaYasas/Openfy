"""Behavioural tests for the Openfy uninstaller.

An uninstall must leave nothing behind: application files, the data
directory, the configuration (admin credential), the update backups, the
service account and the CLI wrapper. These tests run the real
`scripts/linux/uninstall.sh` inside a sandbox with stubbed system commands,
so no root privileges, no network and no changes to the host are required.
Tests that need bash are skipped when no working bash is available.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
UNINSTALLER = REPO_ROOT / "scripts" / "linux" / "uninstall.sh"

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
    """Native path string for use inside bash.

    Under Git-bash on Windows the pytest temp dir lives under the Windows
    temp directory, which msys maps to /tmp; msys tools choke on `C:`-style
    paths, so rewrite temp paths to their /tmp/... aliases.
    """
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


# The runner shadows every command that would touch the host. Bash
# functions take precedence over PATH lookups, so no stub binaries and no
# PATH rewriting are needed.
_RUNNER = """#!/bin/bash
id() { if [ "$1" = "-u" ]; then echo 0; else echo "uid=0(root)"; fi; }
systemctl() { return 0; }
pkill() { return 0; }
userdel() { echo "userdel $*" >> "$OPENFY_TEST_LOG"; return 0; }
groupdel() { echo "groupdel $*" >> "$OPENFY_TEST_LOG"; return 0; }
getent() { if [ "$1" = "passwd" ]; then printf '%s\\n' "$OPENFY_TEST_PASSWD_LINE"; fi; return 0; }
source "$OPENFY_UNINSTALLER" "$@"
"""


def _q(path: str) -> str:
    """Mirror bash's `printf %q` for the paths used in these tests."""
    return path.replace("\\", "\\\\").replace(" ", "\\ ")


class _Sandbox:
    """A throw-away Openfy installation plus a runner for the uninstaller."""

    def __init__(self, tmp_path: Path, app_name: str = "openfy"):
        self.tmp_path = tmp_path
        self.app = tmp_path / "opt" / app_name
        self.data = tmp_path / "var" / "lib" / "openfy"
        self.config = tmp_path / "etc" / "openfy"
        self.backups = tmp_path / "var" / "backups" / "openfy"
        self.bin = tmp_path / "usr" / "local" / "bin"
        self.systemd = tmp_path / "etc" / "systemd" / "system"
        self.log = tmp_path / "stub-commands.log"
        self.runner = tmp_path / "runner.sh"
        self._populate()

    def _populate(self):
        (self.app / "app").mkdir(parents=True)
        (self.app / "app" / "main.py").write_text("x\n", encoding="utf-8")
        (self.app / "uninstall.sh").write_text("x\n", encoding="utf-8")
        (self.data / "music").mkdir(parents=True)
        (self.data / "openfy.db").write_text("sqlite\n", encoding="utf-8")
        (self.data / "music" / "song.mp3").write_bytes(b"audio")
        self.config.mkdir(parents=True)
        (self.config / "openfy.env").write_text(
            "OPENFY_ADMIN_USERNAME=admin\nOPENFY_ADMIN_HASH=of1_credential\n",
            encoding="utf-8",
        )
        (self.config / "openfy.env.bak-20260101T000000Z").write_text(
            "OPENFY_ADMIN_HASH=of1_old\n", encoding="utf-8",
        )
        self.backups.mkdir(parents=True)
        (self.backups / "openfy.env").write_text("OPENFY_ADMIN_HASH=of1_old\n", encoding="utf-8")
        (self.backups / "openfy.db").write_text("sqlite\n", encoding="utf-8")
        self.bin.mkdir(parents=True)
        # The installer writes the path shell-escaped (printf %q).
        (self.bin / "openfy").write_text(
            f'#!/bin/bash\nexport OPENFY_INSTALL_DIR={_q(_m(self.app))}\n'
            f'exec bash {_q("/opt/openfy/openfy")} "$@"\n',
            encoding="utf-8",
        )
        self.systemd.mkdir(parents=True)
        (self.systemd / "openfy.service").write_text("[Unit]\n", encoding="utf-8")
        self.runner.write_text(_RUNNER, encoding="utf-8")

    def env(self, **overrides):
        env = dict(os.environ)
        env.update({
            "OPENFY_UNINSTALLER": _m(UNINSTALLER),
            "OPENFY_TEST_LOG": _m(self.log),
            "OPENFY_TEST_PASSWD_LINE": (
                f"openfy-test:x:999:999:Openfy service account:{_m(self.data)}:/usr/sbin/nologin"
            ),
            "OPENFY_INSTALL_DIR": _m(self.app),
            "OPENFY_DATA_DIR_OVERRIDE": _m(self.data),
            "OPENFY_CONFIG_DIR": _m(self.config),
            "OPENFY_BACKUP_DIR": _m(self.backups),
            "OPENFY_BIN_DIR": _m(self.bin),
            "OPENFY_SYSTEMD_DIR": _m(self.systemd),
            "OPENFY_SERVICE_USER": "openfy-test",
            "OPENFY_SERVICE_NAME": "openfy",
        })
        env.update(overrides)
        return env

    def run(self, *args, stdin="", env=None):
        bash = _need_bash()
        return subprocess.run(
            [bash, _m(self.runner), *args],
            capture_output=True, text=True, timeout=120,
            env=env or self.env(), input=stdin,
        )

    def stub_log(self):
        if not self.log.exists():
            return ""
        return self.log.read_text(encoding="utf-8")


def test_uninstall_removes_every_trace(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes")
    assert proc.returncode == 0, proc.stderr
    assert not box.app.exists(), "application files survived"
    assert not box.data.exists(), "data directory survived"
    assert not box.config.exists(), "configuration (admin credential) survived"
    assert not box.backups.exists(), "update backups survived"
    assert not (box.bin / "openfy").exists(), "CLI wrapper survived"
    assert not (box.systemd / "openfy.service").exists(), "systemd unit survived"
    # The Openfy-specific service account is removed as well.
    assert "userdel openfy-test" in box.stub_log()


def test_uninstall_reports_what_it_removes(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes")
    assert proc.returncode == 0, proc.stderr
    assert "Removing user data" in proc.stdout
    assert "Removing configuration" in proc.stdout
    assert "Removing update backups" in proc.stdout
    assert "Uninstall complete." in proc.stdout


def test_removes_the_cli_wrapper_of_an_install_dir_with_spaces(tmp_path):
    # The installer writes the install path shell-escaped, so the uninstaller
    # has to match the escaped form too.
    box = _Sandbox(tmp_path, app_name="openfy dir")
    proc = box.run("--yes")
    assert proc.returncode == 0, proc.stderr
    assert not (box.bin / "openfy").exists(), "CLI wrapper survived"
    assert not box.app.exists()


def test_keep_data_preserves_the_database_but_drops_the_credential(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", "--keep-data")
    assert proc.returncode == 0, proc.stderr
    assert (box.data / "openfy.db").exists(), "data must survive --keep-data"
    assert not box.config.exists(), "configuration must not survive"
    assert "Preserved user data" in proc.stdout


def test_keep_config_preserves_the_admin_credential(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", "--keep-config")
    assert proc.returncode == 0, proc.stderr
    assert (box.config / "openfy.env").exists(), "config must survive --keep-config"
    assert "OPENFY_ADMIN_HASH" in (box.config / "openfy.env").read_text(encoding="utf-8")
    assert not box.data.exists(), "data must not survive"
    assert "Preserved configuration" in proc.stdout


def test_keep_backups_preserves_the_backup_copies(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", "--keep-backups")
    assert proc.returncode == 0, proc.stderr
    assert (box.backups / "openfy.env").exists(), "backups must survive --keep-backups"
    assert not box.config.exists()


def test_keep_service_user_preserves_the_account(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", "--keep-service-user")
    assert proc.returncode == 0, proc.stderr
    assert "userdel" not in box.stub_log()
    assert "Preserved service account" in proc.stdout


def test_answering_no_aborts_without_touching_anything(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run(stdin="n\n")
    assert proc.returncode == 0, proc.stderr
    assert "Aborted" in proc.stdout
    assert box.app.exists(), "application files must survive an abort"
    assert box.data.exists(), "data must survive an abort"
    assert box.config.exists(), "config must survive an abort"
    assert box.backups.exists(), "backups must survive an abort"


def test_refuses_to_delete_a_shallow_path(tmp_path):
    # A single path component is never a dedicated Openfy directory. The
    # refusal must happen before anything is removed.
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", env=box.env(OPENFY_DATA_DIR_OVERRIDE="/openfy-data-test"))
    assert proc.returncode != 0, "a system-looking path must be refused"
    assert "looks like a system path" in proc.stderr
    assert box.app.exists(), "the application must survive a refused uninstall"
    assert box.config.exists(), "the config must survive a refused uninstall"
    assert box.backups.exists(), "the backups must survive a refused uninstall"


def test_obsolete_purge_flag_is_accepted_and_ignored(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", "--purge")
    assert proc.returncode == 0, proc.stderr
    assert "obsolete" in proc.stderr
    assert not box.data.exists()
    assert not box.config.exists()


def test_unknown_option_fails_fast(tmp_path):
    box = _Sandbox(tmp_path)
    proc = box.run("--yes", "--not-a-flag")
    assert proc.returncode != 0
    assert "unknown option" in proc.stderr
    assert box.data.exists()
