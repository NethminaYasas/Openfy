"""Tests for the root install.sh bootstrap and the hardened bundle installer.

Strategy: source the bash scripts and exercise their functions with a mocked
GitHub API (file:// trees), stubbed system commands, and temporary
directories. No network access, no root privileges, and no destructive host
changes are required. Tests that need bash are skipped when no working bash
is available.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path

import pytest

try:
    import yaml
except ImportError:
    yaml = None

REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = REPO_ROOT / "install.sh"
BUNDLE_INSTALL = REPO_ROOT / "scripts" / "linux" / "install.sh"

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


def _run_bash(bash, script, env=None, timeout=120):
    merged = dict(os.environ)
    if env:
        merged.update(env)
    return subprocess.run(
        [bash, "-c", script], capture_output=True, text=True,
        timeout=timeout, env=merged, cwd=str(REPO_ROOT),
    )


def _source_prelude():
    return f'source "{BOOTSTRAP.as_posix()}"'


def _bash_eval(bash, expression, env=None):
    """Evaluate a bash expression after sourcing the bootstrap; return stdout."""
    proc = _run_bash(bash, f'{_source_prelude()}\n{expression}', env=env)
    return proc


# ------------------------------------------------------------------ fakes

def _func_stub(name: str, body: str):
    """A bash function definition that shadows an external command.

    More hermetic than PATH stubs: immune to msys/Windows PATH conversion.
    """
    return f"{name}() {{\n{body}\n}}"


def _m(path):
    """Native path string for use inside bash.

    On Linux this is the plain POSIX path. Under Git-bash on Windows, the
    pytest temp dir lives under the Windows temp directory, which msys maps
    to /tmp — but msys tools (tar, grep, sha256sum) choke on `C:`-style
    paths, so rewrite temp paths to their /tmp/... aliases.
    """
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


def _uri(path):
    """file:// URI for a local path (for curl-based API/download mocks)."""
    return Path(path).as_uri()


def _fake_github(tmp_path: Path, releases: dict, bundles: dict):
    """Build a file:// GitHub stand-in.

    releases: {tag: {"draft": bool, "prerelease": bool, "assets": [names]}}
    bundles: {(version, arch): {"version": ..., "arch": ...}} tarballs staged
    under dl/v<version>/ with SHA256SUMS.
    Returns (api_base, download_base) as file:// URIs.
    """
    import hashlib

    fake = tmp_path / "fake-gh"
    api_tags = fake / "api" / "repos" / "NethminaYasas" / "Openfy" / "releases" / "tags"
    api_tags.mkdir(parents=True)
    dl = fake / "dl"
    dl.mkdir(parents=True)
    for tag, meta in releases.items():
        assets = meta.get("assets", [])
        payload = {**meta, "tag_name": tag,
                   "assets": [{"name": a} if isinstance(a, str) else a for a in assets]}
        (api_tags / tag).write_text(json.dumps(payload), encoding="utf-8")
    for (version, arch), doc in bundles.items():
        stage = tmp_path / "stage" / f"openfy-v{version}-{arch}"
        (stage / "app").mkdir(parents=True)
        (stage / "client").mkdir(parents=True)
        for rel in ["app/main.py", "client/index.html", "requirements.txt",
                    "install.sh", "update.sh", "uninstall.sh", "openfy",
                    "openfy.service", "generate_hash.py"]:
            (stage / rel).write_text("x\n", encoding="utf-8")
        (stage / "VERSION.json").write_text(json.dumps({
            "name": "openfy",
            "version": doc.get("version", version),
            "tag": f"v{doc.get('version', version)}",
            "prerelease": False,
            "arch": doc.get("arch", arch),
            "commit": "test",
            "bundle": "python-source",
        }), encoding="utf-8")
        outdir = dl / f"v{version}"
        outdir.mkdir(parents=True, exist_ok=True)
        archive = outdir / f"openfy-v{version}-{arch}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(stage, arcname=stage.name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        sums = outdir / "SHA256SUMS"
        with sums.open("a", encoding="utf-8") as f:
            f.write(f"{digest}  {archive.name}\n")
    return _uri(fake / "api"), _uri(fake / "dl")


def _latest_payload(path: Path, tag, draft=False, prerelease=False, assets=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "tag_name": tag, "draft": draft, "prerelease": prerelease,
        "assets": [{"name": a} for a in assets],
    }), encoding="utf-8")


# ------------------------------------------------------------------ basics

def test_bootstrap_exists_with_lf_endings_and_shebang():
    assert BOOTSTRAP.is_file(), "root install.sh is missing"
    raw = BOOTSTRAP.read_bytes()
    assert b"\r" not in raw, "install.sh must use Unix (LF) line endings"
    assert raw.startswith(b"#!/bin/bash"), "install.sh must start with a bash shebang"


def test_bootstrap_is_executable():
    try:
        proc = subprocess.run(
            ["git", "ls-files", "-s", "install.sh"], capture_output=True,
            text=True, timeout=30, cwd=str(REPO_ROOT),
        )
        mode = proc.stdout.split()[0] if proc.stdout.strip() else ""
    except (OSError, subprocess.SubprocessError):
        mode = ""
    if mode:
        assert mode == "100755", f"install.sh git mode is {mode}, expected 100755"
    elif os.name == "posix":
        assert os.stat(BOOTSTRAP).st_mode & stat.S_IXUSR, "install.sh is not executable"
    else:
        pytest.skip("cannot verify executable bit on this platform")


def test_bootstrap_shell_syntax():
    bash = _need_bash()
    proc = subprocess.run([bash, "-n", str(BOOTSTRAP)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_bundle_installer_shell_syntax():
    bash = _need_bash()
    proc = subprocess.run([bash, "-n", str(BUNDLE_INSTALL)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_sourcing_bootstrap_has_no_side_effects(tmp_path):
    bash = _need_bash()
    marker = tmp_path / "work"
    proc = _run_bash(bash, f'{_source_prelude()}\necho "sourced-ok"\n[[ -z "${{WORK_DIR}}" ]] && echo "no-workdir"')
    assert proc.returncode == 0, proc.stderr
    assert "sourced-ok" in proc.stdout
    assert "no-workdir" in proc.stdout
    assert not marker.exists()


# ------------------------------------------------------- version handling

@pytest.mark.parametrize("raw,version,tag", [
    ("1.4.2", "1.4.2", "v1.4.2"),
    ("v1.4.2", "1.4.2", "v1.4.2"),
    ("0.0.1", "0.0.1", "v0.0.1"),
    ("1.5.0-rc.1", "1.5.0-rc.1", "v1.5.0-rc.1"),
    ("v1.5.0-beta.2", "1.5.0-beta.2", "v1.5.0-beta.2"),
    ("v2.0.0-alpha.1", "2.0.0-alpha.1", "v2.0.0-alpha.1"),
])
def test_version_normalization(raw, version, tag):
    bash = _need_bash()
    proc = _run_bash(bash, f'{_source_prelude()}\nnormalize_version_input "{raw}"')
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == f"{version} {tag}"


@pytest.mark.parametrize("raw", [
    "", "latest", "1.4", "v1.4", "1.4.2.3", "v01.2.3", "v1.2.3-",
    "v1.2.3-gamma.1", "v1.2.3-rc.x", "main", "1.4.2 ", " v1.4.2",
    "../../../etc/passwd", "1.4.2; rm -rf /", "$(evil)",
])
def test_version_normalization_invalid(raw):
    bash = _need_bash()
    proc = _run_bash(bash, f'{_source_prelude()}\nnormalize_version_input "{raw}"')
    assert proc.returncode != 0, f"invalid version accepted: {raw!r}"


def test_prerelease_detection():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_source_prelude()}
if version_is_prerelease "1.4.2"; then echo BAD_STABLE; else echo STABLE_OK; fi
if version_is_prerelease "1.5.0-rc.1"; then echo PRE_OK; else echo BAD_PRE; fi""")
    assert proc.returncode == 0, proc.stderr
    assert "STABLE_OK" in proc.stdout
    assert "PRE_OK" in proc.stdout


# ------------------------------------------------------- release lookup

def test_resolve_latest_stable(tmp_path):
    bash = _need_bash()
    api, dl = _fake_github(tmp_path, {}, {})
    _latest_payload(
        tmp_path / "fake-gh" / "api" / "repos" / "NethminaYasas" / "Openfy" / "releases" / "latest",
        "v9.9.9",
    )
    proc = _run_bash(bash, f"""{_source_prelude()}
resolve_latest_stable
echo "TAG=${{RESOLVED_TAG}} VER=${{RESOLVED_VERSION}} PRE=${{RESOLVED_PRERELEASE}}" """,
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert proc.returncode == 0, proc.stderr
    assert "TAG=v9.9.9 VER=9.9.9 PRE=false" in proc.stdout


def test_resolve_latest_refuses_prerelease_tag(tmp_path):
    bash = _need_bash()
    api, dl = _fake_github(tmp_path, {}, {})
    _latest_payload(
        tmp_path / "fake-gh" / "api" / "repos" / "NethminaYasas" / "Openfy" / "releases" / "latest",
        "v9.10.0-rc.1", prerelease=True,
    )
    proc = _run_bash(bash, f"""{_source_prelude()}
if (resolve_latest_stable); then echo ACCEPTED; else echo REFUSED; fi""",
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert "REFUSED" in proc.stdout
    assert "ACCEPTED" not in proc.stdout


def test_fetch_exact_stable_release(tmp_path):
    bash = _need_bash()
    proc = _bash_eval(bash, "detect_arch")
    assert proc.returncode == 0, proc.stderr
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.9": {"draft": False, "prerelease": False,
                    "assets": [f"openfy-v9.9.9-{arch}.tar.gz", "SHA256SUMS"]}},
        {("9.9.9", arch): {}},
    )
    proc = _run_bash(bash, f"""{_source_prelude()}
fetch_release_metadata "v9.9.9"
echo "TAG=${{RESOLVED_TAG}} VER=${{RESOLVED_VERSION}} PRE=${{RESOLVED_PRERELEASE}}" """,
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert proc.returncode == 0, proc.stderr
    assert "TAG=v9.9.9 VER=9.9.9 PRE=false" in proc.stdout


def test_fetch_nonexistent_release_fails_without_fallback(tmp_path):
    bash = _need_bash()
    api, dl = _fake_github(tmp_path, {}, {})
    proc = _run_bash(bash, f"""{_source_prelude()}
if (fetch_release_metadata "v8.8.8"); then echo ACCEPTED; else echo REFUSED; fi
echo "TAG=${{RESOLVED_TAG:-EMPTY}}" """,
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert "REFUSED" in proc.stdout
    assert "ACCEPTED" not in proc.stdout
    assert "TAG=EMPTY" in proc.stdout  # nothing resolved, no silent latest


def test_fetch_draft_release_is_never_installed(tmp_path):
    bash = _need_bash()
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.10": {"draft": True, "prerelease": False, "assets": []}},
        {},
    )
    proc = _run_bash(bash, f"""{_source_prelude()}
if (fetch_release_metadata "v9.9.10"); then echo ACCEPTED; else echo REFUSED; fi""",
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert "REFUSED" in proc.stdout
    assert "DRAFT" in proc.stderr.upper()


def test_fetch_release_with_missing_assets_refused(tmp_path):
    bash = _need_bash()
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.8": {"draft": False, "prerelease": False, "assets": ["notes.txt"]}},
        {},
    )
    proc = _run_bash(bash, f"""{_source_prelude()}
if (fetch_release_metadata "v9.9.8"); then echo ACCEPTED; else echo REFUSED; fi""",
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert "REFUSED" in proc.stdout
    assert "ACCEPTED" not in proc.stdout


def test_prerelease_release_is_flagged(tmp_path):
    bash = _need_bash()
    proc = _bash_eval(bash, "detect_arch")
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {"v9.10.0-rc.1": {"draft": False, "prerelease": True,
                          "assets": [f"openfy-v9.10.0-rc.1-{arch}.tar.gz", "SHA256SUMS"]}},
        {},
    )
    proc = _run_bash(bash, f"""{_source_prelude()}
fetch_release_metadata "v9.10.0-rc.1"
echo "PRE=${{RESOLVED_PRERELEASE}}" """,
                        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert proc.returncode == 0, proc.stderr
    assert "PRE=true" in proc.stdout


# ------------------------------------------------------- download/verify

def _download_and_verify_case(bash, tmp_path, tamper=False):
    proc = _bash_eval(bash, "detect_arch")
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.9": {"draft": False, "prerelease": False,
                    "assets": [f"openfy-v9.9.9-{arch}.tar.gz", "SHA256SUMS"]}},
        {("9.9.9", arch): {}},
    )
    work = tmp_path / "work"
    work.mkdir()
    w = _m(work)
    tamper_line = (
        f'echo tamper >> "{w}/openfy-v9.9.9-{arch}.tar.gz"'
        if tamper else ":"
    )
    return _run_bash(bash, f"""{_source_prelude()}
W="{w}"
download_release "9.9.9" "{arch}" "$W"
{tamper_line}
if (verify_download "$W" "openfy-v9.9.9-{arch}.tar.gz"); then echo VERIFIED; else echo CORRUPT; fi""",
                     env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})


def test_checksum_success(tmp_path):
    bash = _need_bash()
    proc = _download_and_verify_case(bash, tmp_path, tamper=False)
    assert "VERIFIED" in proc.stdout, proc.stderr
    assert "CORRUPT" not in proc.stdout


def test_checksum_mismatch_refused(tmp_path):
    bash = _need_bash()
    proc = _download_and_verify_case(bash, tmp_path, tamper=True)
    assert "CORRUPT" in proc.stdout
    assert "VERIFIED" not in proc.stdout


def test_failed_download_leaves_no_partial_file(tmp_path):
    bash = _need_bash()
    work = tmp_path / "work"
    work.mkdir()
    w = _m(work)
    proc = _run_bash(bash, f"""{_source_prelude()}
if (http_download "file:///nonexistent-openfy-test/missing.tar.gz" "{w}/missing.tar.gz"); then
  echo DOWNLOADED
else
  echo FAILED
fi
[[ -e "{w}/missing.tar.gz" ]] && echo PARTIAL_LEFT || echo CLEAN""")
    assert "FAILED" in proc.stdout
    assert "CLEAN" in proc.stdout


def test_extract_validates_version_and_arch(tmp_path):
    bash = _need_bash()
    proc = _bash_eval(bash, "detect_arch")
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.9": {"draft": False, "prerelease": False,
                    "assets": [f"openfy-v9.9.9-{arch}.tar.gz", "SHA256SUMS"]}},
        {("9.9.9", arch): {}},
    )
    work = tmp_path / "work"
    work.mkdir()
    w = _m(work)
    proc = _run_bash(bash, f"""{_source_prelude()}
W="{w}"
download_release "9.9.9" "{arch}" "$W"
verify_download "$W" "openfy-v9.9.9-{arch}.tar.gz" >/dev/null
TOP="$(extract_and_validate "$W" "openfy-v9.9.9-{arch}.tar.gz" "9.9.9" "{arch}")"
[[ -f "$TOP/install.sh" ]] && echo EXTRACT_OK
if (extract_and_validate "$W" "openfy-v9.9.9-{arch}.tar.gz" "1.2.3" "{arch}" >/dev/null 2>&1); then
  echo WRONG_VERSION_ACCEPTED
else
  echo WRONG_VERSION_REFUSED
fi
if (extract_and_validate "$W" "openfy-v9.9.9-{arch}.tar.gz" "9.9.9" "linux-other" >/dev/null 2>&1); then
  echo WRONG_ARCH_ACCEPTED
else
  echo WRONG_ARCH_REFUSED
fi""",
                     env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert "EXTRACT_OK" in proc.stdout, proc.stderr
    assert "WRONG_VERSION_REFUSED" in proc.stdout
    assert "WRONG_ARCH_REFUSED" in proc.stdout


# ------------------------------------------------------- environment

def test_unsupported_architectures_rejected():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_func_stub("uname", 'if [[ "$1" == "-m" ]]; then echo "i686"; else echo "Linux"; fi')}
{_source_prelude()}
if (detect_arch); then echo ACCEPTED; else echo REFUSED; fi""")
    assert "REFUSED" in proc.stdout
    assert "unsupported CPU architecture" in proc.stderr


def test_arch_override_supported_values():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_source_prelude()}
ARCH_OVERRIDE="linux-arm64" detect_arch""")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "linux-arm64"


_LINUX_UNAME = _func_stub("uname", 'if [[ "$1" == "-m" ]]; then echo "x86_64"; else echo "Linux"; fi')


def test_unsupported_distribution_refused(tmp_path):
    bash = _need_bash()
    os_release = tmp_path / "os-release"
    os_release.write_text('ID=solaris\nVERSION_ID="11"\n', encoding="utf-8")
    proc = _run_bash(bash, f"""{_LINUX_UNAME}
{_source_prelude()}
if (detect_os); then echo ACCEPTED; else echo REFUSED; fi""",
                     env={"OPENFY_OS_RELEASE": _m(os_release)})
    assert "REFUSED" in proc.stdout
    assert "unsupported distribution" in proc.stderr


def test_unsupported_distribution_allowed_with_flag(tmp_path):
    bash = _need_bash()
    os_release = tmp_path / "os-release"
    os_release.write_text('ID=solaris\nVERSION_ID="11"\n', encoding="utf-8")
    proc = _run_bash(bash, f"""{_LINUX_UNAME}
{_source_prelude()}
ALLOW_UNSUPPORTED_OS="true"
if (detect_os); then echo CONTINUED; else echo REFUSED; fi""",
                     env={"OPENFY_OS_RELEASE": _m(os_release)})
    assert "CONTINUED" in proc.stdout


def test_non_linux_kernel_refused():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_func_stub("uname", 'echo "Darwin"')}
{_source_prelude()}
if (detect_os); then echo ACCEPTED; else echo REFUSED; fi""")
    assert "REFUSED" in proc.stdout


def test_insufficient_privileges_detected():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_func_stub("id", 'echo "1000"')}
{_source_prelude()}
if (require_root_native); then echo ROOT; else echo NONROOT; fi""")
    assert "NONROOT" in proc.stdout
    assert "sudo" in proc.stderr


def test_missing_python_detected(tmp_path):
    bash = _need_bash()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    # PATH with only coreutils: no python3, no systemctl.
    proc = _run_bash(bash, f"""{_source_prelude()}
NO_INSTALL_DEPS="true"
if (check_requirements_native); then echo OK; else echo MISSING; fi""",
                     env={"PATH": bin_dir.as_posix()})
    assert "MISSING" in proc.stdout


# ------------------------------------------------------- ports

@pytest.mark.parametrize("service_name", ["openfy", "custom-openfy"])
@pytest.mark.parametrize("busy,unit_port,active,explicit,dry_run,allowed", [
    (True, "9000", True, True, False, True),
    (True, "8000", True, True, False, False),
    (True, "9000", False, True, False, False),
    (True, None, True, True, False, False),
    (True, "", True, True, False, False),
    (False, "8000", False, True, False, True),
    (True, "8000", True, False, False, True),
    (True, "8000", True, True, True, True),
])
def test_native_upgrade_port_conflict(tmp_path, service_name, busy, unit_port, active, explicit, dry_run, allowed):
    systemd_dir = tmp_path / "systemd"
    systemd_dir.mkdir()
    if unit_port is not None:
        port_arg = f" --port {unit_port}" if unit_port else ""
        (systemd_dir / f"{service_name}.service").write_text(
            f"[Service]\nExecStart=/opt/openfy/venv/bin/python -m uvicorn app.main:app{port_arg}\n",
            encoding="utf-8",
        )
    staged = tmp_path / "bundle"
    staged.mkdir()
    (staged / "update.sh").write_text('printf "UPDATE:%s\\n" "$*"\n', encoding="utf-8")
    env = {"OPENFY_SYSTEMD_DIR": _m(systemd_dir), "OPENFY_SERVICE_NAME": service_name}
    proc = _bash_eval(_need_bash(), f"""
OPENFY_PORT=9000
PORT_EXPLICIT={'true' if explicit else 'false'}
DRY_RUN={'true' if dry_run else 'false'}
INSTALLED_VERSION=9.9.8
port_in_use() {{ [[ "$1" == "9000" ]] && return {0 if busy else 1}; }}
systemctl() {{ [[ "$*" == "is-active --quiet {service_name}" ]] && return {0 if active else 1}; }}
detect_arch() {{ echo linux-amd64; }}
run_native_delegate "{_m(staged)}" upgrade 9.9.9 /verified.tar.gz
""", env=env)
    assert (proc.returncode == 0) == allowed, proc.stdout + proc.stderr
    if allowed and not dry_run:
        assert "UPDATE:--archive /verified.tar.gz --arch linux-amd64" in proc.stdout
    else:
        assert "UPDATE:" not in proc.stdout
    if not allowed:
        assert "port 9000 is already in use by another process" in proc.stderr


def test_port_check_helpers():
    bash = _need_bash()
    if shutil.which("python3") is None:
        import pytest
        pytest.skip("python3 not available for port test")
    proc = _run_bash(bash, f"""{_source_prelude()}
# A freshly released ephemeral port is not listening: must report free.
FREE_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
if port_in_use "${{FREE_PORT}}"; then echo P1_USED; else echo P1_FREE; fi
# Hold an ephemeral port open in the background: must report in use.
HELD_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
python3 - "${{HELD_PORT}}" <<'EOF' &
import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", int(sys.argv[1])))
s.listen(1)
time.sleep(20)
EOF
LISTENER=$!
sleep 1
if port_in_use "${{HELD_PORT}}"; then echo HELD; else echo NOT_HELD; fi
kill "${{LISTENER}}" 2>/dev/null || true""")
    assert "P1_FREE" in proc.stdout, proc.stderr
    tokens = proc.stdout.split()
    assert "HELD" in tokens, proc.stdout
    assert "NOT_HELD" not in tokens, proc.stdout


# ------------------------------------------------------- credentials

def _bundle_prelude():
    return f'source "{BUNDLE_INSTALL.as_posix()}"'


def test_credential_format_matches_application():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_bundle_prelude()}
C="$(generate_credential)"
echo "LEN=${{#C}}"
[[ "$C" =~ ^of1_[A-Za-z0-9_-]{{60}}$ ]] && echo PATTERN_OK || echo PATTERN_BAD
valid_credential "$C" && echo FORMAT_OK
valid_credential "abc123" || echo SHORT_REJECTED
valid_credential "" || echo EMPTY_REJECTED
valid_credential 'of1_short' || echo PREFIX_ONLY_REJECTED""")
    assert proc.returncode == 0, proc.stderr
    assert "LEN=64" in proc.stdout, proc.stdout
    assert "PATTERN_OK" in proc.stdout, proc.stdout
    assert "FORMAT_OK" in proc.stdout
    assert "SHORT_REJECTED" in proc.stdout
    assert "EMPTY_REJECTED" in proc.stdout
    assert "PREFIX_ONLY_REJECTED" in proc.stdout


def test_fresh_config_generates_and_rerun_preserves(tmp_path):
    bash = _need_bash()
    cfg = tmp_path / "cfg"
    tapp, tdata, tcfg = _m(tmp_path / "app"), _m(tmp_path / "data"), _m(cfg)
    script = f"""{_func_stub("chown", "return 0")}
{_bundle_prelude()}
parse_args --admin-user testadmin --no-start --no-install-deps
APP_DIR="{tapp}"
DATA_DIR="{tdata}"
CONFIG_DIR="{tcfg}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
NO_GENERATE_CREDENTIAL="false"
unset OPENFY_ADMIN_HASH_VALUE
install_config >/dev/null
HASH="$(grep -E '^OPENFY_ADMIN_HASH=' "${{ENV_FILE}}" | cut -d= -f2-)"
if valid_credential "$HASH"; then echo STORED_VALID; else echo STORED_BAD; fi
OUT="$(install_config)"
if grep -q "of1_" <<<"$OUT"; then echo LEAKED; else echo NO_LEAK; fi
echo "HASH2=$(grep -E '^OPENFY_ADMIN_HASH=' "${{ENV_FILE}}" | cut -d= -f2-)" """
    proc = _run_bash(bash, script)
    assert proc.returncode == 0, proc.stderr
    assert "STORED_VALID" in proc.stdout, proc.stdout
    assert "NO_LEAK" in proc.stdout, proc.stdout
    stored = re.search(r"HASH2=(of1_\S+)", proc.stdout)
    first = (cfg / "openfy.env").read_text()
    assert stored and stored.group(1) in first



@pytest.mark.parametrize("outcome", ["success", "no_start", "dependencies_fail", "health_fail", "existing", "supplied"])
@pytest.mark.parametrize("defer", [False, True])
def test_fresh_credentials_only_appear_after_success(tmp_path, outcome, defer):
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    credential = "of1_" + "a" * 60
    if outcome == "existing":
        (cfg / "openfy.env").write_text(f"OPENFY_ADMIN_HASH={credential}\n")
    handoff = tmp_path / "handoff"
    stubs = "\n".join(
        f"{name}() {{ return 0; }}"
        for name in ["require_root", "resolve_port", "check_os", "check_bundle_arch", "check_systemd",
                     "install_system_deps", "check_python", "check_port", "check_existing", "create_user",
                     "install_files", "create_dirs", "install_service", "install_cli", "chown"]
    )
    proc = _run_bash(_need_bash(), f"""{_bundle_prelude()}
APP_DIR="{_m(tmp_path / 'app')}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
OPENFY_CREDENTIAL_OUTPUT_FILE="{_m(handoff) if defer else ''}"
OPENFY_ADMIN_HASH_VALUE="{credential if outcome == 'supplied' else ''}"
{stubs}
generate_credential() {{ echo "{credential}"; }}
install_venv() {{ echo DEPENDENCIES; {'die dependency-failed' if outcome == 'dependencies_fail' else ':'}; }}
validate_install() {{ echo VALIDATED; }}
start_and_healthcheck() {{ echo HEALTH_CHECK; {'die health-failed' if outcome == 'health_fail' else ':'}; }}
main --admin-user testadmin {'--no-start' if outcome == 'no_start' else ''}
""")
    failed = outcome.endswith("fail")
    assert (proc.returncode != 0) == failed, proc.stderr
    if failed or outcome in ["existing", "supplied"]:
        assert credential not in proc.stdout
        assert not handoff.exists()
    elif defer:
        assert credential not in proc.stdout
        assert handoff.read_text() == f"testadmin\n{credential}\n"
        assert handoff.stat().st_mode & 0o777 == 0o600
    else:
        assert proc.stdout.count(credential) == 1
        assert proc.stdout.index(credential) > proc.stdout.index("HEALTH_CHECK")
        assert proc.stdout.index(credential) > proc.stdout.index("Install complete.")
        assert "  User: testadmin" in proc.stdout
        assert "Manage the server" not in proc.stdout.split(credential, 1)[1]


def test_bootstrap_prints_new_credential_after_summary_and_only_once(tmp_path):
    credential = "of1_" + "a" * 60
    proc = _bash_eval(_need_bash(), f"""
APP_DIR="{_m(tmp_path / 'app')}"
require_root_native() {{ return 0; }}
detect_os() {{ return 0; }}
check_requirements_native() {{ return 0; }}
install_system_deps() {{ return 0; }}
check_port_conflict() {{ return 0; }}
detect_existing_install() {{ INSTALLED_VERSION=""; }}
resolve_latest_stable() {{ RESOLVED_TAG=v9.9.9; RESOLVED_VERSION=9.9.9; }}
download_release() {{ return 0; }}
verify_download() {{ return 0; }}
extract_and_validate() {{ echo /verified-bundle; }}
run_native_delegate() {{
    ( umask 077; printf '%s\n%s\n' testadmin "{credential}" > "${{WORK_DIR}}/admin-credential" )
    echo VERIFIED_BUNDLE_FINISHED
}}
main --yes --admin-user testadmin --arch linux-amd64
print_deferred_credential
[[ ! -e "${{WORK_DIR}}/admin-credential" ]] || exit 2
""")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.count(credential) == 1
    assert proc.stdout.index(credential) > proc.stdout.index("Openfy v9.9.9 installation complete.")
    assert proc.stdout.index(credential) > proc.stdout.index("VERIFIED_BUNDLE_FINISHED")
    assert "  User: testadmin" in proc.stdout


@pytest.mark.parametrize("explicit_port", [False, True])
def test_verified_bundle_passes_credential_to_final_bootstrap_output(tmp_path, explicit_port):
    credential = "of1_" + "a" * 60
    staged = tmp_path / "bundle"
    staged.mkdir()
    (staged / "install.sh").write_text(
        f'{_bundle_prelude()}\npublish_credential "{credential}" testadmin\necho BUNDLE_FINISHED\n',
    )
    proc = _bash_eval(_need_bash(), f"""
new_workdir
ADMIN_USER=testadmin
PORT_EXPLICIT={'true' if explicit_port else 'false'}
run_native_delegate "{_m(staged)}" install 9.9.9 ""
[[ -f "${{WORK_DIR}}/admin-credential" ]] || exit 2
print_native_summary 9.9.9
print_deferred_credential
""")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.count(credential) == 1
    assert proc.stdout.index(credential) > proc.stdout.index("BUNDLE_FINISHED")
    assert proc.stdout.index(credential) > proc.stdout.index("Openfy v9.9.9 installation complete.")

def test_credential_rotation(tmp_path):
    bash = _need_bash()
    cfg = tmp_path / "cfg"
    tapp, tdata, tcfg = _m(tmp_path / "app"), _m(tmp_path / "data"), _m(cfg)
    script = f"""{_func_stub("chown", "return 0")}
{_bundle_prelude()}
parse_args --no-start --no-install-deps
APP_DIR="{tapp}"
DATA_DIR="{tdata}"
CONFIG_DIR="{tcfg}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
NO_GENERATE_CREDENTIAL="false"
unset OPENFY_ADMIN_HASH_VALUE
install_config >/dev/null
BEFORE="$(grep -E '^OPENFY_ADMIN_HASH=' "${{ENV_FILE}}" | cut -d= -f2-)"
rotate_credential >/dev/null
AFTER="$(grep -E '^OPENFY_ADMIN_HASH=' "${{ENV_FILE}}" | cut -d= -f2-)"
[[ "$BEFORE" != "$AFTER" ]] && echo ROTATED || echo SAME
valid_credential "$AFTER" && echo NEW_VALID || echo NEW_BAD
ls "${{ENV_FILE}}".bak-* >/dev/null 2>&1 && echo BACKUP_OK || echo NO_BACKUP"""
    proc = _run_bash(bash, script)
    assert proc.returncode == 0, proc.stderr
    assert "ROTATED" in proc.stdout, proc.stdout
    assert "NEW_VALID" in proc.stdout
    assert "BACKUP_OK" in proc.stdout


def test_updater_never_touches_admin_credentials():
    content = (REPO_ROOT / "scripts" / "linux" / "update.sh").read_text()
    assert "OPENFY_ADMIN_HASH" not in content
    assert "generate_hash" not in content or "generate_hash.py" in content
    # The updater preserves config: it backs up openfy.env and never writes it.
    assert "openfy.env" in content


def _installed_rotation_script(tmp_path, version="9.9.9"):
    app = tmp_path / "app"
    app.mkdir()
    (app / "VERSION.json").write_text(json.dumps({"version": version}), encoding="utf-8")
    (app / "install.sh").write_text(
        '[[ "$*" == "--rotate-credential --admin-user testadmin" ]] || exit 2\n'
        '[[ "$OPENFY_CONFIG_DIR" == "$OPENFY_INSTALL_DIR/../cfg" ]] || exit 3\n'
        'echo ROTATED\n', encoding="utf-8",
    )
    return f'APP_DIR="{_m(app)}"\nCONFIG_DIR="${{APP_DIR}}/../cfg"'


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize("assume_yes", [False, True])
def test_rotation_only_bypasses_release_and_install_planning(tmp_path, dry_run, assume_yes):
    setup = _installed_rotation_script(tmp_path)
    proc = _bash_eval(_need_bash(), f"""{setup}
is_interactive() {{ return 0; }}
run_wizard() {{ die 'unexpected wizard'; }}
resolve_latest_stable() {{ die 'unexpected release lookup'; }}
fetch_release_metadata() {{ die 'unexpected release lookup'; }}
require_root_native() {{ echo ROOT_CHECKED; }}
main --rotate-credential --admin-user testadmin {'--yes' if assume_yes else ''} {'--dry-run' if dry_run else ''}
""")
    assert proc.returncode == 0, proc.stderr
    if dry_run:
        assert "DRY RUN" in proc.stdout
        assert "ROOT_CHECKED" not in proc.stdout
        assert "ROTATED" not in proc.stdout
    else:
        assert "ROOT_CHECKED" in proc.stdout
        assert "ROTATED" in proc.stdout
    assert not (tmp_path / "cfg").exists()


@pytest.mark.parametrize("stored_username", [None, "", "savedadmin"])
@pytest.mark.parametrize("explicit_username", [False, True])
def test_bootstrap_rotation_reports_persisted_username(tmp_path, stored_username, explicit_username):
    setup = _installed_rotation_script(tmp_path)
    (tmp_path / "app" / "install.sh").write_text(f"""{_bundle_prelude()}
require_root() {{ return 0; }}
create_user() {{ return 0; }}
chown() {{ return 0; }}
systemctl() {{ return 0; }}
wait_for_app_health() {{ return 0; }}
generate_credential() {{ echo of1_{'a' * 60}; }}
main "$@"
""", encoding="utf-8")
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    config = "OPENFY_ADMIN_HASH=of1_" + "b" * 60 + "\n"
    if stored_username is not None:
        config += f"OPENFY_ADMIN_USERNAME={stored_username}\n"
    env_file = cfg / "openfy.env"
    env_file.write_text(config, encoding="utf-8")
    proc = _bash_eval(_need_bash(), f"""{setup}
ADMIN_USER=admin
require_root_native() {{ return 0; }}
main --yes --rotate-credential {'--admin-user requestedadmin' if explicit_username else ''}
""")
    assert proc.returncode == 0, proc.stderr
    expected_username = stored_username or ("requestedadmin" if explicit_username else "admin")
    assert f"  User: {expected_username}\n" in proc.stdout
    assert env_file.read_text() == config.replace("of1_" + "b" * 60, "of1_" + "a" * 60)


@pytest.mark.parametrize("failure", ["missing_install", "missing_script", "nonroot", "docker", "delegate"])
def test_rotation_only_refuses_invalid_native_requests(tmp_path, failure):
    setup = _installed_rotation_script(tmp_path)
    if failure == "missing_install":
        (tmp_path / "app" / "VERSION.json").unlink()
    elif failure == "missing_script":
        (tmp_path / "app" / "install.sh").unlink()
    elif failure == "delegate":
        (tmp_path / "app" / "install.sh").write_text("exit 1\n", encoding="utf-8")
    proc = _bash_eval(_need_bash(), f"""{setup}
resolve_latest_stable() {{ die 'unexpected release lookup'; }}
id() {{ echo {'1000' if failure == 'nonroot' else '0'}; }}
main --yes --rotate-credential --admin-user testadmin {'--method docker' if failure == 'docker' else ''}
""")
    assert proc.returncode != 0
    expected = {
        "missing_install": "needs an existing installation",
        "missing_script": "no native installer",
        "nonroot": "requires root",
        "docker": "requires a native installation",
        "delegate": "credential rotation failed",
    }
    assert expected[failure] in proc.stderr
    assert "ROTATED" not in proc.stdout


@pytest.mark.parametrize("action", ["install", "upgrade", "repair", "reinstall", "upgrade_same_version"])
@pytest.mark.parametrize("rotate", [False, True])
@pytest.mark.parametrize("dry_run", [False, True])
def test_explicit_action_preserves_install_flow_before_rotation(tmp_path, action, rotate, dry_run):
    setup = _installed_rotation_script(tmp_path)
    same_version = action == "upgrade_same_version"
    # repair/reinstall must target the installed version (9.9.9); version
    # changes go through upgrade. install/upgrade use 9.9.10.
    if same_version or action in ("repair", "reinstall"):
        version = "9.9.9"
    else:
        version = "9.9.10"
    arch = "linux-amd64"
    api, dl = _fake_github(
        tmp_path,
        {f"v{version}": {"draft": False, "prerelease": False,
                         "assets": [f"openfy-v{version}-{arch}.tar.gz", "SHA256SUMS"]}},
        {(version, arch): {}},
    )
    proc = _bash_eval(_need_bash(), f"""{setup}
require_root_native() {{ return 0; }}
detect_os() {{ return 0; }}
check_requirements_native() {{ return 0; }}
install_system_deps() {{ return 0; }}
check_port_conflict() {{ return 0; }}
run_native_delegate() {{ echo "DELEGATE:$2"; }}
main --yes --action {'upgrade' if same_version else action} --version {version} --arch {arch} --admin-user testadmin {'--rotate-credential' if rotate else ''} {'--dry-run' if dry_run else ''}
""", env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert proc.returncode == 0, proc.stderr
    assert f"Release v{version} is published" in proc.stdout
    if dry_run:
        assert "DRY RUN" in proc.stdout
        assert "DELEGATE:" not in proc.stdout
        assert ("--rotate-credential" in proc.stdout) == rotate
    elif same_version:
        assert "Already at version" in proc.stdout
        assert "DELEGATE:" not in proc.stdout
    else:
        mode = "upgrade" if action == "install" else action
        assert f"DELEGATE:{mode}" in proc.stdout
        if rotate:
            assert proc.stdout.index("DELEGATE:") < proc.stdout.index("ROTATED")
    assert ("ROTATED" in proc.stdout) == (rotate and not dry_run)


@pytest.mark.parametrize("action", ["repair", "reinstall"])
def test_repair_reinstall_reject_version_change(tmp_path, action):
    setup = _installed_rotation_script(tmp_path)
    arch = "linux-amd64"
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.10": {"draft": False, "prerelease": False,
                      "assets": [f"openfy-v9.9.10-{arch}.tar.gz", "SHA256SUMS"]}},
        {("9.9.10", arch): {}},
    )
    proc = _bash_eval(_need_bash(), f"""{setup}
require_root_native() {{ return 0; }}
detect_os() {{ return 0; }}
check_requirements_native() {{ return 0; }}
install_system_deps() {{ return 0; }}
check_port_conflict() {{ return 0; }}
run_native_delegate() {{ echo "DELEGATE:$2"; }}
main --yes --action {action} --version 9.9.10 --arch {arch} --admin-user testadmin
""", env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl})
    assert proc.returncode != 0
    assert f"--action {action} targets 9.9.10 but 9.9.9 is installed" in proc.stderr
    assert "DELEGATE:" not in proc.stdout


@pytest.mark.parametrize("has_config", [False, True])
def test_bundle_rotation_request_never_falls_through_to_install(tmp_path, has_config):
    cfg = tmp_path / "cfg"
    if has_config:
        cfg.mkdir()
        (cfg / "openfy.env").write_text("OPENFY_ADMIN_HASH=of1_" + "b" * 60 + "\n", encoding="utf-8")
    proc = _run_bash(_need_bash(), f"""{_bundle_prelude()}
APP_DIR="{_m(tmp_path / 'app')}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
require_root() {{ return 0; }}
create_user() {{ echo USER_CHECKED; }}
chown() {{ return 0; }}
systemctl() {{ return 0; }}
wait_for_app_health() {{ return 0; }}
generate_credential() {{ echo of1_{'a' * 60}; }}
check_os() {{ die 'unexpected install'; }}
main --rotate-credential
""")
    assert "unexpected install" not in proc.stderr
    assert not (tmp_path / "app").exists()
    if has_config:
        assert "USER_CHECKED" in proc.stdout
        assert proc.returncode == 0, proc.stderr
        assert "OPENFY_ADMIN_HASH=of1_" + "a" * 60 in (cfg / "openfy.env").read_text()
        assert len(list(cfg.glob("openfy.env.bak-*"))) == 1
    else:
        assert "USER_CHECKED" not in proc.stdout
        assert proc.returncode != 0
        assert "no config" in proc.stderr
        assert not cfg.exists()


@pytest.mark.parametrize("has_config", [False, True])
def test_bundle_repair_requires_and_preserves_config(tmp_path, has_config):
    app = tmp_path / "app"
    app.mkdir()
    (app / "VERSION.json").write_text('{"version": "9.9.9"}', encoding="utf-8")
    cfg = tmp_path / "cfg"
    env_file = cfg / "openfy.env"
    config = "OPENFY_ADMIN_USERNAME=savedadmin\nOPENFY_ADMIN_HASH=of1_" + "b" * 60 + "\n"
    if has_config:
        cfg.mkdir()
        env_file.write_text(config, encoding="utf-8")
    proc = _run_bash(_need_bash(), f"""{_bundle_prelude()}
APP_DIR="{_m(app)}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
chown() {{ return 0; }}
create_user() {{ echo REPAIR_STARTED; }}
install_files() {{ return 0; }}
create_dirs() {{ return 0; }}
install_venv() {{ return 0; }}
install_service() {{ return 0; }}
validate_install() {{ return 0; }}
repair_install
""")
    if has_config:
        assert proc.returncode == 0, proc.stderr
        assert "Repair complete" in proc.stdout
        assert env_file.read_text() == config
        assert "of1_" not in proc.stdout
    else:
        assert proc.returncode != 0
        assert "no config" in proc.stderr
        assert "repair never creates configuration" in proc.stderr
        assert "REPAIR_STARTED" not in proc.stdout
        assert not cfg.exists()


# ------------------------------------------------------- wiring/policy

def test_no_curl_pipe_shell_patterns():
    for path in [BOOTSTRAP, BUNDLE_INSTALL,
                 REPO_ROOT / "scripts" / "linux" / "update.sh",
                 REPO_ROOT / "scripts" / "linux" / "uninstall.sh"]:
        content = path.read_text()
        assert not re.search(r"curl[^|]*\|\s*(ba)?sh", content), f"curl|sh in {path.name}"


def test_upgrade_delegates_to_verified_update_archive():
    content = BOOTSTRAP.read_text()
    assert 'update.sh" --archive' in content
    # The archive passed to update.sh is the checksum-verified download.
    assert "verify_download" in content


def test_docker_image_matches_release_registry():
    if yaml is None:
        pytest.skip("PyYAML not installed (test-only dependency)")
    bootstrap = BOOTSTRAP.read_text()
    assert "ghcr.io/nethminayasas/openfy" in bootstrap
    release = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "release.yml").read_text())
    assert release["env"]["IMAGE_NAME"] == "ghcr.io/nethminayasas/openfy"
    prod = yaml.safe_load((REPO_ROOT / "docker-compose.prod.yml").read_text())
    assert prod["services"]["openfy-server"]["image"].startswith("ghcr.io/nethminayasas/openfy:")
    # Prereleases never move the stable aliases (workflow + bootstrap agree).
    assert "prerelease" in bootstrap.lower()


def test_bundle_required_files_match_packager():
    bootstrap = BOOTSTRAP.read_text()
    required_block = re.search(r"for entry in (.*?); do", bootstrap, re.S)
    assert required_block, "extract_and_validate file list not found"
    listed = required_block.group(1).replace("\n", " ").split()
    for rel in ["install.sh", "update.sh", "uninstall.sh", "openfy",
                "openfy.service",
                "app/main.py", "client/index.html", "requirements.txt",
                "generate_hash.py"]:
        assert rel in listed, f"bootstrap does not require {rel}"
    packager = (REPO_ROOT / "scripts" / "release" / "package-linux.sh").read_text()
    for rel in ["install.sh", "generate_hash.py", "openfy.service", "openfy"]:
        assert rel in packager


def test_dry_run_changes_nothing(tmp_path):
    bash = _need_bash()
    proc = _bash_eval(bash, "detect_arch")
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {"v9.9.9": {"draft": False, "prerelease": False,
                    "assets": [f"openfy-v9.9.9-{arch}.tar.gz", "SHA256SUMS"]}},
        {("9.9.9", arch): {}},
    )
    app_dir = tmp_path / "app"
    proc = _run_bash(
        bash,
        f'"{BOOTSTRAP.as_posix()}" --yes --dry-run --method native 9.9.9',
        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl,
             "OPENFY_INSTALL_DIR": _m(app_dir),
             "OPENFY_DATA_DIR_OVERRIDE": _m(tmp_path / "data"),
             "OPENFY_CONFIG_DIR": _m(tmp_path / "cfg")},
    )
    assert proc.returncode == 0, proc.stderr
    assert "DRY RUN" in proc.stdout
    assert not app_dir.exists(), "dry run must not create the install directory"


def test_repair_pins_installed_version_not_latest(tmp_path):
    """--action repair without a version must fix the installed version.

    It must not silently pull the latest release instead.
    """
    import json as _json

    bash = _need_bash()
    proc = _bash_eval(bash, "detect_arch")
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {
            "v9.9.9": {"draft": False, "prerelease": False,
                       "assets": [f"openfy-v9.9.9-{arch}.tar.gz", "SHA256SUMS"]},
            "v9.9.10": {"draft": False, "prerelease": False,
                        "assets": [f"openfy-v9.9.10-{arch}.tar.gz", "SHA256SUMS"]},
        },
        {},
    )
    _latest_payload(
        tmp_path / "fake-gh" / "api" / "repos" / "NethminaYasas" / "Openfy" / "releases" / "latest",
        "v9.9.10",
    )
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "VERSION.json").write_text(_json.dumps({"version": "9.9.9"}), encoding="utf-8")
    proc = _run_bash(
        bash,
        f'"{BOOTSTRAP.as_posix()}" --yes --dry-run --method native --action repair',
        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl,
             "OPENFY_INSTALL_DIR": _m(app_dir),
             "OPENFY_DATA_DIR_OVERRIDE": _m(tmp_path / "data"),
             "OPENFY_CONFIG_DIR": _m(tmp_path / "cfg")},
    )
    assert proc.returncode == 0, proc.stderr
    assert "Repair target pinned to installed version v9.9.9" in proc.stdout, proc.stdout
    assert "v9.9.9" in proc.stdout
    assert "9.9.10" not in proc.stdout


def test_wizard_uninstall_never_downloads():
    # The wizard can switch ACTION to uninstall; main must route straight to
    # the uninstall delegate without resolving or downloading any release.
    content = BOOTSTRAP.read_text()
    assert "The wizard may have switched to uninstall" in content
    assert content.count('[[ "${ACTION}" == "uninstall" ]]') >= 2


def test_docker_uninstall_dry_run():
    bash = _need_bash()
    proc = _run_bash(
        bash, f'"{BOOTSTRAP.as_posix()}" --yes --dry-run --method docker --action uninstall')
    assert proc.returncode == 0, proc.stderr
    assert "DRY RUN" in proc.stdout


def test_explicit_prerelease_needs_opt_in_noninteractive(tmp_path):
    bash = _need_bash()
    proc = _bash_eval(bash, "detect_arch")
    arch = proc.stdout.strip()
    api, dl = _fake_github(
        tmp_path,
        {"v9.10.0-rc.1": {"draft": False, "prerelease": True,
                          "assets": [f"openfy-v9.10.0-rc.1-{arch}.tar.gz", "SHA256SUMS"]}},
        {},
    )
    proc = _run_bash(
        bash,
        f'"{BOOTSTRAP.as_posix()}" --yes --dry-run --method docker v9.10.0-rc.1',
        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl},
    )
    assert proc.returncode != 0, "prerelease installed without opt-in"
    assert "prerelease" in proc.stderr.lower()
    # With opt-in the same request is accepted (dry run: no docker needed).
    proc = _run_bash(
        bash,
        f'"{BOOTSTRAP.as_posix()}" --yes --dry-run --method docker --include-prerelease v9.10.0-rc.1',
        env={"OPENFY_API_BASE": api, "OPENFY_DOWNLOAD_BASE": dl},
    )
    assert proc.returncode == 0, proc.stderr
    assert "9.10.0-rc.1" in proc.stdout


def test_docs_document_one_line_installer():
    readme = (REPO_ROOT / "README.md").read_text()
    assert "raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh" in readme
    assert "bash <(curl -fsSL " in readme
    assert "raw.githubusercontent.com/NethminaYasas/Openfy/main/install-docker.sh" in readme
    linux_doc = (REPO_ROOT / "docs" / "LINUX_INSTALL.md").read_text()
    assert "bash install.sh v1.4.2" in linux_doc
    assert "--yes --version 1.4.2" in linux_doc
    assert "--rotate-credential" in linux_doc
    assert "--action" in linux_doc and "repair" in linux_doc


# ------------------------------------------------------- missing credentials


def test_bundle_preserved_config_prints_rotate_hint_without_leaking(tmp_path):
    """A finished install that kept an existing config must say so loudly.

    Regression test: previously the install completed with no credential
    shown and no recovery hint, leaving operators locked out.
    """
    bash = _need_bash()
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    secret = "of1_" + "b" * 60
    (cfg / "openfy.env").write_text(
        f"OPENFY_ADMIN_USERNAME=savedadmin\nOPENFY_ADMIN_HASH={secret}\n",
        encoding="utf-8",
    )
    script = f"""{_func_stub("chown", "return 0")}
{_bundle_prelude()}
APP_DIR="{_m(tmp_path / 'app')}"
DATA_DIR="{_m(tmp_path / 'data')}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
unset OPENFY_CREDENTIAL_OUTPUT_FILE
REPAIR="false"
install_config >/dev/null
OUT="$(print_credential_notice)"
echo "$OUT"
[[ "$OUT" == *"rotate-credential"* ]] && echo HINT_OK || echo HINT_MISSING"""
    proc = _run_bash(bash, script)
    assert proc.returncode == 0, proc.stderr
    assert "HINT_OK" in proc.stdout, proc.stdout
    assert secret not in proc.stdout
    assert "of1_" not in proc.stdout


def test_bundle_credential_notice_stays_silent_for_repairs_and_delegates(tmp_path):
    bash = _need_bash()
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / "openfy.env").write_text("OPENFY_ADMIN_HASH=of1_" + "b" * 60 + "\n", encoding="utf-8")
    script = f"""{_func_stub("chown", "return 0")}
{_bundle_prelude()}
APP_DIR="{_m(tmp_path / 'app')}"
DATA_DIR="{_m(tmp_path / 'data')}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
install_config >/dev/null
REPAIR="true"
unset OPENFY_CREDENTIAL_OUTPUT_FILE
[[ -z "$(print_credential_notice)" ]] && echo REPAIR_SILENT || echo REPAIR_NOISY
REPAIR="false"
OPENFY_CREDENTIAL_OUTPUT_FILE="{_m(tmp_path / 'handoff')}"
[[ -z "$(print_credential_notice)" ]] && echo DELEGATE_SILENT || echo DELEGATE_NOISY"""
    proc = _run_bash(bash, script)
    assert proc.returncode == 0, proc.stderr
    assert "REPAIR_SILENT" in proc.stdout, proc.stdout
    assert "DELEGATE_SILENT" in proc.stdout, proc.stdout


def test_bundle_no_generate_credential_prints_setup_hint(tmp_path):
    bash = _need_bash()
    cfg = tmp_path / "cfg"
    script = f"""{_func_stub("chown", "return 0")}
{_bundle_prelude()}
APP_DIR="{_m(tmp_path / 'app')}"
DATA_DIR="{_m(tmp_path / 'data')}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
NO_GENERATE_CREDENTIAL="true"
unset OPENFY_ADMIN_HASH_VALUE
unset OPENFY_CREDENTIAL_OUTPUT_FILE
REPAIR="false"
install_config >/dev/null
OUT="$(print_credential_notice)"
echo "$OUT"
[[ "$OUT" == *"NO ADMIN CREDENTIAL IS CONFIGURED"* ]] && echo SETUP_HINT_OK || echo SETUP_HINT_MISSING"""
    proc = _run_bash(bash, script)
    assert proc.returncode == 0, proc.stderr
    assert "SETUP_HINT_OK" in proc.stdout, proc.stdout
    assert "of1_" not in proc.stdout


def test_bootstrap_fresh_install_without_credential_warns_loudly(tmp_path):
    """Fresh native install with no handoff must warn instead of staying silent."""
    proc = _bash_eval(_need_bash(), f"""
APP_DIR="{_m(tmp_path / 'app')}"
require_root_native() {{ return 0; }}
detect_os() {{ return 0; }}
check_requirements_native() {{ return 0; }}
install_system_deps() {{ return 0; }}
check_port_conflict() {{ return 0; }}
detect_existing_install() {{ INSTALLED_VERSION=""; }}
resolve_latest_stable() {{ RESOLVED_TAG=v9.9.9; RESOLVED_VERSION=9.9.9; }}
download_release() {{ return 0; }}
verify_download() {{ return 0; }}
extract_and_validate() {{ echo /verified-bundle; }}
run_native_delegate() {{
    echo VERIFIED_BUNDLE_FINISHED
}}
main --yes --admin-user testadmin --arch linux-amd64
""")
    assert proc.returncode == 0, proc.stderr
    assert "Openfy v9.9.9 installation complete." in proc.stdout
    assert "NO NEW ADMIN CREDENTIAL WAS GENERATED" in proc.stdout
    assert "openfy rotate-credential" in proc.stdout


def test_bootstrap_summary_has_sections_and_next_steps(tmp_path):
    """The final summary groups paths/commands and ends with next steps."""
    credential = "of1_" + "a" * 60
    proc = _bash_eval(_need_bash(), f"""
APP_DIR="{_m(tmp_path / 'app')}"
require_root_native() {{ return 0; }}
detect_os() {{ return 0; }}
check_requirements_native() {{ return 0; }}
install_system_deps() {{ return 0; }}
check_port_conflict() {{ return 0; }}
detect_existing_install() {{ INSTALLED_VERSION=""; }}
resolve_latest_stable() {{ RESOLVED_TAG=v9.9.9; RESOLVED_VERSION=9.9.9; }}
download_release() {{ return 0; }}
verify_download() {{ return 0; }}
extract_and_validate() {{ echo /verified-bundle; }}
run_native_delegate() {{
    ( umask 077; printf '%s\\n%s\\n' testadmin "{credential}" > "${{WORK_DIR}}/admin-credential" )
    echo VERIFIED_BUNDLE_FINISHED
}}
main --yes --admin-user testadmin --arch linux-amd64
""")
    assert proc.returncode == 0, proc.stderr
    assert "Openfy v9.9.9 installation complete." in proc.stdout
    assert "Where things live" in proc.stdout
    assert "Manage the server" in proc.stdout
    assert "Next steps" in proc.stdout
    assert "  User: testadmin" in proc.stdout
    assert proc.stdout.count(credential) == 1


@pytest.mark.parametrize("health_ok", [True, False])
@pytest.mark.parametrize("restart_ok", [True, False])
def test_bundle_rotation_restarts_service_automatically(tmp_path, restart_ok, health_ok):
    """Rotation restarts the service and verifies app health; failures are explicit."""
    bash = _need_bash()
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    before = "of1_" + "b" * 60
    (cfg / "openfy.env").write_text(f"OPENFY_ADMIN_HASH={before}\n", encoding="utf-8")
    rc = 0 if restart_ok else 1
    hc = 0 if health_ok else 1
    script = f"""{_func_stub("chown", "return 0")}
{_bundle_prelude()}
APP_DIR="{_m(tmp_path / 'app')}"
DATA_DIR="{_m(tmp_path / 'data')}"
CONFIG_DIR="{_m(cfg)}"
ENV_FILE="${{CONFIG_DIR}}/openfy.env"
require_root() {{ return 0; }}
create_user() {{ return 0; }}
generate_credential() {{ echo of1_{'a' * 60}; }}
systemctl() {{
    echo "SYSTEMCTL:$*"
    if [[ "$1" == "restart" ]]; then return {rc}; fi
    return 0
}}
wait_for_app_health() {{ echo "HEALTH_CHECK:$1"; return {hc}; }}
main --rotate-credential
"""
    proc = _run_bash(bash, script)
    # The config rotation itself always lands, even if restart/health fails.
    after = (cfg / "openfy.env").read_text()
    assert "of1_" + "a" * 60 in after, after
    assert before not in after
    assert "SYSTEMCTL:restart openfy" in proc.stdout, proc.stdout
    if restart_ok and health_ok:
        assert proc.returncode == 0, proc.stderr
        assert "HEALTH_CHECK:" in proc.stdout, proc.stdout
        assert "new credential is live" in proc.stdout, proc.stdout
    elif not restart_ok:
        assert proc.returncode != 0
        assert "credential was rotated, but" in proc.stderr, proc.stderr
    else:
        assert proc.returncode != 0
        assert "not responding" in proc.stderr, proc.stderr
