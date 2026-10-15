#!/bin/bash
# Uninstall Openfy bare-metal files. Interactive by default.
# Preserves persistent user data and configuration unless explicitly asked
# to remove them. Never erases music, databases, config or artwork silently.
#
# Usage:
#   sudo ./uninstall.sh                 (interactive: keeps data + config)
#   sudo ./uninstall.sh --yes           (non-interactive, still keeps data + config)
#   sudo ./uninstall.sh --purge         (ALSO deletes /var/lib/openfy and /etc/openfy)
#   sudo ./uninstall.sh --remove-data   (also delete /var/lib/openfy)
#   sudo ./uninstall.sh --remove-config (also delete /etc/openfy)

set -euo pipefail

APP_DIR="${OPENFY_INSTALL_DIR:-/opt/openfy}"
DATA_DIR="${OPENFY_DATA_DIR_OVERRIDE:-/var/lib/openfy}"
CONFIG_DIR="${OPENFY_CONFIG_DIR:-/etc/openfy}"
SERVICE_NAME="${OPENFY_SERVICE_NAME:-openfy}"
SERVICE_USER="${OPENFY_SERVICE_USER:-openfy}"
SYSTEMD_DIR="${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}"

ASSUME_YES="false"
REMOVE_DATA="false"
REMOVE_CONFIG="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) ASSUME_YES="true"; shift ;;
        --purge) REMOVE_DATA="true"; REMOVE_CONFIG="true"; shift ;;
        --remove-data) REMOVE_DATA="true"; shift ;;
        --remove-config) REMOVE_CONFIG="true"; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown option '$1'. Use --help." >&2; exit 1 ;;
    esac
done

[[ "$(id -u)" -ne 0 ]] && { echo "ERROR: run as root (e.g. sudo ./uninstall.sh)." >&2; exit 1; }

# Resolve directories lexically so symlinks or ".." cannot hide nesting.
canonical() {
    if command -v realpath >/dev/null 2>&1; then
        realpath -m "$1"
    else
        printf '%s' "$1"
    fi
}
APP_REAL="$(canonical "${APP_DIR}")"
DATA_REAL="$(canonical "${DATA_DIR}")"
CONFIG_REAL="$(canonical "${CONFIG_DIR}")"

if [[ "${APP_REAL}" == "/" ]]; then
    echo "[openfy-uninstall] ERROR: refusing to operate on the filesystem root. Check OPENFY_INSTALL_DIR." >&2
    exit 1
fi

# Data/config nested inside the application directory would be deleted with
# it, contradicting the preservation promise. Refuse rather than risk loss.
nested=""
if [[ "${DATA_REAL}" == "${APP_REAL}" || "${DATA_REAL}" == "${APP_REAL}"/* ]] && [[ "${REMOVE_DATA}" != "true" ]]; then
    nested="${nested} data (${DATA_DIR})"
fi
if [[ "${CONFIG_REAL}" == "${APP_REAL}" || "${CONFIG_REAL}" == "${APP_REAL}"/* ]] && [[ "${REMOVE_CONFIG}" != "true" ]]; then
    nested="${nested} config (${CONFIG_DIR})"
fi
if [[ -n "${nested}" ]]; then
    echo "[openfy-uninstall] ERROR: refusing to remove ${APP_DIR} because it contains preserved${nested}." >&2
    echo "[openfy-uninstall] Move it elsewhere first, point the override at a non-nested path, or rerun with --remove-data/--remove-config to condemn it explicitly." >&2
    exit 1
fi

confirm() {
    local prompt="$1"
    if [[ "${ASSUME_YES}" == "true" ]]; then
        return 0
    fi
    local answer=""
    read -r -p "${prompt} [y/N] " answer || true
    [[ "${answer}" == "y" || "${answer}" == "Y" ]]
}

echo "[openfy-uninstall] This will stop and remove the Openfy application at ${APP_DIR}."
echo "[openfy-uninstall] Data (${DATA_DIR}) and config (${CONFIG_DIR}) are PRESERVED by default."
if [[ "${REMOVE_DATA}" == "true" ]]; then
    echo "[openfy-uninstall] WARNING: --remove-data/--purge WILL PERMANENTLY DELETE ${DATA_DIR} (music, database, artwork, downloads)." >&2
fi
if [[ "${REMOVE_CONFIG}" == "true" ]]; then
    echo "[openfy-uninstall] WARNING: --remove-config/--purge WILL PERMANENTLY DELETE ${CONFIG_DIR} (incl. admin credentials)." >&2
fi
confirm "Proceed with uninstall?" || { echo "[openfy-uninstall] Aborted; nothing changed."; exit 0; }

if [[ "${REMOVE_DATA}" == "true" ]]; then
    confirm "CONFIRM AGAIN: permanently delete ALL user data in ${DATA_DIR}?" \
        || { echo "[openfy-uninstall] Aborted; nothing changed."; exit 0; }
fi

echo "[openfy-uninstall] Stopping and disabling '${SERVICE_NAME}'."
systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
systemctl daemon-reload 2>/dev/null || true

if [[ -e "${APP_DIR}" ]]; then
    echo "[openfy-uninstall] Removing application files at ${APP_DIR}."
    rm -rf "${APP_DIR}"
else
    echo "[openfy-uninstall] No application directory at ${APP_DIR}; nothing to remove."
fi

if [[ "${REMOVE_CONFIG}" == "true" ]]; then
    echo "[openfy-uninstall] Removing configuration at ${CONFIG_DIR}."
    rm -rf "${CONFIG_DIR}"
else
    echo "[openfy-uninstall] Preserved configuration at ${CONFIG_DIR}."
fi

if [[ "${REMOVE_DATA}" == "true" ]]; then
    echo "[openfy-uninstall] Removing user data at ${DATA_DIR}."
    rm -rf "${DATA_DIR}"
else
    echo "[openfy-uninstall] Preserved user data at ${DATA_DIR}."
fi

echo "[openfy-uninstall] Service account '${SERVICE_USER}' was left in place (harmless; remove manually with 'userdel ${SERVICE_USER}' if desired)."
echo "[openfy-uninstall] Uninstall complete."
