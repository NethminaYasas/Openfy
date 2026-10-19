# Plan: Registration modes (open/invite) + `openfy` start/stop control

Status checklist (update after each phase):
- [x] Phase 0 — exploration complete
- [x] Plan written
- [x] Slice 1 — backend core: mode setting + InviteCode model/migration + invite service
- [x] Slice 2 — registration endpoint (both modes) + public endpoints + rate-limit scopes
- [x] Slice 3 — admin API (mode get/set, invite create/list/revoke)
- [x] Slice 4 — frontend admin: mode toggle + Invites UI (desktop + mobile)
- [x] Slice 5 — frontend signup: mode-aware invite field (desktop + mobile)
- [x] Slice 6 — backend tests (registration/invites) — 17 passed
- [x] Slice 7 — `openfy` CLI: start/stop/restart/status (systemd/docker/manual) + tests — 16 passed
- [x] Slice 8 — docs: README, .env.example, CHANGELOG, docs/API.md
- [ ] Phase 2 — fresh-reviewer audit + fixes + end-to-end verification
- [ ] Phase 3 — CodeRabbit local review, push, PR, triage its comments (max 3 rounds)

Branch: `feat(reg)-invite/open-registration` (already checked out, clean).

## Phase 0 findings (condensed)

- **Auth**: `POST /auth/signup` `main.py:3501` (`UserSignup{name}` only, `schemas.py:149`); response `UserOut` includes generated `auth_hash` (`secrets.token_hex(32)`). `POST /auth/signin` :3521. `GET /auth/me` :3533. Auth header `x_auth_hash` is a plain `Header(None)` per-endpoint, verified by `_require_user` :319 → `_get_user` :852. Admin check is inline `if not user.is_admin: 403` (no dependency). Admin bootstrapped in `_startup()` :810-845. Rate limit: `rate_limit(max, window)` `main.py:151-176`, in-memory key `auth:{ip}`; signup 10/300s, signin 15/300s. No passwords anywhere (password_hash vestigial).
- **System settings**: `AppSetting(key PK, value Text, updated_at)` `models.py:313-320`; table created via raw SQL `main.py:657-661`; bool helpers `_get_app_setting_bool`/`_set_app_setting_bool` `main.py:132-149`; **no cache** — every request reads SQLite, so runtime changes are immediate. Admin endpoints `GET/PUT /admin/settings` :3865/:3885; public `GET /system/settings` :3543. Seeding via `INSERT OR IGNORE` :662-667. Desktop settings UI `client/index.html:420-470` + `client/modules/admin.js:40-130` (+ listeners :490).
- **DB**: SQLAlchemy 2.0 `DeclarativeBase` (`db.py:7`), `Base.metadata.create_all` at `main.py:437` runs **before** inline PRAGMA/ALTER migrations (`main.py:438+`); new ORM tables auto-create; new columns need `ALTER TABLE` in `_startup()`. `Depends(get_db)` `db.py:34`; routes commit/rollback explicitly.
- **Admin frontend**: desktop only (`#page-admin` index.html:364, `admin.js` all logic, `api.js` HTTP, native `confirm()`, CSS classes `.settings-card`, `.toggle-switch/.toggle-slider` styles.css:2614). Mobile: **no admin UI at all** (profile menu → `/admin` which mobile routing falls back to Home).
- **Signup frontend**: desktop `client/index.html:17-49` + `client/main.js:699-720`; mobile `client/mobile/index.html:22-53` + `client/mobile/app.js:145-161`; API `signUp(name)` `client/modules/api.js:325`; errors = FastAPI `{"detail"}` shown verbatim via `showAuthStatus`/status elements. No `?invite=` handling anywhere.
- **Tests/CI**: pytest, `server/tests/` (11 files), `pyproject.toml [tool.pytest] pythonpath=["server"]`; CI jobs lint(ruff)/security(bandit -ll, pip-audit)/test(3.12 & 3.14)/docker/packaging. `.coderabbit.yaml`: auto-review disabled. CHANGELOG = Keep-a-Changelog, only `## [Unreleased]`, entries `- **Feature**: text`. Docs: API.md, LINUX_INSTALL.md, RELEASING.md, SECURITY_AUDIT.md.
- **`openfy` command**: **exists** — Linux-only Bash manager `scripts/linux/openfy` (608 lines, `set -euo pipefail`, hand-rolled `case` arg parsing, TUI menu + subcommands, `cmd_service` :237-249 = `require_root; systemctl <action> openfy`, `cmd_status` :149-209, usage prints header comment lines 2-30, source guard :606-608). No Docker/manual support, no PID files. Tests `server/tests/test_openfy_manager.py` source it and stub `systemctl`/`python3`/`require_root`. No `[project]` packaging exists (`pyproject.toml` is tool-config only). No Windows support anywhere in the repo.

## Decisions (and deviations from the task spec)

1. **Endpoint paths**: existing routes have no `/api` prefix, so use `/auth/registration-mode`, `/auth/invite/validate`, `/admin/registration-mode`, `/admin/invites...` (spec said "e.g.").
2. **Mode storage**: reuse `app_settings` table. New key `registration_mode` with string helpers `_get_registration_mode(db)` / `_set_registration_mode(db, mode)` in `main.py` next to the bool helpers. No cache (matches existing mechanism) → runtime changes take effect next request.
3. **Upgrade behavior/seed**: on startup, if `registration_mode` key is absent, seed from `OPENFY_REGISTRATION_MODE` (new setting, default `"invite"`). Env var never overrides an existing DB value. **Existing deployments therefore become invite-only on upgrade** — flagged as a behavior change in CHANGELOG (workaround: set env var or toggle in dashboard).
4. **Invite consumption**: single conditional `UPDATE ... WHERE use_count < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)` in the same transaction as user creation; `rowcount != 1` → generic 400 `Invalid invite code`. Rollback on any user-creation failure un-consumes the invite. Open-mode requests ignore any supplied code and do not consume it.
5. **Code format**: `secrets.token_urlsafe(16)` (22 chars), stored only as SHA-256 hex (`code_hash`, unique index), plus `code_prefix` (first 8 chars) for admin display. Plaintext returned exactly once at creation.
6. **User↔invite link**: nullable `users.invite_code_id` column added via inline `ALTER TABLE` (simplest fit for migration approach); `invite_codes` table via new ORM model (auto `create_all`).
7. **Rate limiting**: extend `rate_limit()` with a `scope` parameter so new endpoints get their own buckets (default `"auth"` preserves signup/signin behavior). Public mode endpoint 30/300s; invite validate 20/300s; signup stays 10/300s.
8. **Mode-change race**: mode is read once at the start of the signup request; a request is judged by the mode it read. Documented in docs + plan (accepted).
9. **Admin UI mobile**: no mobile admin UI exists today; required by spec, so add a minimal mobile Admin page (mode toggle + invites CRUD) in `client/mobile/`, reachable from the existing profile-menu Admin item instead of the broken `/admin` navigation.
10. **CLI — deviation**: instead of a new Python `[project.scripts]` entry point, **extend the existing Bash `openfy` manager** (`scripts/linux/openfy`) per "if an `openfy` command exists, extend it in its existing style". It gains deployment detection: explicit `--systemd|--docker|--manual`, else auto-detect (systemd unit → docker compose file + docker → manual repo checkout). Systemd path keeps current behavior (root required); docker uses `docker compose up -d`/`stop` (never `down`, never `--build`); manual launches `python3 -m uvicorn app.main:app` detached from `server/`, PID file + log in repo `data/` (or `$OPENFY_DATA_DIR`), stale-PID detection, process-identity check via `ps` for stop/start idempotence. Windows unsupported by the project → documented. Tests extend `server/tests/test_openfy_manager.py` harness (source + stub commands) rather than Python `mock.patch`, since the target is Bash.
11. **Logging mode changes**: standard `logging.getLogger(__name__)` at INFO (match whatever logging convention `main.py` already uses; if none, plain logging module, no basicConfig).

## Data/API contract

**`invite_codes`**: `id` (uuid hex str PK), `code_hash` (str(64), unique index), `code_prefix` (str(8)), `created_by` (str, admin name), `created_at`, `expires_at` (nullable), `max_uses` (int, default 1), `use_count` (int, default 0), `revoked_at` (nullable), `note` (str(200), nullable).

**Endpoints**
- `GET /auth/registration-mode` (public, rate-limited 30/300s) → `{"mode": "open"|"invite"}` only.
- `POST /auth/invite/validate` (public, rate-limited 20/300s) body `{"invite_code": str}` → `{"valid": bool}`.
- `POST /auth/signup` — body gains optional `invite_code` (max 128). Invite mode: required, else generic 400. Open mode: ignored.
- `GET /admin/registration-mode` (admin) → `{"mode": ...}`.
- `PUT /admin/registration-mode` (admin) body `{"mode": "open"|"invite"}` → validated, logged, returns `{"mode": ...}`.
- `POST /admin/invites` (admin) body `{max_uses?=1, expires_in_days?, note?}` → `{id, code, code_prefix, max_uses, expires_at, note, created_at}` (plaintext `code` once).
- `GET /admin/invites` (admin) → `{invites: [{id, code_prefix, note, created_by, created_at, expires_at, max_uses, use_count, revoked_at, status: active|used|expired|revoked, redeemers: [names]}]}` — never hashes/full codes.
- `DELETE /admin/invites/{id}` (admin) → sets `revoked_at`; 404 unknown; idempotent if already revoked.

## Slice briefs (each subagent returns ≤300 words; runs `ruff check server/` and `cd server && pytest` where relevant)

1. **Backend core** — `models.py` (+`InviteCode`, +`User.invite_code_id`), `settings.py` (+`registration_mode` validated `open|invite`, default `invite`), `main.py` (string setting helpers, startup seed, inline `ALTER TABLE users`, invite service functions or `server/app/services/invites.py`), `schemas.py` (invite schemas). No routes yet.
2. **Public/auth endpoints** — depends on 1. `main.py` signup changes, mode endpoint, validate endpoint, `rate_limit` scope param, schemas.
3. **Admin API** — depends on 2. `main.py` admin endpoints + logging, schemas.
4. **Frontend admin** — after 3. Desktop: settings toggle + confirmation + invites card (create/reveal-once/copy/list/badges/revoke/open-mode hint) in `index.html`, `admin.js`, `api.js`, `styles.css`. Mobile: minimal admin page in `mobile/index.html`, `mobile/app.js` (+ mobile CSS), wired from profile menu.
5. **Frontend signup** — after 4 (same mobile files). Mode fetch on load, invite field show/hide, `?invite=` prefill, graceful mode-fetch failure (default show field), re-fetch + non-leaky error on rejection. Desktop `index.html`, `main.js`, mobile `index.html`, `app.js`, `api.js`.
6. **Tests** — after 3, parallel with 4/5/7. New `server/tests/` files following existing patterns (isolated temp SQLite, TestClient with lifespan). Covers: open-mode no code + supplied code ignored/unconsumed; invite mode rejects missing/invalid/expired/revoked/exhausted; single-use race; rollback on duplicate name; runtime mode switch both directions; invite survives mode round-trip; non-admin rejected; public endpoint leaks only mode; env seeds only when no DB value.
7. **CLI** — independent. `scripts/linux/openfy` (mode detection, flags, docker/systemd/manual start/stop/restart/status, PID file, stale detection, identity check, health wait, timeouts, help/usage) + tests in `server/tests/` extending the existing bash-stub harness; `bash -n` check.
8. **Docs** — after 5 & 7. README ("Registration modes and invites", "Managing the server"), `.env.example`, CHANGELOG (Added + Changed), `docs/API.md`, `docs/LINUX_INSTALL.md` CLI mention.

## Verification notes
- Local machine is Windows; repo has no Windows support. E2E: pytest TestClient-backed checks + run server manually via uvicorn for API-level checks; use `docker compose` only if Docker is available (check with `docker --version`).
- Commits: one per slice/phase, conventional message style (repo uses `feat(ui):`, `fix(ui):` etc. with scope).
- The `plans/` file stays on the branch during work; decide at PR time whether to keep it.
