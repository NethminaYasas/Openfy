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
# Credential handling (see docs/LINUX_INSTALL.md):
#   - Fresh installs auto-generate a cryptographically secure admin credential
#     (of1_..., same format as ../../scripts/generate_hash.py) and store it as
#     OPENFY_ADMIN_HASH. It is printed ONCE; save it, it cannot be recovered.
#   - Automation may supply OPENFY_ADMIN_HASH_VALUE in the environment (never
#     as a CLI argument, which would leak via process listings). It is
#     validated against the application's credential format and never printed.
#   - Existing configuration is NEVER overwritten and existing credentials are
#     NEVER printed on reruns, repairs, or upgrades. Rotation is explicit:
#     ./install.sh --rotate-credential (prints the new secret once).
#
# Options:
#   --no-start            install but do not start the service
#   --allow-unsupported-os proceed on non-Debian/Ubuntu distros
#   --force               reinstall app files even if version already installed
#   --yes                 non-interactive (accept defaults; no prompts)
#   --port PORT           service port (default: 8000)
#   --admin-user NAME     admin username for fresh installs (default: admin)
#   --no-generate-credential
#                         do not auto-generate the admin credential on a fresh
#                         install (set OPENFY_ADMIN_HASH manually afterwards)
#   --rotate-credential   replace OPENFY_ADMIN_HASH on an existing install
#                         (explicit opt-in; prints the new secret once)
#   --no-install-deps     do not install system packages automatically
#   --repair              verify files, fix ownership/permissions, reinstall
#                         the venv and systemd unit without touching config/data
#   -h | --help           show help

set -euo pipefail

APP_DIR="${OPENFY_INSTALL_DIR:-/opt/openfy}"
DATA_DIR="${OPENFY_DATA_DIR_OVERRIDE:-/var/lib/openfy}"
CONFIG_DIR="${OPENFY_CONFIG_DIR:-/etc/openfy}"
ENV_FILE="${CONFIG_DIR}/openfy.env"
SERVICE_USER="${OPENFY_SERVICE_USER:-openfy}"
SERVICE_NAME="${OPENFY_SERVICE_NAME:-openfy}"
SYSTEMD_DIR="${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}"
if [[ -z "${OPENFY_PORT+x}" ]]; then
    OPENFY_PORT="8000"
    PORT_EXPLICIT="false"
else
    PORT_EXPLICIT="true"
fi
NO_START="false"
ALLOW_UNSUPPORTED_OS="false"
FORCE="false"
ASSUME_YES="false"
ADMIN_USER="${OPENFY_ADMIN_USERNAME:-admin}"
NO_GENERATE_CREDENTIAL="false"
ROTATE_CREDENTIAL="false"
NO_INSTALL_DEPS="false"
REPAIR="false"

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-start) NO_START="true"; shift ;;
            --allow-unsupported-os) ALLOW_UNSUPPORTED_OS="true"; shift ;;
            --force) FORCE="true"; shift ;;
            --yes|-y) ASSUME_YES="true"; shift ;;
            --port) OPENFY_PORT="${2:?--port requires a value}"; PORT_EXPLICIT="true"; shift 2 ;;
            --admin-user) ADMIN_USER="${2:?--admin-user requires a value}"; shift 2 ;;
            --no-generate-credential) NO_GENERATE_CREDENTIAL="true"; shift ;;
            --rotate-credential) ROTATE_CREDENTIAL="true"; shift ;;
            --no-install-deps) NO_INSTALL_DEPS="true"; shift ;;
            --repair) REPAIR="true"; shift ;;
            -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
            *) echo "ERROR: unknown option '$1'. Use --help." >&2; exit 1 ;;
        esac
    done

    if [[ ! "${ADMIN_USER}" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
        echo "[openfy-install] ERROR: invalid admin username '${ADMIN_USER}'." >&2
        exit 1
    fi
    valid_port "${OPENFY_PORT}" || {
        echo "[openfy-install] ERROR: invalid --port '${OPENFY_PORT}' (must be 1-65535, no leading zeros)." >&2
        exit 1
    }
}

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

install_system_deps() {
    if [[ "${NO_INSTALL_DEPS}" == "true" ]]; then
        log "Skipping system package installation (--no-install-deps)."
        return
    fi
    local mgr="none"
    if command -v apt-get >/dev/null 2>&1; then mgr="apt";
    elif command -v dnf >/dev/null 2>&1; then mgr="dnf";
    elif command -v yum >/dev/null 2>&1; then mgr="yum";
    elif command -v pacman >/dev/null 2>&1; then mgr="pacman";
    elif command -v zypper >/dev/null 2>&1; then mgr="zypper"; fi
    if [[ "${mgr}" == "none" ]]; then
        log "WARNING: no supported package manager (apt/dnf/yum/pacman/zypper); ensure python3 (>=3.11), python3-venv, curl, ffmpeg, sqlite3 are installed."
        return
    fi
    local pkgs
    case "${mgr}" in
        apt) pkgs="python3 python3-venv python3-pip curl ffmpeg sqlite3" ;;
        dnf|yum) pkgs="python3 python3-pip curl ffmpeg sqlite3" ;;
        pacman) pkgs="python python-virtualenv python-pip curl ffmpeg sqlite" ;;
        zypper) pkgs="python3 python3-venv python3-pip curl ffmpeg sqlite3" ;;
    esac
    log "Installing system dependencies via ${mgr}."
    case "${mgr}" in
        apt) apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs} ;;
        dnf) dnf install -y ${pkgs/ ffmpeg/} && { dnf install -y ffmpeg || log "WARNING: ffmpeg unavailable (enable RPM Fusion)."; } ;;
        yum) yum install -y ${pkgs/ ffmpeg/} && { yum install -y ffmpeg || log "WARNING: ffmpeg unavailable (enable RPM Fusion/EPEL)."; } ;;
        pacman) pacman -S --needed --noconfirm ${pkgs} ;;
        zypper) zypper --non-interactive install ${pkgs} ;;
    esac || die "package installation via ${mgr} failed; install dependencies manually and rerun (or use --no-install-deps)."
}

port_in_use() {
    local port="${1:-${OPENFY_PORT}}"
    # ss sees listeners on all local addresses (service binds 0.0.0.0).
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | grep -q ":${port} " && return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        # Loopback connect catches loopback listeners (even when ss is
        # blind to them); wildcard bind catches non-loopback ones.
        python3 - "${port}" 2>/dev/null <<'EOF'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(2)
if s.connect_ex(("127.0.0.1", port)) == 0:
    sys.exit(0)
s2 = socket.socket()
s2.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s2.bind(("0.0.0.0", port))
except OSError:
    sys.exit(0)
sys.exit(1)
EOF
    else
        return 1
    fi
}

check_port() {
    if port_in_use "${OPENFY_PORT}"; then
        local unit_port=""
        unit_port="$(grep -oE -- '--port [0-9]+' "${SYSTEMD_DIR}/${SERVICE_NAME}.service" 2>/dev/null | awk '{print $2}' | head -n 1 || true)"
        if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null && [[ "${unit_port:-8000}" == "${OPENFY_PORT}" ]]; then
            log "Port ${OPENFY_PORT} is held by the running ${SERVICE_NAME} service (expected)."
        else
            die "port ${OPENFY_PORT} is already in use by another process. Stop it first, or stop the existing '${SERVICE_NAME}' service if it holds the port."
        fi
    else
        log "Port ${OPENFY_PORT} is free."
    fi
}

resolve_port() {
    # Preserve a custom port across repair/reinstall/upgrade when the operator
    # did not pass --port (or OPENFY_PORT). Fresh installs keep default 8000.
    if [[ "${PORT_EXPLICIT:-false}" == "true" ]]; then
        return
    fi
    local unit="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
    if [[ -f "${unit}" ]]; then
        local p
        p="$(grep -oE -- '--port [0-9]+' "${unit}" 2>/dev/null | awk '{print $2}' | head -n 1 || true)"
        if valid_port "${p}"; then
            OPENFY_PORT="${p}"
            log "Keeping existing service port ${OPENFY_PORT}."
        fi
    fi
}

# Credential format required by the application (server/app/settings.py
# ADMIN_TOKEN_PATTERN): of1_ + 60 url-safe chars. generate_hash.py produces
# exactly this via "of1_" + secrets.token_urlsafe(45); replicate it here with
# stdlib python3 so the installer needs no extra dependencies.
generate_credential() {
    python3 -c 'import secrets; print("of1_" + secrets.token_urlsafe(45))'
}

valid_credential() {
    [[ "$1" =~ ^of1_[A-Za-z0-9_-]{60}$ ]]
}

valid_port() {
    [[ "${1:-}" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

print_credential_once() {
    local credential="$1"
    echo ""
    echo "=================================================================="
    echo "  INITIAL ADMIN CREDENTIAL (generated now, shown ONCE)"
    echo "  User: ${2:-${ADMIN_USER}}"
    echo "  Credential: ${credential}"
    echo "  Save it in a password manager. It CANNOT be recovered if lost;"
    echo "  it can only be rotated (./install.sh --rotate-credential)."
    echo "  Sign in with this value in the Auth Hash field."
    echo "=================================================================="
    echo ""
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
    if [[ "${SCRIPT_SRC_DIR}" == "${APP_DIR}" ]]; then
        log "Source and destination are both ${APP_DIR}; skipping self-copy."
    else
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
        for entry in install.sh start.sh update.sh uninstall.sh generate_hash.py openfy; do
            [[ -e "${SCRIPT_SRC_DIR}/${entry}" ]] && cp -a "${SCRIPT_SRC_DIR}/${entry}" "${APP_DIR}/${entry}"
        done
    fi
    chmod 755 "${APP_DIR}"/start.sh "${APP_DIR}"/update.sh "${APP_DIR}"/uninstall.sh "${APP_DIR}"/openfy 2>/dev/null || true
}

install_cli() {
    # Expose the manager on PATH via a wrapper that pins the configured
    # install dir; /opt/openfy/openfy always remains directly usable.
    local bin_dir="${OPENFY_BIN_DIR:-/usr/local/bin}"
    if [[ -f "${APP_DIR}/openfy" ]]; then
        mkdir -p "${bin_dir}" 2>/dev/null || true
        if {
            printf '%s\n' '#!/bin/bash'
            printf 'export OPENFY_INSTALL_DIR=%q\n' "${APP_DIR}"
            printf 'exec bash %q "$@"\n' "${APP_DIR}/openfy"
        } > "${bin_dir}/openfy" 2>/dev/null; then
            chmod 755 "${bin_dir}/openfy" 2>/dev/null || true
            log "Manager command installed at ${bin_dir}/openfy (run: sudo openfy)."
        else
            log "WARNING: could not install openfy to ${bin_dir}."
        fi
    fi
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
        log "Existing config ${ENV_FILE} preserved (not overwritten; credentials untouched and never printed)."
        chown root:"${SERVICE_USER}" "${ENV_FILE}"
        chmod 640 "${ENV_FILE}"
        return
    fi
    local admin_hash=""
    local generated="false"
    if [[ -n "${OPENFY_ADMIN_HASH_VALUE:-}" ]]; then
        valid_credential "${OPENFY_ADMIN_HASH_VALUE}" \
            || die "OPENFY_ADMIN_HASH_VALUE has an invalid format (expected of1_... from generate_hash.py); refusing to write a bad credential."
        admin_hash="${OPENFY_ADMIN_HASH_VALUE}"
        log "Using administrator credential supplied via OPENFY_ADMIN_HASH_VALUE (not shown)."
    elif [[ "${NO_GENERATE_CREDENTIAL}" == "true" ]]; then
        log "Leaving OPENFY_ADMIN_HASH empty (--no-generate-credential). Set it manually, then restart the service."
    else
        admin_hash="$(generate_credential)"
        valid_credential "${admin_hash}" || die "generated credential failed validation (internal error)."
        generated="true"
    fi
    log "Writing default configuration to ${ENV_FILE}."
    mkdir -p "${CONFIG_DIR}"
    cat > "${ENV_FILE}" <<EOF
# Openfy production configuration (administrator-controlled).
# Installed by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Edit values, then restart: sudo systemctl restart ${SERVICE_NAME}
OPENFY_ENV=prod
OPENFY_ADMIN_USERNAME=${ADMIN_USER}
OPENFY_ADMIN_HASH=${admin_hash}
OPENFY_ALLOWED_ORIGINS=http://localhost:${OPENFY_PORT}
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
    if [[ "${generated}" == "true" ]]; then
        print_credential_once "${admin_hash}"
    elif [[ -z "${admin_hash}" ]]; then
        log "You MUST set OPENFY_ADMIN_HASH before first login:"
        log "  sudo ${APP_DIR}/venv/bin/python ${APP_DIR}/generate_hash.py   (paste the of1_... value into ${ENV_FILE})"
        log "  sudo systemctl restart ${SERVICE_NAME}"
    fi
}

rotate_credential() {
    [[ -f "${ENV_FILE}" ]] || die "no config at ${ENV_FILE}; nothing to rotate (fresh installs generate a credential automatically)."
    local current=""
    current="$(grep -E '^OPENFY_ADMIN_HASH=' "${ENV_FILE}" | cut -d= -f2- || true)"
    local fresh
    fresh="$(generate_credential)"
    valid_credential "${fresh}" || die "generated credential failed validation (internal error)."
    if [[ "${current}" == "${fresh}" ]]; then
        die "rotation produced an identical credential by chance; rerun (this is not an error in your setup)."
    fi
    local stamp backup
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    backup="${ENV_FILE}.bak-${stamp}"
    cp -a "${ENV_FILE}" "${backup}" || die "could not back up ${ENV_FILE} before rotation."
    chmod 600 "${backup}"
    # Replace (or append) exactly the OPENFY_ADMIN_HASH line; never touch the
    # rest of the file. Use a temp file + atomic rename.
    local tmp
    tmp="$(mktemp "${CONFIG_DIR}/.openfy.env.XXXXXX")"
    chmod 640 "${tmp}"
    chown root:"${SERVICE_USER}" "${tmp}" 2>/dev/null || true
    if grep -qE '^OPENFY_ADMIN_HASH=' "${ENV_FILE}"; then
        sed "s|^OPENFY_ADMIN_HASH=.*|OPENFY_ADMIN_HASH=${fresh}|" "${ENV_FILE}" > "${tmp}" \
            || { rm -f "${tmp}"; die "rotation failed while writing; original config untouched (backup at ${backup})."; }
    else
        cat "${ENV_FILE}" > "${tmp}" \
            || { rm -f "${tmp}"; die "rotation failed while writing; original config untouched (backup at ${backup})."; }
        printf 'OPENFY_ADMIN_HASH=%s\n' "${fresh}" >> "${tmp}" \
            || { rm -f "${tmp}"; die "rotation failed while writing; original config untouched (backup at ${backup})."; }
    fi
    local newval
    newval="$(grep -E '^OPENFY_ADMIN_HASH=' "${tmp}" | cut -d= -f2- || true)"
    valid_credential "${newval}" || { rm -f "${tmp}"; die "rotation failed validation; original config untouched (backup at ${backup})."; }
    if ! chown root:"${SERVICE_USER}" "${tmp}"; then
        rm -f "${tmp}" || true
        die "rotation failed while setting temporary config ownership (backup at ${backup})."
    fi
    if ! mv -f "${tmp}" "${ENV_FILE}"; then
        rm -f "${tmp}" || true
        die "rotation failed while replacing config (backup at ${backup})."
    fi
    chown root:"${SERVICE_USER}" "${ENV_FILE}"
    chmod 640 "${ENV_FILE}"
    log "Previous config backed up at ${backup}."
    log "Restart the service to apply: sudo systemctl restart ${SERVICE_NAME} (the OLD credential stops working then)."
    local username
    username="$(grep -E '^OPENFY_ADMIN_USERNAME=' "${ENV_FILE}" | cut -d= -f2- || true)"
    print_credential_once "${fresh}" "${username}"
}

repair_install() {
    log "Repairing installation at ${APP_DIR} (config and data are never modified)."
    [[ -f "${APP_DIR}/VERSION.json" ]] || die "no Openfy installation at ${APP_DIR} (missing VERSION.json); install first."
    [[ -f "${ENV_FILE}" ]] || die "no config at ${ENV_FILE}; repair never creates configuration. Restore it before retrying."
    create_user
    # Reinstall application files from THIS bundle (the caller verified it),
    # then fix ownership/permissions, venv, and the systemd unit.
    install_files
    create_dirs
    install_config
    install_venv
    install_service
    install_cli
    validate_install
    log "Repair complete."
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
    local unit_tmp
    unit_tmp="$(mktemp)"
    sed -e "s|^User=.*|User=${SERVICE_USER}|" \
        -e "s|^Group=.*|Group=${SERVICE_USER}|" \
        -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
        -e "s|^EnvironmentFile=.*|EnvironmentFile=${ENV_FILE}|" \
        -e "s|^ExecStart=.*|ExecStart=${APP_DIR}/venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port ${OPENFY_PORT}|" \
        -e "s|^ReadWritePaths=.*|ReadWritePaths=${DATA_DIR}|" \
        "${APP_DIR}/openfy.service" > "${unit_tmp}"
    cp -a "${unit_tmp}" "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
    rm -f "${unit_tmp}"
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
        if "${APP_DIR}/venv/bin/python" -c "import urllib.request;urllib.request.urlopen('http://localhost:${OPENFY_PORT}/health', timeout=3)" 2>/dev/null; then
            log "Openfy is healthy at http://localhost:${OPENFY_PORT}/health"
            log "Open the app at http://<server-ip>:${OPENFY_PORT} and sign in with your admin credential."
            return
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    die "service did not become healthy. Inspect with: sudo systemctl status ${SERVICE_NAME} ; sudo journalctl -u ${SERVICE_NAME} -n 100"
}

main() {
    parse_args "$@"
    require_root
    if [[ "${ROTATE_CREDENTIAL}" == "true" ]]; then
        [[ -f "${ENV_FILE}" ]] || die "no config at ${ENV_FILE}; nothing to rotate (fresh installs generate a credential automatically)."
        create_user
        rotate_credential
        return
    fi
    if [[ "${REPAIR}" == "true" ]]; then
        # Fail fast before any system mutation (install_system_deps/create_user).
        # repair_install() keeps its own identical guard as defense in depth.
        [[ -f "${APP_DIR}/VERSION.json" ]] || die "no Openfy installation at ${APP_DIR} (missing VERSION.json); install first."
        [[ -f "${ENV_FILE}" ]] || die "no config at ${ENV_FILE}; repair never creates configuration. Restore it before retrying."
    fi
    resolve_port
    check_os
    check_bundle_arch
    check_systemd
    install_system_deps
    check_python
    check_port
    check_existing
    create_user
    if [[ "${REPAIR}" == "true" ]]; then
        repair_install
    else
        install_files
        create_dirs
        install_config
        install_venv
        install_service
        install_cli
        validate_install
    fi
    start_and_healthcheck
    log "Install complete. Config: ${ENV_FILE}  Data: ${DATA_DIR}  App: ${APP_DIR}"
    log "Manage the server anytime with: sudo openfy (status, logs, update, port, credentials, uninstall)"
}

if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
    main "$@"
fi
