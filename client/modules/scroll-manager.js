/**
 * Scroll Manager Module
 *
 * Handles scroll position persistence across SPA navigation.
 * - Main content: global scroll position saved/restored via sessionStorage
 * - Playlist songs list: per-playlist scroll position saved/restored via sessionStorage
 */

const SCROLL_KEYS = {
  MAIN: 'openfy:mainScroll',
  PLAYLIST: (playlistId) => `openfy:playlistScroll:${playlistId}`
};

/**
 * Save current scroll positions to sessionStorage
 * Called before page navigation
 * - Saves main-content global scroll
 * - If on playlist page, also saves that playlist's songs list scroll
 */
export function saveScrollPositions() {
  try {
    const mainContent = document.querySelector('.main-content');

    if (mainContent) {
      sessionStorage.setItem(SCROLL_KEYS.MAIN, mainContent.scrollTop);
    }

    // If currently on a playlist page, also save the playlist's scroll position
    const onPlaylistPage = document.querySelector('.page#page-playlist.active');
    if (onPlaylistPage && state.currentPlaylistId) {
      const playlistScrollKey = SCROLL_KEYS.PLAYLIST(state.currentPlaylistId);
      if (mainContent) {
        sessionStorage.setItem(playlistScrollKey, mainContent.scrollTop);
      }
    }
  } catch (e) {
    // sessionStorage unavailable (private mode, etc.) — fail silently
    console.warn('Scroll positions not saved:', e.message);
  }
}

/**
 * Restore saved scroll positions from sessionStorage
 * Called after page content is fully rendered
 * - Restores main-content global scroll when on any page
 * - If on a playlist page AND this playlist has a saved scroll, restores that playlist's scroll
 */
export function restoreScrollPositions() {
  try {
    const mainContent = document.querySelector('.main-content');

    // Restore main-content scroll (global position) for non-playlist pages
    const onPlaylistPage = document.querySelector('.page#page-playlist.active');
    if (mainContent) {
      if (onPlaylistPage && state.currentPlaylistId) {
        // On playlist: try to restore per-playlist scroll, fall back to global
        const playlistScrollKey = SCROLL_KEYS.PLAYLIST(state.currentPlaylistId);
        const saved = sessionStorage.getItem(playlistScrollKey);
        if (saved !== null) {
          mainContent.scrollTop = parseInt(saved, 10);
          return;
        }
      }
      // Non-playlist pages or no playlist-specific scroll: use global
      const savedGlobal = sessionStorage.getItem(SCROLL_KEYS.MAIN);
      if (savedGlobal !== null) {
        mainContent.scrollTop = parseInt(savedGlobal, 10);
      }
    }
  } catch (e) {
    console.warn('Scroll positions not restored:', e.message);
  }
}
