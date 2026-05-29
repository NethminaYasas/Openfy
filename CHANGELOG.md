# Changelog
All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- SpotiFLAC auto-update during Docker build (`scripts/check_spotiflac_update.sh`)
- `SPOTIFLAC_PIN_VERSION` env var to pin SpotiFLAC to a specific version
- Docker healthcheck on `/health` endpoint
- `restart: unless-stopped` policy in docker-compose.yml
- Local SpotiFLAC package (`server/app/spotiflac_local/`) for custom Apple Music/Spotify downloader

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
- SpotiFLAC upstream auto-updates to latest version (v0.7.0) during Docker build
- Dockerfile no longer overwrites pip-installed SpotiFLAC with local copy
- `requirements.txt` dependencies pinned (`requests==2.32.3`, minimum versions for `ytmusicapi`, `beautifulsoup4`, `yt-dlp`)
- Dockerfile healthcheck uses correct `/health` endpoint path

### Security
- Removed user_hash from TrackOut schema to prevent credential exposure
- Added SSRF hardening for remote artwork fetch endpoints
- Added remote image fetch byte cap (8MB) and content-type validation
- Hardened auth_hash input validation (strict hex format)
