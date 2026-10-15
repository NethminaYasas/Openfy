# Third-Party Notices (Openfy runtime distribution)

Openfy is licensed under the GNU General Public License v3.0 (see `LICENSE`).
This file records the third-party components used at runtime by the Docker
image and the bare-metal Linux bundles.

## Python packages (installed from `server/requirements.txt` at build/install time)

| Package | Source |
|---|---|
| fastapi | PyPI (BSD) |
| uvicorn | PyPI (BSD) |
| SQLAlchemy | PyPI (MIT) |
| pydantic / pydantic-settings | PyPI (MIT) |
| python-multipart | PyPI (Apache-2.0) |
| mutagen | PyPI (GPL-2.0-or-later) |
| requests | PyPI (Apache-2.0) |
| ytmusicapi | PyPI (MIT) |
| beautifulsoup4 | PyPI (MIT) |
| yt-dlp | PyPI (Unlicense) |
| Pillow | PyPI (HPND) |
| SpotiFLAC | `https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version` (upstream; auto-updated to latest at Docker build time unless `SPOTIFLAC_PIN_VERSION` pins a tag) |

## Vendored source

- `spotify_scraper/` — vendored SpotifyScraper copy used for artist image
  fetching (see its own headers for license/attribution). In Docker it is
  copied into site-packages; in bare-metal installs it ships inside the bundle
  and is imported from the application directory.

## System dependencies

- `ffmpeg` — audio processing/downloads (Debian/Ubuntu package; Docker
  `python:3.11-slim` + `apt install ffmpeg`).
- `Python >= 3.11`, `sqlite3` (stdlib).

## Frontend assets

- `client/fontawesome/` — Font Awesome Free (SIL OFL 1.1 for fonts, MIT/CC-BY-4.0
  for CSS; see files in that directory).
- Google Fonts (Montserrat) are loaded from the network at runtime, not bundled.

## Notes on reproducibility

Python dependencies are pinned in `server/requirements.txt`, except SpotiFLAC,
which intentionally tracks upstream `main` so downloads keep working, unless
`SPOTIFLAC_PIN_VERSION` (e.g. `0.7.0`) pins a release. The exact installed
SpotiFLAC version is recorded in Docker image labels and in each Linux
bundle's `VERSION.json` (`spotiflac` field) at release time.
