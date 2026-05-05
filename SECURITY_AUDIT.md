# Openfy Security Audit Report

**Project:** Openfy (self-hosted music streaming server)  
**Path:** `/home/nethmina/Documents/GITHUB/Openfy`  
**Initial Audit:** April 07, 2026  
**Recheck:** April 16, 2026  
**Previous Update:** April 26, 2026  
**Latest Update:** May 05, 2026  
**Scope:** `server/app/`, `server/app/services/`, `client/`

---

## Executive Summary

As of **May 05, 2026**, an additional targeted security hardening pass was completed on backend access control, upload abuse protections, sensitive logging, and frontend DOM injection points. Newly identified exploitable paths were patched and validated with backend tests.

---

## Status Snapshot (May 05, 2026)

### Fixed In This Update

1. **Unauthenticated artwork access closed**
   - `/tracks/{track_id}/artwork` now requires `x-auth-hash`.
   - Prevents unauthenticated media metadata/artwork enumeration.
   - **Files:** `server/app/main.py`

2. **Unauthenticated backend proxy/search abuse closed**
   - `/spotify-search` now requires authenticated user context.
   - Prevents public abuse of server-side search resources.
   - **Files:** `server/app/main.py`

3. **Upload DoS guard added (server-side size enforcement)**
   - `/tracks/upload` now enforces max file size while streaming to disk.
   - New configurable setting: `OPENFY_MAX_UPLOAD_SIZE_MB` (default `200`).
   - Returns HTTP `413` when size limit is exceeded.
   - **Files:** `server/app/main.py`, `server/app/settings.py`

4. **Sensitive queue logging removed**
   - Removed warning log line that emitted user auth-hash prefix and track IDs.
   - Reduces accidental sensitive data leakage in logs.
   - **Files:** `server/app/main.py`

5. **Frontend DOM XSS sinks hardened**
   - Escaped user-controlled artist/title strings before insertion into `innerHTML`.
   - Preserved clickable artist rendering while neutralizing script/HTML injection payloads.
   - **Files:** `client/modules/audio-player.js`, `client/modules/ui.js`

---

## Current Open Risks

### High (Design / Operational)

1. **Long-lived bearer auth model (`auth_hash`)**
   - If leaked, account access persists until rotated/replaced.
   - No robust session lifecycle (expiry/rotation/revocation) yet.

2. **Rate limiting is in-memory only**
   - Not suitable for distributed deployments or process restarts.
   - Can be bypassed across multi-worker/multi-instance setups.

### Low (SQLAlchemy FK Cycle Warning)

3. **Circular FK between `tracks` and `users`**
   - `tracks.user_hash → users.auth_hash` and `users.last_track_id → tracks.id` creates a cycle.
   - SQLAlchemy cannot determine deterministic DROP order for tests, producing a SAWarning.
   - Not a runtime security issue, but should be resolved with `use_alter=True` on one FK or by adding `SET CONSTRAINTS DEFERRED`.

---

## Historical Context

The initial April 07, 2026 report identified major issues in auth coverage, access control, and path safety.  
Most of those issues were addressed by April 16, 2026 and further tightened by April 26, 2026.  
The April 27, 2026 pass resolved linting/deprecation/test correctness items.  
The May 05, 2026 pass added targeted protections for unauthenticated endpoint abuse, upload-size DoS risk, log hygiene, and frontend XSS sinks.

---

## Recommended Next Steps (Prioritized)

1. Replace `auth_hash` bearer model with password/session or JWT + rotation/revocation.
2. Move rate limiting to Redis-backed or gateway-level controls.
3. Add structured security logging for auth failures/token misuse patterns.
4. Resolve the `tracks ↔ users` FK cycle with `use_alter=True` on `users.last_track_id`.
5. Add automated SAST/dependency scanning in CI (`bandit`, `pip-audit`, `ruff`) and fail builds on new high-severity findings.

---

## Verification Notes (Latest Update)

Validation run during May 05, 2026 update:

1. `pytest -q` (from `server/`) → **17 passed**.
2. `python -m compileall app` (from `server/`) → **passed**.
3. `node --check client/modules/audio-player.js` → **passed**.
4. `node --check client/modules/ui.js` → **passed**.
5. `ruff`, `bandit`, and `pip-audit` were not available in the local environment during this run and should be executed in CI.

---

*Last updated: May 05, 2026*
