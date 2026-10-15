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

- GHCR `ghcr.io/nethminayasas/openfy:1.4.2`, `:1.4`, `:1`, `:latest`
  (multi-arch `linux/amd64` + `linux/arm64`, with SBOM + provenance
  attestations; OCI `version`/`revision`/`source`/`licenses` labels).
- Release assets: `openfy-v1.4.2-linux-amd64.tar.gz`,
  `openfy-v1.4.2-linux-arm64.tar.gz`, `SHA256SUMS`,
  `openfy-v1.4.2-sbom.spdx.json`.

For prerelease `v1.5.0-rc.1`: only `ghcr.io/nethminayasas/openfy:1.5.0-rc.1`
plus that version's bundles — stable aliases are untouched.

## If the run fails

- The workflow is **safe to rerun**: one concurrency group per tag prevents
  overlapping publishes; `gh release upload --clobber` converges assets
  instead of duplicating them; re-pushing an unchanged image digest is a
  no-op. Fix the cause, then **Re-run failed jobs** (or re-run all jobs).
- A failed run never moves stable aliases: `docker-publish` requires the
  smoke test, and `attach` requires everything.
- Check the job summary: tag-validation errors name the exact rule violated.

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

## Reproducibility notes

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
