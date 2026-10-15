# Releasing Openfy

This is the maintainer's checklist. End users: see `docs/LINUX_INSTALL.md`
and the installation section in `README.md`.

## Publish a release (web UI only)

1. Merge the intended changes into `main` and make sure CI is green.
2. Update `CHANGELOG.md` (`[Unreleased]` → new version section). The Git tag
   is the authoritative version — there is no version file to bump in the
   repo. (`VERSION.json` inside bundles and Docker OCI labels are injected
   from the tag at build time.)
3. Open GitHub → Releases → **Draft a new release**.
4. **Choose a tag** (create on publish), e.g. `v1.4.2` (stable) or
   `v1.5.0-rc.1` (prerelease). Tag rules:
   - stable: `vMAJOR.MINOR.PATCH` (e.g. `v1.4.2`) — anything else fails fast
     with a clear error;
   - prerelease: append `-rc.N`, `-beta.N`, or `-alpha.N` (e.g. `v1.5.0-rc.1`)
     **and** tick **"Set as a pre-release"**. The workflow cross-checks the
     checkbox against the tag suffix and fails if they disagree, so stable
     aliases (`1.4`, `1`, `latest`) can never be moved by a prerelease.
5. Target `main`, write release notes, press **Publish release**.
6. Watch the **Release** workflow run. It builds from the exact tag commit
   (verified via `git rev-list`), runs the full gate (ruff, pytest,
   `bash -n`, YAML checks, bundle packaging + validation), smoke-tests the
   Docker image, pushes the multi-arch image to GHCR, builds both Linux
   bundles, attaches them to the same release, and verifies every tag and
   asset before reporting success. Nothing needs uploading by hand.

## What gets published

For stable `v1.4.2`:

- GHCR `ghcr.io/nethminayasas/openfy:1.4.2` is pushed first; the mutable
  aliases `:1.4`, `:1`, `:latest` are promoted to it only after the Linux
  bundles and SBOM are attached and verified (separate `promote` step, no
  rebuild — a late failure can never move them). Promotions are serialised
  across tags and refuse to move an alias backwards: each alias records its
  version, so an older release finishing late can never downgrade `latest`.
  (multi-arch `linux/amd64` + `linux/arm64`, with SBOM + provenance
  attestations; OCI `version`/`revision`/`source`/`licenses` labels).
- Release assets: `openfy-v1.4.2-linux-amd64.tar.gz`,
  `openfy-v1.4.2-linux-arm64.tar.gz`, `SHA256SUMS`,
  `openfy-v1.4.2-sbom.spdx.json`.

For prerelease `v1.5.0-rc.1`: only `ghcr.io/nethminayasas/openfy:1.5.0-rc.1`
plus that version's bundles — stable aliases are untouched.

## If the run fails

Distinguish *what* failed before deciding how to recover:

- **`resolve` rejects the tag or prerelease setting** (invalid tag like
  `v1.4`, or a `-rc.N` tag without the pre-release checkbox, or vice
  versa): rerunning cannot help — the same ref fails identically. Publish a
  corrected release instead (delete the bad release/tag if already created,
  then create a new tag such as `v1.4.2` or tick the pre-release box).
  The job message names the exact rule violated.
- **Any later failure** (tests, Docker build/smoke test, bundle packaging,
  push, asset upload): the workflow is **safe to rerun** on the original ref
  and commit — one concurrency group per tag prevents overlapping publishes;
  if the exact version image is already published from the same commit it is
  reused (revision verified) instead of rebuilt; `gh release upload --clobber`
  converges assets instead of duplicating them. Fix the cause, then
  **Re-run failed jobs** (or re-run all jobs).
- A failed run never moves stable aliases: the `promote` step runs only after
  the versioned image, bundles, SBOM, and their verification all succeed.
  Promotion additionally refuses to move an alias backwards, and aborts
  rather than guesses when an alias's current target cannot be determined
  (e.g. it exists without a recorded version — inspect or remove it
  manually, then rerun).

## Repository settings required (one-time manual setup)

These cannot be committed and must be configured by someone with admin access:

1. **GHCR visibility**: after the first successful release, the
   `openfy` container package appears under the GitHub org/user packages.
   Change it from private to **public** (Package settings → Change
   visibility), otherwise `docker pull` requires authentication.
2. **Workflow permissions**: repo Settings → Actions → General → Workflow
   permissions → **Read repository contents and packages permissions** is
   enough (the workflow escalates per-job: `packages: write` for publishing,
   `contents: write` for asset upload, `attestations`/`id-token` for build
   provenance). No Docker Hub credentials or extra secrets needed —
   publishing uses the built-in `GITHUB_TOKEN`.
3. **(Optional) Required checks**: you may mark the `CI` jobs as required
   branch protection on `main`; the release pipeline re-runs the same gates
   on the tag commit regardless.

## Root installer contract (do not break)

The root `install.sh` bootstrap (fetched via the one-line installer URL) is
NOT part of the release bundles — it downloads them. It depends on this
contract; keep it stable across releases:

- Asset names: `openfy-v<VERSION>-linux-amd64.tar.gz`,
  `openfy-v<VERSION>-linux-arm64.tar.gz`, `SHA256SUMS` (all required),
  `openfy-v<VERSION>-sbom.spdx.json` (informational).
- Tag convention: `vMAJOR.MINOR.PATCH`, optional `-rc.N` / `-beta.N` /
  `-alpha.N` suffix (see `scripts/release/common.sh`, the single source of
  truth mirrored by the bootstrap and the packaging tests).
- Every bundle contains a top-level `openfy-v<VERSION>-<arch>/` directory
  with `VERSION.json` (`version`, `tag`, `arch` fields matching the release),
  plus working `install.sh` (accepting `--admin-user`, `--no-start`,
  `--allow-unsupported-os`, `--force`, `--no-generate-credential`,
  `--no-install-deps`, `--repair`), `update.sh` (`--archive`), and
  `uninstall.sh`.
- CI enforces this: `server/tests/test_bootstrap_installer.py` sources the
  bootstrap's functions against a mocked GitHub API, and the packaging
  validation rebuilds + verifies both bundles on every PR.

## Docker image notes

- The image is a single `python:3.11-slim` stage (not multi-stage) on
  purpose: `ffmpeg` is a runtime dependency, and build-only packages (`git`,
  `curl`) are purged in the same layer with caches cleaned, so a separate
  builder stage would save nothing measurable while complicating the
  `spotiflac` install. Revisit only if build tooling grows.
- `linux/arm64` Docker images are **built but not runtime smoke-tested** in

- Bundle contents come from the tag commit; tar metadata is normalised
  (`--sort-name`, fixed owner, `SOURCE_DATE_EPOCH` mtime). `VERSION.json`
  carries a `built_at` timestamp, so byte-identical rebuilds are not
  guaranteed — documented, not hidden.
- `server/requirements.txt` is pinned, **except SpotiFLAC, which
  intentionally tracks upstream `main`** so downloads keep working (same
  behaviour as existing Docker builds). Set `SPOTIFLAC_PIN_VERSION=x.y.z`
  (repo variable or build env) to pin a release; the resolved policy is
  recorded in `VERSION.json` (`spotiflac` field) and Docker labels.
- `linux/arm64` Docker images are **built but not runtime smoke-tested** in
  CI (native `amd64` runners); the workflow and release notes say so
  explicitly. The Python-source Linux bundles are arch-independent and
  resolve native wheels at install time.
- No signatures are attached: integrity is via `SHA256SUMS`
  (`sha256sum -c SHA256SUMS`) plus GHCR digest pinning. Do not claim
  otherwise in release notes.

## Reproducibility notes
