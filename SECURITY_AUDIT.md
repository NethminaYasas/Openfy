# Openfy Security Audit Report

**Project:** Openfy (self-hosted music streaming server)  
**Path:** `/home/nethmina/Documents/GITHUB/Openfy`  
**Initial Audit:** April 07, 2026  
**Recheck:** April 16, 2026  
**Previous Update:** April 26, 2026  
**Latest Update:** May 14, 2026  
**Scope:** `server/app/`, `server/app/services/`, `client/`

---

## Executive Summary

As of **May 14, 2026**, a new hardening pass addressed a critical credential exposure, SSRF paths in remote artwork fetching, and unsafe remote image fetch bounds. A follow-up regression fix restored track/album cover rendering while preserving SSRF protections.

---

## Status Snapshot (May 14, 2026)

### Fixed In This Update

1. **Critical credential leak closed (`user_hash` exposed via track API)**
   - `TrackOut` previously included `user_hash`, which is also used as the bearer-style `x-auth-hash` auth credential.
   - Any authenticated user receiving another user's track payload could reuse that hash for impersonation.
   - Removed `user_hash` from `TrackOut`.
   - **Files:** `server/app/schemas.py`

2. **SSRF hardening for server-side remote image fetches**
   - Added strict URL safety validation for remote artwork/image URLs.
   - Blocks non-HTTP(S), `localhost`, and private/loopback/link-local/reserved network targets.
   - Applied to album/playlist cover fetch and import image probing paths.
   - **Files:** `server/app/main.py`

3. **Remote image fetch bounds and validation added**
   - Added remote fetch byte cap (`8MB`) to prevent oversized payload memory abuse.
   - Added response content-type validation (`image/*` when provided).
   - **Files:** `server/app/main.py`

4. **Playlist image URL input validation tightened**
   - Playlist `image_url` updates now validate/sanitize URL before persistence.
   - Invalid/unsafe URLs are rejected.
   - **Files:** `server/app/main.py`

5. **Auth hash input validation tightened at sign-in boundary**
   - `auth_hash` now requires strict lowercase hex format (`^[0-9a-f]{64}$`).
   - Reduces malformed input attack surface/noise.
   - **Files:** `server/app/schemas.py`

6. **Regression fixed: cover rendering restored**
   - During hardening, auth was temporarily enforced on artwork endpoints and broke browser `<img>` loading (custom auth headers are not sent for plain image tags).
   - Auth requirement for cover/artwork endpoints was reverted.
   - SSRF and remote fetch protections remain active.
   - **Files:** `server/app/main.py`

---

## Current Open Risks

### High (Design / Operational)

1. **Long-lived bearer auth model (`auth_hash`)**
   - If leaked, account access persists until rotated/replaced.
   - No robust session lifecycle (expiry/rotation/revocation) yet.

2. **Artwork endpoints remain headerless by design**
   - `/tracks/{track_id}/artwork` and `/albums/{album_id}/artwork` must currently support unauthenticated image-tag fetches.
   - Risk is reduced by current UUID path requirements and SSRF/path validation, but resource enumeration remains a consideration.
   - Medium severity in internet-exposed deployments.

3. **Rate limiting is in-memory only**
   - Not suitable for distributed deployments or process restarts.
   - Can be bypassed across multi-worker/multi-instance setups.

### Low (SQLAlchemy FK Cycle Warning)

4. **Circular FK between `tracks` and `users`**
   - `tracks.user_hash → users.auth_hash` and `users.last_track_id → tracks.id` creates a cycle.
   - SQLAlchemy cannot determine deterministic DROP order for tests, producing a SAWarning.
   - Not a runtime security issue, but should be resolved with `use_alter=True` on one FK or by adding `SET CONSTRAINTS DEFERRED`.

---

## Historical Context

The initial April 07, 2026 report identified major issues in auth coverage, access control, and path safety.  
Most of those issues were addressed by April 16, 2026 and further tightened by April 26, 2026.  
The April 27, 2026 pass resolved linting/deprecation/test correctness items.  
The May 05, 2026 pass added targeted protections for unauthenticated endpoint abuse, upload-size DoS risk, log hygiene, and frontend XSS sinks.  
The May 14, 2026 pass closed a critical credential leak and added SSRF/remote fetch protections, with a follow-up functional fix for artwork rendering.

---

## Recommended Next Steps (Prioritized)

1. Replace `auth_hash` bearer model with password/session or JWT + rotation/revocation.
2. Move rate limiting to Redis-backed or gateway-level controls.
3. Move artwork access to signed short-lived URLs (or cookie/session auth) instead of raw unauthenticated endpoints.
4. Add structured security logging for auth failures/token misuse patterns.
5. Resolve the `tracks ↔ users` FK cycle with `use_alter=True` on `users.last_track_id`.
6. Add automated SAST/dependency scanning in CI (`bandit`, `pip-audit`, `ruff`) and fail builds on new high-severity findings.

---

## Verification Notes (Latest Update)

Validation run during May 14, 2026 update:

1. `python -m compileall server/app` → **passed**.
2. `python -m compileall server/app/main.py server/app/schemas.py` → **passed**.
3. Manual runtime sanity check confirmed artwork rendering regression was fixed after removing auth requirement on artwork endpoints.
4. `pytest`, `ruff`, `bandit`, and `pip-audit` were not run in this pass and should be executed in CI.

---

*Last updated: May 14, 2026*
