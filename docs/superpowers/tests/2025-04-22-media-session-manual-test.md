# Media Session API Manual Test Verification

This document provides step-by-step instructions for verifying the Media Session API implementation across different platforms and browsers.

## 1. Browser Picture-in-Picture Media Card Test

**Objective:** Verify media controls appear in browser tab hover overlay and function correctly.

### Prerequisites
- Chrome or Edge browser
- Audio track loaded in the Openfy media player
- Internet connection for artwork loading (if applicable)

### Test Steps
1. Open Openfy application in Chrome or Edge browser
2. Load and play any audio track
3. Hover over the browser tab containing the Openfy application
4. **Verify** a media card appears showing:
   - Track title
   - Artist name  
   - Album name
   - Cover artwork (if available)
5. **Test controls:**
   - Click the play/pause button in the media card - playback should toggle
   - Click the previous track button - should skip to previous track
   - Click the next track button - should skip to next track
   - Drag the seek bar - playback position should update accordingly
6. **Verify** that controls are disabled appropriately when:
   - At the beginning of a track (previous button disabled)
   - At the end of a track (next button disabled)
   - No previous/next track exists in playlist

## 2. Windows System Media Overlay Test

**Objective:** Verify media information and controls appear in Windows system media overlay.

### Prerequisites
- Windows 10 or 11 operating system
- Chrome or Edge browser
- Openfy media player with audio track loaded

### Test Steps
1. Open Openfy application in Chrome or Edge on Windows
2. Load and play any audio track
3. **Method 1:** Press `Win + G` to open Xbox Game Bar overlay
   - **Method 2:** Click the volume icon in taskbar → select "Now Playing"
4. **Verify** the Windows media flyout shows:
   - Track title
   - Artist name
   - Album name
   - Cover artwork (if available)
   - Openfy as the media source
5. **Test transport controls:**
   - Click play/pause - playback should toggle
   - Click previous track - should skip to previous track
   - Click next track - should skip to next track
   - Drag seek position - playback should seek accordingly
6. **Verify** controls update when:
   - Track changes (manual or automatic)
   - Playback state changes (playing/paused)
7. Close the media flyout and verify playback continues normally

## 3. Linux MPRIS Test

**Objective:** Verify MPRIS integration with Linux desktop environments.

### Prerequisites
- Linux distribution with MPRIS support (KDE Plasma, GNOME, etc.)
- Chrome, Edge, or Firefox browser
- Openfy media player with audio track loaded

### Test Steps for KDE Plasma
1. Open Openfy application in supported browser on Linux
2. Load and play any audio track
3. Locate the media controller in:
   - System tray (usually bottom-right)
   - Or press `Super + Space` and search for "Media Controller"
4. **Verify** the media controller shows:
   - Track title
   - Artist name
   - Album name
   - Cover artwork (if available)
   - Playback controls (play/pause, previous, next)
5. **Test controls:**
   - Click play/pause - playback should toggle
   - Click previous/next - should skip tracks accordingly
   - Use seek bar - playback position should update
6. **Verify** metadata updates when track changes

### Test Steps for GNOME
1. Open Openfy application in supported browser on Linux
2. Load and play any audio track
3. Check the system menu (top-right corner) for media controls
4. **Verify** track information and controls appear in the media section
5. **Test** play/pause and skip functionality

## 4. Fallback Test

**Objective:** Verify graceful degradation in browsers without Media Session API support.

### Prerequisites
- Any browser (including older versions or headless browsers)
- Developer tools access

### Test Steps
1. Open Openfy application in test browser
2. Open Developer Console (F12 or Ctrl+Shift+I)
3. Navigate to the Console tab
4. **Verify** no errors appear related to:
   - `navigator.mediaSession`
   - `mediaSession.setActionHandler`
   - `mediaSession.metadata`
5. **Optional:** For explicit testing in unsupported environments:
   - Execute in console: `typeof navigator.mediaSession`
   - **Verify** returns `undefined` in unsupported browsers
   - **Verify** returns `object` in supported browsers (Chrome/Edge)
6. **Confirm** media playback continues to work normally despite lack of system integration

## Additional Verification Points

### Artwork Handling
- Verify artwork displays correctly when available from track metadata
- Verify placeholder/default image shows when no artwork is available
- Verify artwork updates when track changes

### Metadata Accuracy
- Verify track title, artist, and album match currently playing track
- Verify special characters in metadata display correctly
- Verify long titles/artist names truncate or scroll appropriately in UI

### Playback State Synchronization
- Verify play/pause state syncs between:
  - Openfy UI
  - Browser media card
  - System media overlay (Windows/Linux)
  - Physical media keys (if available)
- Verify seek position updates across all interfaces

### Error Conditions
- Verify no JavaScript errors occur when:
  - Rapidly skipping tracks
  - Seeking to beginning/end of track
  - Network interruption during artwork loading
  - Browser tab visibility changes (hidden/shown)

## Pass/Fail Criteria

**Pass:** All verification steps complete successfully with:
- Correct metadata displayed in all supported interfaces
- All media controls function as expected
- No JavaScript errors related to Media Session API
- Graceful fallback in unsupported browsers

**Fail:** Any of the following occur:
- Missing or incorrect metadata in media overlays
- Non-functional media controls
- JavaScript errors related to Media Session API
- Playback desynchronization between interfaces