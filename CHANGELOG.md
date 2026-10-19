# Changelog
All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Root-level one-line installer (`install.sh`): `bash <(curl -fsSL .../main/install.sh)` installs the latest stable release; appending `v1.4.2` (or `1.4.2`) installs exactly that version. Interactive wizard (method, version, admin account, dependencies, upgrade/repair/reinstall/uninstall) plus non-interactive flags (`--yes`, `--method`, `--action`, `--version`, `--admin-user`, `--dry-run`, ...). Resolves releases via the GitHub API, verifies `SHA256SUMS` before executing anything from the bundle, refuses drafts/missing/incomplete releases without fallback, and delegates to the verified bundle's `install.sh`/`update.sh` (backups + rollback preserved).
- Bare-metal `install.sh`: automatic system-package installation (apt/dnf/yum/pacman/zypper, `--no-install-deps` to skip), port-conflict detection, automatic initial admin credential generation (printed once, `640` config), `--repair` mode, `--rotate-credential`, `--admin-user`, `--yes`.
- `server/tests/test_bootstrap_installer.py`: installer/version/checksum/credential/lifecycle tests against a mocked GitHub API (no network, no root).
- CI pins all third-party actions to commit SHAs and syntax-checks the root `install.sh`.
- Automatic release pipeline (`.github/workflows/release.yml`): publishing a GitHub Release builds, tests, and publishes the multi-arch (`linux/amd64`, `linux/arm64`) Docker image to GHCR plus `linux-amd64`/`linux-arm64` bare-metal bundles, `SHA256SUMS`, and an SPDX SBOM as release assets. Stable tags publish `X.Y.Z`, `X.Y`, `X`, `latest`; prereleases (`-rc.N`/`-beta.N`/`-alpha.N`) publish only their exact version.
- Bare-metal Linux distribution: `install.sh` / `start.sh` / `update.sh` / `uninstall.sh` + hardened `openfy.service` systemd unit (see `scripts/linux/`); app in `/opt/openfy`, config in `/etc/openfy/openfy.env`, data in `/var/lib/openfy` (preserved across updates and reinstalls, removed by an uninstall).
- CI packaging validation job, bundle packaging/validation scripts (`scripts/release/`), and `server/tests/test_release_packaging.py`.
- `docker-compose.prod.yml` for running version-pinned published images without building.
- `docs/RELEASING.md` (maintainer workflow) and `docs/LINUX_INSTALL.md` (bare-metal guide); `THIRD_PARTY_NOTICES.md`; OCI labels on the Docker image.
- SpotiFLAC auto-update during Docker build (`scripts/check_spotiflac_update.sh`)
- `SPOTIFLAC_PIN_VERSION` env var to pin SpotiFLAC to a specific version
- Docker healthcheck on `/health` endpoint
- `restart: unless-stopped` policy in docker-compose.yml
- Local SpotiFLAC package (`server/app/spotiflac_local/`) for custom Apple Music/Spotify downloader
- **Registration modes**: server-wide `open`/`invite` registration mode stored in the database (`app_settings`) and switchable at runtime via the admin dashboard (desktop + mobile) or API — effective immediately, no restart; `OPENFY_REGISTRATION_MODE` only seeds the initial DB value
- **Invite codes**: admins create codes with optional max uses (default 1), expiry in days, and a note; the plaintext code is returned exactly once and stored only as a SHA-256 hash. `GET /admin/invites` lists status (`active`/`used`/`expired`/`revoked`), uses, and redeemers; codes can be revoked. Redemption is atomic (race-safe) and rolls back if registration fails; invites survive mode switches, can be pre-generated while open, and signup links (`/?invite=CODE`) prefill the code
- **Signup invite field**: desktop and mobile signup forms fetch the registration mode, require/show the invite field in invite mode, and prefill it from `?invite=CODE`
- **Public registration endpoints**: `GET /auth/registration-mode` (returns only `{"mode"}`) and `POST /auth/invite/validate` (non-consuming validity check), both rate-limited
- **`openfy start|stop|restart|status`**: deployment-aware server control for systemd, Docker Compose, and manual deployments — flags `--systemd`/`--docker`/`--manual` (or `OPENFY_DEPLOYMENT`), `--host`/`--port`/`--timeout`; Docker keeps containers and volumes (never `down`) and never rebuilds; manual mode runs `uvicorn` in the background with PID file + log, SIGTERM then SIGKILL, and verified process identity; all subcommands idempotent and never touch data

### Fixed
- **Queue drag-and-drop reset bug**: Queue now persists correctly after reorder when track advances
  - `_save()` fires immediately instead of debouncing — server always has latest queue state
  - `queueJumpTo()` now saves to both localStorage and server
  - `playByIndex()` now saves the updated index to server on auto-advance
- Logger used before definition in `spotiflac.py` (moved to top of file)
- Duplicate `is_apple`/`is_spotify` variable redeclarations in `queue_download()`
- `_ensure_spotiflac_import` sys.path hack replaced with direct local package imports
- Stream download timeout in `_download_via_apple_proxy` (was connection-only, now includes read timeout)
- `print()` warning replaced with `logger.warning()` for duration mismatch

### Changed
- **Uninstall now wipes everything (behavior change)**: `uninstall.sh` (and `openfy uninstall` / `install.sh --action uninstall`) remove the application, the data directory (database, music, artwork, avatars), the configuration **including the admin credential**, the pre-update backups under `/var/backups/openfy/`, the `openfy` service account and the `openfy` command wrapper. The old `--purge` / `--remove-data` / `--remove-config` flags are obsolete and ignored; use `--keep-data`, `--keep-config`, `--keep-backups` or `--keep-service-user` to preserve a part of the installation. Docker deployments lose their containers, images, volumes, `.env` and bind-mounted data too.
- **Invite-only registration by default (upgrade behavior change)**: registration is now gated by invite codes. On startup, if the database has no stored mode, it is seeded from `OPENFY_REGISTRATION_MODE` (**default `invite`**); after that the DB value wins and the env var is ignored. Existing deployments upgrading without a stored value therefore become invite-only (previously anyone could register). Workaround: set `OPENFY_REGISTRATION_MODE=open` before the first start after upgrading, or switch to Open in the admin dashboard.
- SpotiFLAC upstream auto-updates to latest version (v0.7.0) during Docker build
- Dockerfile no longer overwrites pip-installed SpotiFLAC with local copy
- `requirements.txt` dependencies pinned (`requests==2.32.3`, minimum versions for `ytmusicapi`, `beautifulsoup4`, `yt-dlp`)
- Dockerfile healthcheck uses correct `/health` endpoint path

### Security
- Removed user_hash from TrackOut schema to prevent credential exposure
- Added SSRF hardening for remote artwork fetch endpoints
- Added remote image fetch byte cap (8MB) and content-type validation
- Hardened auth_hash input validation (strict hex format)
