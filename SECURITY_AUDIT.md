# Openfy Security Audit Report

**Project:** Openfy (self-hosted music streaming server)  
**Path:** `/home/nethmina/Documents/GITHUB/Openfy`  
**Initial Audit:** April 07, 2026  
**Recheck:** April 16, 2026  
**Latest Update:** April 26, 2026  
**Scope:** `server/app/`, `server/app/services/`, `client/`

---

## Executive Summary

The codebase has materially improved since the initial April 07, 2026 audit.  
As of **April 26, 2026**, the highest-impact practical risks found in this pass were remediated:

1. Removed bearer auth leakage in stream URLs by introducing short-lived stream tokens.
2. Locked down playlist cover endpoint with authentication + ownership checks.
3. Added anti-caching headers on sensitive auth/token endpoints.
4. Fixed downloader crash paths caused by malformed logging calls and dead logic.
5. Fixed admin track-delete consistency edge case.
6. Added read-path indexes and cover caching to reduce load/perf pressure.

Open risks remain around long-lived token auth design and operational hardening (rate limiting/session model), but no newly-identified unauthenticated critical data-access issue remains open from this round.

---

## Status Snapshot (April 26, 2026)

### Fixed In This Update

1. **Auth token in streaming query string replaced**
- **Before:** `GET /tracks/{id}/stream?auth=<auth_hash>`
- **Now:** `GET /tracks/{id}/stream-token` issues short-lived token, stream uses `?token=<short_lived>`
- **Files:** `server/app/main.py`, `client/script.js`

2. **Playlist cover endpoint access control added**
- **Before:** cover endpoint was unauthenticated.
- **Now:** requires auth and enforces owner/admin authorization.
- **Files:** `server/app/main.py`, `client/script.js`

3. **Sensitive response anti-cache headers added**
- Added `Cache-Control: no-store` and `Pragma: no-cache` for `/auth/*` and `/stream-token`.
- **Files:** `server/app/main.py`

4. **Downloader reliability/security bugfixes**
- Corrected bad `_append_log(...)` invocations that could raise runtime exceptions.
- Removed dead branch with undefined variable (`apple_match`).
- Marked worker threads daemonized.
- **Files:** `server/app/services/spotiflac.py`

5. **Admin track delete consistency fix**
- Prevents failing API response after successful DB delete due to late path check.
- File delete is now safe best-effort after validated target.
- **Files:** `server/app/main.py`

6. **Performance hardening**
- Added startup indexes for common query paths.
- Playlist cover now reuses cached collage file when present.
- Improved image resource handling via context manager.
- **Files:** `server/app/main.py`

7. **Test bootstrap reliability**
- Added test import path bootstrap so tests run from repo root consistently.
- **Files:** `server/tests/conftest.py`

---

## Current Open Risks

### High (Design / Operational)

1. **Long-lived bearer auth model (`auth_hash`)**
- If leaked, account access persists until rotated/replaced.
- No robust session lifecycle (expiry/rotation/revocation) yet.

2. **Rate limiting is in-memory only**
- Not suitable for distributed deployments or process restarts.
- Can be bypassed across multi-worker/multi-instance setups.

### Medium

3. **Legacy deprecations and schema lifecycle debt**
- Pydantic class-based config and FastAPI `on_event` deprecations present.
- Not immediate security vulnerabilities, but increases maintenance risk.

---

## Historical Context

The initial April 07, 2026 report identified major issues in auth coverage, access control, and path safety.  
Most of those issues were addressed by April 16, 2026 and further tightened by April 26, 2026.

This document is now the canonical **current-state** summary.  
Older vulnerability IDs from the initial report are retained in git history but are intentionally not repeated here to avoid stale severity/index mismatches.

---

## Recommended Next Steps (Prioritized)

1. Replace `auth_hash` bearer model with password/session or JWT + rotation/revocation.
2. Move rate limiting to Redis-backed or gateway-level controls.
3. Add structured security logging for auth failures/token misuse patterns.
4. Migrate deprecated framework patterns (Pydantic `ConfigDict`, FastAPI lifespan events).
5. Add automated SAST/dependency scanning in CI (`bandit`, `pip-audit`, etc.).

---

## Verification Notes (Latest Update)

Validation run during April 26, 2026 update:

1. `pytest -q server/tests` → **13 passed**
2. `python -m compileall -q server/app` → **passed**
3. `node --check client/script.js` → **passed**

---

*Last updated: April 26, 2026*
