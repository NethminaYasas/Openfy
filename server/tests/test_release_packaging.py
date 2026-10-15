"""Release/packaging validation tests.

These tests verify the distribution layer only (tag policy, bundle file
lists, installer safety properties, workflow wiring). They never touch
system paths, Docker, or the network, so they run on any CI runner.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

# Mirrors scripts/release/common.sh OPENFY_TAG_REGEX.
TAG_RE = re.compile(
    r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(rc|beta|alpha)\.[0-9]+)?$"
)


def parse_tag(tag: str):
    """Python mirror of common.sh parse_release_tag. Raises ValueError if invalid."""
    match = TAG_RE.match(tag)
    if not match:
        raise ValueError(f"invalid release tag: {tag!r}")
    version = tag[1:]
    suffix = match.group(4) or ""
    return {
        "version": version,
        "is_prerelease": bool(suffix),
        "major": match.group(1),
        "minor": match.group(2),
    }


def docker_tags(parsed: dict):
    if parsed["is_prerelease"]:
        return [parsed["version"]]
    return [
        parsed["version"],
        f"{parsed['major']}.{parsed['minor']}",
        parsed["major"],
        "latest",
    ]


@pytest.mark.parametrize(
    "tag,version,major,minor,prerelease",
    [
        ("v1.0.0", "1.0.0", "1", "0", False),
        ("v1.2.3", "1.2.3", "1", "2", False),
        ("v2.0.0", "2.0.0", "2", "0", False),
        ("v1.4.2", "1.4.2", "1", "4", False),
        ("v1.3.0-rc.1", "1.3.0-rc.1", "1", "3", True),
        ("v1.5.0-beta.2", "1.5.0-beta.2", "1", "5", True),
        ("v2.0.0-alpha.1", "2.0.0-alpha.1", "2", "0", True),
    ],
)
def test_tag_policy_valid(tag, version, major, minor, prerelease):
    parsed = parse_tag(tag)
    assert parsed["version"] == version
    assert parsed["major"] == major
    assert parsed["minor"] == minor
    assert parsed["is_prerelease"] is prerelease


@pytest.mark.parametrize(
    "tag",
    ["1.4.2", "v1.4", "v1", "latest", "v1.4.2.3", "v01.2.3", "v1.2.3-", "v1.2.3-rc",
     "v1.2.3-gamma.1", "v1.2.3-rc.x", "", "v2024.01.01", "v1.2.3+build"],
)
def test_tag_policy_invalid(tag):
    with pytest.raises(ValueError):
        parse_tag(tag)


def test_stable_docker_tags_include_aliases():
    assert docker_tags(parse_tag("v1.4.2")) == ["1.4.2", "1.4", "1", "latest"]


def test_prerelease_docker_tags_never_touch_stable_aliases():
    tags = docker_tags(parse_tag("v1.5.0-rc.1"))
    assert tags == ["1.5.0-rc.1"]
    assert "latest" not in tags


BUNDLE_SOURCES = [
    "server/app/main.py",
    "server/app/settings.py",
    "server/app/db.py",
    "server/spotify_search.py",
    "server/spotify_scraper/__init__.py",
    "server/requirements.txt",
    "scripts/generate_hash.py",
    "client/index.html",
    "client/main.js",
    ".env.example",
    "scripts/linux/install.sh",
    "scripts/linux/start.sh",
    "scripts/linux/update.sh",
    "scripts/linux/uninstall.sh",
    "scripts/linux/openfy.service",
    "docs/LINUX_INSTALL.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
]


@pytest.mark.parametrize("rel", BUNDLE_SOURCES)
def test_bundle_source_files_exist(rel):
    assert (REPO_ROOT / rel).is_file(), f"bundle source missing: {rel}"


def test_env_example_ships_no_credential():
    content = (REPO_ROOT / ".env.example").read_text()
    # [^\s] so a value can never hide behind line-ending quirks.
    assert not re.search(r"^OPENFY_ADMIN_HASH=[^\s]+", content, re.M)


def test_no_real_env_in_repo_root():
    # A developer's local .env is gitignored and must never be packaged.
    # Assert both halves: it is ignored by git, and the packager never copies
    # a real .env (only .env.example).
    gitignore = (REPO_ROOT / ".gitignore").read_text()
    assert ".env" in gitignore
    packager = (REPO_ROOT / "scripts" / "release" / "package-linux.sh").read_text()
    assert ".env.example" in packager
    for line in packager.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # No copy/move/archive step may stage a real .env file (only the
        # .env.example template). Leak-detection lines (find/grep -name ".env")
        # are expected and must remain.
        if re.match(r"(cp|mv|tar|rsync)\b", stripped):
            assert ".env.example" in stripped or ".env" not in stripped, \
                f"packager stages a real .env: {stripped}"


LINUX_SCRIPTS = ["install.sh", "start.sh", "update.sh", "uninstall.sh"]


def test_rollback_restores_deps_unit_and_reports_health():
    updater = (REPO_ROOT / "scripts" / "linux" / "update.sh").read_text()
    body = updater[updater.index("rollback()"):]
    # The shared venv must match the restored code, and the previous unit
    # must be back before the service restarts.
    assert "pip install -r" in body
    assert "daemon-reload" in body
    assert "openfy.service" in body
    # The old version's health decides the reported outcome.
    assert "wait_for_health" in body
    assert "ROLLBACK FAILED" in body
    # Stale trees are removed before restore so new-only files cannot linger.
    # Destructive removals guard against an empty APP_DIR (which set -u alone
    # would not catch): "${APP_DIR:?}" aborts instead of resolving to "/...".
    for line in updater.splitlines():
        if line.lstrip().startswith("rm -rf") and "APP_DIR" in line:
            assert "${APP_DIR:?}" in line, f"unguarded rm: {line}"

def test_uninstaller_refuses_nested_data_loss():
    content = (REPO_ROOT / "scripts" / "linux" / "uninstall.sh").read_text()
    # Nested data/config would be deleted with APP_DIR: refuse instead.
    assert "realpath" in content
    assert '== "/"' in content
    assert "refusing to remove" in content


def test_backup_warns_on_missing_members_but_fails_on_tar_errors():
    content = (REPO_ROOT / "scripts" / "linux" / "update.sh").read_text()
    assert "excluding it from the rollback backup" in content
    assert "members+=(" in content
    assert "nothing to back up" in content


def test_credential_generator_ships_in_bundle_and_survives_updates():
    packager = (REPO_ROOT / "scripts" / "release" / "package-linux.sh").read_text()
    assert "generate_hash.py" in packager
    updater = (REPO_ROOT / "scripts" / "linux" / "update.sh").read_text()
    assert "generate_hash.py" in updater
    installer = (REPO_ROOT / "scripts" / "linux" / "install.sh").read_text()
    assert "generate_hash.py" in installer
    # The installer must install itself: the updater's backup/swap lists it,
    # so an /opt/openfy without install.sh would break future updates.
    assert "for entry in install.sh start.sh update.sh uninstall.sh" in installer


@pytest.mark.parametrize("name", LINUX_SCRIPTS)
def test_linux_scripts_have_no_curl_pipe_shell(name):
    content = (REPO_ROOT / "scripts" / "linux" / name).read_text()
    assert not re.search(r"curl[^|]*\|\s*(ba)?sh", content)


def test_installer_preserves_data_and_config_by_default():
    content = (REPO_ROOT / "scripts" / "linux" / "install.sh").read_text()
    assert "Existing config" in content and "preserved" in content
    assert "rm -rf" not in content or "DATA_DIR" not in content.split("rm -rf")[1].split("\n")[0]


def test_installer_requires_python_311_and_checks_arch():
    content = (REPO_ROOT / "scripts" / "linux" / "install.sh").read_text()
    assert "3.11" in content
    assert "uname -m" in content
    assert "systemd" in content.lower()


def test_uninstaller_preserves_data_by_default():
    content = (REPO_ROOT / "scripts" / "linux" / "uninstall.sh").read_text()
    assert "--purge" in content
    assert "PRESERVED" in content or "Preserved" in content
    # Destructive paths require explicit flags, not the default run.
    assert "confirm" in content.lower()


def test_systemd_unit_requirements():
    unit = (REPO_ROOT / "scripts" / "linux" / "openfy.service").read_text()
    for directive in [
        "User=openfy",
        "WorkingDirectory=/opt/openfy",
        "EnvironmentFile=/etc/openfy/openfy.env",
        "ExecStart=/opt/openfy/venv/bin/",
        "Restart=",
        "WantedBy=multi-user.target",
        "ReadWritePaths=/var/lib/openfy",
        "NoNewPrivileges=true",
    ]:
        assert directive in unit, f"unit missing: {directive}"


_WORKING_BASH = None


def _find_bash():
    """Return a bash executable that actually works, or None.

    shutil.which('bash') alone is not enough: some Windows setups expose a
    broken WSL relay as bash.exe, so every candidate is probed with `bash -n`.
    """
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


@pytest.mark.parametrize("name", LINUX_SCRIPTS + ["../release/package-linux.sh",
                                                  "../release/validate-release.sh",
                                                  "../release/common.sh"])
def test_shell_syntax(name):
    bash = _find_bash()
    if bash is None:
        pytest.skip("no working bash available")
    path = REPO_ROOT / "scripts" / "linux" / name
    result = subprocess.run([bash, "-n", str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_release_workflow_wiring():
    text = (REPO_ROOT / ".github" / "workflows" / "release.yml").read_text()
    doc = yaml.safe_load(text)
    # NOTE: YAML 1.1 parses the `on:` key as boolean True; accept either form.
    triggers = doc.get("on", doc.get(True, {}))
    assert "release" in triggers
    assert "published" in triggers["release"].get("types", [])
    jobs = doc["jobs"]
    assert set(["resolve", "test", "docker-verify", "docker-publish", "linux", "attach", "promote"]) <= set(jobs)
    # Exact tag commit everywhere, never main.
    text = (REPO_ROOT / ".github" / "workflows" / "release.yml").read_text()
    assert "github.ref" in text
    assert "linux/amd64,linux/arm64" in text
    assert "prerelease" in text.lower()
    # Least privilege: default read-only, publish jobs escalate explicitly.
    assert doc.get("permissions", {}).get("contents") == "read"


def test_stable_aliases_promote_only_after_attach():
    doc = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "release.yml").read_text())
    jobs = doc["jobs"]
    promote = jobs["promote"]
    # Aliases move only after the versioned image, bundles, and SBOM publish.
    assert "attach" in promote["needs"]
    assert "docker-publish" in promote["needs"]
    assert "is_prerelease" in promote.get("if", "")
    run = "\n".join(str(s.get("run", "")) for s in promote["steps"])
    assert "imagetools create" in run
    promote_step = next(s for s in promote["steps"] if "imagetools create" in str(s.get("run", "")))
    assert "alias_tags" in str(promote_step.get("env", {}).get("ALIASES", ""))
    # Promotions are serialised across tags and never move an alias backwards.
    concurrency = promote.get("concurrency", {})
    group = concurrency.get("group", "") if isinstance(concurrency, dict) else str(concurrency)
    assert "promote" in group and "alias" in group
    assert "annotation" in run and "version_gte" in run
    # Lookup failures must abort, never fall through to first-promotion logic.
    assert "manifest unknown" in run
    assert "Aborting promotion" in run
    # Annotations target the index (bare key=value is rejected by buildx).
    assert "index:org.opencontainers.image.version" in run
    # Phase 1 publishes the exact version tag only.
    publish = next(
        s for s in jobs["docker-publish"]["steps"]
        if "exact version only" in str(s.get("name", "")).lower()
    )
    assert "needs.resolve.outputs.version" in publish["run"]
    assert "alias_tags" not in publish["run"]


def test_release_tag_passed_via_env_not_script_text():
    doc = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "release.yml").read_text())
    parse = next(s for s in doc["jobs"]["resolve"]["steps"] if s.get("id") == "parse")
    env = parse.get("env", {})
    assert "tag_name" in str(env.get("RELEASE_TAG", ""))
    assert "prerelease" in str(env.get("RELEASE_PRERELEASE", ""))
    # The unvalidated value must never be expanded into the script itself.
    assert "github.event.release" not in parse.get("run", "")


def test_sbom_release_upload_owned_by_attach():
    doc = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "release.yml").read_text())
    sbom = next(
        s for s in doc["jobs"]["docker-publish"]["steps"]
        if str(s.get("name", "")).startswith("Generate SBOM")
    )
    # The action defaults upload-release-assets to true on release events;
    # publication must stay in the attach job (controlled filenames).
    assert sbom["with"].get("upload-release-assets") is False


def test_rerun_reuses_verified_published_image():
    doc = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "release.yml").read_text())
    publish = doc["jobs"]["docker-publish"]["steps"]
    reuse = next(s for s in publish if s.get("id") == "reuse")
    assert "org.opencontainers.image.revision" in reuse["run"]
    build = next(s for s in publish if s.get("id") == "push")
    assert "reuse" in str(build.get("if", ""))
    # Unpublished versions still flow through the normal build.
    assert "not published yet" in reuse["run"]


def test_ci_workflow_is_read_only():
    doc = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text())
    assert doc.get("permissions", {}).get("contents") == "read"


def test_checkout_does_not_persist_credentials():
    def checkout_steps(path, job):
        doc = yaml.safe_load((REPO_ROOT / path).read_text())
        return [
            s for s in doc["jobs"][job]["steps"]
            if str(s.get("uses", "")).startswith("actions/checkout@")
        ]

    for path, job in ((".github/workflows/ci.yml", "packaging"),
                      (".github/workflows/release.yml", "test")):
        steps = checkout_steps(path, job)
        assert steps, f"no checkout step in {path}:{job}"
        for step in steps:
            # The persisted token would be reachable from job scripts.
            assert step.get("with", {}).get("persist-credentials") is False, path


def test_prod_compose_uses_pinned_ghcr_image():
    doc = yaml.safe_load((REPO_ROOT / "docker-compose.prod.yml").read_text())
    image = doc["services"]["openfy-server"]["image"]
    assert image.startswith("ghcr.io/nethminayasas/openfy:")
    assert "OPENFY_VERSION" in image
    # Same volume/env/port/healthcheck contract as dev compose.
    svc = doc["services"]["openfy-server"]
    assert "openfy_data:/data" in svc["volumes"]
    assert "8000:8000" in svc["ports"]
    assert svc.get("healthcheck")
    # Operator-supplied origins win; localhost is only the fallback.
    origins = next(e for e in svc.get("environment", []) if "OPENFY_ALLOWED_ORIGINS" in str(e))
    assert "${OPENFY_ALLOWED_ORIGINS:-" in origins


def test_dockerfile_has_oci_labels_and_healthcheck():
    content = (REPO_ROOT / "server" / "Dockerfile").read_text()
    assert "org.opencontainers.image.version" in content
    assert "org.opencontainers.image.revision" in content
    assert "org.opencontainers.image.source" in content
    assert "HEALTHCHECK" in content and "/health" in content
    assert 'CMD ["uvicorn", "app.main:app"' in content
    assert "VOLUME" in content and "/data" in content


def test_docs_exist():
    assert (REPO_ROOT / "docs" / "RELEASING.md").is_file()
    assert (REPO_ROOT / "docs" / "LINUX_INSTALL.md").is_file()
    assert (REPO_ROOT / "THIRD_PARTY_NOTICES.md").is_file()
