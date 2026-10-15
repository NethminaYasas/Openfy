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
import yaml

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
                    "install.sh", "update.sh", "uninstall.sh",
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

def test_port_check_helpers():
    bash = _need_bash()
    proc = _run_bash(bash, f"""{_source_prelude()}
# Port 1 is (practically) never listening: must report free.
if port_in_use "1"; then echo P1_USED; else echo P1_FREE; fi
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
    assert "HELD" in proc.stdout, proc.stdout


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
    for rel in ["install.sh", "update.sh", "uninstall.sh", "openfy.service",
                "app/main.py", "client/index.html", "requirements.txt",
                "generate_hash.py"]:
        assert rel in listed, f"bootstrap does not require {rel}"
    packager = (REPO_ROOT / "scripts" / "release" / "package-linux.sh").read_text()
    for rel in ["install.sh", "generate_hash.py", "openfy.service"]:
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
    assert "install.sh) v1.4.2" in readme
    assert "--yes --version 1.4.2" in readme
    linux_doc = (REPO_ROOT / "docs" / "LINUX_INSTALL.md").read_text()
    assert "--rotate-credential" in linux_doc
    assert "--action" in linux_doc and "repair" in linux_doc
