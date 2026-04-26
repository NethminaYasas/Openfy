# Playlist Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Spotify-inspired playlist detail page with dynamic gradient background, action controls (Play/Shuffle/Download), and a detailed song list table with sticky headers.

**Architecture:** The existing `#page-playlist` in index.html will be enhanced with dynamic gradient extraction, expanded header with 2x2 mosaic, action bar with three buttons, and a full song list table with sticky column headers. All logic will be in script.js with corresponding CSS updates in styles.css.

**Tech Stack:** Vanilla JavaScript, CSS, HTML (existing stack)

---

## File Structure

| File | Purpose |
|------|---------|
| `client/index.html` | Modify existing `#page-playlist` structure - add gradient container, update header layout, add action bar, add song list with column headers |
| `client/styles.css` | Add new styles for gradient, 2x2 mosaic, action bar buttons, song list table, sticky headers, hover states |
| `client/script.js` | Add color extraction function, update `openPlaylist()` to build gradient, mosaic, action bar, song list, implement button behaviors |

---

## Task 1: HTML Structure Updates

**Files:**
- Modify: `client/index.html:138-152`

- [ ] **Step 1: Update page-playlist HTML structure**

Read index.html lines 138-152 to see current playlist page structure, then replace with:

```html
<div class="page" id="page-playlist">
    <div class="playlist-gradient" id="playlist-gradient"></div>
    <div class="playlist-header-section">
        <button class="back-btn" id="playlist-back"><i class="fa-solid fa-chevron-left"></i></button>
        <div class="playlist-header-main">
            <div class="playlist-mosaic" id="playlist-mosaic"></div>
            <div class="playlist-header-info">
                <p class="playlist-type" id="playlist-type">Playlist</p>
                <h1 id="playlist-name"></h1>
                <p class="playlist-meta" id="playlist-meta"></p>
            </div>
        </div>
    </div>
    <div class="playlist-actions" id="playlist-actions">
        <button class="playlist-play-btn" id="playlist-play-btn">
            <i class="fa-solid fa-play"></i>
        </button>
        <button class="playlist-shuffle-btn" id="playlist-shuffle-btn">
            <i class="fa-solid fa-shuffle"></i>
        </button>
        <button class="playlist-download-btn" id="playlist-download-btn">
            <i class="fa-solid fa-download"></i>
        </button>
    </div>
    <div class="playlist-songs-container">
        <div class="playlist-songs-header">
            <span class="ps-col-num">#</span>
            <span class="ps-col-title">Title</span>
            <span class="ps-col-album">Album</span>
            <span class="ps-col-date">Date added</span>
            <span class="ps-col-duration"><i class="fa-regular fa-clock"></i></span>
        </div>
        <div class="playlist-songs-list" id="playlist-songs-list"></div>
    </div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add client/index.html
git commit -m "feat: update playlist page HTML structure"
```

---

## Task 2: CSS Styling

**Files:**
- Modify: `client/styles.css` (append new styles at end)

- [ ] **Step 1: Add playlist gradient and header styles**

Append to styles.css:

```css
/* Playlist Gradient Background */
.playlist-gradient {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 400px;
    background: linear-gradient(180deg, #535353 0%, #121212 300px);
    z-index: 0;
}

#page-playlist {
    position: relative;
    min-height: 100vh;
}

/* Playlist Header Section */
.playlist-header-section {
    position: relative;
    z-index: 1;
    padding: 2rem;
}

.playlist-header-main {
    display: flex;
    gap: 1.5rem;
    align-items: flex-end;
    margin-top: 1rem;
}

/* 2x2 Mosaic */
.playlist-mosaic {
    width: 220px;
    height: 220px;
    border-radius: 4px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 4px;
    flex-shrink: 0;
    overflow: hidden;
    background: #282828;
}

.playlist-mosaic-item {
    width: 100%;
    height: 100%;
    background: #282828;
    display: flex;
    align-items: center;
    justify-content: center;
}

.playlist-mosaic-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.playlist-mosaic-item i {
    color: #535353;
    font-size: 2rem;
}

/* Playlist Header Info */
.playlist-header-info {
    min-width: 0;
}

.playlist-type {
    font-size: 0.75rem;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 0.5rem;
    color: #fff;
}

.playlist-header-info h1 {
    font-size: 3rem;
    font-weight: 900;
    margin-bottom: 0.5rem;
    color: white;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
}

.playlist-meta {
    font-size: 0.875rem;
    color: #b3b3b3;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.playlist-meta-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #282828;
}

/* Playlist Actions */
.playlist-actions {
    position: relative;
    z-index: 1;
    display: flex;
    gap: 2rem;
    padding: 0 2rem 2rem;
    align-items: center;
}

.playlist-play-btn {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #1db954;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.1s, background 0.1s;
}

.playlist-play-btn:hover {
    transform: scale(1.05);
    background: #1ed760;
}

.playlist-play-btn i {
    color: black;
    font-size: 1.25rem;
    margin-left: 2px;
}

.playlist-shuffle-btn,
.playlist-download-btn {
    background: none;
    border: none;
    color: #b3b3b3;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
}

.playlist-shuffle-btn:hover,
.playlist-download-btn:hover {
    color: #fff;
}

.playlist-shuffle-btn.active {
    color: #1db954;
    position: relative;
}

.playlist-shuffle-btn.active::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #1db954;
}

/* Playlist Songs Container */
.playlist-songs-container {
    position: relative;
    z-index: 1;
    padding: 0 2rem;
}

.playlist-songs-header {
    display: grid;
    grid-template-columns: 40px 40px 1fr 1fr 1fr 60px;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #282828;
    color: #b3b3b3;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    position: sticky;
    top: 0;
    background: #121212;
    z-index: 10;
}

.ps-col-num { width: 40px; text-align: center; }
.ps-col-title { min-width: 0; }
.ps-col-album { min-width: 0; }
.ps-col-date { min-width: 0; }
.ps-col-duration { width: 60px; text-align: right; }

.playlist-songs-list {
    display: flex;
    flex-direction: column;
}

/* Song Row */
.playlist-song-row {
    display: grid;
    grid-template-columns: 40px 40px 1fr 1fr 1fr 60px;
    align-items: center;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font-size: 0.875rem;
    color: #fff;
    cursor: pointer;
    transition: background 0.2s;
}

.playlist-song-row:hover {
    background: rgba(255,255,255,0.07);
}

.ps-row-num {
    width: 40px;
    text-align: center;
    color: #b3b3b3;
}

.playlist-song-row:hover .ps-row-num {
    display: none;
}

.ps-row-play-icon {
    display: none;
    width: 40px;
    text-align: center;
    color: #fff;
}

.playlist-song-row:hover .ps-row-play-icon {
    display: block;
}

.ps-row-art {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    overflow: hidden;
    background: #282828;
}

.ps-row-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.ps-row-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.ps-row-title-song {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ps-row-title-artist {
    color: #b3b3b3;
    font-size: 0.8125rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ps-row-album {
    color: #b3b3b3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ps-row-date {
    color: #b3b3b3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ps-row-duration {
    color: #b3b3b3;
    text-align: right;
}

/* Empty State */
.playlist-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem;
    color: #b3b3b3;
    text-align: center;
}

.playlist-empty-state i {
    font-size: 3rem;
    margin-bottom: 1rem;
}

.playlist-empty-state p {
    color: #fff;
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
}

.playlist-empty-state span {
    color: #b3b3b3;
    font-size: 0.875rem;
}

/* Back button adjustment */
.playlist-back {
    position: relative;
    z-index: 2;
    background: rgba(0,0,0,0.5);
    border: none;
    color: #fff;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
}

.playlist-back:hover {
    background: rgba(255,255,255,0.1);
}
```

- [ ] **Step 2: Commit**

```bash
git add client/styles.css
git commit -m "feat: add playlist page CSS styles"
```

---

## Task 3: JavaScript Implementation

**Files:**
- Modify: `client/script.js` (add functions, update openPlaylist)

- [ ] **Step 1: Add color extraction function**

Add at the top of script.js (around line 50, after existing helper functions):

```javascript
// Extract average color from image URL using canvas
async function extractDominantColor(imageUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = function() {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Scale down for performance
            const size = 50;
            canvas.width = size;
            canvas.height = size;
            
            ctx.drawImage(img, 0, 0, size, size);
            
            const imageData = ctx.getImageData(0, 0, size, size);
            const data = imageData.data;
            
            let r = 0, g = 0, b = 0;
            let count = 0;
            
            for (let i = 0; i < data.length; i += 4) {
                // Skip transparent pixels
                if (data[i + 3] > 128) {
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    count++;
                }
            }
            
            if (count === 0) {
                resolve('#535353');
                return;
            }
            
            r = Math.round(r / count);
            g = Math.round(g / count);
            b = Math.round(b / count);
            
            resolve(`rgb(${r}, ${g}, ${b})`);
        };
        
        img.onerror = function() {
            resolve('#535353');
        };
        
        img.src = imageUrl;
    });
}

// Convert RGB string to hex
function rgbToHex(rgb) {
    const match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!match) return '#535353';
    
    const r = parseInt(match[1]).toString(16).padStart(2, '0');
    const g = parseInt(match[2]).toString(16).padStart(2, '0');
    const b = parseInt(match[3]).toString(16).padStart(2, '0');
    
    return '#' + r + g + b;
}
```

- [ ] **Step 2: Add helper function to build 2x2 mosaic**

Add after color extraction functions:

```javascript
// Build 2x2 mosaic from track artwork
function buildMosaic(tracks) {
    const mosaic = document.getElementById('playlist-mosaic');
    mosaic.innerHTML = '';
    
    if (!tracks || tracks.length === 0) {
        // Empty playlist - show placeholder with music note
        const item = document.createElement('div');
        item.className = 'playlist-mosaic-item';
        item.style.gridColumn = '1 / -1';
        item.style.gridRow = '1 / -1';
        item.innerHTML = '<i class="fa-solid fa-music"></i>';
        mosaic.appendChild(item);
        return;
    }
    
    // Get up to 4 unique artwork URLs
    const artworks = [];
    tracks.forEach(pt => {
        if (pt.track && pt.track.artwork && !artworks.includes(pt.track.artwork)) {
            artworks.push(pt.track.artwork);
        }
        if (artworks.length >= 4) return;
    });
    
    // Handle different playlist sizes
    if (tracks.length === 1) {
        // Single song - fill entire mosaic
        const item = document.createElement('div');
        item.className = 'playlist-mosaic-item';
        item.style.gridColumn = '1 / -1';
        item.style.gridRow = '1 / -1';
        if (artworks.length > 0) {
            const img = document.createElement('img');
            img.src = withBase('/tracks/' + tracks[0].track.id + '/artwork?v=' + Date.now());
            item.appendChild(img);
        }
        mosaic.appendChild(item);
        return;
    }
    
    if (tracks.length === 2) {
        // 2 songs - duplicate in both rows
        for (let i = 0; i < 4; i++) {
            const item = document.createElement('div');
            item.className = 'playlist-mosaic-item';
            const artIndex = i < 2 ? 0 : 1;
            if (artworks[artIndex]) {
                const img = document.createElement('img');
                img.src = withBase('/tracks/' + tracks[artIndex].track.id + '/artwork?v=' + Date.now());
                item.appendChild(img);
            }
            mosaic.appendChild(item);
        }
        return;
    }
    
    if (tracks.length === 3) {
        // 3 songs - 3 thumbnails + 1 placeholder
        for (let i = 0; i < 3; i++) {
            const item = document.createElement('div');
            item.className = 'playlist-mosaic-item';
            if (artworks[i]) {
                const img = document.createElement('img');
                img.src = withBase('/tracks/' + tracks[i].track.id + '/artwork?v=' + Date.now());
                item.appendChild(img);
            }
            mosaic.appendChild(item);
        }
        // Placeholder for 4th
        const placeholder = document.createElement('div');
        placeholder.className = 'playlist-mosaic-item';
        placeholder.style.background = '#282828';
        mosaic.appendChild(placeholder);
        return;
    }
    
    // 4+ songs - standard 2x2
    for (let i = 0; i < 4; i++) {
        const item = document.createElement('div');
        item.className = 'playlist-mosaic-item';
        if (artworks[i]) {
            const img = document.createElement('img');
            img.src = withBase('/tracks/' + tracks[i].track.id + '/artwork?v=' + Date.now());
            item.appendChild(img);
        }
        mosaic.appendChild(item);
    }
}
```

- [ ] **Step 3: Add format total duration helper**

Add after buildMosaic:

```javascript
// Format total duration from tracks
function formatTotalDuration(tracks) {
    if (!tracks || tracks.length === 0) return '0 songs';
    
    let totalMs = 0;
    tracks.forEach(pt => {
        if (pt.track && pt.track.duration) {
            totalMs += pt.track.duration;
        }
    });
    
    const totalMinutes = Math.floor(totalMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    if (hours === 0) {
        return tracks.length + ' songs, ' + minutes + ' min';
    }
    return tracks.length + ' songs, ' + hours + ' hr ' + minutes + ' min';
}
```

- [ ] **Step 4: Add format date helper**

Add after formatTotalDuration:

```javascript
// Format date added
function formatDateAdded(dateStr) {
    if (!dateStr) return '—';
    
    const date = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
}
```

- [ ] **Step 5: Update openPlaylist function**

Replace the existing `openPlaylist` function (around line 2723) with this enhanced version:

```javascript
async function openPlaylist(playlistId) {
    currentPlaylistId = playlistId;
    try {
        var pl = await api("/playlists/" + playlistId);
        var tracks = await api("/playlists/" + playlistId + "/tracks");
        
        // Get playlist owner info
        var ownerName = pl.user ? pl.user.username : 'User';
        
        // Update header
        document.getElementById('playlist-name').textContent = pl.name;
        document.getElementById('playlist-type').textContent = pl.is_public ? 'Public Playlist' : 'Private Playlist';
        document.getElementById('playlist-meta').innerHTML = 
            '<div class="playlist-meta-avatar"></div>' + 
            ownerName + ' • ' + formatTotalDuration(tracks);
        
        // Build mosaic and extract color
        buildMosaic(tracks);
        
        // Get first artwork for color extraction
        if (tracks.length > 0 && tracks[0].track && tracks[0].track.artwork) {
            var artUrl = withBase('/tracks/' + tracks[0].track.id + '/artwork?v=' + Date.now());
            var color = await extractDominantColor(artUrl);
            var hex = rgbToHex(color);
            document.getElementById('playlist-gradient').style.background = 
                'linear-gradient(180deg, ' + hex + ' 0%, #121212 300px)';
        } else {
            document.getElementById('playlist-gradient').style.background = 
                'linear-gradient(180deg, #535353 0%, #121212 300px)';
        }
        
        // Build song list
        var container = document.getElementById('playlist-songs-list');
        container.innerHTML = '';
        
        if (tracks.length === 0) {
            container.innerHTML = 
                '<div class="playlist-empty-state">' +
                '<i class="fa-solid fa-music"></i>' +
                '<p>No songs yet</p>' +
                '<span>Add songs to get started</span>' +
                '</div>';
        } else {
            tracks.forEach(function(pt, i) {
                var row = document.createElement('div');
                row.className = 'playlist-song-row';
                
                var track = pt.track;
                var artistName = getArtistDisplay(track) || 'Unknown Artist';
                var albumName = track.album || '—';
                var dateAdded = pt.added_at ? formatDateAdded(pt.added_at) : '—';
                var duration = formatDuration(track.duration);
                
                var artworkUrl = track.artwork ? 
                    withBase('/tracks/' + track.id + '/artwork?v=' + (track.updated_at || '')) : '';
                
                row.innerHTML = 
                    '<span class="ps-row-num">' + (i + 1) + '</span>' +
                    '<span class="ps-row-play-icon"><i class="fa-solid fa-play"></i></span>' +
                    '<span class="ps-row-art">' + (artworkUrl ? '<img src="' + artworkUrl + '" alt="">' : '') + '</span>' +
                    '<span class="ps-row-title">' +
                    '<span class="ps-row-title-song">' + (track.title || '') + '</span>' +
                    '<span class="ps-row-title-artist">' + artistName + '</span>' +
                    '</span>' +
                    '<span class="ps-row-album">' + albumName + '</span>' +
                    '<span class="ps-row-date">' + dateAdded + '</span>' +
                    '<span class="ps-row-duration">' + duration + '</span>';
                
                // Click on title starts playback
                row.addEventListener('click', function() {
                    setQueueFromList(tracks.map(function(t) { return t.track; }), i);
                    if (currentQueue.length) playTrack(currentQueue[0]);
                });
                
                container.appendChild(row);
            });
        }
        
        // Store tracks for play button
        window.currentPlaylistTracks = tracks;
        
        setActivePage("playlist");
    } catch (err) { console.error(err); }
}
```

- [ ] **Step 6: Add action button event listeners**

Add after openPlaylist function:

```javascript
// Playlist action button handlers
document.getElementById('playlist-play-btn').addEventListener('click', function() {
    var tracks = window.currentPlaylistTracks;
    if (!tracks || tracks.length === 0) return;
    
    // Clear queue and add playlist tracks
    currentQueue = tracks.map(function(t) { return t.track; });
    if (currentQueue.length) {
        playTrack(currentQueue[0]);
    }
});

document.getElementById('playlist-shuffle-btn').addEventListener('click', function() {
    this.classList.toggle('active');
    // If enabling shuffle and playback is active, randomize the queue
    if (this.classList.contains('active') && currentQueue.length > 0) {
        // Fisher-Yates shuffle from current position
        var currentIndex = currentQueueIndex;
        for (var i = currentQueue.length - 1; i > currentIndex; i--) {
            var j = Math.floor(Math.random() * (i - currentIndex + 1)) + currentIndex;
            [currentQueue[i], currentQueue[j]] = [currentQueue[j], currentQueue[i]];
        }
    }
});

document.getElementById('playlist-download-btn').addEventListener('click', async function() {
    var tracks = window.currentPlaylistTracks;
    if (!tracks || tracks.length === 0) return;
    
    // Download each track - triggers browser download
    for (var i = 0; i < tracks.length; i++) {
        var track = tracks[i].track;
        var url = withBase('/tracks/' + track.id + '/file');
        var a = document.createElement('a');
        a.href = url;
        a.download = (track.title || 'track') + '.mp3';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Small delay between downloads
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }
});

document.getElementById('playlist-back').addEventListener('click', function() {
    setActivePage("home");
});
```

- [ ] **Step 7: Commit**

```bash
git add client/script.js
git commit -m "feat: implement playlist detail page JavaScript"
```

---

## Task 4: Testing

**Files:**
- Manual: `client/index.html`, `client/styles.css`, `client/script.js`

- [ ] **Step 1: Start dev server**

```bash
cd server && uvicorn app.main:app --reload
```

- [ ] **Step 2: Open browser and test**

Navigate to http://localhost:8000, log in, click on a playlist, and verify:
- [ ] Dynamic gradient appears based on album art
- [ ] 2x2 mosaic shows album thumbnails
- [ ] Header shows playlist type, name, and metadata
- [ ] Action bar has Play, Shuffle, Download buttons
- [ ] Clicking Play starts playback from first track
- [ ] Shuffle toggle changes icon color
- [ ] Song list displays all columns properly
- [ ] Hover states work on track rows
- [ ] Track number becomes play icon on hover
- [ ] Sticky column headers work on scroll

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: verify playlist detail page works"
```

---

## Acceptance Criteria Verification

| Requirement | Task |
|-------------|------|
| Dynamic gradient extracts color from 2x2 mosaic | Task 3, Step 5 |
| Gradient falls back to #535353 if no art | Task 3, Step 5 |
| 2x2 mosaic handles 0-4 songs | Task 3, Step 2 |
| Long titles truncate with ellipsis | Task 2, CSS .playlist-header-info h1 |
| Playlist type, name, metadata shown | Task 3, Step 5 |
| Action bar: Play, Shuffle, Download | Task 3, Step 6 |
| Play clears queue, starts from track 1 | Task 3, Step 6 |
| Shuffle active state green + dot | Task 2, CSS .active |
| Download downloads tracks | Task 3, Step 6 |
| Sticky column headers | Task 2, CSS position: sticky |
| Unknown Album/Date shows — | Task 3, Step 4, Step 5 |
| Empty state shows placeholder | Task 3, Step 5 |
| Hover states work | Task 2, CSS .playlist-song-row:hover |
| Track # becomes play icon on hover | Task 2, CSS .ps-row-play-icon |