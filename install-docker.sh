#!/usr/bin/env bash
# Install from a published image; only Bash, Docker and Docker Compose are needed.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: bash install-docker.sh [directory] (default: ./openfy)"
    exit 0
fi
if [[ $# -gt 1 || "${1:-}" == -* ]]; then
    echo "Usage: bash install-docker.sh [directory]" >&2
    exit 1
fi
command -v docker >/dev/null || { echo "Install Docker with the Compose plugin first." >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null

# Restrict the generated config and data to the installing user.
umask 077
mkdir -p -- "${1:-openfy}"
cd -- "${1:-openfy}"
install_dir="$(pwd -P)"
mkdir -p data
scratch="$(mktemp -d .openfy-install.XXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
credential=""

if [[ ! -e .env ]]; then
    # Python runs inside the image; no host Python installation is required.
    credential="$(docker run --rm --network none --entrypoint python \
        ghcr.io/nethminayasas/openfy:latest \
        -c 'import secrets; print("of1_" + secrets.token_urlsafe(45))')"
    if [[ ! "$credential" =~ ^of1_[A-Za-z0-9_-]{60}$ ]]; then
        echo "Could not generate a valid admin credential; setup stopped." >&2
        exit 1
    fi
    cat > "$scratch/env" <<ENV
OPENFY_VERSION=latest
OPENFY_BIND_IP=127.0.0.1
OPENFY_PORT=8000
OPENFY_ADMIN_USERNAME=admin
OPENFY_ADMIN_HASH=$credential
OPENFY_ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000
ENV
    mv -- "$scratch/env" .env
fi

if [[ ! -e docker-compose.yml ]]; then
    cat > "$scratch/compose" <<'COMPOSE'
services:
  openfy:
    image: ghcr.io/nethminayasas/openfy:${OPENFY_VERSION:-latest}
    restart: unless-stopped
    ports:
      - "${OPENFY_BIND_IP:-127.0.0.1}:${OPENFY_PORT:-8000}:8000"
    volumes:
      - ./data:/data
    env_file:
      - .env
    environment:
      OPENFY_ENV: prod
      OPENFY_DATA_DIR: /data
      OPENFY_MUSIC_DIR: /data/music
      OPENFY_DOWNLOADS_DIR: /data/downloads
      OPENFY_ARTWORK_DIR: /data/artwork
      OPENFY_DATABASE_URL: sqlite:////data/openfy.db
COMPOSE
    mv -- "$scratch/compose" docker-compose.yml
fi

# Run relative to this directory, regardless of Compose variables in the shell.
compose=(docker compose --project-directory "$install_dir" --env-file .env -f docker-compose.yml)
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" up -d --wait --wait-timeout 120

printf '\nOpenfy is ready. Configuration and data: %s\n' "$install_dir"
if [[ -n "$credential" ]]; then
    printf 'Open http://localhost:8000\nAdmin username: admin\nAuth Hash (save this): %s\n' "$credential"
else
    echo "Existing configuration and credentials preserved. See .env for your port and admin settings."
fi
echo "To manage Openfy, cd to this directory and use docker compose logs -f, stop, or up -d."
