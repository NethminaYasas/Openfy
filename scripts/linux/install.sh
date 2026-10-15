#!/bin/bash
# Openfy bare-metal installer for systemd-based Linux (Ubuntu/Debian preferred).
# No Docker required.
#
# Typical use (from the extracted release archive):
#   tar -xzf openfy-v1.4.2-linux-amd64.tar.gz
#   cd openfy-v1.4.2-linux-amd64
#   sudo ./install.sh
#
# The installer:
#   - checks OS / CPU arch / Python >= 3.11 / systemd
#   - installs app files to /opt/openfy (code + venv, no data)
#   - stores persistent data in /var/lib/openfy (music, downloads, artwork, db)
#   - stores admin-controlled config in /etc/openfy/openfy.env (never overwritten
#     without consent; existing credentials and data are preserved on reruns)
#   - creates an isolated venv and installs requirements.txt
#   - installs + enables the openfy systemd service
#
# Safe to rerun. Never deletes user data. Override defaults for testing via:
#   OPENFY_PREFIX=/tmp/openfy-test OPENFY_SYSTEMD_DIR=... ./install.sh --no-start
#
# Options:
#   --no-start            install but do not start the service
#   --allow-unsupported-os proceed on non-Debian/Ubuntu distros
#   --force               reinstall app files even if version already installed
#   -h | --help           show help

set -euo pipefail

APP_DIR="${OPENFY_INSTALL_DIR:-/opt/openfy}"
DATA_DIR="${OPENFY_DATA_DIR_OVERRIDE:-/var/lib/openfy}"
CONFIG_DIR="${OPENFY_CONFIG_DIR:-/etc/openfy}"
ENV_FILE="${CONFIG_DIR}/openfy.env"
SERVICE_USER="${OPENFY_SERVICE_USER:-openfy}"
SERVICE_NAME="${OPENFY_SERVICE_NAME:-openfy}"
SYSTEMD_DIR="${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}"
NO_START="false"
ALLOW_UNSUPPORTED_OS="false"
FORCE="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-start) NO_START="true"; shift ;;
        --allow-unsupported-os) ALLOW_UNSUPPORTED_OS="true"; shift ;;
        --force) FORCE="true"; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown option '$1'. Use --help." >&2; exit 1 ;;
    esac
done

SCRIPT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log()  { echo "[openfy-install] $*"; }
die()  { echo "[openfy-install] ERROR: $*" >&2; exit 1; }

require_root() {
    if [[ "$(id -u)" -ne 0 ]]; then
        die "run as root (e.g. sudo ./install.sh)."
    fi
}

detect_arch() {
    local machine
    machine="$(uname -m)"
    case "${machine}" in
        x86_64)  echo "linux-amd64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) die "unsupported CPU architecture '${machine}'. Openfy ships linux-amd64 and linux-arm64 bundles." ;;
    esac
}

check_os() {
    local id="unknown" version="unknown"
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        id="${ID:-unknown}"; version="${VERSION_ID:-unknown}"
    fi
    log "Detected OS: ${id} ${version} ($(uname -m))"
    case "${id}" in
        ubuntu|debian|linuxmint|pop|raspbian) log "Supported distribution." ;;
        *)
            if [[ "${ALLOW_UNSUPPORTED_OS}" == "true" ]]; then
                log "WARNING: unsupported distribution '${id}'; continuing due to --allow-unsupported-os."
            else
                die "unsupported distribution '${id}'. Tested on Ubuntu/Debian. Re-run with --allow-unsupported-os to proceed anyway."
            fi
            ;;
    esac
}

# If this archive was built for a different CPU arch than the host, refuse early.
check_bundle_arch() {
    local host_arch bundle_arch=""
    host_arch="$(detect_arch)"
    if [[ -f "${SCRIPT_SRC_DIR}/VERSION.json" ]] && command -v python3 >/dev/null 2>&1; then
        bundle_arch="$(python3 -c "import json;print(json.load(open('${SCRIPT_SRC_DIR}/VERSION.json')).get('arch',''))" 2>/dev/null || true)"
    fi
    if [[ -n "${bundle_arch}" && "${bundle_arch}" != "${host_arch}" ]]; then
        die "bundle arch '${bundle_arch}' does not match host '${host_arch}'. Download the ${host_arch} archive instead."
    fi
    log "Architecture check passed (${host_arch})."
}

check_systemd() {
    if [[ ! -d /run/systemd/system ]] && ! systemctl --version >/dev/null 2>&1; then
        die "systemd does not appear to be running. Openfy bare-metal installs require systemd."
    fi
    command -v systemctl >/dev/null 2>&1 || die "systemctl not found; install systemd first."
    log "systemd available."
}

check_python() {
    command -v python3 >/dev/null 2>&1 || die "python3 not found. Install Python 3.11+ (e.g. 'sudo apt install python3 python3-venv python3-pip')."
    local ver major minor
    ver="$(python3 -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    major="${ver%%.*}"; minor="${ver#*.}"
    if [[ "${major}" -lt 3 || ( "${major}" -eq 3 && "${minor}" -lt 11 ) ]]; then
        die "Python ${ver} is too old. Openfy requires Python 3.11+; found ${ver}."
    fi
    log "Python ${ver} OK (>= 3.11 required)."
    python3 -m venv --help >/dev/null 2>&1 || die "python3-venv missing. Install it ('sudo apt install python3-venv')."
    command -v curl >/dev/null 2>&1 || log "WARNING: curl not found; health checks will use python instead."
    command -v ffmpeg >/dev/null 2>&1 || log "WARNING: ffmpeg not found. Audio processing/downloads need it ('sudo apt install ffmpeg')."
}

check_existing() {
    if [[ -e "${APP_DIR}" && -n "$(ls -A "${APP_DIR}" 2>/dev/null || true)" ]]; then
        if [[ -f "${APP_DIR}/VERSION.json" ]]; then
            local installed="unknown" bundle="unknown"
            installed="$(python3 -c "import json;print(json.load(open('${APP_DIR}/VERSION.json')).get('version','unknown'))" 2>/dev/null || echo unknown)"
            bundle="$(python3 -c "import json;print(json.load(open('${SCRIPT_SRC_DIR}/VERSION.json')).get('version','unknown'))" 2>/dev/null || echo unknown)"
            if [[ "${installed}" == "${bundle}" && "${FORCE}" != "true" ]]; then
                log "Version ${installed} already installed at ${APP_DIR}. Re-running anyway to repair (use --force to reinstall files); config and data are preserved."
            else
                log "Existing installation (version ${installed}) found; upgrading files to ${bundle}. Config and data are preserved."
            fi
        else
            die "${APP_DIR} exists but is not an Openfy installation. Move it aside or set OPENFY_INSTALL_DIR to another path."
        fi
    fi
}

create_user() {
    if id "${SERVICE_USER}" >/dev/null 2>&1; then
        log "Service account '${SERVICE_USER}' already exists."
    else
        log "Creating system user '${SERVICE_USER}'."
        useradd --system --no-create-home --home-dir "${DATA_DIR}" \
            --shell /usr/sbin/nologin --comment "Openfy service account" "${SERVICE_USER}"
    fi
}

install_files() {
    log "Installing application files to ${APP_DIR}."
    mkdir -p "${APP_DIR}"
    # App code only: data and config live elsewhere and are never touched here.
    for entry in app client spotify_scraper spotify_search.py requirements.txt \
                 openfy.service VERSION.json LICENSE THIRD_PARTY_NOTICES.md README_LINUX.md .env.example; do
        if [[ -e "${SCRIPT_SRC_DIR}/${entry}" ]]; then
            cp -a "${SCRIPT_SRC_DIR}/${entry}" "${APP_DIR}/${entry}"
        else
            log "WARNING: bundle entry missing (skipped): ${entry}"
        fi
    done
    # Helper scripts live alongside the bundle for operators.
    for entry in start.sh update.sh uninstall.sh generate_hash.py; do
        [[ -e "${SCRIPT_SRC_DIR}/${entry}" ]] && cp -a "${SCRIPT_SRC_DIR}/${entry}" "${APP_DIR}/${entry}"
    done
    chmod 755 "${APP_DIR}"/start.sh "${APP_DIR}"/update.sh "${APP_DIR}"/uninstall.sh 2>/dev/null || true
}

create_dirs() {
    log "Creating persistent directories under ${DATA_DIR}."
    mkdir -p "${DATA_DIR}/music" "${DATA_DIR}/downloads" "${DATA_DIR}/artwork" "${DATA_DIR}/avatars"
    mkdir -p "${CONFIG_DIR}"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
    chmod 755 "${DATA_DIR}" "${DATA_DIR}/music" "${DATA_DIR}/downloads" "${DATA_DIR}/artwork"
    chown root:"${SERVICE_USER}" "${CONFIG_DIR}"
    chmod 2750 "${CONFIG_DIR}"
}

install_config() {
    if [[ -f "${ENV_FILE}" ]]; then
        log "Existing config ${ENV_FILE} preserved (not overwritten)."
        chown root:"${SERVICE_USER}" "${ENV_FILE}"
        chmod 640 "${ENV_FILE}"
        return
    fi
    local admin_user="admin"
    log "Writing default configuration to ${ENV_FILE}. After install, generate a credential:"
    log "  sudo ${APP_DIR}/venv/bin/python ${APP_DIR}/generate_hash.py"
    cat > "${ENV_FILE}" <<EOF
# Openfy production configuration (administrator-controlled).
# Installed by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Edit values, then restart: sudo systemctl restart ${SERVICE_NAME}
OPENFY_ENV=prod
OPENFY_ADMIN_USERNAME=${admin_user}
# Generate with: python3 scripts/generate_hash.py  (paste the of1_... value below)
OPENFY_ADMIN_HASH=
OPENFY_ALLOWED_ORIGINS=http://localhost:8000
OPENFY_MAX_UPLOAD_SIZE_MB=200
OPENFY_DATA_DIR=${DATA_DIR}
OPENFY_MUSIC_DIR=${DATA_DIR}/music
OPENFY_DOWNLOADS_DIR=${DATA_DIR}/downloads
OPENFY_ARTWORK_DIR=${DATA_DIR}/artwork
OPENFY_DATABASE_URL=sqlite:///${DATA_DIR}/openfy.db
SPOTIFLAC_PIN_VERSION=
EOF
    chown root:"${SERVICE_USER}" "${ENV_FILE}"
    chmod 640 "${ENV_FILE}"
    log "Default config written. You MUST set OPENFY_ADMIN_HASH before first login."
}

install_venv() {
    log "Creating isolated virtual environment."
    if [[ ! -x "${APP_DIR}/venv/bin/python" ]]; then
        python3 -m venv "${APP_DIR}/venv"
    fi
    "${APP_DIR}/venv/bin/python" -m pip install --upgrade pip
    # Pinned by server/requirements.txt; SpotiFLAC resolves to latest upstream
    # unless SPOTIFLAC_PIN_VERSION is set (same behaviour as Docker builds).
    "${APP_DIR}/venv/bin/python" -m pip install -r "${APP_DIR}/requirements.txt"
    if [[ -n "${SPOTIFLAC_PIN_VERSION:-}" ]]; then
        "${APP_DIR}/venv/bin/python" -m pip install --no-cache-dir --upgrade \
            "git+https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version.git@v${SPOTIFLAC_PIN_VERSION}"
    fi
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/venv"
}

install_service() {
    log "Installing systemd unit ${SERVICE_NAME}."
    cp -a "${APP_DIR}/openfy.service" "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
    chmod 644 "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/app" "${APP_DIR}/client" 2>/dev/null || true
    chown "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}" 2>/dev/null || true
    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}" >/dev/null
}

validate_install() {
    log "Validating installation."
    "${APP_DIR}/venv/bin/python" -m compileall -q "${APP_DIR}/app" || die "Python syntax check failed."
    [[ -f "${APP_DIR}/app/main.py" && -f "${APP_DIR}/client/index.html" && -f "${ENV_FILE}" ]] \
        || die "validation failed: required files missing."
    # Import check with production paths but without starting the server.
    OPENFY_DATA_DIR="${DATA_DIR}" OPENFY_DATABASE_URL="sqlite:///${DATA_DIR}/openfy.db" \
        "${APP_DIR}/venv/bin/python" -c "import sys; sys.path.insert(0, '${APP_DIR}'); import app.settings; print('settings OK')" \
        || die "application import check failed."
    log "Validation passed."
}

start_and_healthcheck() {
    if [[ "${NO_START}" == "true" ]]; then
        log "Skipping service start (--no-start). Start later with: sudo systemctl start ${SERVICE_NAME}"
        return
    fi
    log "Starting ${SERVICE_NAME}."
    systemctl restart "${SERVICE_NAME}"
    local attempt=0
    while [[ "${attempt}" -lt 30 ]]; do
        if "${APP_DIR}/venv/bin/python" -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health', timeout=3)" 2>/dev/null; then
            log "Openfy is healthy at http://localhost:8000/health"
            log "Open the app at http://<server-ip>:8000 and sign in with your admin credential."
            return
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    die "service did not become healthy. Inspect with: sudo systemctl status ${SERVICE_NAME} ; sudo journalctl -u ${SERVICE_NAME} -n 100"
}

main() {
    require_root
    check_os
    check_bundle_arch
    check_systemd
    check_python
    check_existing
    create_user
    install_files
    create_dirs
    install_config
    install_venv
    install_service
    validate_install
    start_and_healthcheck
    log "Install complete. Config: ${ENV_FILE}  Data: ${DATA_DIR}  App: ${APP_DIR}"
}

main "$@"
