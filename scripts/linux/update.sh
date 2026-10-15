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
SYSTEMD_DIR="${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}"
BACKUP_ROOT="${OPENFY_BACKUP_DIR:-/var/backups/openfy}"
if [[ -z "${OPENFY_PORT+x}" ]]; then
    OPENFY_PORT="8000"
    PORT_EXPLICIT="false"
else
    PORT_EXPLICIT="true"
fi

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
valid_port() {
    [[ "${1:-}" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}
if [[ "${PORT_EXPLICIT}" == "true" ]]; then
    valid_port "${OPENFY_PORT}" \
        || { echo "ERROR: invalid OPENFY_PORT '${OPENFY_PORT}' (must be 1-65535, no leading zeros)." >&2; exit 1; }
else
    # Preserve a custom port across upgrades when no port was explicitly given.
    existing_unit="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
    if [[ -f "${existing_unit}" ]]; then
        p="$(grep -oE -- '--port [0-9]+' "${existing_unit}" 2>/dev/null | awk '{print $2}' | head -n 1 || true)"
        if valid_port "${p}"; then
            OPENFY_PORT="${p}"
        fi
    fi
fi

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

CURRENT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","unknown"))' "${APP_DIR}/VERSION.json" 2>/dev/null || echo unknown)"
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
# Back up what is actually present (warning loudly about anything missing),
# then require tar itself to succeed: a failed snapshot aborts before
# anything changes, instead of leaving a partial backup behind.
members=()
for m in app client spotify_scraper spotify_search.py requirements.txt generate_hash.py openfy.service VERSION.json install.sh start.sh update.sh uninstall.sh openfy; do
    if [[ -e "${APP_DIR}/${m}" ]]; then
        members+=("${m}")
    else
        echo "[openfy-update] WARNING: ${APP_DIR}/${m} not present; excluding it from the rollback backup." >&2
    fi
done
if [[ "${#members[@]}" -eq 0 ]]; then
    echo "[openfy-update] ERROR: nothing to back up in ${APP_DIR}; aborting before any change." >&2
    exit 1
fi
tar -czf "${BACKUP_DIR}/app-files-backup.tar.gz" -C "${APP_DIR}" "${members[@]}" 2>/dev/null \
    || { echo "[openfy-update] ERROR: application backup failed; aborting before any change." >&2; exit 1; }

# --- Extract + validate the new bundle before touching the live install ---
tar -xzf "${ARCHIVE_PATH}" -C "${WORK}"
EXTRACTED="$(find "${WORK}" -maxdepth 1 -name "openfy-v${VERSION}-${ARCH}" -type d | head -n 1)"
[[ -n "${EXTRACTED}" ]] || { echo "[openfy-update] ERROR: archive has unexpected layout." >&2; exit 1; }
for required in app/main.py client/index.html requirements.txt openfy.service VERSION.json install.sh generate_hash.py; do
    [[ -e "${EXTRACTED}/${required}" ]] || { echo "[openfy-update] ERROR: new bundle missing ${required}." >&2; exit 1; }
done
NEW_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${EXTRACTED}/VERSION.json")"
[[ "${NEW_VERSION}" == "${VERSION}" ]] || { echo "[openfy-update] ERROR: bundle version ${NEW_VERSION} != requested ${VERSION}." >&2; exit 1; }
bash -n "${EXTRACTED}/install.sh"

wait_for_health() {
    # Returns 0 once the local service answers /health (up to ~60s).
    local attempt=0
    while [[ "${attempt}" -lt 30 ]]; do
        if "${APP_DIR}/venv/bin/python" -c "import sys,urllib.request; urllib.request.urlopen('http://localhost:' + sys.argv[1] + '/health', timeout=3)" "${OPENFY_PORT}" 2>/dev/null; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    return 1
}

rollback() {
    echo "[openfy-update] Update failed; rolling back to previous application files." >&2
    if [[ ! -f "${BACKUP_DIR}/app-files-backup.tar.gz" ]]; then
        echo "[openfy-update] ERROR: no application backup available; cannot roll back." >&2
        return 1
    fi
    local restore_tmp svc_user
    restore_tmp="$(mktemp -d)" \
        || { echo "[openfy-update] ERROR: cannot create restore workspace." >&2; return 1; }
    tar -xzf "${BACKUP_DIR}/app-files-backup.tar.gz" -C "${restore_tmp}" \
        || { echo "[openfy-update] ERROR: backup archive is unreadable." >&2; rm -rf "${restore_tmp}"; return 1; }
    # Swap the backed-up trees back wholesale, removing the failed update's
    # files first so nothing the new version introduced can linger.
    for entry in app client spotify_scraper; do
        if [[ ! -e "${restore_tmp}/${entry}" ]]; then
            echo "[openfy-update] ERROR: backup is missing ${entry}; aborting rollback to avoid a mixed install." >&2
            rm -rf "${restore_tmp}"
            return 1
        fi
        rm -rf "${APP_DIR:?}/${entry}" "${APP_DIR:?}/${entry}.old" "${APP_DIR:?}/${entry}.new"
        mv "${restore_tmp}/${entry}" "${APP_DIR}/${entry}"
    done
    for entry in spotify_search.py generate_hash.py requirements.txt openfy.service VERSION.json install.sh start.sh update.sh uninstall.sh; do
        if [[ ! -e "${restore_tmp}/${entry}" ]]; then
            echo "[openfy-update] ERROR: backup is missing ${entry}; aborting rollback to avoid a mixed install." >&2
            rm -rf "${restore_tmp}"
            return 1
        fi
        # Atomic rename: the running update.sh keeps its original inode.
        cp "${restore_tmp}/${entry}" "${APP_DIR}/${entry}.new"
        mv -f "${APP_DIR}/${entry}.new" "${APP_DIR}/${entry}"
    done
    # The manager is new: older installs have no backup copy; restore it only
    # when present so rollback still succeeds for them.
    if [[ -e "${restore_tmp}/openfy" ]]; then
        cp "${restore_tmp}/openfy" "${APP_DIR}/openfy.new"
        mv -f "${APP_DIR}/openfy.new" "${APP_DIR}/openfy"
        chmod 755 "${APP_DIR}/openfy" 2>/dev/null || true
    else
        rm -f "${APP_DIR}/openfy.new"
    fi
    rm -rf "${restore_tmp}"
    rm -f "${APP_DIR}"/*.new
    # The venv is shared: reinstall the restored requirements so the old code
    # runs against compatible packages.
    svc_user="$(stat -c %U "${DATA_DIR}" 2>/dev/null || echo openfy)"
    "${APP_DIR}/venv/bin/python" -m pip install -r "${APP_DIR}/requirements.txt" \
        || echo "[openfy-update] WARNING: dependency reinstall during rollback failed." >&2
    chown -R "${svc_user}:${svc_user}" "${APP_DIR}/app" "${APP_DIR}/client" "${APP_DIR}/venv" 2>/dev/null || true
    # Restore the previous unit before restarting.
    cp -a "${APP_DIR}/openfy.service" "${SYSTEMD_DIR}/${SERVICE_NAME}.service" \
        || echo "[openfy-update] WARNING: could not restore the systemd unit file." >&2
    sed -i -E "s|--port [0-9]+|--port ${OPENFY_PORT}|" "${SYSTEMD_DIR}/${SERVICE_NAME}.service" || true
    systemctl daemon-reload || true
    systemctl restart "${SERVICE_NAME}" || true
    if wait_for_health; then
        echo "[openfy-update] Rollback complete: previous version is healthy again. Backup retained at ${BACKUP_DIR}." >&2
        echo "[openfy-update] Config and data were never modified; to restore the database manually: sqlite3 <db> '.restore ${BACKUP_DIR}/openfy.db'" >&2
        return 0
    fi
    echo "[openfy-update] ERROR: ROLLBACK FAILED — the previous version is not healthy either." >&2
    echo "[openfy-update] Inspect with: journalctl -u ${SERVICE_NAME} -n 100" >&2
    echo "[openfy-update] Manual recovery: application backup at ${BACKUP_DIR}/app-files-backup.tar.gz, database backup at ${BACKUP_DIR}/openfy.db." >&2
    return 1
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
cp "${EXTRACTED}/install.sh" "${APP_DIR}/install.sh.new" && \
cp "${EXTRACTED}/start.sh" "${APP_DIR}/start.sh.new" && \
cp "${EXTRACTED}/update.sh" "${APP_DIR}/update.sh.new" && \
cp "${EXTRACTED}/uninstall.sh" "${APP_DIR}/uninstall.sh.new" && \
cp "${EXTRACTED}/openfy" "${APP_DIR}/openfy.new"
SWAP_OK=$?
set -e
if [[ "${SWAP_OK}" -ne 0 ]]; then
    rollback || true
    echo "[openfy-update] ERROR: failed to stage new files." >&2
    exit 1
fi
# Atomic-ish switch of the versioned directories.
for entry in app client spotify_scraper; do
    rm -rf "${APP_DIR:?}/${entry}.old"
    [[ -e "${APP_DIR}/${entry}" ]] && mv "${APP_DIR}/${entry}" "${APP_DIR}/${entry}.old"
    mv "${APP_DIR}/${entry}.new" "${APP_DIR}/${entry}"
done
for entry in spotify_search.py generate_hash.py requirements.txt openfy.service VERSION.json install.sh start.sh update.sh uninstall.sh openfy; do
    mv -f "${APP_DIR}/${entry}.new" "${APP_DIR}/${entry}"
done
chmod 755 "${APP_DIR}/openfy" 2>/dev/null || true
bin_dir="${OPENFY_BIN_DIR:-/usr/local/bin}"
mkdir -p "${bin_dir}" 2>/dev/null || true
if {
    printf '%s\n' '#!/bin/bash'
    printf 'export OPENFY_INSTALL_DIR=%q\n' "${APP_DIR}"
    printf 'exec bash %q "$@"\n' "${APP_DIR}/openfy"
} > "${bin_dir}/openfy" 2>/dev/null; then
    chmod 755 "${bin_dir}/openfy" 2>/dev/null || true
else
    echo "[openfy-update] WARNING: could not install openfy to ${bin_dir}." >&2
fi
# Renames are atomic: the running update.sh keeps reading its original inode
# while the directory entry switches to the new file.

SERVICE_USER="$(stat -c %U "${DATA_DIR}" 2>/dev/null || echo openfy)"
"${APP_DIR}/venv/bin/python" -m pip install -r "${APP_DIR}/requirements.txt" \
    || { rollback || true; echo "[openfy-update] ERROR: dependency install failed." >&2; exit 1; }
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/app" "${APP_DIR}/client" "${APP_DIR}/venv" 2>/dev/null || true

# Refresh the systemd unit if the bundle changed it, then restart.
cp -a "${APP_DIR}/openfy.service" "${SYSTEMD_DIR}/${SERVICE_NAME}.service" \
    || { rollback || true; echo "[openfy-update] ERROR: failed to install systemd unit." >&2; exit 1; }
sed -i -E "s|--port [0-9]+|--port ${OPENFY_PORT}|" "${SYSTEMD_DIR}/${SERVICE_NAME}.service" \
    || { rollback || true; echo "[openfy-update] ERROR: failed to configure service port." >&2; exit 1; }
systemctl daemon-reload
systemctl start "${SERVICE_NAME}" || { rollback || true; echo "[openfy-update] ERROR: service failed to start." >&2; exit 1; }

if ! wait_for_health; then
    echo "[openfy-update] ERROR: new version unhealthy; attempting rollback. See: journalctl -u ${SERVICE_NAME} -n 100" >&2
    rollback || true
    exit 1
fi

rm -rf "${APP_DIR:?}"/app.old "${APP_DIR:?}"/client.old "${APP_DIR:?}"/spotify_scraper.old
echo "[openfy-update] Updated ${CURRENT} -> ${VERSION}. Backup retained at ${BACKUP_DIR}."
echo "[openfy-update] Config ${ENV_FILE} and data ${DATA_DIR} were preserved."
