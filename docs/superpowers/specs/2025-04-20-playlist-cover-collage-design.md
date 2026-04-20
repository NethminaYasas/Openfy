---
name: Playlist Cover Collage Feature
description: Generate collage cover images for playlists with 4+ tracks
type: project
---

# Playlist Cover Collage — Design Specification

**Date:** 2025-04-20  
**Feature:** Display a 2×2 collage of the first 4 tracks' album artwork as the playlist cover image (except for "Liked Songs" which keeps its gradient).

---

## 1. Architecture Overview

### Backend
- Add Pillow (`Pillow`) to `server/requirements.txt`
- Create `data/artwork/collages/` directory on startup
- New endpoint: `GET /playlists/{playlist_id}/cover` — returns JPEG image or 404
- Collage generation: Resize 4 source images to 250×250 each, tile into 500×500 grid
- Files stored at: `data/artwork/collages/{playlist_id}.jpg`
- Invalidation: append-only DB updates to `playlist_tracks` trigger collage deletion

### Frontend
- In `openPlaylist()` function: request `/playlists/{id}/cover` and display `<img>` in `.playlist-cover`
- For Liked Songs: retain existing gradient + heart icon
- Cache-busting: append `?v=` timestamp to force browser refresh

---

## 2. Backend Implementation

### 2.1 Dependencies
Add to `server/requirements.txt`:
```
Pillow==10.4.0
```

### 2.2 Directory Setup
In `server/app/main.py` startup (`_startup()`), ensure collages directory exists:
```python
from pathlib import Path
collages_dir = settings.artwork_dir / "collages"
collages_dir.mkdir(parents=True, exist_ok=True)
```

### 2.3 Endpoint: GET /playlists/{playlist_id}/cover

**Location:** `server/app/main.py`

**Logic:**
1. Authenticate user (same as other playlist endpoints)
2. Load playlist; verify ownership (or admin)
3. If `playlist.is_liked`: return `404` (frontend handles gradient)
4. Count tracks in playlist via relationship
5. If track count < 4: return `404` (playlist too small for collage)
6. Build collage from first 4 tracks' album artwork:
   - For each of first 4 `PlaylistTrack` entries:
     - Get `track.album.artwork_path`
     - If missing or file not found → use fallback color (dark gray `#282828`)
     - Open with PIL, resize to 250×250 (Lanczos), paste into 2×2 grid
   - Grid layout: top-left, top-right, bottom-left, bottom-right
7. Save collage to `collages_dir / f"{playlist_id}.jpg"` (overwrite if exists)
8. Return `Response(content=image_bytes, media_type="image/jpeg")`

**Error responses:**
- `401` — Not authenticated
- `403` — Not your playlist
- `404` — Playlist not found / Liked Songs / < 4 tracks / artwork missing on all tracks

**Fallback behavior:**
If all 4 tracks lack artwork, generate a 500×500 solid-color image (dark gray `#282828`) so the UI never breaks.

### 2.4 Cache Invalidation Hooks

Add collage deletion to these endpoints in `server/app/main.py`:

- **`POST /playlists/{playlist_id}/tracks`** — after successful insert, delete collage file
- **`DELETE /playlists/{playlist_id}`** — delete collage file

**Note:** The current codebase does not expose a `DELETE /playlists/{playlist_id}/tracks/{track_id}` endpoint for removing individual tracks from a playlist. If that endpoint is added in the future, collage invalidation should be hooked there as well.

**Helper function:**
```python
def _delete_playlist_collage(playlist_id: str):
    path = collages_dir / f"{playlist_id}.jpg"
    if path.exists():
        path.unlink()
```

---

## 3. Frontend Implementation

### 3.1 Playlist Page Cover Display

**File:** `client/script.js`  
**Function:** `openPlaylist(playlistId)`

**Current code (lines ~2480–2482):**
```js
var cover = document.getElementById("playlist-cover");
cover.style.background = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";
cover.innerHTML = pl.is_liked ? '<i class="fa-solid fa-heart"></i>' : '<svg...playlist icon...</svg>';
```

**New logic:**
```js
var cover = document.getElementById("playlist-cover");

if (pl.is_liked) {
    // Liked Songs: keep gradient + heart
    cover.style.background = "linear-gradient(135deg,#450af5,#c4efd9)";
    cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
} else {
    // Regular playlist: attempt to load collage image
    var img = document.createElement("img");
    img.src = withBase("/playlists/" + playlistId + "/cover?v=" + Date.now());
    img.onerror = function() {
        // Collage not available (<4 tracks, no artwork, etc.)
        cover.style.background = "#282828";
        cover.innerHTML = '<svg class="playlist-cover-icon" viewBox="292 128 156 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Playlist"><title>Playlist icon</title><desc>A music note/playlist icon</desc><g transform="translate(297, 133) scale(6.667)"><path fill="currentColor" d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5z"/></g></svg>';
    };
    cover.style.background = "transparent";
    cover.innerHTML = "";
    cover.appendChild(img);
}
```

**Notes:**
- `withBase()` utility exists in `script.js` — confirms path prefix handling
- `?v=` timestamp bypasses browser cache when collage regenerates
- `onerror` fallback handles 404 responses gracefully

### 3.2 Library Sidebar Playlist Item Covers

**File:** `client/script.js`  
**Function:** `loadPlaylists()` — renders sidebar playlist list

**Current code (~lines 2396–2402):** Sets solid gradient for Liked Songs, gray for others.

**Enhancement:** For non-liked playlists, also attempt to show collage thumbnail (smaller).

```js
var bg = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";
var cover = document.createElement("div");
cover.className = "lib-item-cover";
cover.style.background = bg;

if (!pl.is_liked) {
    var img = document.createElement("img");
    img.src = withBase("/playlists/" + pl.id + "/cover?v=" + Date.now());
    img.onerror = function() { /* keep bg fallback */ };
    cover.appendChild(img);
} else {
    cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
}
```

**CSS consideration:** `.lib-item-cover img` already has `object-fit: cover` styling (line 2055–2058 in `styles.css`). Size is 48×48 (lines 2038–2044). Collage endpoint should return same 500×500 image; browser scales down.

---

## 4. Data Model Impact

**No database changes required.**  
Collage is purely file-based; no new columns needed.

---

## 5. Edge Cases & Error Handling

| Scenario | Backend Behavior | Frontend Behavior |
|----------|------------------|-------------------|
| Liked Songs playlist | 404 | Shows gradient + heart |
| Playlist with < 4 tracks | 404 | Shows solid gray + playlist icon |
| All 4 tracks missing artwork | Returns 500×500 gray JPG | Shows gray image (no error) |
| Some tracks missing artwork | Fill missing quadrants with gray | Shows partial collage with gray blocks |
| Collage file deleted on disk | Regenerates on next request | No impact (auto-regenerates) |
| Track artwork file deleted | Treats that track as missing → gray quadrant | Shows partial collage |
| Playlist deleted | 404 (playlist not found) | Item removed from sidebar |
| Concurrent cover requests | First generates, others wait (PIL is fast) | No issues; filesystem handles atomic writes |

**Missing track artwork fallback:** In collage generation, if a track's `album.artwork_path` is `None` or file missing, paste a `#282828` rectangle in its quadrant.

---

## 6. Performance Considerations

- **Collage size:** 500×500 JPEG at ~85% quality ≈ 15–30 KB (acceptable)
- **Generation time:** ~30–50 ms per collage (Pillow resize + paste) — imperceptible
- **Storage:** One file per playlist; negligible for typical usage (< 1000 playlists = ~30 MB max)
- **CDN/HTTP caching:** Not needed; files live in app sandbox; browser caches with `?v=` busting
- **Concurrent requests:** If two users request same new collage simultaneously, both may generate — but the second overwrites harmlessly. Consider file-lock if needed, but overkill.

---

## 7. API Contract

**New endpoint:**
```
GET /playlists/{playlist_id}/cover
Headers: x-auth-hash: <user_hash>
Response: image/jpeg (500×500) or 404
```

**No changes to existing endpoints.**

---

## 8. Testing Checklist

- [ ] Liked Songs: cover request returns 404, gradient displays
- [ ] Playlist with 0–3 tracks: cover request returns 404, fallback icon displays
- [ ] Playlist with 4 tracks (all have artwork): 2×2 collage displays correctly
- [ ] Playlist with 4 tracks (2 missing artwork): 2 quadrants show images, 2 show gray
- [ ] Adding a 5th track: collage unchanged until cache invalidated
- [ ] Removing a track ( dropping below 4): next cover fetch returns 404, fallback displays
- [ ] Collage file persists across server restarts
- [ ] Collage regenerates correctly after cache invalidation
- [ ] Wrong user requesting another user's playlist: 403
- [ ] Unauthenticated request: 401
- [ ] Collage image loads in both playlist page header and library sidebar

---

## 9. Open Questions / TBD

None — all resolved.

---

## 10. Step-by-Step Implementation Plan

1. Add Pillow dependency to `server/requirements.txt`
2. Create `_delete_playlist_collage(playlist_id)` helper in `main.py`
3. Add collages dir creation in `_startup()`
4. Implement `GET /playlists/{playlist_id}/cover` endpoint
5. Hook invalidation into `POST /playlists/{id}/tracks` (track added)
6. Hook invalidation into `DELETE /playlists/{id}` (playlist deleted)
7. Check if `DELETE /playlists/{id}/tracks` exists; if not, skip (out of scope)
8. Frontend: modify `openPlaylist()` to fetch collage image
9. Frontend: modify `loadPlaylists()` sidebar items to show collage thumbnails
10. Build and run Docker container
11. Manual testing with real audio files

---

**End of specification.**
