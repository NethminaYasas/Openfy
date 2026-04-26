# Playlist Detail Page Design

**Date:** 2026-04-26
**Project:** Openfy - Playlist Detail Page UI
**Status:** Approved

## Overview

Spotify-inspired playlist detail page with dynamic gradient background extracted from playlist artwork, featuring action controls and a detailed song list table.

---

## 1. Dynamic Gradient Background

### Implementation
1. **Color Extraction:** On playlist page load, extract the dominant/average color from the **2x2 mosaic composite image** (preferred). If fewer than 4 songs exist, fall back to the first available album art. If no art is available, fall back to a default neutral dark color (`#535353`).
2. **Canvas-based Sampler:**
   - Create offscreen `<canvas>` element
   - Draw cover image onto canvas
   - Use `getImageData()` to read all pixels
   - Average R, G, B channels across all pixels
3. **CSS Gradient:**
   - Start: averaged RGB color (at top of header)
   - End: `#121212` (dark), fade length ~300px measured from the top of the page
4. **Recompute:** Update extracted color whenever the active playlist changes

---

## 2. Header Section

### Layout
- **Background:** Dynamic gradient (see Section 1)
- **Left-aligned content:**
  - **2x2 Mosaic:** Grid of 4 album art thumbnails (~110px each), forming a square collage
    - If playlist has 3 songs: 3 thumbnails + 1 placeholder (dark grey tile)
    - If playlist has 2 songs: top row = 2 thumbnails, bottom row = 2 thumbnails (repeat both)
    - If playlist has 1 song: single image fills the full mosaic square
    - If playlist has 0 songs: show a single grey placeholder with a music note icon
  - **Beside mosaic:**
    - Small label: "Private Playlist" or "Public Playlist"
    - Large bold white title (e.g., "Mymix") — truncate with ellipsis if title exceeds 2 lines
    - Bottom row: user avatar (small circle) + username + bullet + song count + bullet + total duration (e.g., "21 songs, 1 hr 20 min")

---

## 3. Action Bar

### Controls (left-aligned with spacing)
1. **Play button** — large filled green circle (`#1DB954`) with white play icon
2. **Shuffle button** — shuffle icon; **active state:** icon tinted `#1DB954` with a small dot indicator below; **inactive state:** icon in `#b3b3b3`
3. **Download button** — download/arrow-down icon

### Behavior
- **Play:** Clears the current queue, loads the entire playlist, and starts playback from the first track
- **Shuffle:** Toggles shuffle mode; when enabled, also randomizes playback order immediately if playback is active
- **Download:** Downloads all tracks in the playlist in their original stored format (FLAC or MP3, whichever was added)

---

## 4. Song List

### Scrolling Behavior
- The header (gradient + mosaic + action bar) scrolls away naturally as the user scrolls down
- The **column header row** (`#`, Title, Album, Date added, Duration) becomes **sticky** at the top of the viewport once the playlist header scrolls out of view

### Table Columns
| Column | Content |
|--------|---------|
| `#` | Track number; replaced by a play icon on row hover |
| `Title` | Album thumbnail (40px square, rounded) + song title (bold) + artist name (muted, smaller) stacked |
| `Album` | Album name (muted text); show `—` if unknown |
| `Date added` | e.g., "Mar 28, 2025"; show `—` if unknown |
| `Duration` | Clock icon in header, time values right-aligned (e.g., "4:53") |

### Row Behavior
- **Hover:** Slightly lighter background (`rgba(255,255,255,0.07)`)
- **Hover over track number:** Replace `#` with a white play icon
- **Row height:** ~64px

### Empty State
- If the playlist has 0 songs, show a centered message in the song list area: a music note icon, "No songs yet" in white, and a muted subtext "Add songs to get started"

---

## 5. Styling

| Property | Value |
|----------|-------|
| Background | `#121212` (dark theme) |
| Accent | `#1DB954` (Openfy green — play button, active shuffle) |
| Secondary text | `#b3b3b3` (muted grey) |
| Row hover | `rgba(255,255,255,0.07)` |
| Font | Montserrat (existing) |
| Gradient fade | ~300px from top of page to `#121212` |
| Long title truncation | Ellipsis after 2 lines in header |

---

## Acceptance Criteria

- [ ] Dynamic gradient background extracts color from the 2x2 mosaic composite
- [ ] Gradient falls back to `#535353` if no album art is available
- [ ] 2x2 mosaic handles playlists with 0–4 songs gracefully
- [ ] Long playlist names truncate with ellipsis after 2 lines
- [ ] Header shows playlist type, name, and metadata
- [ ] Action bar has Play, Shuffle, and Download buttons only
- [ ] Play button clears the queue and starts playback from track 1
- [ ] Shuffle active state is visually distinct (green icon + dot indicator)
- [ ] Download uses the track's original stored format (FLAC or MP3)
- [ ] Song list column header becomes sticky on scroll
- [ ] Unknown Album and Date added values display as `—`
- [ ] Empty playlist shows a dedicated empty state UI
- [ ] Hover states work on track rows and track number → play icon swap
- [ ] Dark theme with Openfy-green accent applied consistently
