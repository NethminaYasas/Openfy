#!/bin/bash
# Shared release helpers: tag validation and version derivation.
# The Git tag is the single authoritative version source.
# Sourced by packaging/validation scripts and mirrored by the release workflow.
#
# Usage:
#   source "$(dirname "$0")/common.sh"
#   parse_release_tag "v1.4.2"   # sets OPENFY_VERSION, OPENFY_IS_PRERELEASE, ...
#
# Supported stable tags:    v1.0.0  v1.2.3  v2.0.0
# Supported prerelease tags: v1.3.0-rc.1  v1.5.0-beta.2  v2.0.0-alpha.1

set -euo pipefail

# Matches vMAJOR.MINOR.PATCH with an optional -rc.N / -beta.N / -alpha.N suffix.
OPENFY_TAG_REGEX='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((rc|beta|alpha)\.[0-9]+))?$'

# parse_release_tag <tag>
# Exports on success:
#   OPENFY_TAG, OPENFY_VERSION (no leading v), OPENFY_IS_PRERELEASE (true/false),
#   OPENFY_MAJOR, OPENFY_MINOR, OPENFY_PATCH, OPENFY_SUFFIX (e.g. rc.1 or empty)
# Returns non-zero with a clear message on invalid tags.
parse_release_tag() {
    local tag="${1:-}"
    if [[ ! "${tag}" =~ ${OPENFY_TAG_REGEX} ]]; then
        echo "ERROR: invalid release tag '${tag}'." >&2
        echo "Expected a semantic version tag such as v1.4.2 (stable) or v1.3.0-rc.1 (prerelease)." >&2
        echo "Prerelease suffixes supported: -rc.N, -beta.N, -alpha.N (e.g. v2.0.0-beta.2)." >&2
        return 1
    fi
    OPENFY_TAG="${tag}"
    OPENFY_VERSION="${tag#v}"
    OPENFY_MAJOR="${BASH_REMATCH[1]}"
    OPENFY_MINOR="${BASH_REMATCH[2]}"
    OPENFY_PATCH="${BASH_REMATCH[3]}"
    OPENFY_SUFFIX="${BASH_REMATCH[5]:-}"
    if [[ -n "${OPENFY_SUFFIX}" ]]; then
        OPENFY_IS_PRERELEASE="true"
    else
        OPENFY_IS_PRERELEASE="false"
    fi
    export OPENFY_TAG OPENFY_VERSION OPENFY_IS_PRERELEASE OPENFY_MAJOR OPENFY_MINOR OPENFY_PATCH OPENFY_SUFFIX
}

# docker_tags_for_release
# Prints the GHCR tags for the parsed release, one per line (without registry prefix).
# Stable releases get full + minor + major + latest aliases.
# Prereleases publish ONLY their exact version and never move stable aliases.
docker_tags_for_release() {
    if [[ "${OPENFY_IS_PRERELEASE}" == "true" ]]; then
        printf '%s\n' "${OPENFY_VERSION}"
    else
        printf '%s\n' "${OPENFY_VERSION}" "${OPENFY_MAJOR}.${OPENFY_MINOR}" "${OPENFY_MAJOR}" "latest"
    fi
}

# archive_basename <arch>
# Prints e.g. openfy-v1.4.2-linux-amd64.tar.gz
archive_basename() {
    local arch="${1:?archive_basename requires an arch (linux-amd64|linux-arm64)}"
    case "${arch}" in
        linux-amd64|linux-arm64) ;;
        *) echo "ERROR: unsupported archive arch '${arch}'. Use linux-amd64 or linux-arm64." >&2; return 1 ;;
    esac
    printf 'openfy-v%s-%s.tar.gz' "${OPENFY_VERSION}" "${arch}"
}

# require_clean_version_string <value> <label>
# Rejects values containing characters unsafe for paths/URLs/shell.
require_clean_version_string() {
    local value="${1:-}" label="${2:-value}"
    if [[ ! "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
        echo "ERROR: unsafe ${label} '${value}' (allowed: letters, digits, . _ -)." >&2
        return 1
    fi
}
