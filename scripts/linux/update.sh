#!/bin/bash
# Update a bare-metal Openfy installation to a newer published release.
#
# Usage:
#   sudo ./update.sh --version 1.4.2
#   sudo ./update.sh --latest
#   sudo ./update.sh --version 1.5.0-rc.1 --arch linux-arm64
#   sudo ./update.sh --archive /path/to/openfy-v1.4.2-linux-amd64.tar.gz
#
# Behaviour:
#   - resolves an explicit version (or the latest STABLE version via the GitHub API)
#   - downloads the archive + SHA256SUMS for this host's arch, verifies checksum first
#   - backs up /etc/openfy/openfy.env and the SQLite database (safe online backup)
#   - stops the service, replaces ONLY application files, reinstalls deps in the
#     existing venv, restarts and health-checks
#   - on failure, restores the previous application files + restarts (rollback)
#   - never overwrites openfy.env with the example file
#
# Never deletes the current installation before the new release is validated.

set -euo pipefail

REPO="NethminaYasas/Openfy"
APP_DIR="${OPENFY_INSTALL_DIR:-/opt/openfy}"
DATA_DIR="${OPENFY_DATA_DIR_OVERRIDE:-/var/lib/openfy}"
CONFIG_DIR="${OPENFY_CONFIG_DIR:-/etc/openfy}"
ENV_FILE="${CONFIG_DIR}/openfy.env"
SERVICE_NAME="${OPENFY_SERVICE_NAME:-openfy}"
BACKUP_ROOT="${OPENFY_BACKUP_DIR:-/var/backups/openfy}"

VERSION=""
LATEST="false"
ARCH=""
ARCHIVE_PATH=""
ALLOW_PRERELEASE_LATEST="false"

host_arch() {
    case "$(uname -m)" in
        x86_64) echo "linux-amd64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) echo "ERROR: unsupported CPU arch '$(uname -m)'." >&2; exit 1 ;;
    esac
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
        --latest) LATEST="true"; shift ;;
        --arch) ARCH="${2:?--arch requires a value}"; shift 2 ;;
        --archive) ARCHIVE_PATH="${2:?--archive requires a value}"; shift 2 ;;
        --include-prerelease-latest) ALLOW_PRERELEASE_LATEST="true"; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown option '$1'. Use --help." >&2; exit 1 ;;
    esac
done

[[ -z "${ARCH}" ]] && ARCH="$(host_arch)"
case "${ARCH}" in linux-amd64|linux-arm64) ;; *) echo "ERROR: --arch must be linux-amd64 or linux-arm64." >&2; exit 1 ;; esac

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (e.g. sudo ./update.sh --latest)." >&2
    exit 1
fi
if [[ ! -f "${APP_DIR}/VERSION.json" ]]; then
    echo "ERROR: no Openfy installation found at ${APP_DIR}. Install first with sudo ./install.sh." >&2
    exit 1
fi

# A version string ends up in URLs and file paths: validate strictly.
validate_version() {
    [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(rc|beta|alpha)\.[0-9]+)?$ ]] \
        || { echo "ERROR: invalid version '$1' (expected e.g. 1.4.2 or 1.5.0-rc.1)." >&2; exit 1; }
}

resolve_latest() {
    local api="https://api.github.com/repos/${REPO}/releases/latest" tag
    echo "[openfy-update] Querying latest stable release: ${api}" >&2
    tag="$(python3 -c "
import json, urllib.request
req = urllib.request.Request('${api}', headers={'User-Agent': 'Openfy-Updater', 'Accept': 'application/vnd.github+json'})
print(json.load(urllib.request.urlopen(req, timeout=30))['tag_name'])
")"
    [[ "${tag}" =~ ^v ]] || { echo "ERROR: unexpected tag '${tag}' from GitHub API." >&2; exit 1; }
    if [[ "${ALLOW_PRERELEASE_LATEST}" != "true" && "${tag}" == *-* ]]; then
        echo "ERROR: latest release '${tag}' is a prerelease; refusing (pass an explicit --version or --include-prerelease-latest)." >&2
        exit 1
    fi
    echo "${tag#v}"
}

if [[ -z "${ARCHIVE_PATH}" ]]; then
    if [[ "${LATEST}" == "true" ]]; then
        VERSION="$(resolve_latest)"
    fi
    [[ -n "${VERSION}" ]] || { echo "ERROR: specify --version X.Y.Z, --latest, or --archive PATH." >&2; exit 1; }
    validate_version "${VERSION}"
else
    # Local archive: derive the version from its filename and validate it.
    base="$(basename "${ARCHIVE_PATH}")"
    if [[ "${base}" =~ ^openfy-v(.+)-(${ARCH})\.tar\.gz$ ]]; then
        VERSION="${BASH_REMATCH[1]}"
        validate_version "${VERSION}"
    else
        echo "ERROR: archive name '${base}' does not match openfy-vVERSION-${ARCH}.tar.gz." >&2
        exit 1
    fi
fi

CURRENT="$(python3 -c "import json;print(json.load(open('${APP_DIR}/VERSION.json')).get('version','unknown'))" 2>/dev/null || echo unknown)"
echo "[openfy-update] Installed: ${CURRENT}  Target: ${VERSION} (${ARCH})"
if [[ "${CURRENT}" == "${VERSION}" ]]; then
    echo "[openfy-update] Already at version ${VERSION}; nothing to do."
    exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

if [[ -z "${ARCHIVE_PATH}" ]]; then
    ARCHIVE_NAME="openfy-v${VERSION}-${ARCH}.tar.gz"
    BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
    echo "[openfy-update] Downloading ${BASE_URL}/${ARCHIVE_NAME}"
    python3 - "${BASE_URL}/${ARCHIVE_NAME}" "${WORK}/${ARCHIVE_NAME}" <<'EOF'
import sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "Openfy-Updater"})
with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
    while True:
        chunk = r.read(1024 * 1024)
        if not chunk:
            break
        f.write(chunk)
print("downloaded", dest)
EOF
    echo "[openfy-update] Downloading SHA256SUMS for verification."
    python3 - "${BASE_URL}/SHA256SUMS" "${WORK}/SHA256SUMS" <<'EOF'
import sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "Openfy-Updater"})
with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
    f.write(r.read())
EOF
    # Verify checksum BEFORE extracting or touching the installation.
    (cd "${WORK}" && sha256sum -c SHA256SUMS --ignore-missing) \
        || { echo "[openfy-update] ERROR: checksum verification failed; aborting before any change." >&2; exit 1; }
    echo "[openfy-update] Checksum verified."
    ARCHIVE_PATH="${WORK}/${ARCHIVE_NAME}"
else
    [[ -f "${ARCHIVE_PATH}" ]] || { echo "ERROR: archive not found: ${ARCHIVE_PATH}" >&2; exit 1; }
    echo "[openfy-update] Using local archive ${ARCHIVE_PATH} (checksum pre-verified by operator)."
fi

# --- Back up config + database (safe SQLite online backup) ---
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}-to-${VERSION}"
mkdir -p "${BACKUP_DIR}"
echo "[openfy-update] Backing up to ${BACKUP_DIR}."
[[ -f "${ENV_FILE}" ]] && cp -a "${ENV_FILE}" "${BACKUP_DIR}/openfy.env"
# Derive the DB path from the env file / convention: sqlite:///<abs path>
DB_URL="$(grep -E '^OPENFY_DATABASE_URL=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)"
DB_FILE="${DB_URL#sqlite:///}"
if [[ -n "${DB_FILE}" && -f "${DB_FILE}" ]]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "${DB_FILE}" ".backup '${BACKUP_DIR}/openfy.db'" \
            || cp -a "${DB_FILE}" "${BACKUP_DIR}/openfy.db"
    else
        python3 - "${DB_FILE}" "${BACKUP_DIR}/openfy.db" <<'EOF'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
with sqlite3.connect(src) as a, sqlite3.connect(dst) as b:
    a.backup(b)
print("database backup complete")
EOF
    fi
    echo "[openfy-update] Database backed up."
else
    echo "[openfy-update] No database file found yet (fresh install); skipping DB backup."
fi
# Snapshot current application files for rollback (code only, never data).
tar -czf "${BACKUP_DIR}/app-files-backup.tar.gz" -C "${APP_DIR}" app client spotify_scraper spotify_search.py requirements.txt generate_hash.py openfy.service VERSION.json 2>/dev/null || true

# --- Extract + validate the new bundle before touching the live install ---
tar -xzf "${ARCHIVE_PATH}" -C "${WORK}"
EXTRACTED="$(find "${WORK}" -maxdepth 1 -name "openfy-v${VERSION}-${ARCH}" -type d | head -n 1)"
[[ -n "${EXTRACTED}" ]] || { echo "[openfy-update] ERROR: archive has unexpected layout." >&2; exit 1; }
for required in app/main.py client/index.html requirements.txt openfy.service VERSION.json install.sh generate_hash.py; do
    [[ -e "${EXTRACTED}/${required}" ]] || { echo "[openfy-update] ERROR: new bundle missing ${required}." >&2; exit 1; }
done
NEW_VERSION="$(python3 -c "import json;print(json.load(open('${EXTRACTED}/VERSION.json'))['version'])")"
[[ "${NEW_VERSION}" == "${VERSION}" ]] || { echo "[openfy-update] ERROR: bundle version ${NEW_VERSION} != requested ${VERSION}." >&2; exit 1; }
bash -n "${EXTRACTED}/install.sh"

rollback() {
    echo "[openfy-update] Update failed; rolling back to previous application files." >&2
    if [[ -f "${BACKUP_DIR}/app-files-backup.tar.gz" ]]; then
        tar -xzf "${BACKUP_DIR}/app-files-backup.tar.gz" -C "${APP_DIR}"
        systemctl restart "${SERVICE_NAME}" || true
        echo "[openfy-update] Rollback applied from ${BACKUP_DIR}. Config and data were never modified." >&2
        echo "[openfy-update] To restore the database manually: sqlite3 <db> <.restore ${BACKUP_DIR}/openfy.db>" >&2
    fi
}

# --- Apply: stop, swap code, reinstall deps, restart, verify ---
echo "[openfy-update] Stopping ${SERVICE_NAME}."
systemctl stop "${SERVICE_NAME}" || true

set +e
cp -a "${EXTRACTED}/app" "${APP_DIR}/app.new" && \
cp -a "${EXTRACTED}/client" "${APP_DIR}/client.new" && \
cp -a "${EXTRACTED}/spotify_scraper" "${APP_DIR}/spotify_scraper.new" && \
cp "${EXTRACTED}/spotify_search.py" "${APP_DIR}/spotify_search.py.new" && \
cp "${EXTRACTED}/generate_hash.py" "${APP_DIR}/generate_hash.py.new" && \
cp "${EXTRACTED}/requirements.txt" "${APP_DIR}/requirements.txt.new" && \
cp "${EXTRACTED}/openfy.service" "${APP_DIR}/openfy.service.new" && \
cp "${EXTRACTED}/VERSION.json" "${APP_DIR}/VERSION.json.new" && \
cp "${EXTRACTED}/install.sh" "${EXTRACTED}/start.sh" "${EXTRACTED}/update.sh" "${EXTRACTED}/uninstall.sh" "${APP_DIR}/"
SWAP_OK=$?
set -e
if [[ "${SWAP_OK}" -ne 0 ]]; then
    rollback
    echo "[openfy-update] ERROR: failed to stage new files." >&2
    exit 1
fi
# Atomic-ish switch of the versioned directories.
for entry in app client spotify_scraper; do
    rm -rf "${APP_DIR}/${entry}.old"
    [[ -e "${APP_DIR}/${entry}" ]] && mv "${APP_DIR}/${entry}" "${APP_DIR}/${entry}.old"
    mv "${APP_DIR}/${entry}.new" "${APP_DIR}/${entry}"
done
for entry in spotify_search.py generate_hash.py requirements.txt openfy.service VERSION.json; do
    mv -f "${APP_DIR}/${entry}.new" "${APP_DIR}/${entry}"
done

SERVICE_USER="$(stat -c %U "${DATA_DIR}" 2>/dev/null || echo openfy)"
"${APP_DIR}/venv/bin/python" -m pip install -r "${APP_DIR}/requirements.txt" \
    || { rollback; echo "[openfy-update] ERROR: dependency install failed." >&2; exit 1; }
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/app" "${APP_DIR}/client" "${APP_DIR}/venv" 2>/dev/null || true

# Refresh the systemd unit if the bundle changed it, then restart.
cp -a "${APP_DIR}/openfy.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl start "${SERVICE_NAME}" || { rollback; echo "[openfy-update] ERROR: service failed to start." >&2; exit 1; }

attempt=0
healthy="false"
while [[ "${attempt}" -lt 30 ]]; do
    if "${APP_DIR}/venv/bin/python" -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health', timeout=3)" 2>/dev/null; then
        healthy="true"
        break
    fi
    attempt=$((attempt + 1))
    sleep 2
done
if [[ "${healthy}" != "true" ]]; then
    rollback
    echo "[openfy-update] ERROR: new version unhealthy; rolled back. See: journalctl -u ${SERVICE_NAME} -n 100" >&2
    exit 1
fi

rm -rf "${APP_DIR}"/app.old "${APP_DIR}"/client.old "${APP_DIR}"/spotify_scraper.old
echo "[openfy-update] Updated ${CURRENT} -> ${VERSION}. Backup retained at ${BACKUP_DIR}."
echo "[openfy-update] Config ${ENV_FILE} and data ${DATA_DIR} were preserved."
