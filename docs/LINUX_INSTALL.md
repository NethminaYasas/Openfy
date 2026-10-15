# Openfy on bare-metal Linux (no Docker)

This guide covers installing Openfy directly on a systemd-based Linux server
using the downloadable release archives. No Docker or Docker Compose required,
no Node.js/npm required (the frontend is vanilla JavaScript).

Supported: current **Ubuntu** and **Debian** releases (other systemd distros
work with `--allow-unsupported-os`), architectures **x86-64 (`linux-amd64`)**
and **ARM64 (`linux-arm64`)**. Requires **Python 3.11+**, `ffmpeg`, and
systemd. Dependencies are installed from the bundled `requirements.txt` into
an isolated virtualenv at install time, so an internet connection is required
during installation and updates.

## Layout

| Path | Contents |
|---|---|
| `/opt/openfy/` | Application code, virtualenv, scripts (replaced on update) |
| `/etc/openfy/openfy.env` | Your configuration incl. admin credential (preserved across updates/reinstalls) |
| `/var/lib/openfy/` | Database (`openfy.db`), `music/`, `downloads/`, `artwork/`, `avatars/` (preserved across updates, reinstalls, and normal uninstalls) |
| `/etc/systemd/system/openfy.service` | systemd unit (logs to the journal) |

The service runs as the dedicated `openfy` system user and reads config from
`/etc/openfy/openfy.env`:

```ini
OPENFY_ENV=prod
OPENFY_ADMIN_USERNAME=admin
OPENFY_ADMIN_HASH=of1_...
OPENFY_ALLOWED_ORIGINS=http://localhost:8000
OPENFY_MAX_UPLOAD_SIZE_MB=200
OPENFY_DATA_DIR=/var/lib/openfy
OPENFY_MUSIC_DIR=/var/lib/openfy/music
OPENFY_DOWNLOADS_DIR=/var/lib/openfy/downloads
OPENFY_ARTWORK_DIR=/var/lib/openfy/artwork
OPENFY_DATABASE_URL=sqlite:////var/lib/openfy/openfy.db
```

## Install

1. Download the archive matching your CPU from the GitHub Release page, plus
   `SHA256SUMS`, all into one directory. Verify integrity first:

   ```bash
   sha256sum -c --ignore-missing SHA256SUMS
   ```

   Every downloaded file must report `OK` (missing optional assets are
   skipped). Do not install if verification fails.

2. Extract and install:

   ```bash
   tar -xzf openfy-v1.4.2-linux-amd64.tar.gz   # use the real version + your arch
   cd openfy-v1.4.2-linux-amd64
   sudo ./install.sh
   ```

   The installer checks OS/arch/Python/systemd, creates the `openfy` user,
   installs `/opt/openfy`, writes a default `/etc/openfy/openfy.env` (existing
   config is never overwritten), builds the virtualenv, installs the systemd
   unit, enables it, and waits for the health check.

3. Generate an admin credential and configure Openfy:

   ```bash
   sudo /opt/openfy/venv/bin/python /opt/openfy/generate_hash.py
   sudoedit /etc/openfy/openfy.env   # set OPENFY_ADMIN_HASH to the value above
   sudo systemctl restart openfy
   ```

   Also set `OPENFY_ALLOWED_ORIGINS` to the URL(s) you serve Openfy from
   (comma-separated), e.g. `https://music.example.com`.

4. Open `http://<server-ip>:8000` in a browser and sign in with the credential
   in the Auth Hash field.

Useful installer options: `--no-start` (install without starting),
`--allow-unsupported-os`, `--force` (reinstall same-version files).

## Service management

```bash
sudo systemctl start openfy
sudo systemctl stop openfy
sudo systemctl restart openfy
sudo systemctl status openfy
sudo journalctl -u openfy -f
```

To try things manually in the foreground (uses the installed virtualenv and
config; warns if the systemd service already holds port 8000):

```bash
sudo -u openfy /opt/openfy/start.sh
```

## Update

```bash
cd /opt/openfy
sudo ./update.sh --latest              # latest stable release
sudo ./update.sh --version 1.5.0      # an explicit version
sudo ./update.sh --version 1.5.0-rc.1 # explicit prereleases are supported
```

The updater resolves the release, downloads the archive for your CPU,
**verifies its SHA-256 checksum before touching anything**, backs up
`/etc/openfy/openfy.env` and the SQLite database to a timestamped directory
under `/var/backups/openfy/`, stops the service, replaces only application
files, reinstalls dependencies, restarts, and health-checks. On failure it
restores the previous application files and restarts the service; your config
and data are never modified, and the backup directory tells you how to restore
the database manually if needed. To install from a pre-downloaded file:

```bash
sudo ./update.sh --archive /path/to/openfy-v1.5.0-linux-amd64.tar.gz
```

## Uninstall

```bash
sudo /opt/openfy/uninstall.sh          # interactive; keeps data + config
sudo /opt/openfy/uninstall.sh --yes    # non-interactive; still keeps data + config
```

Data (`/var/lib/openfy`) and config (`/etc/openfy`) survive a normal
uninstall. Deleting them requires explicit destructive flags plus a second
confirmation:

```bash
sudo /opt/openfy/uninstall.sh --purge  # ALSO deletes data + config (irreversible)
```

`--remove-data` / `--remove-config` delete only that side. The `openfy`
service account is left in place (remove manually with `userdel openfy` if
you really want to).

## Backups

Back up `/var/lib/openfy/openfy.db` (SQLite — prefer `sqlite3 db ".backup
backup.db"` or the automatic pre-update backups under `/var/backups/openfy/`)
and `/var/lib/openfy/music/`. Keep `/etc/openfy/openfy.env` (admin credential)
in a safe place.

## Troubleshooting

- `service did not become healthy`: `sudo systemctl status openfy` and
  `sudo journalctl -u openfy -n 100`. Common causes: unset `OPENFY_ADMIN_HASH`
  is fine (server still starts), but a bad `OPENFY_DATABASE_URL` or a port
  already in use is not.
- `Python 3.x is too old`: install Python 3.11+ and rerun `install.sh`
  (it repairs the install without touching data/config).
- `bundle arch ... does not match host`: you downloaded the wrong archive.
- Downloads failing: install `ffmpeg` (`sudo apt install ffmpeg`) and check
  connectivity to upstream providers.
- Port 8000 already in use: stop the other process or the systemd service
  before running `start.sh` manually.
