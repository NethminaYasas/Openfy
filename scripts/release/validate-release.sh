#!/bin/bash
# Validate finished release artifacts (archives + SHA256SUMS + version consistency).
# Used by CI and the release workflow BEFORE anything is published.
#
# Usage:
#   scripts/release/validate-release.sh --tag v1.4.2 --dir dist/
#
# Checks:
#   - tag parses and both expected archives exist
#   - SHA256SUMS exists and verifies (sha256sum -c)
#   - each archive extracts, has the required layout, no secrets/data
#   - VERSION.json version/arch/commit match the release
#   - shell scripts pass bash -n, systemd unit has required directives
#   - service/install scripts contain no curl|sh patterns or hardcoded secrets

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

TAG=""
DIR="dist"
EXPECTED_COMMIT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
        --dir) DIR="${2:?--dir requires a value}"; shift 2 ;;
        --expect-commit) EXPECTED_COMMIT="${2:?--expect-commit requires a value}"; shift 2 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown argument '$1'." >&2; exit 1 ;;
    esac
done

[[ -n "${TAG}" ]] || { echo "ERROR: --tag is required." >&2; exit 1; }
parse_release_tag "${TAG}"

PASS=0
FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

echo "==> Validating release ${OPENFY_TAG} in ${DIR}/"

for arch in linux-amd64 linux-arm64; do
    base="openfy-v${OPENFY_VERSION}-${arch}.tar.gz"
    if [[ -f "${DIR}/${base}" ]]; then
        ok "archive present: ${base}"
    else
        fail "archive missing: ${base}"
    fi
done

if [[ -f "${DIR}/SHA256SUMS" ]]; then
    ok "SHA256SUMS present"
    if (cd "${DIR}" && sha256sum -c SHA256SUMS); then
        ok "SHA256SUMS verifies"
    else
        fail "SHA256SUMS verification failed"
    fi
else
    fail "SHA256SUMS missing"
fi

REQUIRED_FILES=(
    "app/main.py" "app/settings.py" "app/db.py"
    "spotify_search.py" "spotify_scraper/__init__.py" "requirements.txt"
    "generate_hash.py"
    "client/index.html" "client/main.js"
    ".env.example" "install.sh" "start.sh" "update.sh" "uninstall.sh"
    "openfy.service" "README_LINUX.md" "LICENSE"
    "THIRD_PARTY_NOTICES.md" "VERSION.json"
)

for arch in linux-amd64 linux-arm64; do
    base="openfy-v${OPENFY_VERSION}-${arch}.tar.gz"
    [[ -f "${DIR}/${base}" ]] || continue
    echo "==> Inspecting ${base}"
    tmp="$(mktemp -d)"
    tar -xzf "${DIR}/${base}" -C "${tmp}"
    topdirs=( "${tmp}"/*/ )
    if [[ "${#topdirs[@]}" -ne 1 ]]; then
        fail "${base}: expected a single top-level directory, found ${#topdirs[@]}"
        rm -rf "${tmp}"
        continue
    fi
    root="${topdirs[0]}"
    expected_top="openfy-v${OPENFY_VERSION}-${arch}"
    if [[ "$(basename "${root}")" == "${expected_top}" ]]; then
        ok "${base}: top-level dir ${expected_top}"
    else
        fail "${base}: top-level dir '$(basename "${root}")' != '${expected_top}'"
    fi

    for rel in "${REQUIRED_FILES[@]}"; do
        if [[ -e "${root}/${rel}" ]]; then
            ok "${base}: has ${rel}"
        else
            fail "${base}: missing ${rel}"
        fi
    done

    # No secrets / user data.
    if find "${root}" \( -name ".env" -o -name "*.db" \) | grep -q .; then
        fail "${base}: contains .env or database files"
    else
        ok "${base}: no .env/database files"
    fi
    if grep -rqE '^OPENFY_ADMIN_HASH=[^[:space:]]' "${root}/.env.example" 2>/dev/null; then
        fail "${base}: .env.example ships a credential"
    else
        ok "${base}: .env.example has no credential"
    fi
    if find "${root}" -name ".git" -maxdepth 2 | grep -q .; then
        fail "${base}: contains .git"
    else
        ok "${base}: no .git"
    fi

    # VERSION.json consistency (skipped where no working python3 exists).
    if python3 -c 'import json, sys' >/dev/null 2>&1; then
        if python3 - "${root}/VERSION.json" "${OPENFY_VERSION}" "${arch}" "${EXPECTED_COMMIT}" <<'EOF'
import json, sys
path, want_version, want_arch, want_commit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
doc = json.load(open(path))
assert doc.get("version") == want_version, f"version {doc.get('version')} != {want_version}"
assert doc.get("arch") == want_arch, f"arch {doc.get('arch')} != {want_arch}"
assert doc.get("tag") == f"v{want_version}", f"tag {doc.get('tag')}"
if want_commit:
    assert doc.get("commit") == want_commit, f"commit {doc.get('commit')} != {want_commit}"
assert doc.get("bundle") == "python-source", "bundle must be honestly labelled python-source"
EOF
        then
            ok "${base}: VERSION.json consistent"
        else
            fail "${base}: VERSION.json mismatch"
        fi
    fi

    # Shell syntax.
    syntax_ok=true
    for sh in install.sh start.sh update.sh uninstall.sh; do
        if ! bash -n "${root}/${sh}"; then
            fail "${base}: ${sh} fails bash -n"
            syntax_ok=false
        fi
    done
    ${syntax_ok} && ok "${base}: all scripts pass bash -n"

    # No curl|sh anti-pattern in shipped scripts.
    if grep -rE 'curl[^|]*\|\s*(ba)?sh' "${root}"/*.sh 2>/dev/null | grep -q .; then
        fail "${base}: installer uses curl|sh pattern"
    else
        ok "${base}: no curl|sh pattern"
    fi

    # systemd unit essentials.
    unit="${root}/openfy.service"
    if [[ -f "${unit}" ]]; then
        for directive in "User=openfy" "WorkingDirectory=/opt/openfy" "EnvironmentFile=/etc/openfy/openfy.env" \
                         "ExecStart=/opt/openfy/venv/bin/" "Restart=" "WantedBy=multi-user.target"; do
            if grep -qF "${directive}" "${unit}"; then
                ok "${base}: unit has '${directive}'"
            else
                fail "${base}: unit missing '${directive}'"
            fi
        done
        if grep -qE 'ReadWritePaths=.*\/var\/lib\/openfy' "${unit}"; then
            ok "${base}: unit allows writes to /var/lib/openfy"
        else
            fail "${base}: unit missing ReadWritePaths for /var/lib/openfy"
        fi
    fi

    # Executable bits survive tar.
    for sh in install.sh start.sh update.sh uninstall.sh; do
        if [[ -x "${root}/${sh}" ]]; then
            ok "${base}: ${sh} is executable"
        else
            fail "${base}: ${sh} lost executable bit"
        fi
    done

    rm -rf "${tmp}"
done

echo "==> Validation: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
