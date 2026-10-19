#!/bin/bash
# Openfy one-line installer (bootstrap).
#
# Install Openfy on a fresh supported Linux server without cloning the
# repository or manually extracting release archives:
#
#   Latest stable release:
#     curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh
#
#   Exact version (installs EXACTLY this version, never silently "latest"):
#     curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh v1.4.2
#
#   Already downloaded (same behaviour, run as root for native installs):
#     sudo bash install.sh v1.4.2
#
# What this script does:
#   1. Detects OS / distribution / CPU architecture / privileges / package
#      manager and checks requirements BEFORE changing anything.
#   2. Resolves the requested version (latest STABLE, or exactly the version
#      given) against the official Openfy GitHub releases.
#   3. Downloads the release archive + SHA256SUMS for this machine's
#      architecture, verifies the checksum, and verifies the bundle's
#      VERSION.json matches the requested version and architecture.
#   4. Delegates the actual installation to the VERIFIED bundle's own
#      installer (scripts/linux/install.sh inside the archive) for fresh
#      installs / repairs, or to its update.sh (--archive) for upgrades, so
#      backups and rollback apply. Nothing from the network is executed
#      before successful verification.
#
# Version / prerelease policy:
#   - No version argument  -> latest STABLE release (GitHub /releases/latest,
#    which by definition excludes prereleases and drafts). If the API ever
#    returned a prerelease-looking tag, installation is refused.
#   - Explicit version      -> installs EXACTLY that version. Stable versions
#    install directly; prerelease versions (e.g. 1.5.0-rc.1) require
#    --include-prerelease (or an interactive confirmation). Draft releases
#    are NEVER installed.
#   - A requested version that is missing, invalid, unpublished, a draft, or
#    lacks the required assets is a fatal error (non-zero exit). The
#    installer never falls back to another version.
#   - Accepted input: 1.4.2, v1.4.2, 1.5.0-rc.1, v1.5.0-rc.1 (tag convention:
#    vMAJOR.MINOR.PATCH with optional -rc.N / -beta.N / -alpha.N suffix).
#
# Non-interactive usage (automation):
#   sudo bash install.sh --yes
#   sudo bash install.sh --yes --version 1.4.2 --method native
#   sudo bash install.sh --yes --method docker --version 1.4.2
# See --help for all options.
#
# Test hooks (not for normal use): OPENFY_API_BASE overrides the GitHub API
# base URL and OPENFY_DOWNLOAD_BASE overrides the release download base URL,
# so version resolution is testable without live GitHub releases.
#
# Structure note: this bootstrap is intentionally self-contained (a fresh
# machine has nothing else to fetch helpers from). Heavy lifting lives in the
# verified release bundle (install.sh / update.sh / uninstall.sh). All
# functions are defined before use and the script does nothing on `source`,
# so tests can `source` it and exercise functions in isolation.

set -euo pipefail

OPENFY_REPO="NethminaYasas/Openfy"
OPENFY_GHCR_IMAGE="ghcr.io/nethminayasas/openfy"
OPENFY_API_BASE="${OPENFY_API_BASE:-https://api.github.com}"
OPENFY_DOWNLOAD_BASE="${OPENFY_DOWNLOAD_BASE:-https://github.com/NethminaYasas/Openfy/releases/download}"
if [[ -z "${OPENFY_PORT+x}" ]]; then
    OPENFY_PORT="8000"
    PORT_EXPLICIT="false"
else
    PORT_EXPLICIT="true"
fi

APP_DIR="${OPENFY_INSTALL_DIR:-/opt/openfy}"
DATA_DIR="${OPENFY_DATA_DIR_OVERRIDE:-/var/lib/openfy}"
CONFIG_DIR="${OPENFY_CONFIG_DIR:-/etc/openfy}"
ENV_FILE="${CONFIG_DIR}/openfy.env"

# Tag convention shared with scripts/release/common.sh:
# vMAJOR.MINOR.PATCH with optional -rc.N / -beta.N / -alpha.N suffix.
OPENFY_TAG_REGEX='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((rc|beta|alpha)\.[0-9]+))?$'

WORK_DIR=""
REQUESTED_VERSION_RAW=""
REQUESTED_VERSION=""
REQUESTED_TAG=""
INCLUDE_PRERELEASE="false"
WANT_LATEST="false"
METHOD=""
ACTION="auto"
ASSUME_YES="false"
NO_START="false"
ALLOW_UNSUPPORTED_OS="false"
FORCE="false"
ARCH_OVERRIDE=""
ADMIN_USER="${OPENFY_ADMIN_USER:-admin}"
NO_GENERATE_CREDENTIAL="false"
ROTATE_CREDENTIAL="false"
NO_INSTALL_DEPS="false"
PURGE="false"
KEEP_DATA="false"
KEEP_CONFIG="false"
KEEP_BACKUPS="false"
KEEP_SERVICE_USER="false"
DRY_RUN="false"

# ------------------------------------------------------------------ UI / logging
# Color-aware, pipe-safe output helpers. Colors are enabled only when stdout
# is a TTY, NO_COLOR is unset, and TERM is not "dumb" - so piped output,
# logs, and tests always see the plain "[openfy] ..." text unchanged.
# Data-output functions (normalize_version_input, detect_arch, ask_choice's
# stdout answer, ...) never emit color codes.

_ui_has_color="false"
_ui_reset=""; _ui_bold=""; _ui_dim=""; _ui_red=""; _ui_green=""
_ui_yellow=""; _ui_blue=""; _ui_cyan=""; _ui_magenta=""

_ui_init() {
    _ui_has_color="false"
    _ui_reset=""; _ui_bold=""; _ui_dim=""; _ui_red=""; _ui_green=""
    _ui_yellow=""; _ui_blue=""; _ui_cyan=""; _ui_magenta=""
    if [[ -n "${NO_COLOR:-}" ]]; then return 0; fi
    if [[ "${TERM:-}" == "dumb" ]]; then return 0; fi
    if [[ -t 1 ]] && [[ -t 2 ]]; then
        _ui_reset=$'\e[0m'; _ui_bold=$'\e[1m'; _ui_dim=$'\e[2m'
        _ui_red=$'\e[31m'; _ui_green=$'\e[32m'; _ui_yellow=$'\e[33m'
        _ui_blue=$'\e[34m'; _ui_cyan=$'\e[36m'; _ui_magenta=$'\e[35m'
        _ui_has_color="true"
    fi
}
_ui_init

log() { echo "[openfy] $*"; }
log_ok() {
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s[openfy]%s %sOK%s %s\n' "${_ui_blue}" "${_ui_reset}" "${_ui_green}" "${_ui_reset}" "$*"
    else
        echo "[openfy] $*"
    fi
}
step() {
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '\n%s%s=== %s ===%s\n' "${_ui_bold}" "${_ui_cyan}" "$*" "${_ui_reset}"
    else
        echo ""; echo "==> $*"
    fi
}
warn() {
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s[openfy] WARNING:%s %s\n' "${_ui_yellow}" "${_ui_reset}" "$*" >&2
    else
        echo "[openfy] WARNING: $*" >&2
    fi
}
die() {
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s[openfy] ERROR:%s %s\n' "${_ui_red}" "${_ui_reset}" "$*" >&2
    else
        echo "[openfy] ERROR: $*" >&2
    fi
    exit 1
}

_ui_hr() {
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s\n' "${_ui_dim}" "----------------------------------------" "${_ui_reset}" >&2
    else
        echo "----------------------------------------" >&2
    fi
}

_ui_section() {
    # Dim group label for summary output (TTY only; plain text otherwise).
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s\n' "${_ui_dim}" "$*" "${_ui_reset}"
    else
        printf '%s\n' "$*"
    fi
}

_ui_headline() {
    # Bold green success headline (TTY only; plain text otherwise).
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s%s\n' "${_ui_bold}" "${_ui_green}" "$*" "${_ui_reset}"
    else
        printf '%s\n' "$*"
    fi
}

_ui_banner() {
    # Compact banner for interactive terminals only; never on pipes/tests.
    if [[ "${_ui_has_color}" != "true" ]]; then return 0; fi
    {
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '  /$$$$$$                                 /$$$$$$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" ' /$$__  $$                               /$$__  $$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '| $$  \ $$  /$$$$$$   /$$$$$$  /$$$$$$$ | $$  \__//$$   /$$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '| $$  | $$ /$$__  $$ /$$__  $$| $$__  $$| $$$$   | $$  | $$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '| $$  | $$| $$  \ $$| $$$$$$$$| $$  \ $$| $$_/   | $$  | $$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '| $$  | $$| $$  | $$| $$_____/| $$  | $$| $$     | $$  | $$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '|  $$$$$$/| $$$$$$$/|  $$$$$$$| $$  | $$| $$     |  $$$$$$$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" ' \______/ | $$____/  \_______/|__/  |__/|__/      \____  $$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '          | $$                                    /$$  | $$' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '          | $$                                   |  $$$$$$/' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_bold}${_ui_cyan}" '          |__/                                    \______/' "${_ui_reset}"
        printf '%s%s%s\n' "${_ui_dim}" '                  self-hosted music server' "${_ui_reset}"
    } >&2
}

cleanup() {
    local status=$?
    if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
        rm -rf "${WORK_DIR}"
    fi
    return "${status}"
}
trap cleanup EXIT
trap 'echo "[openfy] ERROR: interrupted." >&2; exit 130' INT TERM

usage() {
    sed -n '2,/^# Structure note/p' "${BASH_SOURCE[0]}"
    cat <<'EOF'

Usage:
  curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh [VERSION] [options]
  sudo bash install.sh [VERSION] [options]

Options:
  --version X             install exactly version X (same as positional VERSION)
  --latest                install the latest stable release (default)
  -m, --method M          native | docker (default: ask, or native with --yes)
  --action A              install | upgrade | repair | reinstall | uninstall
                          (default: auto-detect, or ask when interactive)
                          uninstall removes the application AND all data,
                          config (admin credential) and backups; use the
                          --keep-* options to preserve parts of it
  -y, --yes               non-interactive: accept defaults, assume yes
  --no-start              install but do not start the service/container
  --allow-unsupported-os  proceed on untested Linux distributions
  --force                 reinstall same-version files without prompting
  --arch ARCH             override detection: linux-amd64 | linux-arm64
  --admin-user NAME       admin username for fresh installs (default: admin)
  --port PORT             service port for native installs and Docker host
                          mapping (default: 8000)
  --no-generate-credential
                          do not auto-generate the admin credential on a fresh
                          install (you must set OPENFY_ADMIN_HASH manually)
  --rotate-credential     generate a NEW admin credential for an existing
                          install (prints once; explicit opt-in)
  --no-install-deps       do not install system packages automatically
  --include-prerelease    allow installing an explicitly requested prerelease
                          version (stable versions never need this; drafts are
                          always refused)
  --keep-data             with --action uninstall: keep the data directory
  --keep-config           with --action uninstall: keep the configuration
                          (admin credential)
  --keep-backups          with --action uninstall: keep the pre-update backups
  --keep-service-user     with --action uninstall: keep the 'openfy' account
  --dry-run               print the plan and exit without changing anything
  -h, --help              show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh
  curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh v1.4.2
  sudo bash install.sh --yes --version 1.4.2
  sudo bash install.sh --yes --method docker --version 1.4.2
EOF
}

# ------------------------------------------------------------------ args

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help) usage; exit 0 ;;
            --version)
                [[ $# -ge 2 ]] || die "--version requires a value (e.g. --version 1.4.2)."
                [[ -z "${REQUESTED_VERSION_RAW}" ]] || die "version given twice ('${REQUESTED_VERSION_RAW}' and '$2')."
                REQUESTED_VERSION_RAW="$2"; shift 2 ;;
            --latest) WANT_LATEST="true"; shift ;;
            -m|--method)
                [[ $# -ge 2 ]] || die "--method requires a value (native|docker)."
                METHOD="$2"; shift 2 ;;
            --action)
                [[ $# -ge 2 ]] || die "--action requires a value."
                ACTION="$2"; shift 2 ;;
            -y|--yes) ASSUME_YES="true"; shift ;;
            --no-start) NO_START="true"; shift ;;
            --allow-unsupported-os) ALLOW_UNSUPPORTED_OS="true"; shift ;;
            --force) FORCE="true"; shift ;;
            --arch)
                [[ $# -ge 2 ]] || die "--arch requires a value (linux-amd64|linux-arm64)."
                ARCH_OVERRIDE="$2"; shift 2 ;;
            --admin-user)
                [[ $# -ge 2 ]] || die "--admin-user requires a value."
                ADMIN_USER="$2"; shift 2 ;;
            --port)
                [[ $# -ge 2 ]] || die "--port requires a value (e.g. --port 8000)."
                OPENFY_PORT="$2"; PORT_EXPLICIT="true"; shift 2 ;;
            --no-generate-credential) NO_GENERATE_CREDENTIAL="true"; shift ;;
            --rotate-credential) ROTATE_CREDENTIAL="true"; shift ;;
            --no-install-deps) NO_INSTALL_DEPS="true"; shift ;;
            --include-prerelease) INCLUDE_PRERELEASE="true"; shift ;;
            --purge) PURGE="true"; shift ;;
            --keep-data) KEEP_DATA="true"; shift ;;
            --keep-config) KEEP_CONFIG="true"; shift ;;
            --keep-backups) KEEP_BACKUPS="true"; shift ;;
            --keep-service-user) KEEP_SERVICE_USER="true"; shift ;;
            --dry-run) DRY_RUN="true"; shift ;;
            --) shift; break ;;
            -*) die "unknown option '$1'. See --help." ;;
            *)
                [[ -z "${REQUESTED_VERSION_RAW}" ]] || die "unexpected extra argument '$1' (version already '${REQUESTED_VERSION_RAW}')."
                REQUESTED_VERSION_RAW="$1"; shift ;;
        esac
    done
    case "${METHOD}" in ""|native|docker) ;; *) die "--method must be native or docker, got '${METHOD}'." ;; esac
    case "${ACTION}" in auto|install|upgrade|repair|reinstall|uninstall) ;; *) die "--action must be install|upgrade|repair|reinstall|uninstall, got '${ACTION}'." ;; esac
    case "${ARCH_OVERRIDE}" in ""|linux-amd64|linux-arm64) ;; *) die "--arch must be linux-amd64 or linux-arm64, got '${ARCH_OVERRIDE}'." ;; esac
    if [[ "${PURGE}" == "true" ]]; then
        echo "[openfy] NOTE: --purge is obsolete - an uninstall removes data and config by default." >&2
        PURGE="false"
    fi
    if [[ -n "${ADMIN_USER}" ]]; then
        [[ "${ADMIN_USER}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "invalid --admin-user '${ADMIN_USER}' (letters, digits, . _ -; max 64 chars)."
    else
        die "--admin-user must not be empty."
    fi
    valid_port "${OPENFY_PORT}" \
        || die "invalid --port '${OPENFY_PORT}' (must be 1-65535, no leading zeros)."
    if [[ -n "${REQUESTED_VERSION_RAW}" && "${WANT_LATEST}" == "true" ]]; then
        die "cannot combine --latest with an explicit version ('${REQUESTED_VERSION_RAW}')."
    fi
}

# valid_port <value> : decimal 1-65535 with no leading zeros (avoids
# bash octal interpretation of values like 08080 in arithmetic checks).
valid_port() {
    [[ "${1:-}" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

# ------------------------------------------------- version handling

# normalize_version_input <raw>
# Prints "<version> <tag>" (e.g. "1.4.2 v1.4.2"). Fails on invalid input.
normalize_version_input() {
    local raw="${1:-}"
    local version="${raw#v}"
    local tag="v${version}"
    if [[ ! "${tag}" =~ ${OPENFY_TAG_REGEX} ]]; then
        echo "ERROR: invalid version '${raw}'. Expected e.g. 1.4.2 (or v1.4.2) for stable, or 1.5.0-rc.1 for a prerelease." >&2
        return 1
    fi
    printf '%s %s\n' "${version}" "${tag}"
}

# version_is_prerelease <version>  (true if it carries -rc.N/-beta.N/-alpha.N)
version_is_prerelease() {
    [[ "$1" == *-* ]]
}

# valid_credential <value> : true if it matches the application's admin
# credential format (server/app/settings.py ADMIN_TOKEN_PATTERN).
valid_credential() {
    [[ "$1" =~ ^of1_[A-Za-z0-9_-]{60}$ ]]
}

# ------------------------------------------------- http helpers

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# http_get <url> : prints response body. Retries, timeouts, clear errors.
http_get() {
    local url="$1"
    if have_cmd curl; then
        curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 \
            -H "User-Agent: Openfy-Installer" -H "Accept: application/vnd.github+json" \
            "${url}" \
            || die "download failed: ${url} (check network access to github.com / api.github.com, proxy settings, and DNS; rerun to retry)."
    elif have_cmd python3; then
        python3 - "${url}" <<'EOF' \
            || die "download failed: ${url} (check network access, proxy settings, and DNS; rerun to retry)."
import sys, urllib.request
url = sys.argv[1]
req = urllib.request.Request(url, headers={"User-Agent": "Openfy-Installer",
                                            "Accept": "application/vnd.github+json"})
with urllib.request.urlopen(req, timeout=120) as r:
    sys.stdout.write(r.read().decode("utf-8", "replace"))
EOF
    else
        die "need curl or python3 to contact GitHub (install one first)."
    fi
}

# http_download <url> <dest> : downloads a binary file with retries/timeouts.
http_download() {
    local url="$1" dest="$2"
    if have_cmd curl; then
        curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 \
            -H "User-Agent: Openfy-Installer" \
            -o "${dest}" "${url}" \
            || { rm -f "${dest}"; die "download failed: ${url} (interrupted or unreachable; partial file removed — rerun to retry)."; }
    elif have_cmd python3; then
        rm -f "${dest}"
        python3 - "${url}" "${dest}" <<'EOF' \
            || { rm -f "$2"; die "download failed: $1 (interrupted or unreachable; partial file removed — rerun to retry)."; }
import sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "Openfy-Installer"})
with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
    while True:
        chunk = r.read(1024 * 1024)
        if not chunk:
            break
        f.write(chunk)
EOF
    else
        die "need curl or python3 to download release files."
    fi
    [[ -s "${dest}" ]] || { rm -f "${dest}"; die "download produced an empty file: ${url} (rerun to retry)."; }
}

# json_field <json> <field> : extract a top-level string/bool field.
# Prefers python3, falls back to sed for simple flat fields; the caller must
# still validate the value before trusting it.
json_field() {
    local json="$1" field="$2"
    if have_cmd python3; then
        python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get(sys.argv[1], ""); print(v if isinstance(v,(str,bool,int)) else "")' "${field}" <<<"${json}" 2>/dev/null || true
    else
        # Fallback for flat JSON: "field": "value" | true | false | 123
        sed -n "s/^[[:space:]]*\"${field}\"[[:space:]]*:[[:space:]]*\"\\{0,1\\}\\([^\",}]*\\)\"\\{0,1\\}.*/\\1/p" <<<"${json}" | head -n 1
    fi
}

# json_asset_names <json> : list release asset names, one per line.
json_asset_names() {
    local json="$1"
    if have_cmd python3; then
        python3 -c 'import json,sys; [print(a.get("name","")) for a in json.load(sys.stdin).get("assets",[])]' <<<"${json}" 2>/dev/null || true
    else
        grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"${json}" | sed 's/.*"[[:space:]]*:[[:space:]]*"//; s/"$//' || true
    fi
}

# ------------------------------------------------- release resolution

RESOLVED_TAG=""
RESOLVED_VERSION=""
RESOLVED_PRERELEASE=""

# resolve_latest_stable : sets RESOLVED_TAG / RESOLVED_VERSION from /releases/latest.
resolve_latest_stable() {
    local api="${OPENFY_API_BASE}/repos/${OPENFY_REPO}/releases/latest"
    log "Resolving latest stable release (${api})."
    local body tag version
    body="$(http_get "${api}")" || die "could not contact the GitHub API (${api}); check network access and rerun."
    tag="$(json_field "${body}" "tag_name")"
    [[ -n "${tag}" ]] || die "could not determine the latest release (empty tag_name from GitHub API)."
    if [[ ! "${tag}" =~ ${OPENFY_TAG_REGEX} ]]; then
        die "latest release tag '${tag}' is not a recognised Openfy version tag; refusing to guess."
    fi
    version="${tag#v}"
    if version_is_prerelease "${version}"; then
        die "latest release '${tag}' is a prerelease; refusing (pass an explicit --version with --include-prerelease, or wait for a stable release)."
    fi
    RESOLVED_TAG="${tag}"
    RESOLVED_VERSION="${version}"
    RESOLVED_PRERELEASE="false"
    log "Latest stable release: ${RESOLVED_TAG}."
}

# fetch_release_metadata <tag> : validates the release is published (not a
# draft), reports prerelease status, and requires the needed assets.
# Sets RESOLVED_* globals. Fails without falling back to another version.
fetch_release_metadata() {
    local tag="$1"
    local api="${OPENFY_API_BASE}/repos/${OPENFY_REPO}/releases/tags/${tag}"
    log "Checking release ${tag} (${api})."
    local body
    body="$(http_get "${api}")" || die "release ${tag} not found (HTTP error above). Check published versions at https://github.com/${OPENFY_REPO}/releases."
    local returned draft prerelease
    returned="$(json_field "${body}" "tag_name")"
    [[ "${returned}" == "${tag}" ]] || die "release lookup for ${tag} returned unexpected tag '${returned:-<empty>}'; refusing to install an unverified release."
    draft="$(json_field "${body}" "draft")"
    if [[ "${draft}" == "True" || "${draft}" == "true" ]]; then
        die "release ${tag} is a DRAFT and can never be installed. Publish it first, or choose a published release."
    fi
    prerelease="$(json_field "${body}" "prerelease")"
    if [[ "${prerelease}" == "True" || "${prerelease}" == "true" ]]; then
        RESOLVED_PRERELEASE="true"
    else
        RESOLVED_PRERELEASE="false"
    fi
    local version="${tag#v}"
    if [[ "${METHOD}" != "docker" ]]; then
        local arch
        arch="$(detect_arch)"
        local need="openfy-v${version}-${arch}.tar.gz"
        local names
        names="$(json_asset_names "${body}")"
        if ! grep -qxF "${need}" <<<"${names}"; then
            die "release ${tag} has no asset '${need}' for your architecture (${arch}). Available assets: $(tr '\n' ' ' <<<"${names}"). The release cannot be installed on this machine."
        fi
        if ! grep -qxF "SHA256SUMS" <<<"${names}"; then
            die "release ${tag} has no SHA256SUMS asset; integrity cannot be verified. Refusing to install."
        fi
    fi
    RESOLVED_TAG="${tag}"
    RESOLVED_VERSION="${version}"
    log "Release ${tag} is published (prerelease: ${RESOLVED_PRERELEASE}) with required assets."
}

# ------------------------------------------------- environment detection

detect_os() {
    [[ "$(uname -s)" == "Linux" ]] || die "unsupported operating system '$(uname -s)'. Openfy native installs require Linux (use Docker on other systems)."
    local id="unknown" version="unknown"
    # OPENFY_OS_RELEASE is a test hook (points at a fake os-release file).
    local os_release="${OPENFY_OS_RELEASE:-/etc/os-release}"
    if [[ -f "${os_release}" ]]; then
        # shellcheck disable=SC1091
        . "${os_release}"
        id="${ID:-unknown}"; version="${VERSION_ID:-unknown}"
    fi
    log "Detected OS: ${id} ${version} ($(uname -m))."
    case "${id}" in
        ubuntu|debian|linuxmint|pop|raspbian) log "Supported distribution." ;;
        *)
            if [[ "${ALLOW_UNSUPPORTED_OS}" == "true" ]]; then
                warn "unsupported distribution '${id}'; continuing due to --allow-unsupported-os."
            else
                die "unsupported distribution '${id}'. Tested on Ubuntu/Debian. Re-run with --allow-unsupported-os to proceed anyway."
            fi ;;
    esac
}

detect_arch() {
    if [[ -n "${ARCH_OVERRIDE}" ]]; then
        echo "${ARCH_OVERRIDE}"
        return
    fi
    case "$(uname -m)" in
        x86_64) echo "linux-amd64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) die "unsupported CPU architecture '$(uname -m)'. Openfy ships linux-amd64 and linux-arm64 builds." ;;
    esac
}

detect_pkg_manager() {
    if have_cmd apt-get; then echo "apt";
    elif have_cmd dnf; then echo "dnf";
    elif have_cmd yum; then echo "yum";
    elif have_cmd pacman; then echo "pacman";
    elif have_cmd zypper; then echo "zypper";
    else echo "none"; fi
}

require_root_native() {
    if [[ "$(id -u)" -ne 0 ]]; then
        die "native installation requires root. Rerun with: sudo bash install.sh ${REQUESTED_VERSION_RAW:-} (or use --method docker; see --help)."
    fi
}

check_requirements_native() {
    local missing=()
    have_cmd python3 || missing+=("python3 (>= 3.11)")
    have_cmd systemctl || missing+=("systemctl/systemd")
    have_cmd curl || missing+=("curl")
    have_cmd tar || missing+=("tar")
    if [[ "${#missing[@]}" -gt 0 && "${NO_INSTALL_DEPS}" == "true" ]]; then
        die "missing required tools: ${missing[*]} (and --no-install-deps was given, so they will not be installed automatically)."
    fi
    if have_cmd python3; then
        local ver
        ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "?")"
        log "python3 ${ver} found."
        python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null \
            || die "python3 ${ver} is too old; Openfy requires Python >= 3.11."
    fi
    if ! have_cmd ffmpeg; then
        warn "ffmpeg not found. Audio processing/downloads need it; it will be installed automatically unless --no-install-deps is given."
    fi
    if [[ ! -d /run/systemd/system ]] && ! systemctl --version >/dev/null 2>&1; then
        die "systemd does not appear to be present. Native installs require a systemd-based Linux distribution (or use --method docker)."
    fi
}

install_system_deps() {
    if [[ "${NO_INSTALL_DEPS}" == "true" ]]; then
        log "Skipping system package installation (--no-install-deps)."
        return
    fi
    local mgr
    mgr="$(detect_pkg_manager)"
    if [[ "${mgr}" == "none" ]]; then
        warn "no supported package manager found (apt/dnf/yum/pacman/zypper); install python3 (>=3.11), python3-venv, curl, ffmpeg, and sqlite3 manually."
        return
    fi
    local pkgs
    case "${mgr}" in
        apt) pkgs="python3 python3-venv python3-pip curl ffmpeg sqlite3" ;;
        dnf|yum) pkgs="python3 python3-pip curl ffmpeg sqlite3" ;;
        pacman) pkgs="python python-virtualenv python-pip curl ffmpeg sqlite" ;;
        zypper) pkgs="python3 python3-venv python3-pip curl ffmpeg sqlite3" ;;
    esac
    step "Installing system dependencies via ${mgr}: ${pkgs}"
    case "${mgr}" in
        apt) apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs} ;;
        dnf) dnf install -y ${pkgs/ ffmpeg/} && { dnf install -y ffmpeg || warn "ffmpeg unavailable (enable RPM Fusion)."; } ;;
        yum) yum install -y ${pkgs/ ffmpeg/} && { yum install -y ffmpeg || warn "ffmpeg unavailable (enable RPM Fusion/EPEL)."; } ;;
        pacman) pacman -S --needed --noconfirm ${pkgs} ;;
        zypper) zypper --non-interactive install ${pkgs} ;;
    esac || die "package installation via ${mgr} failed. Install dependencies manually and rerun (or use --no-install-deps to skip this step)."
    log "System dependencies installed."
}

# port_in_use <port> : true if something listens on <port> on any local
# address (ss sees all; python checks loopback connect + wildcard bind).
port_in_use() {
    local port="$1"
    if have_cmd ss; then
        ss -ltn 2>/dev/null | grep -q ":${port} " && return 0
    fi
    if have_cmd python3; then
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

check_port_conflict() {
    if port_in_use "${OPENFY_PORT}"; then
        local service_name="${OPENFY_SERVICE_NAME:-openfy}" unit_port
        unit_port="$(grep -oE -- '--port [0-9]+' "${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}/${service_name}.service" 2>/dev/null | awk '{print $2}' | head -n 1 || true)"
        if [[ "${unit_port}" == "${OPENFY_PORT}" ]] && have_cmd systemctl && systemctl is-active --quiet "${service_name}" 2>/dev/null; then
            log "Port ${OPENFY_PORT} is held by the running ${service_name} service (expected during upgrades)."
        else
            die "port ${OPENFY_PORT} is already in use by another process. Free the port or stop the other process first."
        fi
    else
        log "Port ${OPENFY_PORT} is free."
    fi
}

# ------------------------------------------------- download + verify

new_workdir() {
    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openfy-install.XXXXXX")"
    chmod 700 "${WORK_DIR}"
}

# download_release <version> <arch> <destdir> : fetches archive + SHA256SUMS.
download_release() {
    local version="$1" arch="$2" destdir="$3"
    local base="${OPENFY_DOWNLOAD_BASE}/v${version}"
    local archive="openfy-v${version}-${arch}.tar.gz"
    step "Downloading Openfy v${version} (${arch})"
    log "From: ${base}/${archive}"
    http_download "${base}/${archive}" "${destdir}/${archive}"
    log "Downloading SHA256SUMS for verification."
    http_download "${base}/SHA256SUMS" "${destdir}/SHA256SUMS"
    log_ok "Download complete."
}

# verify_download <destdir> <archive> : checksum MUST pass; no fallbacks.
verify_download() {
    local destdir="$1" archive="$2"
    step "Verifying integrity (SHA-256)"
    # SHA256SUMS lines use either "  <file>" (text) or " *<file>" (binary).
    # Match the complete filename so prefixed assets (e.g. *.tar.gz.sig)
    # are never picked up.
    local entry
    entry="$(awk -v f="${archive}" '{n=$2; sub(/^\*/,"",n); if (n==f) {print; exit}}' "${destdir}/SHA256SUMS")"
    if [[ -z "${entry}" ]]; then
        die "SHA256SUMS has no entry for '${archive}'. The release is incomplete; refusing to install."
    fi
    local hash_cmd=""
    if have_cmd sha256sum; then
        hash_cmd="sha256sum"
    elif have_cmd python3; then
        hash_cmd="python3-sha256"
    else
        die "cannot verify checksums (need sha256sum or python3)."
    fi
    if [[ "${hash_cmd}" == "sha256sum" ]]; then
        (cd "${destdir}" && printf '%s\n' "${entry}" | sha256sum -c -) \
            || die "CHECKSUM MISMATCH for '${archive}'. The download is corrupt or tampered with; nothing was installed. Delete partial files and rerun."
    else
        python3 - "${destdir}/SHA256SUMS" "${destdir}/${archive}" <<'EOF' \
            || die "CHECKSUM MISMATCH for the downloaded archive. The download is corrupt or tampered with; nothing was installed. Rerun to retry."
import sys, hashlib
sums_path, archive_path = sys.argv[1], sys.argv[2]
want = None
with open(sums_path) as f:
    for line in f:
        parts = line.strip().split()
        if len(parts) >= 2 and parts[1].lstrip("*") == archive_path.split("/")[-1]:
            want = parts[0]
            break
if not want:
    sys.exit("no checksum entry for archive")
h = hashlib.sha256()
with open(archive_path, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
if h.hexdigest().lower() != want.lower():
    sys.exit(f"mismatch: got {h.hexdigest()} want {want}")
print("checksum OK")
EOF
    fi
    log_ok "Checksum verified."
}

# extract_and_validate <destdir> <archive> <version> <arch> : extracts to a
# fresh temp dir, checks VERSION.json matches the requested version + arch,
# and requires the installer entry points. Prints the top directory.
extract_and_validate() {
    local destdir="$1" archive="$2" version="$3" arch="$4"
    local staged="${destdir}/staged"
    rm -rf "${staged}"
    mkdir -p "${staged}"
    tar -xzf "${destdir}/${archive}" -C "${staged}" \
        || die "could not extract '${archive}' (corrupt archive despite valid checksum? rerun)."
    local top
    top="$(find "${staged}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [[ -n "${top}" ]] || die "archive has unexpected layout (no top-level directory); refusing to install."
    local expected="openfy-v${version}-${arch}"
    [[ "$(basename "${top}")" == "${expected}" ]] \
        || die "archive top directory '$(basename "${top}")' != expected '${expected}'; refusing to install."
    [[ -f "${top}/VERSION.json" ]] || die "bundle is missing VERSION.json; refusing to install."
    local got_version got_arch
    if have_cmd python3; then
        got_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "${top}/VERSION.json")"
        got_arch="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("arch",""))' "${top}/VERSION.json")"
    else
        got_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${top}/VERSION.json" | head -n 1)"
        got_arch="$(sed -n 's/.*"arch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${top}/VERSION.json" | head -n 1)"
    fi
    [[ "${got_version}" == "${version}" ]] \
        || die "bundle version '${got_version:-<empty>}' != requested '${version}'. Refusing to install the wrong version."
    [[ "${got_arch}" == "${arch}" ]] \
        || die "bundle arch '${got_arch:-<empty>}' != host '${arch}'. Download the ${arch} archive instead."
    for entry in install.sh update.sh uninstall.sh openfy openfy.service app/main.py client/index.html requirements.txt generate_hash.py; do
        [[ -e "${top}/${entry}" ]] || die "bundle is missing required file '${entry}'; refusing to install an incomplete release."
    done
    bash -n "${top}/install.sh" || die "bundled installer failed syntax check; refusing to run it."
    bash -n "${top}/openfy" || die "bundled manager failed syntax check; refusing to run it."
    echo "[openfy] Bundle validated: version ${got_version}, arch ${got_arch}." >&2
    printf '%s\n' "${top}"
}

# ------------------------------------------------- existing installation

INSTALLED_VERSION=""

detect_existing_install() {
    INSTALLED_VERSION=""
    if [[ -f "${APP_DIR}/VERSION.json" ]]; then
        if have_cmd python3; then
            INSTALLED_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","unknown"))' "${APP_DIR}/VERSION.json" 2>/dev/null || echo unknown)"
        fi
        if [[ -z "${INSTALLED_VERSION}" || "${INSTALLED_VERSION}" == "unknown" ]]; then
            INSTALLED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${APP_DIR}/VERSION.json" 2>/dev/null | head -n 1 || true)"
        fi
        [[ -n "${INSTALLED_VERSION}" ]] || INSTALLED_VERSION="unknown"
    fi
}

# ------------------------------------------------- interactive wizard

is_interactive() { [[ -t 0 ]]; }

# ask_choice <prompt> <default> <opt1> <opt2> ... : numbered menu, prints choice.
# Menu goes to stderr; the chosen number goes to stdout (command-substitution safe).
ask_choice() {
    local prompt="$1" default="$2"
    shift 2
    local i opt ans
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '\n%s%s %s%s\n' "${_ui_bold}" "${_ui_cyan}" "${prompt}" "${_ui_reset}" >&2
    else
        echo "${prompt}" >&2
    fi
    i=1
    for opt in "$@"; do
        if [[ "${i}" == "${default}" ]]; then
            if [[ "${_ui_has_color}" == "true" ]]; then
                printf '  %s%s)%s %s %s(default)%s\n' "${_ui_green}" "${i}" "${_ui_reset}" "${opt}" "${_ui_dim}" "${_ui_reset}" >&2
            else
                echo "  ${i}) ${opt} (default)" >&2
            fi
        else
            if [[ "${_ui_has_color}" == "true" ]]; then
                printf '  %s%s)%s %s\n' "${_ui_dim}" "${i}" "${_ui_reset}" "${opt}" >&2
            else
                echo "  ${i}) ${opt}" >&2
            fi
        fi
        i=$((i + 1))
    done
    while true; do
        ans=""
        if [[ "${_ui_has_color}" == "true" ]]; then
            printf '%sEnter choice [%s]%s ' "${_ui_bold}" "${default}" "${_ui_reset}" >&2
            read -r ans || true
        else
            read -r -p "Enter choice [${default}]: " ans || true
        fi
        [[ -z "${ans}" ]] && ans="${default}"
        if [[ "${ans}" =~ ^[0-9]+$ ]] && [[ "${ans}" -ge 1 ]] && [[ "${ans}" -lt "$i" ]]; then
            printf '%s\n' "${ans}"
            return
        fi
        if [[ "${_ui_has_color}" == "true" ]]; then
            printf '%sInvalid choice. Enter a number between 1 and %s.%s\n' "${_ui_red}" "$((i - 1))" "${_ui_reset}" >&2
        else
            echo "Invalid choice. Enter a number between 1 and $((i - 1))." >&2
        fi
    done
}

# ask_value <prompt> <default> : free input with default, prints value.
ask_value() {
    local prompt="$1" default="$2" ans
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s %s[%s]%s: ' "${_ui_bold}" "${prompt}" "${_ui_reset}" "${_ui_dim}" "${default}" "${_ui_reset}" >&2
        read -r ans || true
    else
        read -r -p "${prompt} [${default}]: " ans || true
    fi
    [[ -z "${ans}" ]] && ans="${default}"
    printf '%s\n' "${ans}"
}

ask_yes_no() {
    local prompt="$1" default="$2" ans
    while true; do
        if [[ "${_ui_has_color}" == "true" ]]; then
            printf '%s%s%s ' "${_ui_bold}" "${prompt}" "${_ui_reset}" >&2
            read -r ans || true
        else
            read -r -p "${prompt} " ans || true
        fi
        [[ -z "${ans}" ]] && ans="${default}"
        case "${ans}" in
            y|Y|yes|YES) return 0 ;;
            n|N|no|NO) return 1 ;;
            *)
                if [[ "${_ui_has_color}" == "true" ]]; then
                    printf '%sPlease answer y or n.%s\n' "${_ui_yellow}" "${_ui_reset}" >&2
                else
                    echo "Please answer y or n." >&2
                fi
                ;;
        esac
    done
}

_ui_wizard_step() {
    # _ui_wizard_step <n> <total> <title> : dim "Step n/total" + bold title.
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '\n%s[Step %s/%s]%s %s%s%s\n' "${_ui_dim}" "$1" "$2" "${_ui_reset}" "${_ui_bold}" "$3" "${_ui_reset}" >&2
    else
        echo "" >&2
        echo "--- Step $1/$2: $3 ---" >&2
    fi
}

run_wizard() {
    _ui_banner
    step "Openfy installation wizard"
    # 1. Method.
    _ui_wizard_step 1 6 "Installation method"
    if [[ -z "${METHOD}" ]]; then
        local c
        c="$(ask_choice "How should Openfy be installed?" "1" \
            "Native Linux service (systemd, no Docker)" \
            "Docker container (published GHCR image)")"
        if [[ "${c}" == "1" ]]; then METHOD="native"; else METHOD="docker"; fi
    fi
    log_ok "Method: ${METHOD}."
    if [[ "${METHOD}" == "native" && "${DRY_RUN}" != "true" ]]; then
        require_root_native
    fi
    # 2. Version.
    _ui_wizard_step 2 6 "Version"
    if [[ -z "${REQUESTED_VERSION_RAW}" && "${WANT_LATEST}" != "true" ]]; then
        local c
        c="$(ask_choice "Which version should be installed?" "1" \
            "Latest stable release (recommended)" \
            "A specific version (e.g. 1.4.2)")"
        if [[ "${c}" == "2" ]]; then
            while true; do
                REQUESTED_VERSION_RAW="$(ask_value "Version to install" "")"
                [[ -n "${REQUESTED_VERSION_RAW}" ]] || { echo "Enter a version (e.g. 1.4.2) or Ctrl+C to abort." >&2; continue; }
                if normalize_version_input "${REQUESTED_VERSION_RAW}" >/dev/null; then
                    break
                fi
            done
        fi
    fi
    if [[ -n "${REQUESTED_VERSION_RAW}" ]]; then
        local out
        out="$(normalize_version_input "${REQUESTED_VERSION_RAW}")" || exit 1
        REQUESTED_VERSION="${out%% *}"
        REQUESTED_TAG="${out##* }"
        if version_is_prerelease "${REQUESTED_VERSION}" && [[ "${INCLUDE_PRERELEASE}" != "true" ]]; then
            warn "version ${REQUESTED_VERSION} is a PRERELEASE (not a stable release)."
            ask_yes_no "Install this prerelease anyway? [y/N]" "n" \
                || die "aborted (rerun with a stable version, or pass --include-prerelease)."
            INCLUDE_PRERELEASE="true"
        fi
    fi
    # 3. Existing installation.
    _ui_wizard_step 3 6 "Existing installation"
    detect_existing_install
    if [[ "${METHOD}" == "native" && -n "${INSTALLED_VERSION}" && "${ACTION}" == "auto" ]]; then
        echo "Existing installation found: version ${INSTALLED_VERSION} at ${APP_DIR}." >&2
        echo "Upgrade, repair and reinstall preserve the configuration (${ENV_FILE}) and the data (${DATA_DIR})." >&2
        echo "An uninstall removes both (--keep-data / --keep-config preserve them)." >&2
        local c
        c="$(ask_choice "What should be done?" "1" \
            "Upgrade / change version (backs up config + database, rolls back on failure)" \
            "Repair current installation (verify files, fix permissions, reinstall service)" \
            "Reinstall (explicit; replaces application files, keeps data + config)" \
            "Uninstall (removes data + config too; use --keep-data/--keep-config to preserve them)" \
            "Abort")"
        case "${c}" in
            1) ACTION="upgrade" ;;
            2) ACTION="repair" ;;
            3) ACTION="reinstall" ;;
            4) ACTION="uninstall" ;;
            *) die "aborted by user; nothing changed." ;;
        esac
    elif [[ -n "${INSTALLED_VERSION}" ]]; then
        log "Existing installation: version ${INSTALLED_VERSION} at ${APP_DIR}."
    else
        log "No existing installation found - fresh install."
    fi
    # 4. Admin account (fresh native installs only; upgrades never touch it).
    _ui_wizard_step 4 6 "Admin account"
    if [[ "${METHOD}" == "native" && -z "${INSTALLED_VERSION}" ]]; then
        ADMIN_USER="$(ask_value "Admin username" "${ADMIN_USER}")"
        [[ "${ADMIN_USER}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "invalid admin username '${ADMIN_USER}'."
        if [[ "${NO_GENERATE_CREDENTIAL}" != "true" ]]; then
            echo "The admin sign-in uses a generated credential (of1_...) stored as OPENFY_ADMIN_HASH." >&2
            if ask_yes_no "Generate the initial admin credential automatically? [Y/n]" "y"; then
                NO_GENERATE_CREDENTIAL="false"
            else
                NO_GENERATE_CREDENTIAL="true"
                echo "You must set OPENFY_ADMIN_HASH manually afterwards (see the summary at the end)." >&2
            fi
        fi
    fi
    # 5. Service port (native service port / Docker host mapping).
    _ui_wizard_step 5 6 "Service port"
    if [[ "${METHOD}" == "native" || "${METHOD}" == "docker" ]]; then
        local default_port="${OPENFY_PORT}"
        if [[ "${PORT_EXPLICIT}" != "true" ]]; then
            if [[ "${METHOD}" == "native" ]]; then
                local unit_file="${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}/openfy.service"
                local unit_port
                unit_port="$(grep -oE -- '--port [0-9]+' "${unit_file}" 2>/dev/null | awk '{print $2}' | head -n 1 || true)"
                valid_port "${unit_port}" && default_port="${unit_port}"
            else
                local cname="${OPENFY_CONTAINER_NAME:-openfy}"
                local dock_port
                dock_port="$(docker inspect -f '{{with index .HostConfig.PortBindings "8000/tcp"}}{{(index . 0).HostPort}}{{end}}' "${cname}" 2>/dev/null || true)"
                valid_port "${dock_port}" && default_port="${dock_port}"
            fi
        fi
        while true; do
            local entered
            entered="$(ask_value "Service port" "${default_port}")"
            if valid_port "${entered}"; then
                OPENFY_PORT="${entered}"
                [[ "${entered}" != "${default_port}" || "${PORT_EXPLICIT}" == "true" ]] && PORT_EXPLICIT="true"
                break
            fi
            echo "Invalid port '${entered}'. Enter 1-65535 (no leading zeros)." >&2
        done
    fi
    # 6. Dependencies.
    _ui_wizard_step 6 6 "System packages & confirmation"
    if [[ "${METHOD}" == "native" && "${NO_INSTALL_DEPS}" != "true" ]]; then
        if ask_yes_no "Install required system packages automatically (python3, ffmpeg, ...)? [Y/n]" "y"; then
            NO_INSTALL_DEPS="false"
        else
            NO_INSTALL_DEPS="true"
        fi
    fi
    # 7. Summary + confirm.
    _ui_hr
    echo "Plan: method=${METHOD} action=${ACTION:-install} version=${REQUESTED_VERSION_RAW:-latest-stable} arch=$(detect_arch) port=${OPENFY_PORT}" >&2
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s\n' "${_ui_dim}" "Review the plan above. Nothing has changed yet." "${_ui_reset}" >&2
    fi
    if [[ "${DRY_RUN}" == "true" ]]; then
        return
    fi
    ask_yes_no "Proceed with installation? [Y/n]" "y" || die "aborted by user; nothing changed."
}

# ------------------------------------------------- actions

generate_admin_credential() {
    # Prints a fresh of1_... credential (same format as scripts/generate_hash.py).
    python3 -c 'import secrets; print("of1_" + secrets.token_urlsafe(45))'
}

run_native_delegate() {
    local staged_dir="$1" mode="$2" version="$3" archive_path="$4"
    local args=()
    if [[ "${mode}" == "upgrade" ]]; then
        step "Upgrading via verified bundle (backups + rollback handled by update.sh)"
        log "Installed: ${INSTALLED_VERSION} -> target: ${version}."
        if [[ "${DRY_RUN}" == "true" ]]; then
            log "DRY RUN: would execute: ${staged_dir}/update.sh --archive <verified ${version} archive>"
            return
        fi
        [[ "${NO_START}" != "true" ]] \
            || die "--no-start is not supported for native upgrades; update.sh always restarts the service to apply the new version."
        if [[ "${PORT_EXPLICIT}" == "true" ]]; then
            check_port_conflict
        fi
        bash "${staged_dir}/update.sh" --archive "${archive_path}" --arch "$(detect_arch)"
    else
        step "Installing application files (config + data preserved)"
        if [[ "${mode}" == "repair" ]]; then
            log "Repairing installation of version ${version}."
        fi
        args+=(--admin-user "${ADMIN_USER}")
        [[ "${PORT_EXPLICIT}" == "true" ]] && args+=(--port "${OPENFY_PORT}")
        [[ "${NO_START}" == "true" ]] && args+=(--no-start)
        [[ "${ALLOW_UNSUPPORTED_OS}" == "true" ]] && args+=(--allow-unsupported-os)
        [[ "${FORCE}" == "true" || "${mode}" == "reinstall" || "${mode}" == "repair" ]] && args+=(--force)
        [[ "${mode}" == "repair" ]] && args+=(--repair)
        [[ "${NO_GENERATE_CREDENTIAL}" == "true" ]] && args+=(--no-generate-credential)
        [[ "${NO_INSTALL_DEPS}" == "true" ]] && args+=(--no-install-deps)
        if [[ "${DRY_RUN}" == "true" ]]; then
            log "DRY RUN: would execute: ${staged_dir}/install.sh ${args[*]}"
            return
        fi
        if [[ "${PORT_EXPLICIT}" == "true" ]]; then
            OPENFY_CREDENTIAL_OUTPUT_FILE="${WORK_DIR}/admin-credential" OPENFY_ADMIN_USERNAME="${ADMIN_USER}" OPENFY_PORT="${OPENFY_PORT}" bash "${staged_dir}/install.sh" "${args[@]}"
        else
            OPENFY_CREDENTIAL_OUTPUT_FILE="${WORK_DIR}/admin-credential" OPENFY_ADMIN_USERNAME="${ADMIN_USER}" bash "${staged_dir}/install.sh" "${args[@]}"
        fi
    fi
}

run_rotate_credential_delegate() {
    detect_existing_install
    [[ -n "${INSTALLED_VERSION}" ]] || die "--rotate-credential needs an existing installation at ${APP_DIR}."
    [[ -f "${APP_DIR}/install.sh" ]] || die "no native installer at ${APP_DIR}/install.sh; repair the installation before rotating credentials."
    if [[ "${DRY_RUN}" == "true" ]]; then
        log "DRY RUN: would execute: ${APP_DIR}/install.sh --rotate-credential --admin-user ${ADMIN_USER}"
        return
    fi
    require_root_native
    [[ -n "${WORK_DIR}" ]] || new_workdir
    OPENFY_CREDENTIAL_OUTPUT_FILE="${WORK_DIR}/admin-credential" OPENFY_INSTALL_DIR="${APP_DIR}" OPENFY_DATA_DIR_OVERRIDE="${DATA_DIR}" OPENFY_CONFIG_DIR="${CONFIG_DIR}" \
        bash "${APP_DIR}/install.sh" --rotate-credential --admin-user "${ADMIN_USER}" || {
            if [[ -f "${WORK_DIR}/admin-credential" ]]; then
                log "Save the new credential below; service readiness could not be verified."
                log "Recover with: sudo systemctl restart ${OPENFY_SERVICE_NAME:-openfy} ; sudo journalctl -u ${OPENFY_SERVICE_NAME:-openfy} -n 100"
                print_deferred_credential
            fi
            die "credential rotation failed."
        }
}

run_uninstall_delegate() {
    if [[ ! -f "${APP_DIR}/uninstall.sh" && ! -f "${APP_DIR}/VERSION.json" ]]; then
        die "no Openfy installation found at ${APP_DIR}; nothing to uninstall."
    fi
    local args=()
    [[ "${ASSUME_YES}" == "true" ]] && args+=(--yes)
    [[ "${KEEP_DATA}" == "true" ]] && args+=(--keep-data)
    [[ "${KEEP_CONFIG}" == "true" ]] && args+=(--keep-config)
    [[ "${KEEP_BACKUPS}" == "true" ]] && args+=(--keep-backups)
    [[ "${KEEP_SERVICE_USER}" == "true" ]] && args+=(--keep-service-user)
    if [[ "${DRY_RUN}" == "true" ]]; then
        log "DRY RUN: would execute: ${APP_DIR}/uninstall.sh ${args[*]}"
        return
    fi
    bash "${APP_DIR}/uninstall.sh" "${args[@]}"
}

docker_health_ok() {
    local url="http://localhost:$1/health"
    if have_cmd curl; then
        curl -fsS --max-time 3 "${url}" >/dev/null 2>&1
    elif have_cmd python3; then
        python3 -c 'import sys,urllib.request; urllib.request.urlopen(sys.argv[1], timeout=3)' "${url}" >/dev/null 2>&1
    else
        return 1
    fi
}

run_docker_uninstall() {
    local cname="${OPENFY_CONTAINER_NAME:-openfy}"
    local docker_dir="${OPENFY_DOCKER_DIR:-/opt/openfy-docker}"
    if [[ "${DRY_RUN}" == "true" ]]; then
        log "DRY RUN: would stop/remove container '${cname}' and delete the data volume, ${docker_dir} (incl. .env) and the Openfy image."
        return
    fi
    have_cmd docker || die "docker not found; nothing to do."
    if [[ "${ASSUME_YES}" != "true" ]]; then
        [[ "${KEEP_DATA}" == "true" ]] || warn "the Openfy data volume(s) WILL BE PERMANENTLY DELETED (database, music, artwork)."
        [[ "${KEEP_CONFIG}" == "true" ]] || warn "${docker_dir} (incl. the admin credential) WILL BE PERMANENTLY DELETED."
        ask_yes_no "Proceed with the Docker uninstall? [y/N]" "n" || die "aborted; nothing changed."
        if [[ "${KEEP_DATA}" != "true" || "${KEEP_CONFIG}" != "true" ]]; then
            ask_yes_no "CONFIRM AGAIN: permanently delete ALL Openfy data (music, database, admin credential)? [y/N]" "n" \
                || die "aborted; nothing changed."
        fi
    fi
    # Remember the image and the volumes before the container disappears.
    local image=""
    local volumes=()
    if docker ps -a --format '{{.Names}}' | grep -qx "${cname}"; then
        image="$(docker inspect -f '{{.Config.Image}}' "${cname}" 2>/dev/null || true)"
        while read -r vol; do
            # Only the volume the installer created; a volume an operator
            # mounted on the container is not ours to delete.
            if [[ "${vol}" == "openfy_data" ]]; then volumes+=("${vol}"); fi
        done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "${cname}" 2>/dev/null || true)
        log "Stopping and removing container '${cname}'."
        docker stop "${cname}" >/dev/null 2>&1 || true
        docker rm "${cname}" >/dev/null 2>&1 || true
    else
        log "No container named '${cname}'; nothing to remove."
    fi
    # The installer creates the volume "openfy_data"; the volumes that were
    # attached to the container are removed with it. Volumes of unrelated
    # projects are never touched.
    while read -r vol; do
        if [[ "${vol}" == "openfy_data" ]]; then
            if [[ " ${volumes[*]:-} " != *" ${vol} "* ]]; then
                volumes+=("${vol}")
            fi
        fi
    done < <(docker volume ls --format '{{.Name}}' 2>/dev/null || true)
    if [[ "${KEEP_DATA}" == "true" ]]; then
        log "Preserved Docker volume(s): ${volumes[*]:-<none>}"
    else
        for vol in ${volumes[@]+"${volumes[@]}"}; do
            docker volume rm "${vol}" >/dev/null 2>&1 \
                || warn "volume ${vol} could not be removed (it may not exist or still be in use)."
        done
    fi
    if [[ "${KEEP_CONFIG}" == "true" ]]; then
        log "Preserved ${docker_dir} (it holds the admin credential)."
    elif [[ -d "${docker_dir}" ]]; then
        # Only the files the installer created are removed: the directory
        # itself may be a user-owned location that holds unrelated files.
        rm -f -- "${docker_dir}/.env" "${docker_dir}/${cname}-failed.log"
        log "Removed the admin credential from ${docker_dir}."
        rmdir -- "${docker_dir}" 2>/dev/null \
            || log "Left ${docker_dir} in place (it holds files that Openfy did not create)."
    fi
    # The image is re-pullable, but it is still an Openfy artefact on disk.
    if [[ -n "${image}" ]]; then
        docker rmi "${image}" >/dev/null 2>&1 || warn "image ${image} could not be removed (it may be in use by another container)."
    fi
    while read -r img; do
        if [[ -n "${img}" ]]; then
            docker rmi "${img}" >/dev/null 2>&1 || warn "image ${img} could not be removed (it may be in use by another container)."
        fi
    done < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -F "${OPENFY_GHCR_IMAGE}" || true)
}

run_docker_install() {
    local version="$1"
    step "Installing Openfy v${version} via Docker"
    local image="${OPENFY_GHCR_IMAGE}:${version}"
    if [[ "${DRY_RUN}" == "true" ]]; then
        log "DRY RUN: would pull ${image} and start a container (volume openfy_data, port ${OPENFY_PORT})."
        return
    fi
    have_cmd docker || die "docker not found. Install Docker first (https://docs.docker.com/engine/install/), then rerun with --method docker."
    if [[ "${NO_GENERATE_CREDENTIAL}" != "true" ]]; then
        have_cmd python3 || die "python3 is required to generate the admin credential (or rerun with --no-generate-credential and set OPENFY_ADMIN_HASH manually)."
    fi
    local docker_dir="${OPENFY_DOCKER_DIR:-/opt/openfy-docker}"
    if ! mkdir -p "${docker_dir}" 2>/dev/null || [[ ! -w "${docker_dir}" ]]; then
        die "cannot write ${docker_dir}. Rerun with sudo, or set OPENFY_DOCKER_DIR to a writable directory."
    fi
    log "Pulling ${image}."
    docker pull "${image}" || die "could not pull ${image} (check the version exists and the registry is reachable)."
    chmod 755 "${docker_dir}"
    local env_file="${docker_dir}/.env"
    local credential=""
    if [[ ! -f "${env_file}" ]]; then
        ( umask 077; : > "${env_file}" )
        if [[ "${NO_GENERATE_CREDENTIAL}" == "true" ]]; then
            cat > "${env_file}" <<EOF
OPENFY_ENV=prod
OPENFY_ADMIN_USERNAME=${ADMIN_USER}
# Generate with: python3 -c 'import secrets; print("of1_" + secrets.token_urlsafe(45))'
OPENFY_ADMIN_HASH=
OPENFY_ALLOWED_ORIGINS=http://localhost:${OPENFY_PORT}
EOF
        else
            credential="$(generate_admin_credential)"
            valid_credential "${credential}" || die "generated credential failed validation (internal error)."
            cat > "${env_file}" <<EOF
OPENFY_ENV=prod
OPENFY_ADMIN_USERNAME=${ADMIN_USER}
OPENFY_ADMIN_HASH=${credential}
OPENFY_ALLOWED_ORIGINS=http://localhost:${OPENFY_PORT}
EOF
        fi
        chmod 600 "${env_file}"
    else
        log "Existing Docker env ${env_file} preserved (credentials untouched)."
        log "If you have lost the admin credential, set a new OPENFY_ADMIN_HASH in ${env_file}"
        log "(generate one with: python3 -c 'import secrets; print(\"of1_\" + secrets.token_urlsafe(45))')"
        log "and rerun this installer to recreate the container with the new value."
    fi
    local cname="${OPENFY_CONTAINER_NAME:-openfy}"
    local backup_cname="${cname}-openfy-prev"
    local had_existing="false"
    local was_running="false"
    if docker ps -a --format '{{.Names}}' | grep -qx "${cname}"; then
        had_existing="true"
        if docker ps --format '{{.Names}}' | grep -qx "${cname}"; then
            was_running="true"
        fi
        if [[ "${PORT_EXPLICIT}" != "true" ]]; then
            local existing_port
            existing_port="$(docker inspect -f '{{with index .HostConfig.PortBindings "8000/tcp"}}{{(index . 0).HostPort}}{{end}}' "${cname}" 2>/dev/null || true)"
            if valid_port "${existing_port}"; then
                OPENFY_PORT="${existing_port}"
                log "Keeping existing host port ${OPENFY_PORT} (pass --port to change it)."
            fi
        fi
        log "Preserving existing container '${cname}' while replacing it with ${image}."
        if docker ps -a --format '{{.Names}}' | grep -qx "${backup_cname}"; then
            docker rm -f "${backup_cname}" >/dev/null 2>&1 || true
        fi
        docker stop "${cname}" >/dev/null 2>&1 || true
        docker rename "${cname}" "${backup_cname}" \
            || die "could not preserve existing container '${cname}' (rename failed); nothing changed."
    fi
    if ! docker run -d --name "${cname}" --restart unless-stopped \
        -p "${OPENFY_PORT}:8000" -v openfy_data:/data --env-file "${env_file}" \
        "${image}"; then
        if [[ "${had_existing}" == "true" ]]; then
            warn "replacement failed; restoring preserved container '${backup_cname}'."
            docker rm "${cname}" >/dev/null 2>&1 || true
            if docker rename "${backup_cname}" "${cname}" >/dev/null 2>&1; then
                if [[ "${was_running}" == "true" ]]; then
                    docker start "${cname}" >/dev/null 2>&1 || true
                fi
            else
                warn "could not restore original container '${backup_cname}'. Manual recovery: docker rename \"${backup_cname}\" \"${cname}\""
            fi
        fi
        die "failed to start the container (see 'docker logs ${cname}'). Original container restored where possible."
    fi
    if [[ "${NO_START}" == "true" ]]; then
        docker stop "${cname}" >/dev/null
        if [[ "${had_existing}" == "true" ]]; then
            docker rm "${backup_cname}" >/dev/null 2>&1 || true
        fi
        log "Container created but left stopped (--no-start)."
        if [[ -n "${credential}" ]]; then
            echo "  Admin user: ${ADMIN_USER}"
            echo "  Admin credential (generated NOW, shown ONCE — save it securely):"
            echo "    ${credential}"
        fi
        return
    fi
    local attempt=0
    log "Waiting for Openfy to become healthy (up to 60s)..."
    while [[ "${attempt}" -lt 30 ]]; do
        if docker_health_ok "${OPENFY_PORT}"; then
            log_ok "Openfy (Docker) is healthy at http://localhost:${OPENFY_PORT}/health."
            break
        fi
        attempt=$((attempt + 1))
        if (( attempt % 5 == 0 )); then
            log "Still waiting... (${attempt}/30 checks, http://localhost:${OPENFY_PORT}/health)"
        fi
        sleep 2
        if [[ "${attempt}" -eq 30 ]]; then
            if [[ "${had_existing}" == "true" ]]; then
                warn "replacement failed its health check; restoring preserved container '${backup_cname}'."
                docker stop "${cname}" >/dev/null 2>&1 || true
                docker rm "${cname}" >/dev/null 2>&1 || true
                if docker rename "${backup_cname}" "${cname}" >/dev/null 2>&1; then
                    if [[ "${was_running}" == "true" ]]; then
                        docker start "${cname}" >/dev/null 2>&1 || true
                    fi
                else
                    warn "could not restore original container '${backup_cname}'. Manual recovery: docker rename \"${backup_cname}\" \"${cname}\""
                fi
                die "container did not become healthy. Inspect with: docker logs ${cname}"
            else
                local fail_log="${docker_dir}/${cname}-failed.log"
                docker logs "${cname}" > "${fail_log}" 2>&1 || true
                docker stop "${cname}" >/dev/null 2>&1 || true
                docker rm "${cname}" >/dev/null 2>&1 || true
                die "container did not become healthy and was removed. Logs saved to ${fail_log}."
            fi
        fi
    done
    if [[ "${had_existing}" == "true" ]]; then
        docker rm "${backup_cname}" >/dev/null 2>&1 || true
    fi
    echo ""
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s\n' "${_ui_green}" "----------------------------------------" "${_ui_reset}"
    else
        echo "----------------------------------------"
    fi
    _ui_headline "Openfy v${version} is running (Docker image ${image})."
    echo ""
    _ui_section "  Where things live"
    echo "  URL:      http://<server-ip>:${OPENFY_PORT}"
    echo "  Env file: ${env_file}  (volume: openfy_data)"
    echo ""
    if [[ -n "${credential}" ]]; then
        echo "=================================================================="
        if [[ "${_ui_has_color}" == "true" ]]; then
            printf '%s%s%s%s\n' "${_ui_bold}" "${_ui_green}" "  ADMIN CREDENTIAL (generated now, shown ONCE - save it securely)" "${_ui_reset}"
        else
            echo "  ADMIN CREDENTIAL (generated now, shown ONCE - save it securely)"
        fi
        echo "  Admin user: ${ADMIN_USER}"
        echo "  Admin credential: ${credential}"
        echo "  Sign in with this credential in the Auth Hash field. It cannot be recovered if lost;"
        echo "  rotate it by editing ${env_file} (OPENFY_ADMIN_HASH), then recreate the container (rerun this installer with --method docker --version ${version}); 'docker restart' does NOT reload the env file."
        echo "=================================================================="
        echo ""
    else
        echo "  Credentials preserved (existing ${env_file} untouched)."
    fi
    _ui_section "  Manage the container"
    echo "  Logs:   docker logs -f ${cname}"
    echo "  Update: rerun this installer with --version <new> (data in the openfy_data volume is kept)."
    echo ""
    _ui_section "  Next steps"
    echo "    1. Open the app: http://<server-ip>:${OPENFY_PORT}"
    echo "    2. Sign in with your admin credential in the Auth Hash field."
    echo ""
}

print_deferred_credential() {
    [[ -n "${WORK_DIR}" && -f "${WORK_DIR}/admin-credential" ]] || return 0
    local username credential
    {
        IFS= read -r username
        IFS= read -r credential
    } < "${WORK_DIR}/admin-credential"
    valid_credential "${credential}" || die "invalid generated credential handoff."
    rm -f "${WORK_DIR}/admin-credential"
    echo ""
    echo "=================================================================="
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s%s\n' "${_ui_bold}" "${_ui_green}" "  ADMIN CREDENTIAL (generated now, shown ONCE - save it securely)" "${_ui_reset}"
    else
        echo "  ADMIN CREDENTIAL (generated now, shown ONCE - save it securely)"
    fi
    echo "  User: ${username}"
    echo "  Credential: ${credential}"
    echo "  Sign in with this value in the Auth Hash field."
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s\n' "${_ui_dim}" "  It cannot be recovered if lost; rotate it with: sudo openfy rotate-credential" "${_ui_reset}"
    else
        echo "  It cannot be recovered if lost; rotate it with: sudo openfy rotate-credential"
    fi
    echo "=================================================================="
    echo ""
}

print_missing_credential_warning() {
    # Loud end-of-install guidance for fresh installs that produced no new
    # credential (pre-existing config was preserved, or generation was
    # disabled). Never prints any secret.
    echo ""
    echo "=================================================================="
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s%s\n' "${_ui_bold}" "${_ui_yellow}" "  NO NEW ADMIN CREDENTIAL WAS GENERATED" "${_ui_reset}"
    else
        echo "  NO NEW ADMIN CREDENTIAL WAS GENERATED"
    fi
    echo "  The existing ${ENV_FILE} was preserved (credentials are only"
    echo "  shown once, when first generated), or credential generation was"
    echo "  disabled for this install."
    echo "  If you do not know the current admin credential, create a new"
    echo "  one (the service restarts automatically to apply it; printed"
    echo "  ONCE - save it securely):"
    echo "    sudo openfy rotate-credential"
    echo "=================================================================="
    echo ""
}

print_native_summary() {
    local version="$1"
    echo ""
    if [[ "${_ui_has_color}" == "true" ]]; then
        printf '%s%s%s\n' "${_ui_green}" "----------------------------------------" "${_ui_reset}"
    else
        echo "----------------------------------------"
    fi
    _ui_headline "Openfy v${version} installation complete."
    echo ""
    _ui_section "  Where things live"
    echo "  App:     ${APP_DIR}"
    echo "  Config:  ${ENV_FILE}"
    echo "  Data:    ${DATA_DIR}  (database, music, downloads, artwork)"
    echo "  URL:     http://<server-ip>:${OPENFY_PORT}"
    echo ""
    _ui_section "  Manage the server"
    echo "  Status:  sudo systemctl status openfy"
    echo "  Logs:    sudo journalctl -u openfy -f"
    echo "  Restart: sudo systemctl restart openfy"
    echo "  Update:  sudo ${APP_DIR}/update.sh --latest   (or rerun this installer)"
    echo "  Remove:  sudo ${APP_DIR}/uninstall.sh         (removes data + config; --keep-data/--keep-config to preserve)"
    echo "  Manage:  sudo openfy   (TUI: status, logs, update/downgrade, port, credentials, repair, uninstall)"
    echo ""
    _ui_section "  Next steps"
    echo "    1. Open the app: http://<server-ip>:${OPENFY_PORT}"
    echo "    2. Manage it anytime: sudo openfy"
    echo ""
    echo "Sign in with your admin credential in the Auth Hash field."
    echo "Existing credentials are preserved unless you explicitly rotate them."
}

# ------------------------------------------------- main

main() {
    parse_args "$@"

    # Resolve defaults for non-interactive runs.
    if [[ "${ASSUME_YES}" == "true" && -z "${METHOD}" ]]; then
        METHOD="native"
    fi
    if [[ "${ACTION}" == "uninstall" ]]; then
        if [[ "${METHOD}" == "docker" ]]; then
            run_docker_uninstall
        else
            require_root_native
            run_uninstall_delegate
        fi
        return
    fi

    # Rotation alone uses the installed native script without release planning.
    if [[ "${ROTATE_CREDENTIAL}" == "true" && "${ACTION}" == "auto" ]]; then
        [[ "${METHOD}" != "docker" ]] || die "--rotate-credential requires a native installation."
        METHOD="native"
        run_rotate_credential_delegate
        print_deferred_credential
        return
    fi

    if [[ "${ASSUME_YES}" != "true" ]] && is_interactive; then
        run_wizard
    else
        # Non-interactive: validate the requested combination up front.
        if [[ -n "${REQUESTED_VERSION_RAW}" ]]; then
            local out
            out="$(normalize_version_input "${REQUESTED_VERSION_RAW}")" || exit 1
            REQUESTED_VERSION="${out%% *}"
            REQUESTED_TAG="${out##* }"
            if version_is_prerelease "${REQUESTED_VERSION}" && [[ "${INCLUDE_PRERELEASE}" != "true" ]]; then
                die "version ${REQUESTED_VERSION} is a prerelease; pass --include-prerelease to install it (drafts are never installed)."
            fi
        fi
        if [[ -z "${METHOD}" ]]; then
            METHOD="native"
        fi
        if [[ "${ACTION}" == "auto" ]]; then
            detect_existing_install
            if [[ -n "${INSTALLED_VERSION}" && "${METHOD}" == "native" ]]; then
                die "existing installation (version ${INSTALLED_VERSION}) found at ${APP_DIR}. Non-interactive runs need an explicit --action (upgrade|repair|reinstall|uninstall); nothing changed."
            fi
            ACTION="install"
        fi
    fi

    # Fail fast for native installs before any network lookup (one-liner needs
    # a root shell; DRY_RUN never needs root).
    if [[ "${METHOD}" == "native" && "${DRY_RUN}" != "true" ]]; then
        require_root_native
    fi

    # The wizard may have switched to uninstall; never download in that case.
    if [[ "${ACTION}" == "uninstall" ]]; then
        if [[ "${METHOD}" == "docker" ]]; then
            run_docker_uninstall
        else
            require_root_native
            run_uninstall_delegate
        fi
        return
    fi

    # A repair/reinstall without an explicit version fixes the INSTALLED
    # version in place — it must not silently pull the latest release instead.
    if [[ "${METHOD}" == "native" && ("${ACTION}" == "repair" || "${ACTION}" == "reinstall") && -z "${REQUESTED_VERSION_RAW}" && "${WANT_LATEST}" != "true" ]]; then
        detect_existing_install
        if [[ -z "${INSTALLED_VERSION}" ]]; then
            die "no existing installation at ${APP_DIR}, so --action ${ACTION} is impossible. Omit --action for a fresh install; nothing changed."
        elif [[ "${INSTALLED_VERSION}" == "unknown" ]]; then
            die "cannot determine the installed version; use --action upgrade with an explicit --version."
        else
            local pinned
            if pinned="$(normalize_version_input "${INSTALLED_VERSION}")"; then
                REQUESTED_VERSION="${pinned%% *}"
                REQUESTED_TAG="${pinned##* }"
                log "Repair target pinned to installed version ${REQUESTED_TAG}."
            else
                die "installed version '${INSTALLED_VERSION}' is not a recognised tag; use --action upgrade with an explicit --version."
            fi
        fi
    fi

    # Resolve the version to install.
    if [[ -n "${REQUESTED_TAG}" || -n "${REQUESTED_VERSION_RAW}" ]]; then
        if [[ -z "${REQUESTED_TAG}" ]]; then
            local out
            out="$(normalize_version_input "${REQUESTED_VERSION_RAW}")" || exit 1
            REQUESTED_VERSION="${out%% *}"
            REQUESTED_TAG="${out##* }"
        fi
        fetch_release_metadata "${REQUESTED_TAG}"
        if [[ "${RESOLVED_PRERELEASE}" == "true" && "${INCLUDE_PRERELEASE}" != "true" ]]; then
            die "release ${RESOLVED_TAG} is a prerelease; pass --include-prerelease to install it (or choose a stable version)."
        fi
    else
        resolve_latest_stable
    fi
    if [[ "${RESOLVED_PRERELEASE}" == "true" ]]; then
        warn "installing PRERELEASE ${RESOLVED_TAG} (explicitly requested). Stable aliases and auto-updates never use prereleases."
    fi

    local arch
    arch="$(detect_arch)"
    log "Target: Openfy ${RESOLVED_TAG} for ${arch} via ${METHOD}."

    if [[ "${METHOD}" == "native" ]]; then
        detect_existing_install
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        local plan_mode="install"
        if [[ "${METHOD}" == "native" && -n "${INSTALLED_VERSION}" ]]; then
            if [[ "${INSTALLED_VERSION}" == "${RESOLVED_VERSION}" ]]; then
                plan_mode="repair/reinstall (already at ${INSTALLED_VERSION}; use --action and/or --force)"
            else
                plan_mode="upgrade (${INSTALLED_VERSION} -> ${RESOLVED_VERSION})"
            fi
        elif [[ "${METHOD}" == "docker" ]]; then
            plan_mode="docker pull + run"
        fi
        log "DRY RUN: no changes made. Plan: ${plan_mode} Openfy ${RESOLVED_TAG} (${arch}): download openfy-v${RESOLVED_VERSION}-${arch}.tar.gz -> verify SHA-256 -> delegate to verified bundle."
        if [[ "${METHOD}" == "docker" ]]; then
            run_docker_install "${RESOLVED_VERSION}"
        elif [[ "${ROTATE_CREDENTIAL}" == "true" ]]; then
            run_rotate_credential_delegate
        fi
        return
    fi

    if [[ "${METHOD}" == "docker" ]]; then
        run_docker_install "${RESOLVED_VERSION}"
        return
    fi

    # Native path: root + environment checks BEFORE any download.
    require_root_native
    detect_os
    check_requirements_native

    # Decide install vs upgrade vs repair now that versions are known.
    detect_existing_install
    local mode="install"
    if [[ -n "${INSTALLED_VERSION}" ]]; then
        if [[ "${ACTION}" == "auto" || "${ACTION}" == "install" ]]; then
            if [[ "${INSTALLED_VERSION}" == "${RESOLVED_VERSION}" && "${FORCE}" != "true" ]]; then
                die "version ${RESOLVED_VERSION} is already installed at ${APP_DIR}. Use --action repair, --action reinstall, --force, or request a different --version; nothing changed."
            elif [[ "${INSTALLED_VERSION}" == "${RESOLVED_VERSION}" ]]; then
                mode="reinstall"
            else
                mode="upgrade"
            fi
        else
            mode="${ACTION}"
            if [[ ("${mode}" == "reinstall" || "${mode}" == "repair") && "${INSTALLED_VERSION}" != "${RESOLVED_VERSION}" ]]; then
                die "--action ${mode} targets ${RESOLVED_VERSION} but ${INSTALLED_VERSION} is installed. Use --action upgrade (backups + rollback) or pass --version ${INSTALLED_VERSION}; nothing changed."
            fi
            if [[ "${mode}" == "upgrade" && "${INSTALLED_VERSION}" == "${RESOLVED_VERSION}" ]]; then
                log "Already at version ${RESOLVED_VERSION}; nothing to do."
                if [[ "${ROTATE_CREDENTIAL}" == "true" ]]; then
                    run_rotate_credential_delegate
                    print_deferred_credential
                fi
                return
            fi
        fi
    else
        if [[ "${ACTION}" == "upgrade" || "${ACTION}" == "repair" ]]; then
            die "no existing installation at ${APP_DIR}, so --action ${ACTION} is impossible. Omit --action for a fresh install; nothing changed."
        fi
        mode="install"
    fi
    if [[ "${ROTATE_CREDENTIAL}" == "true" && -z "${INSTALLED_VERSION}" ]]; then
        die "--rotate-credential needs an existing installation at ${APP_DIR}."
    fi

    # Non-interactive runs skip the wizard, so resolve a custom unit port here
    # (wizard already does this interactively). Keeps PORT_EXPLICIT=false so
    # the bundle still applies its own resolve_port.
    if [[ "${METHOD}" == "native" && "${PORT_EXPLICIT}" != "true" && -n "${INSTALLED_VERSION}" ]]; then
        local unit_port
        unit_port="$(grep -oE -- '--port [0-9]+' "${OPENFY_SYSTEMD_DIR:-/etc/systemd/system}/openfy.service" 2>/dev/null | awk '{print $2}' | head -n 1 || true)"
        if valid_port "${unit_port}"; then OPENFY_PORT="${unit_port}"; fi
    fi

    # Port check runs only for modes that invoke the bundle installer
    # (install/reinstall/repair). Explicit upgrade ports are checked in
    # run_native_delegate; other upgrades preserve the service's port.
    if [[ "${mode}" == "install" || "${mode}" == "reinstall" || "${mode}" == "repair" ]]; then
        check_port_conflict
    fi

    install_system_deps
    check_requirements_native

    new_workdir
    download_release "${RESOLVED_VERSION}" "${arch}" "${WORK_DIR}"
    verify_download "${WORK_DIR}" "openfy-v${RESOLVED_VERSION}-${arch}.tar.gz"
    local staged
    staged="$(extract_and_validate "${WORK_DIR}" "openfy-v${RESOLVED_VERSION}-${arch}.tar.gz" "${RESOLVED_VERSION}" "${arch}")"

    if [[ "${mode}" == "upgrade" ]]; then
        if [[ "${PORT_EXPLICIT}" == "true" ]]; then
            OPENFY_INSTALL_DIR="${APP_DIR}" OPENFY_DATA_DIR_OVERRIDE="${DATA_DIR}" OPENFY_CONFIG_DIR="${CONFIG_DIR}" OPENFY_PORT="${OPENFY_PORT}" \
                run_native_delegate "${staged}" "upgrade" "${RESOLVED_VERSION}" "${WORK_DIR}/openfy-v${RESOLVED_VERSION}-${arch}.tar.gz"
        else
            OPENFY_INSTALL_DIR="${APP_DIR}" OPENFY_DATA_DIR_OVERRIDE="${DATA_DIR}" OPENFY_CONFIG_DIR="${CONFIG_DIR}" \
                run_native_delegate "${staged}" "upgrade" "${RESOLVED_VERSION}" "${WORK_DIR}/openfy-v${RESOLVED_VERSION}-${arch}.tar.gz"
        fi
    else
        OPENFY_INSTALL_DIR="${APP_DIR}" OPENFY_DATA_DIR_OVERRIDE="${DATA_DIR}" OPENFY_CONFIG_DIR="${CONFIG_DIR}" \
            run_native_delegate "${staged}" "${mode}" "${RESOLVED_VERSION}" ""
    fi

    if [[ "${ROTATE_CREDENTIAL}" == "true" ]]; then
        run_rotate_credential_delegate
    fi

    print_native_summary "${RESOLVED_VERSION}"
    if [[ -f "${WORK_DIR}/admin-credential" ]]; then
        print_deferred_credential
    elif [[ "${mode}" == "install" ]]; then
        # Fresh install but no new credential (pre-existing config was
        # preserved, or generation was disabled): say so loudly instead of
        # silently leaving the operator locked out.
        print_missing_credential_warning
    fi
}

if [[ -z "${BASH_SOURCE[0]:-}" ]]; then
    die "run this installer from a file: curl -fsSL https://raw.githubusercontent.com/${OPENFY_REPO}/main/install.sh -o install.sh && sudo bash install.sh"
elif [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
