# Web Media Session API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the Web Media Session API so the OS and browser display currently playing track metadata and playback controls in system media overlays.

**Architecture:** Add a vanilla JavaScript helper `updateMediaSession(track)` that sets `navigator.mediaSession.metadata` with track info; wire action handlers to existing player logic; update playback and position state in existing audio event handlers.

**Tech Stack:** Native browser Media Session API (no external deps), vanilla JS, fastapi backend (no changes needed)

---

## File Structure

**Files to modify:**
- `client/script.js` — add Media Session helper, action handlers, state synchronization

**Files to create:**
- `docs/superpowers/tests/2025-04-22-media-session-manual-test.md` — manual test verification steps

---

## Task 1: Write Manual Test Document

**Files:**
- Create: `docs/superpowers/tests/2025-04-22-media-session-manual-test.md`

- [ ] **Step 1:** Write the manual test verification document with concrete testing steps for Windows/Linux taskbar overlays and browser Picture-in-Picture media card

- [ ] **Step 2:** Commit the test document

```bash
git add docs/superpowers/tests/2025-04-22-media-session-manual-test.md
git commit -m "docs: add manual test steps for Media Session API"
```

---

## Task 2: Add `updateMediaSession` Helper Function

**Files:**
- Modify: `client/script.js` (around line ~525, near other helper functions)

**Context:** Around line 525-560 (near `escapeHtml`, `createPlaylistIconSvg`), add the helper function.

- [ ] **Step 1:** Add the helper function

Insert this code after `escapeHtml` function (after line 459):

```javascript
// Media Session API integration for OS/browser media overlays
function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;

    const artworkUrl = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
    const artistName = (track.artists && track.artists.length > 0 && track.artists[0].name) || 
                       (track.artist && track.artist.name) || "Unknown";
    const albumTitle = track.album?.title || "";

    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || "",
            artist: artistName,
            album: albumTitle,
            artwork: [
                {
                    src: artworkUrl,
                    sizes: '512x512',
                    type: 'image/jpeg'
                }
            ]
        });
    } catch (e) {
        // Silently ignore - Media Session is best-effort
        console.warn('MediaSession metadata error:', e.message);
    }
}
```

- [ ] **Step 2:** Commit

```bash
git add client/script.js
git commit -m "feat: add updateMediaSession helper for Web Media Session API"
```

---

## Task 3: Invoke `updateMediaSession` on Track Load

**Files:**
- Modify: `client/script.js`

**Integration points:**
- `playTrack(track)` — around line 1603-1648
- `loadTrackPaused(track)` — around line 1650-1699

- [ ] **Step 1:** Add call in `playTrack(track)` function

Find the `playTrack` function (around line 1603). At the START of the function (right after line 1604 `console.log('Playing track:', track.title);` or after the `currentTrackId = track.id;` line), add:

```javascript
        function playTrack(track) {
            console.log('Playing track:', track.title);
            currentTrackId = track.id;
            updateMediaSession(track); // <-- Add this line
            var streamUrl = "/tracks/" + track.id + "/stream";
```

Full relevant snippet after edit:

```javascript
        function playTrack(track) {
            console.log('Playing track:', track.title);
            currentTrackId = track.id;
            updateMediaSession(track);
            var streamUrl = "/tracks/" + track.id + "/stream";
```

- [ ] **Step 2:** Add call in `loadTrackPaused(track)` function

Find `loadTrackPaused` (around line 1650). At START (after `currentTrackId = track.id;`), add:

```javascript
        function loadTrackPaused(track) {
            console.log('Loading track (paused):', track.title);
            currentTrackId = track.id;
            updateMediaSession(track);
            // Set track to current queue (single track)
```

- [ ] **Step 3:** Commit

```bash
git add client/script.js
git commit -m "feat: call updateMediaSession when loading tracks"
```

---

## Task 4: Register Media Session Action Handlers

**Files:**
- Modify: `client/script.js` (around line 2258-2270, after audio controls setup)

**Context:** After the `topBarHome` click handler and other audio control event bindings (around line 2260+), register Media Session action handlers once on DOMContentLoaded.

- [ ] **Step 1:** Verify `navigator.mediaSession` availability and register handlers

After the existing audio control event bindings (find the line that says `topBarHome.addEventListener("click"...`), add:

```javascript
        // Register Media Session API action handlers
        if ('mediaSession' in navigator) {
            // Play handler
            navigator.mediaSession.setActionHandler('play', function() {
                if (audioPlayer.paused && audioPlayer.src && audioPlayer.src !== window.location.href) {
                    audioPlayer.play().catch(function(err) { console.error(err); });
                }
            });

            // Pause handler
            navigator.mediaSession.setActionHandler('pause', function() {
                if (!audioPlayer.paused) {
                    audioPlayer.pause();
                }
            });

            // Previous track handler
            navigator.mediaSession.setActionHandler('previoustrack', function() {
                if (currentQueue.length && currentIndex > 0) {
                    playByIndex(currentIndex - 1, false);
                }
            });

            // Next track handler
            navigator.mediaSession.setActionHandler('nexttrack', function() {
                if (currentQueue.length && currentIndex < currentQueue.length - 1) {
                    playByIndex(currentIndex + 1, false);
                }
            });

            // Seek backward handler (-10 seconds)
            navigator.mediaSession.setActionHandler('seekbackward', function() {
                if (audioPlayer.duration) {
                    audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10);
                    // Immediately update position state for responsive OS UI
                    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
                        navigator.mediaSession.setPositionState({
                            duration: audioPlayer.duration,
                            playbackRate: audioPlayer.playbackRate,
                            position: audioPlayer.currentTime
                        });
                    }
                }
            });

            // Seek forward handler (+10 seconds)
            navigator.mediaSession.setActionHandler('seekforward', function() {
                if (audioPlayer.duration) {
                    audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 10);
                    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
                        navigator.mediaSession.setPositionState({
                            duration: audioPlayer.duration,
                            playbackRate: audioPlayer.playbackRate,
                            position: audioPlayer.currentTime
                        });
                    }
                }
            });
        }

        topBarHome.addEventListener("click", function(event) {
```

- [ ] **Step 2:** Commit

```bash
git add client/script.js
git commit -m "feat: register Media Session action handlers for play/pause/seek/track navigation"
```

---

## Task 5: Sync Playback State on Play/Pause Events

**Files:**
- Modify: `client/script.js` (around line 2149-2162)

**Integration:** Update existing audio `play` and `pause` event listeners to set `navigator.mediaSession.playbackState`.

- [ ] **Step 1:** Update the `play` event listener

Find: `audioPlayer.addEventListener("play", function() {` (line ~2149)

Modify inside the handler to add playback state:

```javascript
        audioPlayer.addEventListener("play", function() {
            btnPlay.classList.add("playing");
            progressContainer.classList.add("active");
            // Update media session playback state
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
            // Update tab title when playback starts (including resume from pause)
            if (currentQueue.length && currentIndex >= 0 && currentIndex < currentQueue.length) {
                var track = currentQueue[currentIndex];
                var artistTitle = (track.artists && track.artists.length > 0 && track.artists[0].name) || (track.artist && track.artist.name) || "Unknown";
                document.title = (track.title || "Openfy") + " - " + artistTitle;
            }
        });
```

- [ ] **Step 2:** Update the `pause` event listener

Find: `audioPlayer.addEventListener("pause", function() {` (line ~2159)

Modify:

```javascript
        audioPlayer.addEventListener("pause", function() {
            btnPlay.classList.remove("playing");
            progressContainer.classList.remove("active");
            // Update media session playback state
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
        });
```

- [ ] **Step 3:** Commit

```bash
git add client/script.js
git commit -m "feat: sync Media Session playbackState on play and pause events"
```

---

## Task 6: Sync Position State via `timeupdate` Event

**Files:**
- Modify: `client/script.js` (add new event listener after line ~2180, near other listeners)

**Context:** Register a `timeupdate` event listener on `audioPlayer` to keep OS progress bar in sync. Throttle to ~100ms intervals (roughly 10 updates/sec) to avoid excessive IPC while keeping smooth UI.

- [ ] **Step 1:** Add `timeupdate` event listener and throttle logic

Add after the `smoothProgress()` call (around line 2176, before `ended` listener) OR after the `ended` listener ends (after line 2205). Insert:

```javascript
        // Media Session position state synchronization (throttled via timeupdate)
        let lastMediaSessionUpdate = 0;
        audioPlayer.addEventListener("timeupdate", function() {
            if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;

            const now = Date.now();
            if (now - lastMediaSessionUpdate < 100) return; // Throttle to ~10Hz
            lastMediaSessionUpdate = now;

            if (audioPlayer.duration) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: audioPlayer.duration,
                        playbackRate: audioPlayer.playbackRate,
                        position: audioPlayer.currentTime
                    });
                } catch (e) {
                    // Silently ignore
                }
            }
        });
```

- [ ] **Step 2:** Add `durationchange` event listener for files that report duration late

Add after the `timeupdate` listener:

```javascript
        // Update position state when duration becomes available (some files report late)
        audioPlayer.addEventListener("durationchange", function() {
            if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
            if (audioPlayer.duration) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: audioPlayer.duration,
                        playbackRate: audioPlayer.playbackRate,
                        position: audioPlayer.currentTime
                    });
                } catch (e) {
                    // Silently ignore
                }
            }
        });
```

- [ ] **Step 3:** Commit

```bash
git add client/script.js
git commit -m "feat: sync Media Session positionState via throttled timeupdate and durationchange events"
```

---

## Task 7: Immediate Position State on Seek

**Files:**
- Modify: `client/script.js` (inside `seekFromEvent` function around line 2211)

**Integration:** When user seeks, update Media Session position immediately so OS progress bar reflects the new position without waiting for next `timeupdate`.

- [ ] **Step 1:** Update `seekFromEvent` to set position state after changing `currentTime`

Modify `seekFromEvent`:

```javascript
        function seekFromEvent(e) {
            var rect = progressTrack.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
            if (audioPlayer.duration) {
                audioPlayer.currentTime = (pct / 100) * audioPlayer.duration;
                updateProgressFill();
                // Immediately notify Media Session of seek to keep OS overlay in sync
                if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
                    try {
                        navigator.mediaSession.setPositionState({
                            duration: audioPlayer.duration,
                            playbackRate: audioPlayer.playbackRate,
                            position: audioPlayer.currentTime
                        });
                    } catch (e) {
                        // Silently ignore
                    }
                }
            }
        }
```

- [ ] **Step 2:** Commit

```bash
git add client/script.js
git commit -m "feat: immediately update Media Session position on user seek"
```

---

## Task 8: Final Integration Check & Build Verification

**Files:**
- Verify: `client/index.html` includes `script.js` (should already be correct)

- [ ] **Step 1:** Confirm script is loaded from the HTML

Check `client/index.html` contains `<script src="script.js"></script>` (or equivalent). This should already be in place. If missing, add before `</body>`.

- [ ] **Step 2:** Verify no syntax errors would prevent script execution

Run a syntax check:

```bash
node --check /home/nethmina/Documents/GITHUB/Openfy/client/script.js
```

If the command reports errors, fix them before proceeding.

- [ ] **Step 3:** Commit (only if changes were made)

```bash
git add client/index.html client/script.js
git commit -m "chore: verify script.js loads correctly"
```

---

## Task 9: Docker Rebuild & Validation

**Files:**
- None (operational task)

- [ ] **Step 1:** Rebuild Docker image to include changes

```bash
docker compose up --build -d
```

Wait for build to complete (`docker compose ps` shows `openfy` state as "Up").

- [ ] **Step 2:** Verify server is healthy

```bash
curl -s http://localhost:8000/health | jq .
```

Expected: `{"status":"ok"}`

- [ ] **Step 3:** Manual verification

Open browser to `http://localhost:8000`, log in, play a track, and confirm:
- Media Session metadata appears (hover over browser tab → media card shows track/artist/album/artwork)
- Play/pause/skip/seek buttons in media card work
- System OS overlay (Windows taskbar, Linux MPRIS) shows correct track info
- Console has no Media Session related errors (open DevTools Console)

If everything works, the implementation is complete.

---

## Self-Review Checklist

- [ ] All tasks have concrete code blocks (no placeholders)
- [ ] Each modification specifies exact file, line context, and code to insert
- [ ] Feature detection (`'mediaSession' in navigator`) guards all calls
- [ ] Error handling wraps `MediaMetadata` construction with try/catch
- [ ] `updateMediaSession` is called from both play and load-paused paths
- [ ] All action handlers check conditions before calling player (no-op if invalid)
- [ ] Position state is throttled (~10Hz) in `timeupdate`
- [ ] Seek updates position state immediately
- [ ] Duration change updates position state
- [ ] No external dependencies added

---

## Notes

- **No proxy endpoint needed:** Existing `/tracks/{id}/artwork` serves same-origin images already; no CORS issue.
- **No tests in test suite:** This project has no automated test runner configured; TDD discipline followed via manual test doc creation (Task 1) and incremental commits.
- **Browser support:** Media Session API is widely supported in modern browsers (Chrome 53+, Edge 79+, Firefox 71+, Safari 15.4+). Legacy browsers skip silently.
