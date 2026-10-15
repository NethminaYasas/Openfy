#!/bin/bash
# Build a self-contained, deployable Openfy Linux application bundle and pack it
# into a distributable tar.gz archive.
#
# This is a CI-side packaging script (run in GitHub Actions), NOT the end-user
# installer. The end-user installer is scripts/linux/install.sh, which is
# copied INTO each archive.
#
# Strategy: versioned application bundle (Python source + frontend + manifests
# + installer scripts). Native/arch-specific dependencies (wheels for Pillow,
# SQLAlchemy, etc.) resolve at install time inside an isolated venv on the
# target machine, so the same source bundle serves both linux-amd64 and
# linux-arm64; the arch label selects the correct download and is recorded in
# VERSION.json. No Node.js/npm is required (frontend is vanilla JS).
#
# Usage:
#   scripts/release/package-linux.sh --tag v1.4.2 --arch linux-amd64 [--commit SHA] [--out dist/]
#
# Inputs are validated; secrets, .env files, databases and user data are never
# included (see _assert_no_secrets below).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

TAG=""
ARCH=""
COMMIT="${GITHUB_SHA:-unknown}"
OUT_DIR="${REPO_ROOT}/dist"
SPOTIFLAC_PIN="${SPOTIFLAC_PIN_VERSION:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
        --arch) ARCH="${2:?--arch requires a value}"; shift 2 ;;
        --commit) COMMIT="${2:?--commit requires a value}"; shift 2 ;;
        --out) OUT_DIR="${2:?--out requires a value}"; shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0
            ;;
        *) echo "ERROR: unknown argument '$1'. See --help." >&2; exit 1 ;;
    esac
done

[[ -n "${TAG}" ]] || { echo "ERROR: --tag is required (e.g. --tag v1.4.2)." >&2; exit 1; }
[[ -n "${ARCH}" ]] || { echo "ERROR: --arch is required (linux-amd64 or linux-arm64)." >&2; exit 1; }

parse_release_tag "${TAG}"
require_clean_version_string "${OPENFY_VERSION}" "version"
case "${ARCH}" in
    linux-amd64|linux-arm64) ;;
    *) echo "ERROR: --arch must be linux-amd64 or linux-arm64, got '${ARCH}'." >&2; exit 1 ;;
esac

STAGE_PARENT="$(mktemp -d)"
trap 'rm -rf "${STAGE_PARENT}"' EXIT

DIST_NAME="openfy-v${OPENFY_VERSION}-linux-${ARCH#linux-}"
STAGE="${STAGE_PARENT}/${DIST_NAME}"
mkdir -p "${STAGE}"

echo "==> Packaging ${DIST_NAME} from commit ${COMMIT}"

copy_tree() {
    local src="$1" dest="$2"
    mkdir -p "${dest}"
    # tar preserves permissions and avoids cp -r inconsistencies across platforms.
    tar -cf - -C "$(dirname "${src}")" "$(basename "${src}")" | tar -xf - -C "${dest}"
}

# --- Backend (mirrors server/Dockerfile build context) ---
copy_tree "${REPO_ROOT}/server/app" "${STAGE}/app_tmp"
mv "${STAGE}/app_tmp/app" "${STAGE}/app"
rmdir "${STAGE}/app_tmp"
cp "${REPO_ROOT}/server/spotify_search.py" "${STAGE}/spotify_search.py"
cp "${REPO_ROOT}/scripts/generate_hash.py" "${STAGE}/generate_hash.py"
copy_tree "${REPO_ROOT}/server/spotify_scraper" "${STAGE}/staging_scraper"
mv "${STAGE}/staging_scraper/spotify_scraper" "${STAGE}/spotify_scraper"
rmdir "${STAGE}/staging_scraper"
cp "${REPO_ROOT}/server/requirements.txt" "${STAGE}/requirements.txt"
# NOTE: server/SpotiFLAC/ is a stale legacy copy; the app uses the PyPI
# SpotiFLAC package plus server/app/spotiflac_local. It is intentionally
# excluded (as is the Dockerfile build, which never copies it).

# --- Frontend (vanilla JS, no build step; served as static files) ---
copy_tree "${REPO_ROOT}/client" "${STAGE}/client_tmp"
mv "${STAGE}/client_tmp/client" "${STAGE}/client"
rmdir "${STAGE}/client_tmp"

# --- Runtime configuration template (safe example only, never a real .env) ---
cp "${REPO_ROOT}/.env.example" "${STAGE}/.env.example"

# --- End-user operations scripts + systemd unit ---
cp "${REPO_ROOT}/scripts/linux/install.sh"   "${STAGE}/install.sh"
cp "${REPO_ROOT}/scripts/linux/start.sh"     "${STAGE}/start.sh"
cp "${REPO_ROOT}/scripts/linux/update.sh"    "${STAGE}/update.sh"
cp "${REPO_ROOT}/scripts/linux/uninstall.sh" "${STAGE}/uninstall.sh"
cp "${REPO_ROOT}/scripts/linux/openfy"        "${STAGE}/openfy"
cp "${REPO_ROOT}/scripts/linux/openfy.service" "${STAGE}/openfy.service"
chmod 755 "${STAGE}/install.sh" "${STAGE}/start.sh" "${STAGE}/update.sh" "${STAGE}/uninstall.sh" "${STAGE}/openfy"

# --- Docs, license, notices ---
cp "${REPO_ROOT}/LICENSE" "${STAGE}/LICENSE"
cp "${REPO_ROOT}/docs/LINUX_INSTALL.md" "${STAGE}/README_LINUX.md"
cp "${REPO_ROOT}/THIRD_PARTY_NOTICES.md" "${STAGE}/THIRD_PARTY_NOTICES.md"

# --- Version metadata (machine-readable, injected from the release tag) ---
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SPOTIFLAC_RESOLVED="${SPOTIFLAC_PIN:-latest-upstream}"
cat > "${STAGE}/VERSION.json" <<EOF
{
  "name": "openfy",
  "version": "${OPENFY_VERSION}",
  "tag": "${OPENFY_TAG}",
  "prerelease": ${OPENFY_IS_PRERELEASE},
  "arch": "${ARCH}",
  "commit": "${COMMIT}",
  "built_at": "${BUILT_AT}",
  "python_requires": ">=3.11",
  "spotiflac": "${SPOTIFLAC_RESOLVED}",
  "bundle": "python-source"
}
EOF

# --- Strip developer/build residue ---
find "${STAGE}" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "${STAGE}" -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true
rm -rf "${STAGE}/client/tests" "${STAGE}/client/__pycache__" 2>/dev/null || true

_assert_no_secrets() {
    local failures=0
    # Real .env files, databases, media and VCS history must never ship.
    if find "${STAGE}" \( -name ".env" -o -name "*.db" -o -name "*.sqlite*" \) | grep -q .; then
        echo "ERROR: bundle contains a database or real .env file." >&2
        failures=1
    fi
    if [[ -d "${STAGE}/.git" ]]; then
        echo "ERROR: bundle contains .git history." >&2
        failures=1
    fi
    if find "${STAGE}" -path "*music/*" -name "*.mp3" -o -path "*music/*" -name "*.flac" 2>/dev/null | grep -q .; then
        echo "ERROR: bundle contains audio files." >&2
        failures=1
    fi
    # A non-empty admin hash baked into shipped config would leak credentials.
    # [^[:space:]] (instead of .) so CRLF checkouts cannot false-positive.
    if grep -rqE '^OPENFY_ADMIN_HASH=[^[:space:]]' "${STAGE}/.env.example" 2>/dev/null; then
        echo "ERROR: .env.example ships a non-empty OPENFY_ADMIN_HASH." >&2
        failures=1
    fi
    # No private keys or tokens may be staged.
    if grep -rIlE 'BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}' "${STAGE}" 2>/dev/null | grep -q .; then
        echo "ERROR: bundle appears to contain a private key or token." >&2
        failures=1
    fi
    return "${failures}"
}

if ! _assert_no_secrets; then
    echo "Secret/data leak check FAILED; refusing to pack." >&2
    exit 1
fi

# --- Required-file check before packing ---
required=(
    "app/main.py" "app/settings.py" "app/db.py"
    "spotify_search.py" "spotify_scraper/__init__.py" "requirements.txt"
    "generate_hash.py"
    "client/index.html" "client/main.js"
    ".env.example" "install.sh" "start.sh" "update.sh" "uninstall.sh"
    "openfy" "openfy.service" "README_LINUX.md" "LICENSE"
    "THIRD_PARTY_NOTICES.md" "VERSION.json"
)
for rel in "${required[@]}"; do
    if [[ ! -e "${STAGE}/${rel}" ]]; then
        echo "ERROR: required bundle file missing: ${rel}" >&2
        exit 1
    fi
done

mkdir -p "${OUT_DIR}"
ARCHIVE_BASENAME="openfy-v${OPENFY_VERSION}-${ARCH}.tar.gz"
# Deterministic metadata on GNU tar (CI): sorted entries, fixed owner/group,
# mtime from SOURCE_DATE_EPOCH. File contents come from the release commit, so
# the archive is reproducible apart from the VERSION.json built_at timestamp
# (documented limitation). Other tar implementations get a plain archive.
TAR_OPTS=()
if tar --sort-name --version >/dev/null 2>&1; then
    TAR_OPTS+=(--sort-name --owner=0 --group=0 "--mtime=@${SOURCE_DATE_EPOCH:-0}")
fi
tar "${TAR_OPTS[@]}" -czf "${OUT_DIR}/${ARCHIVE_BASENAME}" -C "${STAGE_PARENT}" "${DIST_NAME}"

echo "==> Wrote ${OUT_DIR}/${ARCHIVE_BASENAME}"
sha256sum "${OUT_DIR}/${ARCHIVE_BASENAME}"
