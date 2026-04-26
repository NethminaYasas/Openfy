# Openfy Security Audit Report

**Project:** Openfy (self-hosted music streaming server)  
**Path:** `/home/nethmina/Documents/GITHUB/Openfy`  
**Initial Audit:** April 07, 2026  
**Recheck:** April 16, 2026  
**Previous Update:** April 26, 2026  
**Latest Update:** April 27, 2026  
**Scope:** `server/app/`, `server/app/services/`, `client/`

---

## Executive Summary

As of **April 27, 2026**, a comprehensive security, performance, and bug-fix pass was performed. All previously identified high/medium issues remain resolved. This pass focused on code correctness, deprecation removal, and test reliability. Bandit now reports **0 unflagged issues** (all remaining Low-severity `except: pass` patterns carry explicit `# nosec` justifications). Ruff lint is fully clean with 0 errors. All 17 tests pass.

---

## Status Snapshot (April 27, 2026)

### Fixed In This Update

1. **Import ordering violations (E402) — Ruff**
   - Module-level imports in `main.py` and `db.py` were placed after executable code, violating PEP 8 and Ruff E402.
   - All local imports moved to the top; logging configuration relocated below imports.
   - **Files:** `server/app/main.py`, `server/app/db.py`

2. **Unused variable assignments removed (F841) — Ruff**
   - `user =` in `get_track()` (assigned but never used after auth check).
   - `is_spotify =` in `spotiflac.py` (dead assignment from removed branch).
   - `user1`, `auth2`, `user1` in test file (dead variables in test helpers).
   - **Files:** `server/app/main.py`, `server/app/services/spotiflac.py`, `server/tests/test_track_playlists.py`

3. **Deprecated `@app.on_event("startup")` migrated to lifespan**
   - FastAPI's `on_event` is deprecated since v0.93. Migrated to `@asynccontextmanager` lifespan pattern.
   - **Files:** `server/app/main.py`

4. **Deprecated Pydantic `class Config` migrated to `model_config = ConfigDict(...)`**
   - All 8 schema classes updated from `class Config: from_attributes = True` to the Pydantic v2 `model_config = ConfigDict(from_attributes=True)` pattern.
   - **Files:** `server/app/schemas.py`

5. **`datetime.utcnow()` deprecation fixed**
   - Python 3.12+ deprecated `datetime.utcnow()`. All call sites migrated to `datetime.now(timezone.utc).replace(tzinfo=None)` for SQLite-compatible naive UTC storage.
   - All ORM model `default=` lambdas fixed: `datetime.UTC` → `timezone.utc` (correct attribute on the `timezone` class, not `datetime` class).
   - **Files:** `server/app/main.py`, `server/app/models.py`

6. **Bug: `datetime.UTC` AttributeError on model insert**
   - The auto-replace script introduced `lambda: datetime.now(datetime.UTC)` — but `datetime.UTC` doesn't exist on the `datetime` *class*. The correct reference is `timezone.utc` from the `datetime` *module*.
   - Fixed and `timezone` imported in `models.py`.
   - **Files:** `server/app/models.py`

7. **Bug: Offset-naive vs offset-aware datetime subtraction**
   - SQLite stores datetimes without timezone info (offset-naive), causing `TypeError` when subtracting `datetime.now(timezone.utc)` (offset-aware) from stored values.
   - Fixed `_get_user()` and the admin stats `five_mins_ago` calculation to use naive UTC via `.replace(tzinfo=None)`.
   - **Files:** `server/app/main.py`

8. **Bug: `_migrate()` called at module import time (before tables exist)**
   - The `_migrate()` function ran at import, before ORM tables were created, causing `OperationalError: no such table: users` during test collection.
   - Removed standalone `_migrate()` and inlined the `queue_data` column migration into `_startup()`, which runs after `Base.metadata.create_all()`.
   - **Files:** `server/app/main.py`

9. **Bug: Wrong endpoint URL in upload-toggle tests**
   - `test_manual_upload_toggle_off_blocks_*` tests called `/admin/settings/manual-upload` which doesn't exist; the actual endpoint is `PUT /admin/settings`.
   - **Files:** `server/tests/test_track_playlists.py`

10. **Bandit B110/B112 intentional patterns annotated with `# nosec`**
    - All 7 Low-severity `except: pass/continue` patterns are intentional best-effort handlers (queue sync, file cleanup, image pixel failure, stat sizing).
    - Annotated with `# nosec BXX – <reason>` so future scans suppress them with context.
    - **Files:** `server/app/main.py`, `server/app/services/library.py`

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
The April 27, 2026 pass resolved all remaining linting, deprecation, and test-correctness issues.

This document is now the canonical **current-state** summary.

---

## Recommended Next Steps (Prioritized)

1. Replace `auth_hash` bearer model with password/session or JWT + rotation/revocation.
2. Move rate limiting to Redis-backed or gateway-level controls.
3. Add structured security logging for auth failures/token misuse patterns.
4. Resolve the `tracks ↔ users` FK cycle with `use_alter=True` on `users.last_track_id`.
5. Add automated SAST/dependency scanning in CI (`bandit`, `pip-audit`, `ruff`).

---

## Verification Notes (Latest Update)

Validation run during April 27, 2026 update:

1. `ruff check server/app server/tests` → **All checks passed!**
2. `bandit -r server/app` → **0 unflagged issues** (7 Low annotated with `# nosec`)
3. `pytest server/tests -q` → **17 passed**
4. `node --check client/script.js` → **passed**

---

*Last updated: April 27, 2026*
