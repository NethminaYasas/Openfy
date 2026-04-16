# Openfy Security Audit Report

**Project:** Openfy — Self-hosted music streaming server
**Path:** /home/nethmina/Documents/GITHUB/Openfy
**Audit Date:** April 07, 2026 (initial)
**Audit Update:** April 16, 2026 (post-fix recheck)
**Scope:** server/app/ and client/ (focused on auth, access control, file access, and XSS)

---

## EXECUTIVE SUMMARY

The initial audit (April 07, 2026) identified multiple critical issues across authentication, access control, and unsafe file access. A set of fixes has since been implemented and rechecked (April 16, 2026).

As of **April 16, 2026**, the most impactful issues from the initial report are **addressed**:
- Authentication is enforced on data endpoints that previously allowed anonymous access.
- Path traversal risks are mitigated by resolving paths and ensuring they remain under allowed base directories.
- Streaming range parsing is hardened to avoid malformed range handling.
- Admin user deletion no longer requires exposing user auth hashes to the UI.
- Client-side DOM rendering hotspots that could enable XSS via playlist/track/user names were rewritten to use `textContent`/DOM APIs.

Important **remaining risks** (design / operational):
- Token-only auth (`auth_hash`) is still a long-lived bearer credential; compromise = account takeover until rotated.
- The audio stream endpoint supports `?auth=...` because `<audio>` cannot send custom headers; this can leak via logs/proxies. `Referrer-Policy: same-origin` is set server-side to reduce incidental leakage, but URL logging remains a concern.
- No rate limiting / brute-force protections (recommended for any internet-facing deployment).

---

## VULNERABILITY INDEX

Note: The tables and detailed findings below reflect the **initial (April 07, 2026)** state. See “STATUS (April 16, 2026)” for what is fixed vs. remaining.

---

## STATUS (April 16, 2026)

**Resolved / Mitigated (server):**
- Library scan now requires auth + admin and rejects paths outside `settings.music_dir` (`server/app/main.py`).
- Downloads require auth; job status is owner/admin scoped (`server/app/main.py`).
- Track listing/search/most-played/artist/album endpoints require auth (`server/app/main.py`).
- Artwork reads are restricted to `settings.artwork_dir` (`server/app/main.py`).
- Track streaming enforces auth, validates `Range`, and restricts file reads to `settings.music_dir` (`server/app/main.py`).
- CORS now avoids the unsafe `"*"+credentials` combination (`server/app/main.py`, `server/app/settings.py`).
- Track API schemas no longer expose filesystem paths to non-admins (`server/app/schemas.py`).
- Playlist schemas no longer expose `user_hash` (`server/app/schemas.py`).
- Admin users list no longer returns `auth_hash`; admin user deletion now uses `user_id` instead of `auth_hash` (`server/app/main.py`).
- `/auth/me` now uses a public schema and no longer returns `auth_hash` (`server/app/main.py`, `server/app/schemas.py`).

**Resolved / Mitigated (client):**
- Removed `innerHTML` rendering of untrusted strings (playlist names, track titles/artists in playlist view, admin tables) (`client/script.js`).

**Still Open / Recommendations:**
- Consider adding rotation/revocation for `auth_hash` and/or a real session mechanism.
- Consider rate limiting on auth endpoints and download creation.
- Consider using a short-lived stream token (instead of `auth_hash`) for `?auth=...` playback URLs.

### CRITICAL Issues (CR)

| ID | Title | File | Line(s) |
|----|-------|------|---------|
| CR-01 | Auth Hash Leaked in UserOut Schema | schemas.py | 92-99 |
| CR-02 | Unauthenticated Library Scan Endpoint | main.py | 214-221 |
| CR-03 | Path Traversal in Library Scan | main.py | 216-220 |
| CR-04 | Unauthenticated Download Creation | main.py | 514-522 |
| CR-05 | Auth Hash Leak of ALL Users in Admin Endpoint | main.py | 650-658 |
| CR-06 | No Ownership Check on Download Job Status | main.py | 525-530 |

### HIGH Issues (HI)

| ID | Title | File | Line(s) |
|----|-------|------|---------|
| HI-01 | Arbitrary File Read via track_artwork Path Traversal | main.py | 261-271 |
| HI-02 | IDOR on Playlist Detail and Tracks | main.py | 399-404, 435-445 |
| HI-03 | No Ownership Check on add_track_to_playlist | main.py | 448-488 |
| HI-04 | IDOR on Download Job Status | main.py | 525-530 |
| HI-05 | Auth Hash Leaked in Admin User List (Intentional but Dangerous) | main.py | 624-659 |

### MEDIUM Issues (ME)

| ID | Title | File | Line(s) |
|----|-------|------|---------|
| ME-01 | TrackOut Schema Exposes file_path | schemas.py | 38-58 |
| ME-02 | No Ownership on Track Detail / Stream | main.py | 253-258, 284-332 |
| ME-03 | Unrestricted CORS with allow_origins="*" | settings.py | 18 |
| ME-04 | Unauthenticated Liked Check Leaks Auth State | main.py | 571-587 |
| ME-05 | DownloadJob Model Missing user_hash | models.py | 131-143 |

### LOW Issues (LO)

| ID | Title | File | Line(s) |
|----|-------|------|---------|
| LO-01 | No Password System — Token-Only Auth | models.py | 88 |
| LO-02 | Dead Code in spotiflac.py | spotiflac.py | 109-116 |
| LO-03 | File Deletion Silently Swallowed | main.py | 768-773 |
| LO-04 | SQLite WAL/Journal Mode Not Configured | (settings) | - |

---

## DETAILED FINDINGS

---

### CR-01: Auth Hash Leaked in UserOut Schema

**Severity:** CRITICAL
**File:** schemas.py, lines 92-99
**Category:** Information Disclosure / Credential Leak

```python
class UserOut(BaseModel):
    name: str
    auth_hash: str          # <-- THE SECRET TOKEN IS RETURNED
    is_admin: bool = False
    created_at: datetime
```

The `auth_hash` is the sole authentication credential for each user. Returning it in `UserOut` means:

- **POST /auth/signup** (line 590) returns the new user's auth_hash — acceptable for initial signup, it's a one-time reveal.
- **POST /auth/signin** (line 606) returns the user's auth_hash — returning it every login is unnecessary but debatable.
- **GET /auth/me** (line 614) returns the auth_hash — a user can always see their own.
- **GET /admin/users** (line 624) returns ALL users' auth_hashes (see CR-05 related).

**Impact:** Anywhere UserOut is serialized, the user's secret token is exposed. If an attacker intercepts OR obtains a UserOut response, they have full account takeover as it's the sole credential.

**Recommendation:** Create `UserOutPublic` without `auth_hash` for all endpoints except signup/signin. The auth_hash must never appear in the admin user list.

---

### CR-02: Unauthenticated Library Scan Endpoint

**Severity:** CRITICAL
**File:** main.py, lines 214-221
**Category:** Authentication Bypass / Authorization Gap

```python
@app.post("/library/scan")
def scan_library(path: str | None = None, db: Session = Depends(get_db)):
    if path:
        target = Path(path)
        if not target.exists():
            raise HTTPException(status_code=404, detail="Path not found")
        return scan_paths(db, [target])
    return scan_default_library(db)
```

**No authentication whatsoever.** Any anonymous caller can:
- Trigger a full library re-scan (resource exhaustion, database bloat).
- Scan an arbitrary filesystem path (leads directly into CR-03).
- Cause I/O spikes that degrade music streaming for all users.

**Impact:** Complete denial of service, filesystem enumeration.

**Fix:** Add `x_auth_hash` header check + admin-only authorization.

---

### CR-03: Path Traversal in Library Scan

**Severity:** CRITICAL
**File:** main.py, lines 216-220
**Category:** Path Traversal

```python
if path:
    target = Path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return scan_paths(db, [target])
```

No validation that `path` is within an allowed directory. An attacker can pass `path=../../../etc` or `path=/` and the library scanner will recursively walk those directories, indexing any audio files it finds into the database.

**Impact:**
- Full filesystem enumeration — attacker learns which paths and files exist on the server.
- Can scan sensitive directories for accidentally placed audio or other files.
- Combined with the scan endpoint being unauthenticated (CR-02), anyone on the network can probe the server's filesystem.

**Fix:** Validate that the resolved path is within `settings.music_dir` or a configured whitelist:
```python
target = Path(path).resolve()
if not str(target).startswith(str(settings.music_dir.resolve())):
    raise HTTPException(403, "Path outside allowed directories")
```

---

### CR-04: Unauthenticated Download Creation

**Severity:** CRITICAL
**File:** main.py, lines 514-522
**Category:** Authentication Bypass

```python
@app.post("/downloads", response_model=DownloadJobOut)
def create_download(
    payload: DownloadRequest,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    from .services.spotiflac import queue_download
    return queue_download(db, payload.query, payload.source or "auto", x_auth_hash)
```

The `x_auth_hash` is extracted but **never checked**. `queue_download` is called regardless of whether the user is authenticated.

**Impact:** Any anonymous user can:
- Queue arbitrary downloads (server resource abuse).
- Trigger the external SpotiFLAC tool with arbitrary queries.
- Fill disk space with downloaded music.

**Fix:** Require authentication:
```python
if not x_auth_hash:
    raise HTTPException(status_code=401, detail="Not authenticated")
user = _get_user(db, x_auth_hash)
if not user:
    raise HTTPException(status_code=401, detail="Invalid auth hash")
```

---

### CR-05: No Ownership Check on Download Job Status

**Severity:** CRITICAL (downgraded to HIGH as it was originally HI-04, see below)

### CR-05 (revised): Auth Hash Leakage in /admin/users Response

**Severity:** CRITICAL
**File:** main.py, lines 650-658
**Category:** Information Disclosure

```python
user_data = {
    "id": user.id,
    "name": user.name,
    "auth_hash": user.auth_hash,    # <-- LEAKED
    "is_admin": user.is_admin,
    "created_at": user.created_at,
    "uploaded_tracks_count": len(track_count),
}
```

While admin access is required, returning raw auth_hash for ALL users means a compromised admin account (or an admin being careless) instantly exposes every user's credential. Given the token-only auth model, knowing a user's auth_hash = full account control.

**Recommendation:** Never include auth_hash in admin views. Use a masked version if necessary for UI display.

---

### CR-06 (renumbered): Unauthenticated Playlist Creation

**Severity:** CRITICAL
**File:** main.py, lines 382-396
**Category:** Authentication Bypass

```python
@app.post("/playlists", response_model=PlaylistOut)
def create_playlist(
    payload: PlaylistCreate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    playlist = Playlist(
        name=payload.name,
        description=payload.description,
        user_hash=x_auth_hash or "",   # <-- Anonymous playlists with empty user_hash
    )
```

No auth required. Anonymous users can create playlists. The playlist gets `user_hash=""` (empty string). This pollutes the database and can create playlists that no real user owns, which cannot be managed or deleted by any legitimate user.

**Fix:** Require authentication and verify user exists.

---

## HIGH SEVERITY

---

### HI-01: Arbitrary File Read via Path Traversal in track_artwork

**Severity:** HIGH
**File:** main.py, lines 261-271
**Category:** Path Traversal

```python
@app.get("/tracks/{track_id}/artwork")
def track_artwork(track_id: str, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track or not track.album:
        raise HTTPException(status_code=404, detail="Artwork not found")
    if not track.album.artwork_path:
        raise HTTPException(status_code=404, detail="Artwork not found")
    path = Path(track.album.artwork_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Artwork not found")
    return FileResponse(path)
```

If an attacker can manipulate `artwork_path` in the Album model (e.g., during library scan or through any upload mechanism), they can cause this endpoint to serve arbitrary files. The path is read directly from the database without any sanitization or base-directory check.

While artwork_path is set by the library scanner (not directly user-controlled), if the music library contains any metadata that could be poisoned, or if there's any other mechanism to set artwork_path, this becomes a file read oracle.

**Impact:** Potential arbitrary file read.

**Fix:** Validate that artwork_path is within `settings.artwork_dir`.

---

### HI-02: IDOR on Playlist Detail and Playlist Tracks

**Severity:** HIGH
**File:** main.py, lines 399-404, 435-445
**Category:** IDOR

```python
@app.get("/playlists/{playlist_id}", response_model=PlaylistOut)
def get_playlist(playlist_id: str, db: Session = Depends(get_db)):
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist

@app.get("/playlists/{playlist_id}/tracks", response_model=List[PlaylistTrackOut])
def list_playlist_tracks(playlist_id: str, db: Session = Depends(get_db)):
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    stmt = (
        select(PlaylistTrack)
        .where(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
    )
    return db.execute(stmt).scalars().all()
```

Both endpoints have **no authentication and no ownership check**. Any user can:
- Request `/playlists/{any_uuid}` to get details of ANY user's playlist.
- Request `/playlists/{any_uuid}/tracks` to enumerate the contents of ANY user's playlist.

This is a textbook IDOR. PlaylistOut includes `user_hash`, so an attacker can discover which user owns which playlist, then use the `user_hash` from `/tracks?user_hash=...` to enumerate another user's tracks (see CR-08 below).

**Fix:** Require authentication and either check ownership (playlist.user_hash == x_auth_hash) OR allow viewing but exclude user_hash from the response.

---

### HI-03: No Ownership Enforcement on add_track_to_playlist

**Severity:** HIGH
**File:** main.py, lines 448-488
**Category:** Authorization Gap

```python
@app.post("/playlists/{playlist_id}/tracks", response_model=PlaylistTrackOut)
def add_track_to_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = None,   # <-- Not Header(), just a bare param
    db: Session = Depends(get_db),
):
    ...
    if x_auth_hash and playlist.user_hash != x_auth_hash:
        raise HTTPException(status_code=403, detail="Not your playlist")
```

Two issues:
1. `x_auth_hash` is not `Header(None)` so it may not bind correctly from requests. It becomes a query/body parameter depending on FastAPI's inference.
2. Even if it does bind, the check is `if x_auth_hash and ...` — if `x_auth_hash` is None, **the ownership check is entirely bypassed** and anyone can add tracks to anyone's playlist.

**Impact:** Any user can add or attempt to add tracks to any other user's playlists (for non-Liked-Songs playlists).

**Fix:** Require `x_auth_hash` from Header and enforce the check unconditionally.

---

### HI-04: IDOR on Download Job Status

**Severity:** HIGH
**File:** main.py, lines 525-530
**Category:** IDOR

```python
@app.get("/downloads/{job_id}", response_model=DownloadJobOut)
def get_download_status(job_id: str, db: Session = Depends(get_db)):
    job = db.get(DownloadJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Download job not found")
    return job
```

No authentication, no ownership check. Any user can check the status of any download job by cycling through UUIDs. This reveals:
- What the download query was (the URL searched).
- Output paths on the filesystem.
- Error logs.

**Fix:** Add user_hash to DownloadJob model and check ownership, or require authentication.

---

### HI-05: Auth Hash Exposed in PlaylistOut Schema

**Severity:** HIGH (Information Disclosure)
**File:** schemas.py, lines 71-81
**Category:** Information Disclosure

```python
class PlaylistOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    user_hash: str | None = None   # <-- Exposes other users' auth identifiers
```

`user_hash` is the user's auth_hash. Exposing it in playlist responses from any public endpoint lets attackers discover valid auth hashes through playlist enumeration.

**Fix:** Remove user_hash from PlaylistOut, or only include it when the current user is the owner.

---

## MEDIUM SEVERITY

---

### ME-01: TrackOut Schema Exposes file_path

**Severity:** MEDIUM
**File:** schemas.py, lines 38-58
**Category:** Information Disclosure

```python
class TrackOut(TrackBase):
    id: str
    file_path: str  # <-- Server filesystem path exposed in API responses
    ...
```

Every track listing, search result, and individual track response exposes the absolute file path on the server. This:
- Reveals the server's file system layout.
- Gives attackers information about other files that may exist.
- Could be combined with other vulnerabilities for targeted attacks.

**Assessment:** In a self-hosted, single-org context this is minor. On an internet-facing instance with untrusted users, it's more serious.

**Fix:** Remove file_path from TrackOut or make it admin-only.

---

### ME-02: No Ownership Check on Track Detail and Stream

**Severity:** MEDIUM
**File:** main.py, lines 253-258, 284-332
**Category:** Authorization Gap

```python
@app.get("/tracks/{track_id}", response_model=TrackOut)
def get_track(track_id: str, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track
```

Any authenticated user can get details about ANY track, including tracks owned by other users. Since TrackOut exposes `file_path`, `user_hash`, and other metadata, this leaks cross-user information.

The stream endpoint (`/tracks/{track_id}/stream`) allows any user to stream any track regardless of ownership. In a multi-user self-hosted context, this is the expected behavior for a shared library — it's flagged as MEDIUM since the "shared library" model makes this acceptable, but it should be a conscious design decision.

---

### ME-03: Unrestricted CORS with Wildcard Origins

**Severity:** MEDIUM
**File:** settings.py, line 18; main.py, lines 56-62
**Category:** Misconfiguration

```python
allowed_origins: str = "*"
```

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.allowed_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

The default configuration allows ALL origins with credentials. This means any website the user visits can make authenticated requests to the Openfy server if running on localhost, stealing auth hashes, playing tracks, modifying playlists, etc.

**Impact:** A malicious website can interact with Openfy if the browser has cached the x-auth-hash (via JS storage on the Openfy page).

**Fix:** Default to specific origins, or at minimum document the risk.

---

### ME-04: Unauthenticated Liked-Check Leaks User State

**Severity:** MEDIUM
**File:** main.py, lines 571-587
**Category:** Information Disclosure

```python
@app.get("/liked/{track_id}")
def is_track_liked(
    track_id: str, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)
):
    if not x_auth_hash:
        return {"liked": False}   # <-- Always returns False for anonymous
```

While this doesn't directly leak data (it returns a fixed response for unauthenticated), it enables an attacker to iterate over all tracks checking which ones are liked by the user whose auth_hash they may have obtained. The endpoint itself needs auth enforcement — if combined with HI-02 (playlist IDOR), the attacker can first discover a user's Liked Songs playlist, then use this endpoint to fingerprint listening habits.

---

### ME-05: DownloadJob Model Missing user_hash

**Severity:** MEDIUM
**File:** models.py, lines 131-143
**Category:** Design Flaw

```python
class DownloadJob(Base):
    __tablename__ = "download_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    source: Mapped[str] = mapped_column(String(120))
    query: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    output_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    log: Mapped[str | None] = mapped_column(Text, nullable=True)
    # NO user_hash field
```

Download jobs have no association with a user. This makes it impossible to:
- Check ownership on the status endpoint.
- List only a user's download jobs.
- Attribute downloads to users for auditing.

**Fix:** Add `user_hash` column to DownloadJob and set it during creation.

---

## LOW SEVERITY

---

### LO-01: No Password System — Token-Only Auth

**Severity:** LOW
**File:** models.py, line 88
**Category:** Design

```python
password_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
```

The `password_hash` field exists but is never used. Auth is entirely via the `auth_hash` token. There's no way to change tokens, no session invalidation, no rotation. If a token is compromised, the only remediation is deleting and recreating the user.

**Note:** The `password_hash` column exists in the model but is never populated or checked anywhere in the codebase. It's dead code that might create a false sense of security.

---

### LO-02: Dead Code in spotiflac.py

**Severity:** LOW
**File:** spotiflac.py, lines 109-116
**Category:** Code Quality

```python
    return job

# Dead code below — never executed
    thread = threading.Thread(
        target=_run_download,
        args=(job.id, query, settings.database_url, user_hash),
        daemon=True,
    )
    thread.start()

    return job
```

Duplicate code after the function return statement. Dead code that is never executed.

---

### LO-03: File Deletion Error Silently Swallowed

**Severity:** LOW
**File:** main.py, lines 768-773
**Category:** Error Handling

```python
try:
    p = Path(file_path)
    if p.exists():
        p.unlink()
except Exception as e:
    pass  # File deletion failure shouldn't break the response
```

If file deletion fails (permissions, locked file), the admin never knows. The track is removed from the database but the file persists, leading to orphaned files. At minimum, log the error.

---

### LO-04: No Security Headers

**Severity:** LOW
**Category:** Misconfiguration

No security headers are configured (X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, etc.). Not critical for an API backend but worth noting.

---

## ENDPOINT-BY-ENDPOINT AUTH SUMMARY

| Endpoint | Auth Required? | Ownership Check? | Sensitive Data Leaked? |
|----------|---------------|------------------|----------------------|
| GET /health | No | N/A | No |
| GET / | No | N/A | No |
| POST /library/scan | **NO** | N/A | No |
| GET /tracks | Partial (user_hash filter) | Admin check for user_hash filter | file_path, user_hash in TrackOut |
| GET /tracks/{id} | No | No | file_path, user_hash |
| GET /tracks/{id}/artwork | No | No | Potential path traversal |
| GET /tracks/most-played | No | No | file_path, user_hash |
| GET /artists | No | N/A | No |
| GET /albums | No | N/A | No |
| GET /search | No | No | file_path, user_hash |
| GET /playlists | Partial (filters to own if auth'd) | Only filters, not enforced | user_hash in PlaylistOut |
| POST /playlists | **NO** | Creates with empty user_hash | user_hash in response |
| GET /playlists/{id} | **NO** | **NO** | user_hash in PlaylistOut |
| PUT /playlists/{id} | Yes | Yes (owner check) | user_hash in response |
| GET /playlists/{id}/tracks | **NO** | **NO** | Tracks + file_paths via PlaylistTrackOut |
| POST /playlists/{id}/tracks | Weak (check bypassed if no header) | Conditional (bypassed if no auth) | No |
| DELETE /playlists/{id} | Yes | Yes (owner check) | No |
| POST /downloads | **NO** | **NO** | No |
| GET /downloads/{id} | **NO** | **NO** | Query, output_path in response |
| POST /liked/{track_id} | Yes | N/A (acts on authenticated user) | No |
| GET /liked/{track_id} | **NO** (silent fail) | N/A | No |
| POST /auth/signup | No (intentional) | N/A | auth_hash (intentional for signup) |
| POST /auth/signin | No (intentional) | N/A | auth_hash (intentional for signin) |
| GET /auth/me | Yes | N/A | auth_hash (to own user) |
| GET /admin/users | Yes + Admin | N/A | **auth_hash of ALL users** |
| DELETE /admin/users/{hash} | Yes + Admin | Self-deletion check | No |
| GET /admin/tracks | Yes + Admin | N/A (admin view) | user_hash, file_path |
| DELETE /admin/tracks/{id} | Yes + Admin | N/A (admin delete) | No |

---

## RECOMMENDATIONS (Prioritized)

### Immediate (Ship-blocker)

1. **Add authentication to POST /library/scan** and validate path is within allowed directories.
2. **Add authentication to POST /downloads** and add user_hash to DownloadJob model.
3. **Add ownership checks to GET /playlists/{id}** and **GET /playlists/{id}/tracks**.
4. **Remove auth_hash from admin user list response** or at minimum mask it.
5. **Require authentication for POST /playlists** and fix the x_auth_header binding in add_track_to_playlist.

### Short-term

6. Remove `user_hash` and `file_path` from public API schemas (TrackOut, PlaylistOut).
7. Add user_hash to DownloadJob for ownership tracking.
8. Fix the `x_auth_hash` parameter in `add_track_to_playlist` to use `Header(None)` and make the check unconditional.
9. Add rate limiting to POST /auth/signup to prevent abuse.
10. Set a specific CORS origin default rather than `"*"`.

---

## SEVERITY SUMMARY

| Severity | Count |
|----------|-------|
| CRITICAL | 6 |
| HIGH | 5 |
| MEDIUM | 5 |
| LOW | 4 |
| **TOTAL** | **20** |

---

*End of Security Audit Report*
