# Design Document: Remove Track from Playlist via Like Button

## 1. Problem Statement

Currently, users can add tracks to regular playlists via the "+" (plus) button's "Add to Playlist" submenu. The heart button toggles the "Liked Songs" playlist. When a track is already in a regular playlist, the like button shows a **green tick** overlay (`in-playlist` class), but clicking it does nothing.

**Goal:** Enable users to **remove** a track from any regular playlist by clicking the tick icon, which should show a menu of playlists containing the current track. Selecting a playlist removes the track from it.

## 2. Current System Behavior

| Button State | Icon | Meaning | Click Action |
|---|---|---|---|
| `default` | empty / plus | Not in any playlist | Opens "Add to Playlist" submenu |
| `liked` | heart | In "Liked Songs" | Toggles unlike |
| `in-playlist` | tick | In ≥1 regular playlist | Does nothing (new feature needed) |

**Important globals (client/script.js):**
- `trackIdsInRegularPlaylists`: `Set` of track IDs present in any regular (non-Liked) playlist
- `likedTrackIds`: `Set` of track IDs in "Liked Songs"

**Relevant endpoint:** `POST /playlists/{playlist_id}/tracks?track_id=...` (adds a track)
** missing endpoints:** 
- Query: Which regular playlists contain a given track?
- Delete: Remove a track from a playlist

## 3. Proposed Solution

### 3.1 Backend Changes (server/app/main.py)

#### Endpoint 1: `GET /tracks/{track_id}/playlists`

Returns all **regular** playlists (excludes Liked Songs) owned by the authenticated user that include the specified track.

**Signature:**
```python
@app.get("/tracks/{track_id}/playlists", response_model=List[PlaylistOut])
def list_playlists_containing_track(
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
```

**Logic:**
1. Authenticate via `_require_user` or `_get_user`
2. Find all playlists for the user where `is_liked == 0`
3. Join with `PlaylistTrack` where `track_id == track_id`
4. Return list of `PlaylistOut` (no track details needed)

**SQL:**
```python
stmt = (
    select(Playlist)
    .join(PlaylistTrack, Playlist.id == PlaylistTrack.playlist_id)
    .where(
        Playlist.user_hash == user.auth_hash,
        Playlist.is_liked == 0,
        PlaylistTrack.track_id == track_id,
    )
)
```

**Error cases:**
- `401` — not authenticated
- `404` — track not found (optional, could return empty list if track doesn't exist)

#### Endpoint 2: `DELETE /playlists/{playlist_id}/tracks/{track_id}`

Removes a specific track from a specific playlist.

**Signature:**
```python
@app.delete("/playlists/{playlist_id}/tracks/{track_id}")
def remove_track_from_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
```

**Logic:**
1. Authenticate
2. Verify playlist exists and belongs to user (or user is admin)
3. Prevent deletion from Liked Songs (`403` — use `/liked/{track_id}` instead)
4. Delete the `PlaylistTrack` row
5. Commit
6. Return `{ "status": "removed", "playlist_id": ..., "track_id": ... }`

**Error cases:**
- `401` — not authenticated
- `403` — not owner, or is Liked Songs
- `404` — playlist or track not found
- `500` — database error

**Idempotency:** If the track is already not in the playlist, delete affects 0 rows → still return 200 with status "removed" (or 404 if we choose strict, but idempotent preferred).

### 3.2 Frontend Changes (client/script.js)

#### New State Variables
Add near line ~444 (with other globals):
```javascript
let trackPlaylistRemovalMenu = null;  // DOM reference to removal dropdown
let currentTrackPlaylistsCache = [];  // Playlists containing current track (for menu)
```

#### New DOM Element
Add to the now-playing bar (around `npLikeBtn` in HTML):
```html
<div id="np-playlist-removal-menu" class="np-removal-menu"></div>
```

#### Modified `npLikeBtn` Click Handler

Existing handler (lines ~2245–2300) toggles liked/unliked and currently ignores `in-playlist` clicks.

**New logic:**
```javascript
npLikeBtn.addEventListener("click", async function(event) {
  if (!currentTrackId) return;
  if (!authHash) { alert("Please log in"); return; }

  const isLiked = npLikeBtn.classList.contains("liked");
  const isInPlaylist = npLikeBtn.classList.contains("in-playlist");

  if (isLiked) {
    await toggleUnlike(currentTrackId);  // existing code path
  } else if (isInPlaylist) {
    event.preventDefault();
    event.stopPropagation();
    await toggleRemovalMenu();  // NEW: show/hide playlist removal menu
  } else {
    showAddToPlaylistSubmenu();  // existing: add to playlist
  }
});
```

#### New Functions

**`async function toggleRemovalMenu(forceState)`**
Shows or toggles the removal menu.
```javascript
async function toggleRemovalMenu(forceShow) {
  const menu = document.getElementById("np-playlist-removal-menu");
  const showing = menu.classList.contains("visible");
  
  // Hide all other popovers/menus first
  hideContextMenu();
  
  if (forceShow === false || (shoring && forceShow !== true)) {
    menu.classList.remove("visible");
    currentTrackPlaylistsCache = [];
    return;
  }
  
  // Fetch playlists containing current track
  currentTrackPlaylistsCache = await loadTrackPlaylists(currentTrackId);
  
  if (currentTrackPlaylistsCache.length === 0) {
    // No regular playlists contain this track — shouldn't happen if tick shows, but guard
    return;
  }
  
  buildRemovalMenu(currentTrackPlaylistsCache);
  positionRemovalMenu(menu, npLikeBtn);
  menu.classList.add("visible");
}
```

**`async function loadTrackPlaylists(trackId)`**
Calls `GET /tracks/{trackId}/playlists`, returns array of playlists.
```javascript
async function loadTrackPlaylists(trackId) {
  try {
    return await api("/tracks/" + trackId + "/playlists");
  } catch (e) {
    console.error("Failed to load track playlists:", e);
    return [];
  }
}
```

**`function buildRemovalMenu(playlists)`**
Generates menu HTML and attaches click handlers.
```javascript
function buildRemovalMenu(playlists) {
  const menu = document.getElementById("np-playlist-removal-menu");
  menu.innerHTML = '';  // clear
  
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

**`async function confirmAndRemoveFromPlaylist(playlistId, playlistName)`**
Shows `confirm()` dialog, calls delete API, updates state.
```javascript
async function confirmAndRemoveFromPlaylist(playlistId, playlistName) {
  const confirmed = confirm(`Remove this track from "${playlistName}"?`);
  if (!confirmed) return;
  
  try {
    await api(`/playlists/${playlistId}/tracks/${currentTrackId}`, { method: "DELETE" });
    
    // Update cache
    const idx = currentTrackPlaylistsCache.findIndex(pl => pl.id === playlistId);
    if (idx > -1) currentTrackPlaylistsCache.splice(idx, 1);
    
    // Update global trackIdsInRegularPlaylists
    const stillInAny = currentTrackPlaylistsCache.length > 0;
    if (stillInAny) {
      trackIdsInRegularPlaylists.add(currentTrackId);  // still present
    } else {
      trackIdsInRegularPlaylists.delete(currentTrackId);  // no longer in any
    }
    
    // Update button UI
    const menu = document.getElementById("np-playlist-removal-menu");
    menu.classList.remove("visible");
    
    if (stillInAny) {
      // Still in other playlists → keep tick
      syncLikeButtonState({ id: currentTrackId });
    } else {
      // No longer in any playlist → show plus
      npLikeBtn.classList.remove("in-playlist", "liked");
      npLikeBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
      npLikeBtn.setAttribute("aria-label", "Add to Liked Songs");
      npLikeBtn.setAttribute("title", "Add to Liked Songs");
    }
    
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("401") || msg.includes("403")) {
      // Session expired — logout
      logout();
    } else {
      alert("Failed to remove from playlist: " + msg);
    }
  }
}
```

**`function hideRemovalMenuIfVisible()`**
Called on global click events to close menu.
```javascript
function hideRemovalMenuIfVisible() {
  const menu = document.getElementById("np-playlist-removal-menu");
  if (menu.classList.contains("visible")) {
    menu.classList.remove("visible");
    currentTrackPlaylistsCache = [];
  }
}
```

Add this to existing document click listener that closes context menu.

#### Remove Menu Styling (`client/styles.css`)

```css
.np-removal-menu {
  position: absolute;
  background: var(--panel-bg, #2a2a2a);
  border: 1px solid var(--border-color, #444);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
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
}

.removal-menu-item:hover .removal-icon {
  color: var(--text-primary, #eee);
}
```

Position via JS: `top = npLikeBtn.offsetTop + npLikeBtn.offsetHeight + 4`, `left` aligned.

## 4. Data Flow

```
User clicks tick (npLikeBtn with .in-playlist)
  ↓
Prevent default, stopPropagation
  ↓
toggleRemovalMenu() opens
  ↓
GET /tracks/{trackId}/playlists
  ↓
buildRemovalMenu(playlists) → renders `<div class="removal-menu-item">` per playlist
  ↓
User clicks a playlist item
  ↓
confirm("Remove from 'Playlist Name'?")
  ↓
DELETE /playlists/{playlistId}/tracks/{trackId}
  ↓
Success:
  - Remove from currentTrackPlaylistsCache
  - Update trackIdsInRegularPlaylists set
  - If no playlists remain: remove in-playlist class, show plus
  - Else: keep in-playlist class (still in other playlists)
  - Hide menu
```

## 5. Edge Cases

| Scenario | Behavior |
|---|---|
| Track in 0 playlists somehow, tick visible | Menu won't open; ignore (cache consistency protects against) |
| Track removed from playlist by another device | DELETE returns 404; show error, refresh playlists cache |
| User clicks outside | Menu closes, cache cleared |
| Track changes while menu open | Track changes → `currentTrackId` updates → close menu automatically |
| Many playlists (20+) | Menu scrolls (CSS `max-height` + `overflow-y`) |
| Confirmation cancelled | No API call, menu stays open |
| API error on fetch | Silently fail; console error, don't open menu |

## 6. Error Handling

- **401/403 on GET**: Log out user (same as existing auth error flow)
- **404 on GET**: Empty list (track not in any playlists)
- **401/403 on DELETE**: Log out
- **404 on DELETE**: Already removed — treat as success (idempotent), ensure cache update
- **500 on DELETE**: Alert: "Failed to remove from playlist", keep menu open for retry

## 7. CSS Classes & DOM IDs

**New classes:**
- `.np-removal-menu` — container
- `.removal-menu-item` — per-playlist row
- `.removal-playlist-name` — playlist name span
- `.removal-icon` — X icon

**New ID:**
- `#np-playlist-removal-menu` — menu container

**Interaction classes:**
- `.visible` on menu to show it

## 8. Testing Checklist

- [ ] Click tick on track in 1 playlist → menu shows that playlist
- [ ] Click tick on track in 3 playlists → menu shows all 3
- [ ] Click outside → menu closes
- [ ] Confirm removal → track removed, tick becomes plus (if no playlists remain)
- [ ] Confirm removal → track still shows tick (if still in ≥1 playlist after)
- [ ] Cancel confirmation → no change
- [ ] Click tick again while menu open → menu closes (toggle)
- [ ] Change track while menu open → menu closes
- [ ] Auth expires during menu open → logout on next action
- [ ] DELETE fails (500) → error alert, menu stays open
- [ ] GET /tracks/{id}/playlists returns empty → no menu shown
- [ ] "Liked Songs" (heart) still toggles unlike separately
- [ ] "+" button still opens "Add to Playlist" submenu

## 9. API Contract Summary

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `GET` | `/tracks/{track_id}/playlists` | List regular playlists containing track | Required |
| `DELETE` | `/playlists/{playlist_id}/tracks/{track_id}` | Remove track from playlist | Required |

## 10. Files to Modify

- `server/app/main.py` — add 2 endpoints
- `client/script.js` — tick click handler, menu toggle, API calls, state updates
- `client/index.html` — add menu DOM structure near `np-like-btn`
- `client/styles.css` — add removal menu styles

---
