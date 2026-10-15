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

## One-line installer (recommended)

No cloning, no manual downloads. The bootstrap detects your OS/architecture,
resolves the release from the official GitHub repository, downloads the
archive for your CPU plus `SHA256SUMS`, **verifies the checksum before
executing anything from the bundle**, then delegates to the verified
bundle's installer:

Run in a **root Bash shell** (`sudo -i` if needed), with `curl` installed:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh)
```

To install a specific published version, append its tag:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh) v0.1.0
```

Replace `v0.1.0` with the release you want. Without a version, the installer
offers the latest stable release.

For a downloaded copy or a specific version:

```bash
# Latest stable release (interactive wizard; native installs need a root shell):
curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh

# An exact version (installs EXACTLY this version; example uses the
# vMAJOR.MINOR.PATCH tag convention — see the Releases page for real versions):
curl -fsSL https://raw.githubusercontent.com/NethminaYasas/Openfy/main/install.sh -o install.sh && sudo bash install.sh v1.4.2

# Already downloaded (same behaviour; native installs need root):
sudo bash install.sh v1.4.2
```

Version policy: with no version argument you get the latest **stable**
release (prereleases and drafts are never selected). An explicit version
installs exactly that published release — a missing/invalid/draft release,
or one without assets for your architecture, is a fatal error (the installer
never substitutes another version). Prerelease versions require
`--include-prerelease` (or a wizard confirmation); drafts are never
installed.

Non-interactive usage (automation):

```bash
sudo bash install.sh --yes --version 1.4.2
sudo bash install.sh --yes --action upgrade --version 1.5.0
sudo bash install.sh --yes --method docker --version 1.4.2
sudo bash install.sh --dry-run --version 1.4.2   # print the plan, change nothing
```

Useful options: `--method native|docker`, `--action
install|upgrade|repair|reinstall|uninstall`, `--admin-user NAME`,
`--no-start`, `--allow-unsupported-os`, `--force`, `--arch
linux-amd64|linux-arm64`, `--no-install-deps`, `--no-generate-credential`,
`--rotate-credential`, `--purge` (with `--action uninstall`), `--dry-run`.
Full list: `bash install.sh --help`.

On a fresh install the wizard asks for the admin username (default `admin`)
and generates the initial admin credential automatically (printed **once** at the end of a successful install —
save it in a password manager). Existing installs are detected and offered
**Upgrade / Repair / Reinstall / Uninstall**; upgrades use the bundle's
`update.sh` (config + database backup, rollback on failure), repairs
re-verify files and the service without touching config or data.

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

## Manual install (without the bootstrap)

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

3. Save the admin credential printed by the installer (generated
   automatically on fresh installs, shown **once**). If you passed
   `--no-generate-credential`, generate one manually instead:

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
`--allow-unsupported-os`, `--force` (reinstall same-version files),
`--admin-user NAME`, `--no-install-deps`, `--repair` (verify + fix without
touching config/data), `--rotate-credential` (new admin secret, explicit).

## Service management

The installer also provides `sudo openfy` — a text-menu manager (no extra
dependencies) for status, logs, start/stop/restart, update to latest or a
specific version (older versions downgrade), port changes, credential
rotation, username changes, repair, and uninstall.

```bash
sudo openfy
sudo openfy status
sudo openfy logs
sudo openfy restart
sudo openfy update --latest
sudo openfy port 9000
sudo openfy rotate-credential
sudo openfy repair
sudo openfy uninstall
```

To try things manually in the foreground (uses the installed virtualenv and
config; warns if the systemd service already holds port 8000):

```bash
sudo -u openfy /opt/openfy/start.sh
```

## Admin credentials

The admin sign-in uses a generated `of1_...` credential stored as
`OPENFY_ADMIN_HASH` (`/etc/openfy/openfy.env`, mode `640`) — the same format
produced by `scripts/generate_hash.py` and enforced by the application's
auth code. Fresh installs generate one automatically and print it **once**:
save it in a password manager. The installer never prints existing
credentials on upgrades, repairs, or status checks, and never overwrites an
existing config.

Rotate the credential explicitly (backs up the config, prints the new secret
once, restarts the service automatically to apply it, keeps everything else):

```bash
sudo /opt/openfy/install.sh --rotate-credential
```

If you lose the printed credential, root can still read it as
`OPENFY_ADMIN_HASH` in `/etc/openfy/openfy.env` (mode `640`). Otherwise
rotate to a new one — a lost credential cannot be "looked up" without shell
access to that file.

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

## Repair

If application files are damaged, repair from a freshly verified bundle
(config and data are intact):

```bash
sudo bash install.sh --yes --action repair
```

If only permissions, the venv, or the systemd unit are broken, the installed
copy can repair in place (it does not restore application files):

```bash
sudo /opt/openfy/install.sh --repair
```

Repair fixes ownership/permissions, rebuilds the virtualenv dependencies,
reinstalls the systemd unit, and health-checks —
`/etc/openfy/openfy.env` and `/var/lib/openfy/` are never modified. The
one-line installer offers the same via its wizard (**Repair**). If the
repair itself fails, the service logs (`journalctl -u openfy -n 100`) show
why; your data and config are still untouched.

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

- `release vX.Y.Z not found` / `has no asset ... for your architecture`:
  check the version on the Releases page (`v` prefix optional,
  e.g. `1.4.2` and `v1.4.2` are equivalent). The installer never substitutes
  another version — fix the version argument and rerun.
- `CHECKSUM MISMATCH`: the download is corrupt or tampered with. Nothing was
  installed. Rerun; if it persists, download the archive + `SHA256SUMS`
  manually and verify with `sha256sum -c --ignore-missing SHA256SUMS`.
- `unsupported distribution`: tested on Ubuntu/Debian; rerun with
  `--allow-unsupported-os` on other systemd distros (or use Docker).
- `native installation requires root`: rerun the downloaded script with
  `sudo` (`sudo bash install.sh ...`).
- `port 8000 is already in use`: stop the conflicting process (or the old
  `openfy` service) and rerun. The installer refuses to start a second
  server on the same port.
- `service did not become healthy`: `sudo systemctl status openfy` and
  `sudo journalctl -u openfy -n 100`. Common causes: unset `OPENFY_ADMIN_HASH`
  is fine (server still starts), but a bad `OPENFY_DATABASE_URL` or a port
  already in use is not.
- `pydantic-core` / PyO3 build fails on Python 3.14, or SQLAlchemy fails
  while importing `typing.Union`: older releases pin dependencies that do
  not support Python 3.14. The bootstrap downloads a published release archive
  even when run from a repository checkout; changing the checkout does not
  change an already published archive. For an installation that failed during
  dependency setup, update its local pins and repair in place (keeps config and
  data):

  ```bash
  sudo sed -i -e 's/^pydantic==2\.9\.2$/pydantic==2.12.5/' -e 's/^SQLAlchemy==2\.0\.36$/SQLAlchemy==2.0.54/' /opt/openfy/requirements.txt
  sudo /opt/openfy/install.sh --repair
  ```

  Future installs and upgrades need a release containing these updated
  requirements; reinstalling an older release restores its old pins.
- `Python 3.x is too old`: install Python 3.11+ and rerun `install.sh`
  (it repairs the install without touching data/config).
- `bundle arch ... does not match host`: you downloaded the wrong archive.
- Downloads failing: install `ffmpeg` (`sudo apt install ffmpeg`) and check
  connectivity to upstream providers.
- Port 8000 already in use: stop the other process or the systemd service
  before running `start.sh` manually.
