# Openfy

A self-hosted music streaming platform.

## Prerequisites

- For the one-line / bare-metal install: a fresh supported Linux server —
  current **Ubuntu or Debian** (other systemd distros with
  `--allow-unsupported-os`), CPU **x86-64 (`linux-amd64`)** or
  **ARM64 (`linux-arm64`)**, **Python 3.11+**, `ffmpeg`, systemd, root access,
  and internet access during installation. System packages are installed
  automatically via apt/dnf/yum/pacman/zypper unless `--no-install-deps` is
  given.
- For Docker install: Docker and Docker Compose.
- For manual setup: Python 3.11+.

## Quick Start (one-line installer, bare-metal Linux, no Docker)

Install the latest stable release (interactive wizard — guides you through
method, version, admin account, and dependencies; native installs need a
root shell — sudo users use the download-first command below):

```bash
curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && bash install.sh
```

Install an exact version instead (installs **exactly** this version — check
the [Releases page](https://github.com/NethminaYasas/Openfy/releases) for
published versions; `v1.4.2` below is an example of the `vMAJOR.MINOR.PATCH`
tag convention):

```bash
curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && bash install.sh v1.4.2
```

Or download the script first, then run it as root (same behaviour):

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh
sudo bash install.sh v1.4.2
```

Non-interactive (automation):

```bash
sudo bash install.sh --yes                                    # latest stable
sudo bash install.sh --yes --version 1.4.2                    # pinned version
sudo bash install.sh --yes --method docker --version 1.4.2    # Docker instead
```

The installer detects your OS/architecture, resolves the release from the
official GitHub repository, downloads the archive for your CPU plus
`SHA256SUMS`, **verifies the checksum before executing anything from the
bundle**, installs the app to `/opt/openfy`, writes config to
`/etc/openfy/openfy.env`, keeps data in `/var/lib/openfy/`, creates the
`openfy` systemd service, generates the initial admin credential (shown
**once** — save it), and health-checks the service. Rerunning is safe:
existing config, credentials, and data are preserved. A requested version
that is missing, a draft, or lacks assets is a fatal error — the installer
never silently substitutes another version.

See `install.sh --help` for all options (`--action upgrade|repair|reinstall|
uninstall`, `--admin-user`, `--no-start`, `--purge`, `--dry-run`, ...).

Manual alternative (no bootstrap): download
`openfy-vVERSION-linux-amd64.tar.gz` (x86-64) or
`openfy-vVERSION-linux-arm64.tar.gz` (ARM64) plus `SHA256SUMS` from the
[Releases page](https://github.com/NethminaYasas/Openfy/releases), then:

```bash
sha256sum -c --ignore-missing SHA256SUMS   # every downloaded file must report OK
tar -xzf openfy-vVERSION-linux-amd64.tar.gz
cd openfy-vVERSION-linux-amd64
sudo ./install.sh
```

For local access, visit `http://localhost:8000`. For remote access, use a
TLS-terminating reverse proxy and visit its `https://` URL — do not expose
port 8000 directly to remote clients. Sign in with your admin credential in
the Auth Hash field.

Full guide — wizard options, non-interactive flags, configuration, systemd
service commands, credential rotation, upgrades, repair, safe uninstall,
data locations, backups, troubleshooting:
[`docs/LINUX_INSTALL.md`](docs/LINUX_INSTALL.md).

## Installation

### Option A — Bare-metal Linux without Docker (recommended)

Use the one-line installer above. No Docker, no Node.js. App lives in
`/opt/openfy`, config in `/etc/openfy/openfy.env`, data in
`/var/lib/openfy/` (database, music, downloads, artwork) — config and data
survive updates, repairs, reinstalls, and normal uninstalls.

### Option B — Docker, published image

No build needed. Pin a released version (see the
[Releases page](https://github.com/NethminaYasas/Openfy/releases)):

```bash
cp .env.example .env   # fill in your values
OPENFY_VERSION=1.4.2 docker compose -f docker-compose.prod.yml up -d
```

Images: `ghcr.io/nethminayasas/openfy:1.4.2` (also `:1.4`, `:1`, `:latest`).
Prefer an explicit version in production; `latest` moves on every stable
release and prereleases (e.g. `1.5.0-rc.1`) never touch the stable aliases.
Multi-arch: `linux/amd64` and `linux/arm64`.

### Option C — Docker from source (development)

```bash
cp .env.example .env   # fill in your values
docker compose up --build -d
```
### Configuration and admin credentials

Copy `.env.example` to `.env` and fill in your values before starting
(Docker/manual setups).

```bash
python scripts/generate_hash.py   # paste the of1_... value as OPENFY_ADMIN_HASH
```

Native installs generate the initial admin credential automatically and print
it **once** — save it in a password manager; it cannot be recovered, only
rotated:

```bash
sudo /opt/openfy/install.sh --rotate-credential   # explicit; prints the new secret once
sudo systemctl restart openfy
```

Bare-metal installs keep their config at `/etc/openfy/openfy.env` (mode
`640`) and data at `/var/lib/openfy/` (database, music, downloads, artwork)
— both survive updates, repairs, reinstalls, and normal uninstalls. Upgrades
never print or change existing credentials.

### Upgrading

- One-line installer: rerun it and choose **Upgrade**, or non-interactively:
  `sudo bash install.sh --yes --action upgrade --version 1.5.0`.
- Bare-metal: `sudo /opt/openfy/update.sh --latest` (verifies checksums,
  backs up config + database, rolls back on failure).
- Docker (prod): set `OPENFY_VERSION` to the new release and
  `docker compose -f docker-compose.prod.yml up -d`.

### Repair, reinstall, and uninstall

- Repair damaged application files from a verified bundle (data/config
  untouched): choose **Repair** in the installer wizard, or
  `sudo bash install.sh --yes --action repair`. In-place
  `sudo /opt/openfy/install.sh --repair --no-start` only fixes
  ownership/permissions, venv, and systemd unit (it does not restore
  application files).
- Reinstall application files (keeps data + config, asks first):
  via the wizard (verified bundle). In-place
  `sudo /opt/openfy/install.sh --force` does not restore files.
- Uninstall (keeps data + config by default):
  `sudo /opt/openfy/uninstall.sh`; permanent data removal needs explicit
  `--purge` plus a second confirmation. Back up `/var/lib/openfy/openfy.db`
  and `/var/lib/openfy/music/` before destructive operations. Rollback after
  a failed upgrade is automatic (previous files restored, backup retained
  under `/var/backups/openfy/`); database formats only move forward, so keep
  the pre-upgrade backup.

## Manual Setup

```bash
git clone https://github.com/NethminaYasas/Openfy.git
cd Openfy
cp .env.example .env   # fill in your values (also used by manual setup)
cd server
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Features

- **Web-based music player** - Stream your music library from any browser
- **Desktop & Mobile UI** - Dedicated mobile frontend served automatically for mobile devices
- **Upload music** - Upload local audio files (mp3, flac, wav, m4a, ogg, opus)
- **Spotify/Apple Music downloads** - Download tracks from streaming services via SpotiFLAC
- **Spotify playlist import** - Import entire Spotify playlists and albums with automatic deduplication
- **Multi-user support** - Each user gets their own library, playlists, and queue
- **Liked Songs** - Universal "Liked Songs" playlist per user
- **Playlist management** - Create, rename, reorder, pin, and share public playlists
- **Follow playlists, albums & artists** - Follow other users' public playlists plus albums and artists
- **Album management** - Auto-organized album views with artwork extraction
- **Artist pages** - Dedicated artist pages with all tracks and albums
- **Search** - Search by track title, artist name, or album title
- **Spotify search** - Search Spotify directly from the UI
- **Queue system** - Persistent per-user queue with drag-and-drop reorder, shuffle, and repeat
- **Player state persistence** - Shuffle and repeat settings, queue, last track, and library state saved per user (volume is local-only)
- **User avatars** - Upload profile pictures
- **Audio streaming** - HTTP range-request support for seeking and partial content
- **Admin dashboard** - User management, track management, system settings, and server stats
- **Rate limiting** - Auth endpoints protected against brute force (10 signups / 15 signins per 5 min per IP)
- **Stream tokens** - Time-limited tokens (120s TTL) for secure audio streaming
- **Docker deployment** - Containerized setup with automatic database initialization and healthcheck
- **SpotiFLAC auto-update** - Docker build automatically installs latest SpotiFLAC from upstream

## Screenshots

### Home Page
![Home Page](docs/screenshots/home_page.png)

### Upload Page
![Upload Page](docs/screenshots/upload_page.png)

### Artist Page
![Artist Page](docs/screenshots/artist_page.png)

### Playlist Page
![Playlist Page](docs/screenshots/playlist_page.png)

> All screenshots live in the `docs/screenshots/` directory.

## Configuration

Copy `.env.example` to `.env` and fill in your values before starting.

Available environment variables (all prefixed with `OPENFY_`, except `SPOTIFLAC_PIN_VERSION` which is a build-time-only variable read by `scripts/check_spotiflac_update.sh`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENFY_ENV` | `dev` | Environment mode |
| `OPENFY_DATABASE_URL` | `sqlite:///./data/openfy.db` | Database connection string |
| `OPENFY_DATA_DIR` | `./data` | Data directory path |
| `OPENFY_MUSIC_DIR` | `./data/music` | Music library path |
| `OPENFY_DOWNLOADS_DIR` | `./data/downloads` | Downloads directory |
| `OPENFY_ARTWORK_DIR` | `./data/artwork` | Album art cache directory |
| `OPENFY_ALLOWED_ORIGINS` | `http://localhost` | CORS allowed origins (docker-compose overrides to `http://localhost:8000,http://127.0.0.1:8000`) |
| `OPENFY_ADMIN_USERNAME` | `` | Admin username (auto-created on startup) |
| `OPENFY_ADMIN_HASH` | `` | Random admin credential (`of1_...`, 64 chars) from `scripts/generate_hash.py` |
| `OPENFY_MAX_UPLOAD_SIZE_MB` | `200` | Maximum upload file size in MB |
| `SPOTIFLAC_PIN_VERSION` | `` | Pin SpotiFLAC to a specific version (e.g. `0.7.0`). Leave empty for latest. No `OPENFY_` prefix. |

## Generating an Admin Hash

```bash
python scripts/generate_hash.py
```

Copy the output into your `.env` as `OPENFY_ADMIN_HASH`, then restart the server.
Use this credential in the Auth Hash sign-in field and keep it secret. The generator
uses cryptographically secure randomness and does not accept a password.
(Native one-line installs generate and store this for you automatically.)

### Rotating existing administrator credentials

Password-derived administrator hashes are no longer accepted, including credentials
still stored in the database. Generate a fresh credential with the command above,
replace `OPENFY_ADMIN_HASH`, and restart with the same `OPENFY_ADMIN_USERNAME`.
Startup rotates the existing account's credential and its ownership references in
one transaction, preserving its library and playlists. Sign in again with the new
credential; the old credential no longer works. Repeat for each existing administrator.

The `scripts/` directory contains developer/admin utilities.

## Architecture

- **Frontend**: Vanilla JS with ES modules in `client/modules/` - no Node.js/npm required
- **Backend**: FastAPI (Python) with SQLAlchemy ORM
- **Database**: SQLite (auto-initialized on first run)
- **Audio streaming**: HTTP range requests with optional time-limited stream tokens
- **SPA routing**: All non-API routes serve `index.html` for client-side routing
- **Mobile**: Separate mobile UI auto-detected via User-Agent
- **Queue Manager**: `client/modules/queue-manager.js` is the single source of truth for the playback queue
- **SpotiFLAC**: Upstream SpotiFLAC package (auto-updated to latest at Docker build time, pinnable via `SPOTIFLAC_PIN_VERSION`) + local Apple Music/Spotify fallback downloader (`server/app/spotiflac_local/`, via YouTube Music)

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES Modules)
- **Backend**: FastAPI (Python 3.11+; Docker ships 3.11-slim, CI tests 3.12)
- **Database**: SQLite via SQLAlchemy
- **Auth**: X-Auth-Hash header (token-based, no Bearer/JWT)
- **Containerization**: Docker with healthcheck and auto-restart

## License

GNU General Public License v3.0
