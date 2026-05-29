#!/bin/bash
# SpotiFLAC Auto-Update Script
# Always installs the latest SpotiFLAC from upstream during Docker build.
# pip's cache layer ensures this only re-runs when requirements.txt layer is invalidated.
# Set SPOTIFLAC_PIN_VERSION=x.y.z in .env to pin a specific version.

set -euo pipefail

REPO="ShuShuzinhuu/SpotiFLAC-Module-Version"
PINNED_VERSION="${SPOTIFLAC_PIN_VERSION:-}"

echo "=== SpotiFLAC Update Check ==="

INSTALLED_VERSION=$(pip show SpotiFLAC 2>/dev/null | awk '/^Version:/{print $2}' || echo "none")
echo "Currently installed: ${INSTALLED_VERSION}"

if [ -n "$PINNED_VERSION" ]; then
    echo "Installing pinned version ${PINNED_VERSION}..."
    pip install --no-cache-dir --upgrade "git+https://github.com/${REPO}.git@v${PINNED_VERSION}"
else
    echo "Installing latest from upstream..."
    pip install --no-cache-dir --upgrade "git+https://github.com/${REPO}.git@main"
fi

NEW_VERSION=$(pip show SpotiFLAC 2>/dev/null | awk '/^Version:/{print $2}' || echo "unknown")
echo "SpotiFLAC now at: ${NEW_VERSION}"
echo "=== SpotiFLAC Update Check Complete ==="
