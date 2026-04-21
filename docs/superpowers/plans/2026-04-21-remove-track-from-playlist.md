# Remove Track from Playlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to remove a track from any regular playlist by clicking the green tick (`in-playlist`) indicator in the now-playing bar, which shows a dropdown menu of playlists containing the current track.

**Architecture:** Add two backend endpoints (GET to query playlists containing a track, DELETE to remove), then build frontend dropdown menu with confirmation dialog and state updates. The tick button changes behavior: currently does nothing, will toggle a removal menu instead.

**Tech Stack:** FastAPI (Python), SQLAlchemy (SQLite), JavaScript (vanilla, DOM manipulation), CSS

---

## File Structure

- **server/app/main.py** — Add `GET /tracks/{track_id}/playlists` and `DELETE /playlists/{playlist_id}/tracks/{track_id}` endpoints
- **client/script.js** — New state vars, DOM element creation, click handler modification, new menu functions
- **client/index.html** — Add `<div id="np-playlist-removal-menu">` inside now-playing bar
- **client/styles.css** — Add `.np-removal-menu` styles

---

## Task 1: Backend — GET `/tracks/{track_id}/playlists`

**Files:**
- Modify: `server/app/main.py` (add new endpoint after `list_playlist_tracks`, around line 795)

**Purpose:** Return all regular (non-Liked) playlists owned by the authenticated user that contain the given track.

**Implementation:**

```python
@app.get("/tracks/{track_id}/playlists", response_model=List[PlaylistOut])
def list_track_playlists(
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    stmt = (
        select(Playlist)
        .join(PlaylistTrack, Playlist.id == PlaylistTrack.playlist_id)
        .where(
            Playlist.user_hash == user.auth_hash,
            Playlist.is_liked == 0,
            PlaylistTrack.track_id == track_id,
        )
        .order_by(Playlist.created_at.desc())
    )
    return db.execute(stmt).scalars().all()
```

- [ ] **Step 1:** Write the failing test — Create `tests/test_track_playlists_endpoint.py`
```python
import pytest
from fastapi.testclient import TestClient
from server.app.main import app
from server.app.db import Base, engine, SessionLocal

@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)

def test_get_track_playlists_requires_auth():
    client = TestClient(app)
    resp = client.get("/tracks/fake-id/playlists")
    assert resp.status_code == 401

def test_get_track_playlists_returns_playlists_containing_track():
    # TODO: expanded in next task with proper DB fixtures
    pass
```
- [ ] **Step 2:** Run test to verify it fails**
Run: `cd /home/nethmina/Documents/GITHUB/Openfy/server && python -m pytest tests/test_track_playlists_endpoint.py::test_get_track_playlists_requires_auth -v`
Expected: `FAIL` because endpoint doesn't exist yet

- [ ] **Step 3:** Write minimal implementation**
Add the endpoint code above to `server/app/main.py` at the end of the "Playlist track management" section (after `list_playlist_tracks`, before `add_track_to_playlist` or after line 840).

- [ ] **Step 4:** Run the test again**
Expected: `PASS` for auth test

- [ ] **Step 5:** Commit**
```bash
cd /home/nethmina/Documents/GITHUB/Openfy
git add server/app/main.py tests/
git commit -m "feat: add GET /tracks/{track_id}/playlists endpoint"
```

---

## Task 2: Backend — DELETE `/playlists/{playlist_id}/tracks/{track_id}`

**Files:**
- Modify: `server/app/main.py` (add new endpoint after previous task)

**Implementation:**

```python
@app.delete("/playlists/{playlist_id}/tracks/{track_id}")
def remove_track_from_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")

    if playlist.is_liked:
        raise HTTPException(
            status_code=403, detail="Use /liked/{track_id} endpoint for Liked Songs"
        )

    # Delete the association; use execute to avoid ORM Issues
    result = db.execute(
        delete(PlaylistTrack).where(
            PlaylistTrack.playlist_id == playlist_id,
            PlaylistTrack.track_id == track_id,
        )
    )
    if result.rowcount == 0:
        # Idempotent: return success even if wasn't there
        return {"status": "removed", "playlist_id": playlist_id, "track_id": track_id, "was_present": False}

    db.commit()
    return {"status": "removed", "playlist_id": playlist_id, "track_id": track_id, "was_present": True}
```

- [ ] **Step 1:** Write failing test — extend `tests/test_track_playlists_endpoint.py`:
```python
def test_delete_track_from_playlist_requires_auth():
    client = TestClient(app)
    resp = client.delete("/playlists/pid/tracks/tid")
    assert resp.status_code == 401

def test_delete_track_from_playlist_cannot_remove_from_liked():
    # Create user, playlist (is_liked=1), attempt delete → 403
    pass

def test_delete_track_removes_association():
    # Create user, playlist, track, add via PlaylistTrack, then DELETE
    # Verify row gone, response status "removed", was_present=True
    pass

def test_delete_track_idempotent():
    # DELETE on non-existent association returns 200, not error
    pass
```

- [ ] **Step 2:** Run tests — expect failures (endpoint missing)

- [ ] **Step 3:** Implement endpoint code above

- [ ] **Step 4:** Write helper to create test fixtures properly: use `SessionLocal()` to create user, playlist, track, commit IDs.

Expand test functions to create real DB records and assert correct responses.

- [ ] **Step 5:** Run all new DELETE tests — expect pass

- [ ] **Step 6:** Commit**
```bash
git add server/app/main.py tests/
git commit -m "feat: add DELETE /playlists/{id}/tracks/{track_id} endpoint"
```

---

## Task 3: Frontend — HTML Structure

**Files:**
- Modify: `client/index.html`

**Change:** Inside the now-playing bar (around line 280-283, near `np-like-btn`), add the removal menu container:

```html
<!-- Existing: npLikeBtn button -->
<button class="player-like-btn" id="np-like-btn" aria-label="Add to Liked Songs" title="Add to Liked Songs">
</button>

<!-- NEW: Removal menu dropdown -->
<div id="np-playlist-removal-menu" class="np-removal-menu"></div>
```

Placement: directly after the `np-like-btn` button, within the same parent `.player-like` container.

- [ ] **Step 1:** Open `client/index.html`, locate the now-playing control bar (search for `id="np-like-btn"`)

- [ ] **Step 2:** Add the `<div id="np-playlist-removal-menu" class="np-removal-menu"></div>` immediately after line 282 (closing `</button>`)

- [ ] **Step 3:** Verify HTML structure is valid (no unclosed tags)

- [ ] **Step 4:** Commit**
```bash
git add client/index.html
git commit -m "feat: add removal menu container to now-playing bar"
```

---

## Task 4: Frontend — CSS Styling

**Files:**
- Modify: `client/styles.css`

**Add:** Rules for `.np-removal-menu`, `.removal-menu-item`, `.removal-playlist-name`, `.removal-icon`.

```css
/* Removal menu (dropdown from tick button) */
.np-removal-menu {
  position: absolute;
  bottom: 100%;  /* Position above the button; we'll adjust via JS */
  right: 0;
  background: var(--panel-bg, #2a2a2a);
  border: 1px solid var(--border-color, #444);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  min-width: 180px;
  max-height: 240px;
  overflow-y: auto;
  z-index: 1000;
  display: none;
}

.np-removal-menu.visible {
  display: block;
}

.removal-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-primary, #eee);
  font-size: 13px;
  border-bottom: 1px solid var(--border-color, #333);
}

.removal-menu-item:last-child {
  border-bottom: none;
}

.removal-menu-item:hover {
  background: var(--hover-bg, #3a3a3a);
}

.removal-playlist-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.removal-icon {
  color: var(--text-muted, #888);
  font-size: 12px;
  margin-left: 8px;
  transition: color 0.15s;
}

.removal-menu-item:hover .removal-icon {
  color: var(--text-primary, #eee);
}
```

Positioning note: JS will set `top` and `left` based on `npLikeBtn` position.

- [ ] **Step 1:** Add CSS rules at end of `client/styles.css`

- [ ] **Step 2:** Commit**
```bash
git add client/styles.css
git commit -m "feat: add styling for playlist removal menu"
```

---

## Task 5: Frontend — State Variables & Menu Toggle

**Files:**
- Modify: `client/script.js`

**Changes:**

1. Add state variables (after line 445 with other globals):
```javascript
let trackPlaylistRemovalMenu = null;  // DOM reference
let currentTrackPlaylistsCache = [];  // Playlists containing current track
```

2. Add helper: `function escapeHtml(text)` — sanitize playlist names for innerHTML:
```javascript
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```
(Add near other helpers around line 450-460)

3. Add `function positionRemovalMenu(menu, anchorBtn)`:
```javascript
function positionRemovalMenu(menu, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  const container = anchorBtn.parentElement; // parent .player-like
  const containerRect = container.getBoundingClientRect();

  // Position: above the button, right-aligned
  menu.style.position = 'absolute';
  menu.style.bottom = (containerRect.height - rect.top + containerRect.top + 4) + 'px';
  menu.style.left = (rect.left - containerRect.left) + 'px';
  menu.style.top = 'auto';  // Use bottom instead
}
```

4. Add `function hideRemovalMenuIfVisible()`:
```javascript
function hideRemovalMenuIfVisible() {
  const menu = document.getElementById("np-playlist-removal-menu");
  if (menu && menu.classList.contains("visible")) {
    menu.classList.remove("visible");
    currentTrackPlaylistsCache = [];
  }
}
```

- [ ] **Step 1:** Add state variables after line 445

- [ ] **Step 2:** Add `escapeHtml` helper

- [ ] **Step 3:** Add `positionRemovalMenu` function

- [ ] **Step 4:** Add `hideRemovalMenuIfVisible` function

- [ ] **Step 5:** Call `hideRemovalMenuIfVisible()` in existing document click handler (where `hideContextMenu()` is called — around line 2984, add `else { hideRemovalMenuIfVisible(); }`)

- [ ] **Step 6:** Commit**
```bash
git add client/script.js
git commit -m "feat: add removal menu state and positioning helpers"
```

---

## Task 6: Frontend — Build & Toggle Removal Menu

**Files:**
- Modify: `client/script.js`

**New function: `async function toggleRemovalMenu(forceShow)`**

```javascript
async function toggleRemovalMenu(forceShow) {
  const menu = document.getElementById("np-playlist-removal-menu");
  if (!menu) return;

  const isVisible = menu.classList.contains("visible");

  // Hide if already visible and not forced
  if (isVisible && forceShow !== true) {
    menu.classList.remove("visible");
    currentTrackPlaylistCache = [];
    return;
  }

  // Ensure other menus are hidden
  hideContextMenu();

  // Fetch playlists containing current track
  const playlists = await loadTrackPlaylists(currentTrackId);
  if (playlists.length === 0) {
    // Edge case: no playlists — don't show menu
    return;
  }

  currentTrackPlaylistsCache = playlists;
  buildRemovalMenu(playlists);
  positionRemovalMenu(menu, npLikeBtn);
  menu.classList.add("visible");
}
```

**New function: `async function loadTrackPlaylists(trackId)`**

```javascript
async function loadTrackPlaylists(trackId) {
  try {
    return await api("/tracks/" + trackId + "/playlists");
  } catch (e) {
    console.error("Failed to load track's playlists:", e);
    // Auth errors will throw; handler in click will logout
    throw e;
  }
}
```

**New function: `function buildRemovalMenu(playlists)`**

```javascript
function buildRemovalMenu(playlists) {
  const menu = document.getElementById("np-playlist-removal-menu");
  menu.innerHTML = '';

  playlists.forEach(pl => {
    const item = document.createElement('div');
    item.className = 'removal-menu-item';
    item.dataset.playlistId = pl.id;
    item.innerHTML = `
      <span class="removal-playlist-name">${escapeHtml(pl.name)}</span>
      <i class="fa-solid fa-xmark removal-icon"></i>
    `;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      await confirmAndRemoveFromPlaylist(pl.id, pl.name);
    });
    menu.appendChild(item);
  });
}
```

- [ ] **Step 1:** Add `toggleRemovalMenu` function (insert around line 3110, near `showPlaylistSubmenu`)

- [ ] **Step 2:** Add `loadTrackPlaylists` function

- [ ] **Step 3:** Add `buildRemovalMenu` function

- [ ] **Step 4:** Commit**
```bash
git add client/script.js
git commit -m "feat: implement removal menu toggle and population"
```

---

## Task 7: Frontend — Removal Confirmation & API Call

**Files:**
- Modify: `client/script.js`

**New function: `async function confirmAndRemoveFromPlaylist(playlistId, playlistName)`**

```javascript
async function confirmAndRemoveFromPlaylist(playlistId, playlistName) {
  const confirmed = confirm(`Remove this track from "${playlistName}"?`);
  if (!confirmed) return;

  try {
    await api(`/playlists/${playlistId}/tracks/${currentTrackId}`, { method: "DELETE" });

    // Update cache: remove from currentTrackPlaylistsCache
    currentTrackPlaylistsCache = currentTrackPlaylistsCache.filter(pl => pl.id !== playlistId);

    // Update global trackIdsInRegularPlaylists set
    if (currentTrackPlaylistsCache.length > 0) {
      // Track still in at least one regular playlist
      trackIdsInRegularPlaylists.add(currentTrackId);
    } else {
      // Track no longer in any regular playlist
      trackIdsInRegularPlaylists.delete(currentTrackId);
    }

    // Hide menu
    const menu = document.getElementById("np-playlist-removal-menu");
    if (menu) menu.classList.remove("visible");

    // Update like button state (re-render based on cache state)
    syncLikeButtonState({ id: currentTrackId });

    // Optional: subtle feedback — briefly show checkmark or shake?
    // For now, silent success
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("401") || msg.includes("403") || msg.includes("Not authenticated")) {
      // Trigger logout flow
      localStorage.removeItem("openfy_auth");
      authHash = "";
      npLikeBtn.classList.add("hidden");
      alert("Session expired. Please log in again.");
      authOverlay.style.display = "flex";
      appMain.style.display = "none";
      topBar.style.display = "none";
    } else if (msg.includes("404")) {
      // Already removed — treat as success, sync state
      console.warn("Track already removed, syncing state");
      // Refresh caches to recover
      currentTrackPlaylistsCache = currentTrackPlaylistsCache.filter(pl => pl.id !== playlistId);
      if (currentTrackPlaylistsCache.length === 0) {
        trackIdsInRegularPlaylists.delete(currentTrackId);
      }
      syncLikeButtonState({ id: currentTrackId });
      const menu = document.getElementById("np-playlist-removal-menu");
      if (menu) menu.classList.remove("visible");
    } else {
      alert("Failed to remove from playlist: " + msg);
    }
  }
}
```

- [ ] **Step 1:** Write `confirmAndRemoveFromPlaylist` function

- [ ] **Step 2:** Commit**
```bash
git add client/script.js
git commit -m "feat: add track removal confirmation and API call"
```

---

## Task 8: Frontend — Modify Like Button Click Handler

**Files:**
- Modify: `client/script.js`

**Location:** Find `npLikeBtn.addEventListener("click", async function(event) { ... })` starting around line 2245.

**Change:** Insert new branch for `in-playlist` before the default "+" case.

**Updated handler structure:**

```javascript
npLikeBtn.addEventListener("click", async function(event) {
  if (!currentTrackId) return;
  if (!authHash) {
    alert("Please log in to like songs.");
    return;
  }

  const wasLiked = npLikeBtn.classList.contains("liked");
  const wasInPlaylist = npLikeBtn.classList.contains("in-playlist");

  npLikeBtn.disabled = true;

  try {
    if (wasLiked) {
      // EXISTING: Unlike from Liked Songs
      await api("/liked/" + currentTrackId, { method: "POST" });
      likedTrackIds.delete(currentTrackId);
      npLikeBtn.classList.remove("liked");
      if (trackIdsInRegularPlaylists.has(currentTrackId)) {
        npLikeBtn.classList.add("in-playlist");
        npLikeBtn.innerHTML = "";
        npLikeBtn.setAttribute("aria-label", "Added to playlist");
        npLikeBtn.setAttribute("title", "Added to playlist");
      } else {
        npLikeBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        npLikeBtn.setAttribute("aria-label", "Add to Liked Songs");
        npLikeBtn.setAttribute("title", "Add to Liked Songs");
      }
      npLikeBtn.disabled = false;

    } else if (wasInPlaylist) {
      // NEW: Show removal menu instead of direct action
      event.preventDefault();
      event.stopPropagation();
      await toggleRemovalMenu(true);  // force show
      npLikeBtn.disabled = false;

    } else {
      // EXISTING: Show add-to-playlist submenu
      showAddToPlaylistSubmenu();
      npLikeBtn.disabled = false;
    }
  } catch (err) {
    npLikeBtn.classList.remove("adding");
    npLikeBtn.disabled = false;
    const msg = err.message || "";
    if (msg.includes("Not authenticated") || msg.includes("401") || msg.includes("403")) {
      localStorage.removeItem("openfy_auth");
      authHash = "";
      npLikeBtn.classList.add("hidden");
      alert("Session expired. Please log in again.");
      authOverlay.style.display = "flex";
      appMain.style.display = "none";
      topBar.style.display = "none";
    } else {
      alert("Failed: " + msg);
    }
  }
});
```

Note: Ensure ` wasInPlaylist` check happens BEFORE `showAddToPlaylistSubmenu()` to override default behavior when tick is present.

- [ ] **Step 1:** Replace the existing `npLikeBtn.addEventListener` body with updated logic

- [ ] **Step 2:** Commit**
```bash
git add client/script.js
git commit -m "feat: modify like button handler to show removal menu for in-playlist tracks"
```

---

## Task 9: Frontend — Close Menu on Track Change & Outside Click

**Files:**
- Modify: `client/script.js`

**Step 1:** Find the existing document-level click handler that closes `ctxPlaylistSubmenu`. It likely looks like:

```javascript
document.addEventListener("click", function(e) {
  if (!ctxTrackAddPlaylist.contains(e.target) && !ctxPlaylistSubmenu.contains(e.target)) {
    ctxPlaylistSubmenu.classList.remove('visible');
  }
});
```

Add branch for removal menu:

```javascript
document.addEventListener("click", function(e) {
  // Close add-to-playlist submenu
  if (!ctxTrackAddPlaylist.contains(e.target) && !ctxPlaylistSubmenu.contains(e.target)) {
    ctxPlaylistSubmenu.classList.remove('visible');
  }
  // Close removal menu
  if (!npLikeBtn.contains(e.target) && !menu.contains(e.target)) {
    hideRemovalMenuIfVisible();
  }
});
```

Replace the exact code to also check `np-playlist-removal-menu`.

**Step 2:** Also close removal menu when `currentTrackId` changes (in `loadTrack` functions). Add at end of `loadTrack` and `loadTrackPaused`:

```javascript
// After setting currentTrackId and updating UI...
hideRemovalMenuIfVisible();
```

- [ ] **Step 1:** Modify document click listener to also close removal menu

- [ ] **Step 2:** Add `hideRemovalMenuIfVisible()` calls to both `loadTrack(track)` and `loadTrackPaused(track)` (after setting `currentTrackId`, around lines 1586 and 1636)

- [ ] **Step 3:** Commit**
```bash
git add client/script.js
git commit -m "feat: close removal menu on outside click and track change"
```

---

## Task 10: Integration Test & Manual Verification

**No code changes — testing phase**

- [ ] **Step 1:** Docker rebuild and restart**

```bash
cd /home/nethmina/Documents/GITHUB/Openfy
docker compose build
docker compose up -d
```

Wait for "Admin user ensured" in logs.

- [ ] **Step 2:** Verify backend endpoints with curl**
```bash
# Get playlists containing a track (use known track ID from DB)
curl -s -H "x-auth-hash: <hash>" "http://localhost:8000/tracks/<track_id>/playlists" | head -c 200

# Remove track from playlist (use valid ids)
curl -s -X DELETE -H "x-auth-hash: <hash>" "http://localhost:8000/playlists/<playlist_id>/tracks/<track_id>"
```

- [ ] **Step 3:** Open browser → http://localhost:8000
- Log in, play a track that is in a regular playlist
- Verify tick appears
- Click tick → dropdown appears with playlist name(s)
- Click a playlist → confirm dialog → remove
- Verify: tick disappears (becomes plus) if no playlists remain, or stays tick if still in others
- Click tick again with 2+ playlists → menu shows remaining only after one removed
- Click outside → menu closes, no action
- Change track while menu open → menu closes
- Heart (liked) still works separately

- [ ] **Step 4:** Commit test evidence (screenshots if desired to `docs/` or just note in commit)**

```bash
git add .
git commit -m "test: verify removal menu works end-to-end"
```

---

## Task 11: Refinement & Polish

**Files to inspect and potentially improve:**

- `syncLikeButtonState(track)` — already handles `trackIdsInRegularPlaylists` set. No change needed unless new edge case found.
- `updateRegularPlaylistTrackCache()` — populates `trackIdsInRegularPlaylists`. After DELETE, we manually update. Consider if we want to re-fetch playlists for accuracy. Current approach: optimistic update + set manipulation. Acceptable.
- `addTrackToPlaylist` in script.js — already adds to `trackIdsInRegularPlaylists`. Consistent.

Potential improvements (optional):
- Show loading spinner while fetching playlists for menu
- Fade-in animation for menu
- Add "trash" icon instead of X, or use same as queue clear
- On successful removal, show brief toast "Removed from Playlist Name"

- [ ] **Step 1:** Review CSS for any overflow/clipping issues on different screen sizes
- [ ] **Step 2:** Ensure `escapeHtml` is used everywhere inserting playlist name into DOM (already in `buildRemovalMenu`)
- [ ] **Step 3:** Test with very long playlist names (50+ chars) — ellipsis works?
- [ ] **Step 4:** Commit any polish changes**
```bash
git add .
git commit -m " polish: improve removal menu UX"
```

---

## Self-Review Checklist

- [ ] All four files modified: `main.py`, `script.js`, `index.html`, `styles.css`
- [ ] Two new endpoints documented and implemented with proper auth
- [ ] Menu only appears for `in-playlist` state
- [ ] Confirmation dialog before removal (per user request)
- [ ] Menu shows "name + X icon" per item
- [ ] Clicking outside closes menu
- [ ] Track change auto-closes menu
- [ ] Error handling: 401→logout, 404→treat as already removed, 500→alert
- [ ] Idempotent DELETE (no error if already removed)
- [ ] No regressions: heart (like) still works, plus (add) still works
- [ ] Tests: manual verification completed
- [ ] Commits are atomic and descriptive

---

**Plan total tasks:** 11 (with subtasks). Each subtask is atomic and commit-worthy.
