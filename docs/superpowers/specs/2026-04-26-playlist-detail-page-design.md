# Playlist Detail Page Design

**Date:** 2026-04-26
**Project:** Openfy - Playlist Detail Page UI
**Status:** Approved

## Overview

Spotify-inspired playlist detail page with dynamic gradient background extracted from playlist artwork, featuring action controls and a detailed song list table.

---

## 1. Dynamic Gradient Background

### Implementation
1. **Color Extraction:** On playlist page load, extract dominant/average color from the playlist cover image (2x2 mosaic or first album art)
2. **Canvas-based Sampler:**
   - Create offscreen `<canvas>` element
   - Draw cover image onto canvas
   - Use `getImageData()` to read all pixels
   - Average R, G, B channels across all pixels
3. **CSS Gradient:**
   - Start: averaged RGB color (at top)
   - End: `#121212` (dark) fading over ~300px
4. **Recompute:** Update color whenever playlist changes

---

## 2. Header Section

### Layout
- **Background:** Dynamic gradient (above)
- **Left-aligned content:**
  - **2x2 Mosaic:** Grid of 4 album art thumbnails (~110px each), forming square collage
  - **Beside mosaic:**
    - Small label: "Private Playlist" or "Public Playlist"
    - Large bold white title (e.g., "Mymix")
    - Bottom row: user avatar (small circle) + username + bullet + song count + bullet + total duration (e.g., "21 songs, 1 hr 20 min")

---

## 3. Action Bar

### Controls (left-aligned with spacing)
1. **Play button** — large filled green circle (#1DB954) with white play icon
2. **Shuffle button** — shuffle icon (toggle active/inactive state)
3. **Download button** — download/arrow-down icon

### Behavior
- **Play:** Adds entire playlist to queue, starts from beginning
- **Shuffle:** Toggles shuffle mode for the playlist
- **Download:** Downloads all tracks in playlist

---

## 4. Song List

### Table Columns
| Column | Content |
|--------|---------|
| `#` | Track number |
| `Title` | Album thumbnail (40px square, rounded) + song title (bold) + artist name (muted, smaller) stacked |
| `Album` | Album name (muted text) |
| `Date added` | e.g., "Mar 28, 2025" |
| `Duration` | Clock icon in header, time values right-aligned (e.g., "4:53") |

### Row Behavior
- **Hover:** Slightly lighter background
- **Hover over track number:** Replace `#` with play icon
- **Row height:** ~64px

---

## 5. Styling

| Property | Value |
|----------|-------|
| Background | `#121212` (dark theme) |
| Accent | `#1DB954` (Spotify green for play button) |
| Secondary text | `#b3b3b3` (muted grey) |
| Font | Montserrat (existing) |
| Gradient fade | ~300px to #121212 |

---

## Acceptance Criteria

- [ ] Dynamic gradient background extracts color from playlist cover
- [ ] 2x2 mosaic grid displays album art thumbnails
- [ ] Header shows playlist type, name, and metadata
- [ ] Action bar has Play, Shuffle, and Download buttons
- [ ] Play button adds playlist to queue and starts playback
- [ ] Song list displays all columns with proper styling
- [ ] Hover states work on track rows and numbers
- [ ] Dark theme with Spotify-green accent applied consistently