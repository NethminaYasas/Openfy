#!/bin/bash
# Uninstall Openfy. A plain run removes the application AND every trace it
# left behind: the data directory (music, database, artwork, avatars), the
# configuration (admin credential), the update backups, the service account
# and the CLI wrapper. Interactive by default.
#
# Nothing is ever deleted silently: the run asks for confirmation (twice for
# a full wipe) and prints exactly what it removes.
#
# Usage:
#   sudo ./uninstall.sh                     (full wipe: app + data + config + backups + account)
#   sudo ./uninstall.sh --yes               (same, non-interactive)
#   sudo ./uninstall.sh --keep-data         (keep /var/lib/openfy)
#   sudo ./uninstall.sh --keep-config       (keep /etc/openfy)
#   sudo ./uninstall.sh --keep-backups      (keep /var/backups/openfy)
#   sudo ./uninstall.sh --keep-service-user (keep the 'openfy' system account)

set -euo pipefail

APP_DIR="${OPENFY_INSTALL_DIR:-/opt/openfy}"
DATA_DIR="${OPENFY_DATA_DIR_OVERRIDE:-/var/lib/openfy}"
CONFIG_DIR="${OPENFY_CONFIG_DIR:-/etc/openfy}"
BACKUP_DIR="${OPENFY_BACKUP_DIR:-/var/backups/openfy}"
SERVICE_NAME="${OPENFY_SERVICE_NAME:-openfy}"
SERVICE_USER="${OPENFY_SERVICE_USER:-openfy}"
SYSTEMD_DIR="${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}"
BIN_DIR="${OPENFY_BIN_DIR:-/usr/local/bin}"

ASSUME_YES="false"
KEEP_DATA="false"
KEEP_CONFIG="false"
KEEP_BACKUPS="false"
KEEP_SERVICE_USER="false"

usage() {
    cat <<'EOF'
Uninstall Openfy and remove every trace it left behind.

Usage:
  sudo ./uninstall.sh                     full wipe: app + data + config + backups + account
  sudo ./uninstall.sh --yes               same, non-interactive
  sudo ./uninstall.sh --keep-data         keep the data directory (music, database, artwork)
  sudo ./uninstall.sh --keep-config       keep the configuration (admin credential)
  sudo ./uninstall.sh --keep-backups      keep the pre-update backups
  sudo ./uninstall.sh --keep-service-user keep the 'openfy' system account
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) ASSUME_YES="true"; shift ;;
        --keep-data) KEEP_DATA="true"; shift ;;
        --keep-config) KEEP_CONFIG="true"; shift ;;
        --keep-backups) KEEP_BACKUPS="true"; shift ;;
        --keep-service-user) KEEP_SERVICE_USER="true"; shift ;;
        --purge|--remove-data|--remove-config)
            echo "[openfy-uninstall] NOTE: '$1' is obsolete - a plain run already wipes everything. Ignoring." >&2
            shift ;;
        -h|--help) usage; exit 0 ;;
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
BACKUP_REAL="$(canonical "${BACKUP_DIR}")"

if [[ "${APP_REAL}" == "/" ]]; then
    echo "[openfy-uninstall] ERROR: refusing to operate on the filesystem root. Check OPENFY_INSTALL_DIR." >&2
    exit 1
fi

# A mistyped override must never turn into "rm -rf /var" or "rm -rf /etc".
unsafe_target() {
    local path="$1"
    case "${path}" in
        "/" | "/bin" | "/boot" | "/dev" | "/etc" | "/home" | "/lib" | "/lib64" | \
        "/opt" | "/proc" | "/root" | "/run" | "/sbin" | "/srv" | "/sys" | "/tmp" | \
        "/usr" | "/var" | "/var/lib" | "/var/local" | "/var/log" | "/var/spool" | \
        "/var/tmp" | "/var/www" | "/var/backups" | "/etc/default" | "/etc/skel" | \
        "/etc/systemd" | "/etc/systemd/system" | "/usr/local" | "/usr/local/bin" | \
        "/usr/local/sbin" | "/usr/local/lib")
            return 0 ;;
    esac
    # A single path component (e.g. "/openfy") is too shallow to be a
    # dedicated Openfy directory.
    case "${path}" in
        /*/*) return 1 ;;
        *) return 0 ;;
    esac
}

# Data/config nested inside the application directory would be deleted with
# it, contradicting an explicit "keep" request. Refuse rather than risk loss.
nested=""
if [[ "${DATA_REAL}" == "${APP_REAL}" || "${DATA_REAL}" == "${APP_REAL}"/* ]] && [[ "${KEEP_DATA}" == "true" ]]; then
    nested="${nested} data (${DATA_DIR})"
fi
if [[ "${CONFIG_REAL}" == "${APP_REAL}" || "${CONFIG_REAL}" == "${APP_REAL}"/* ]] && [[ "${KEEP_CONFIG}" == "true" ]]; then
    nested="${nested} config (${CONFIG_DIR})"
fi
if [[ -n "${nested}" ]]; then
    echo "[openfy-uninstall] ERROR: refusing to remove ${APP_DIR} because it contains preserved${nested}." >&2
    echo "[openfy-uninstall] Move it elsewhere first, point the override at a non-nested path, or drop the --keep flag to condemn it explicitly." >&2
    exit 1
fi

# Validate every deletion target before anything is changed: a refusal must
# leave the installation untouched, not half-removed.
preflight() {
    # preflight <keep?> <path> <label>
    local keep="$1" target="$2" label="$3"
    if [[ "${keep}" == "true" ]]; then
        return 0
    fi
    if [[ -z "${target}" || "${target}" == "/" ]] || unsafe_target "${target}"; then
        echo "[openfy-uninstall] ERROR: refusing to remove the ${label} at '${target}': it looks like a system path. Nothing changed." >&2
        exit 1
    fi
}
preflight "false" "${APP_REAL}" "application files"
preflight "${KEEP_CONFIG}" "${CONFIG_REAL}" "configuration"
preflight "${KEEP_DATA}" "${DATA_REAL}" "user data"
preflight "${KEEP_BACKUPS}" "${BACKUP_REAL}" "update backups"

confirm() {
    local prompt="$1"
    if [[ "${ASSUME_YES}" == "true" ]]; then
        return 0
    fi
    local answer=""
    read -r -p "${prompt} [y/N] " answer || true
    [[ "${answer}" == "y" || "${answer}" == "Y" ]]
}

remove_tree() {
    # remove_tree <path> <label> : delete a directory tree, refusing paths
    # that look like system directories.
    local target="$1" label="$2"
    if [[ -z "${target}" || "${target}" == "/" ]]; then
        echo "[openfy-uninstall] ERROR: refusing to remove ${label}: invalid path '${target}'." >&2
        return 1
    fi
    if unsafe_target "${target}"; then
        echo "[openfy-uninstall] ERROR: refusing to remove ${label}: '${target}' looks like a system path." >&2
        return 1
    fi
    if [[ -e "${target}" || -L "${target}" ]]; then
        echo "[openfy-uninstall] Removing ${label} at ${target}."
        rm -rf -- "${target}" || { echo "[openfy-uninstall] ERROR: could not remove ${target}." >&2; return 1; }
    else
        echo "[openfy-uninstall] No ${label} at ${target}; nothing to remove."
    fi
}

remove_tree_or_keep() {
    # remove_tree_or_keep <keep?> <path> <resolved> <label>
    local keep="$1" path="$2" resolved="$3" label="$4"
    if [[ "${keep}" == "true" ]]; then
        echo "[openfy-uninstall] Preserved ${label} at ${path}."
        return 0
    fi
    remove_tree "${resolved}" "${label}"
    # A symlinked location would survive its target and dangle afterwards.
    if [[ "${path}" != "${resolved}" && -L "${path}" ]]; then
        rm -f -- "${path}" || true
    fi
}

passwd_field() {
    # passwd_field <user> <field-index> : read one field of a passwd entry
    # (6 = home dir, 5 = GECOS comment). Falls back to /etc/passwd.
    local user="$1" index="$2" entry=""
    if command -v getent >/dev/null 2>&1; then
        entry="$(getent passwd "${user}" 2>/dev/null || true)"
    fi
    if [[ -z "${entry}" && -r /etc/passwd ]]; then
        entry="$(grep -m1 "^${user}:" /etc/passwd 2>/dev/null || true)"
    fi
    [[ -n "${entry}" ]] || return 0
    printf '%s' "${entry}" | cut -d: -f"${index}"
}

resolved_hint() {
    # resolved_hint <configured> <resolved> : " (-> /real/path)" when the
    # configured path is a symlink and something else gets deleted.
    if [[ "$1" == "$2" ]]; then
        return 0
    fi
    printf ' (-> %s)' "$2"
}

echo "[openfy-uninstall] Removing the Openfy application at ${APP_DIR}."
if [[ "${KEEP_DATA}" != "true" ]]; then
    echo "[openfy-uninstall] WARNING: all user data in ${DATA_DIR}$(resolved_hint "${DATA_DIR}" "${DATA_REAL}") WILL BE PERMANENTLY DELETED (music, database, artwork, avatars)." >&2
fi
if [[ "${KEEP_CONFIG}" != "true" ]]; then
    echo "[openfy-uninstall] WARNING: the configuration in ${CONFIG_DIR}$(resolved_hint "${CONFIG_DIR}" "${CONFIG_REAL}") WILL BE PERMANENTLY DELETED (incl. the admin credential)." >&2
fi
if [[ "${KEEP_BACKUPS}" != "true" ]]; then
    echo "[openfy-uninstall] WARNING: the update backups in ${BACKUP_DIR}$(resolved_hint "${BACKUP_DIR}" "${BACKUP_REAL}") WILL BE PERMANENTLY DELETED (they contain copies of the config and database)." >&2
fi
confirm "Proceed with uninstall?" || { echo "[openfy-uninstall] Aborted; nothing changed."; exit 0; }
if [[ "${KEEP_DATA}" != "true" || "${KEEP_CONFIG}" != "true" || "${KEEP_BACKUPS}" != "true" ]]; then
    confirm "CONFIRM AGAIN: permanently delete ALL Openfy data (music, database, admin credential)?" \
        || { echo "[openfy-uninstall] Aborted; nothing changed."; exit 0; }
fi

echo "[openfy-uninstall] Stopping and disabling '${SERVICE_NAME}'."
systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
rm -rf -- "${SYSTEMD_DIR}/${SERVICE_NAME}.service.d"
systemctl daemon-reload 2>/dev/null || true

remove_tree_or_keep "false" "${APP_DIR}" "${APP_REAL}" "application files"
remove_tree_or_keep "${KEEP_CONFIG}" "${CONFIG_DIR}" "${CONFIG_REAL}" "configuration"
remove_tree_or_keep "${KEEP_DATA}" "${DATA_DIR}" "${DATA_REAL}" "user data"
remove_tree_or_keep "${KEEP_BACKUPS}" "${BACKUP_DIR}" "${BACKUP_REAL}" "update backups"

# The CLI wrapper installed on PATH points at the removed application.
# The installer writes the path shell-escaped, so both forms are matched.
if [[ -f "${BIN_DIR}/openfy" ]]; then
    app_dir_escaped="$(printf '%q' "${APP_DIR}")"
    if grep -q "OPENFY_INSTALL_DIR" "${BIN_DIR}/openfy" 2>/dev/null \
        && { grep -qF -- "${APP_DIR}" "${BIN_DIR}/openfy" 2>/dev/null \
            || grep -qF -- "${app_dir_escaped}" "${BIN_DIR}/openfy" 2>/dev/null; }; then
        echo "[openfy-uninstall] Removing the Openfy command wrapper at ${BIN_DIR}/openfy."
        rm -f -- "${BIN_DIR}/openfy" || true
    else
        echo "[openfy-uninstall] WARNING: ${BIN_DIR}/openfy was not created by Openfy; left in place." >&2
    fi
fi

# The system account is Openfy-specific: it owns the data directory and the
# cached Spotify session. Only remove it when it really is the Openfy account.
if [[ "${KEEP_SERVICE_USER}" == "true" ]]; then
    echo "[openfy-uninstall] Preserved service account '${SERVICE_USER}'."
elif id "${SERVICE_USER}" >/dev/null 2>&1; then
    user_home="$(passwd_field "${SERVICE_USER}" 6)"
    user_comment="$(passwd_field "${SERVICE_USER}" 5)"
    if [[ "${user_home}" != "${DATA_REAL}" && "${user_comment}" != *"Openfy"* ]]; then
        echo "[openfy-uninstall] WARNING: service account '${SERVICE_USER}' does not look like an Openfy account (home '${user_home}'); left in place." >&2
    else
        echo "[openfy-uninstall] Removing service account '${SERVICE_USER}'."
        if command -v pkill >/dev/null 2>&1; then
            pkill -u "${SERVICE_USER}" 2>/dev/null || true
        fi
        userdel "${SERVICE_USER}" 2>/dev/null \
            || echo "[openfy-uninstall] WARNING: could not remove service account '${SERVICE_USER}'; remove it manually with 'userdel ${SERVICE_USER}'." >&2
        groupdel "${SERVICE_USER}" 2>/dev/null || true
    fi
fi

echo "[openfy-uninstall] Uninstall complete."
echo "[openfy-uninstall] Traces this script cannot remove:"
echo "[openfy-uninstall]   - systemd journal entries: 'journalctl --unit=${SERVICE_NAME}' (systemd cannot vacuum a single unit; 'journalctl --vacuum-time=1s' purges the whole journal)."
echo "[openfy-uninstall]   - a plain-container Docker deployment: run 'bash install.sh --action uninstall --method docker' ('sudo openfy uninstall' covers native and Compose deployments)."
echo "[openfy-uninstall]   - browser localStorage (openfy_auth) on clients that used Openfy: clear it in the browser."
