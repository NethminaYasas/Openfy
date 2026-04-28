/**
 * Scroll Manager Module
 *
 * Handles scroll position persistence for the main content window.
 * - Main content: global scroll position saved/restored via sessionStorage
 * - Playlist page: scroll always resets to top (no persistence)
 */

const SCROLL_KEY_MAIN = 'openfy:mainScroll';

/**
 * Save current main-content scroll position to sessionStorage
 * Called before page navigation (only when leaving non-playlist pages)
 */
export function saveScrollPositions() {
  try {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      sessionStorage.setItem(SCROLL_KEY_MAIN, mainContent.scrollTop);
    }
  } catch (e) {
    console.warn('Scroll positions not saved:', e.message);
  }
}

/**
 * Restore main-content scroll position from sessionStorage
 * Called after page content is fully rendered
 * - On playlist pages: always resets to top (no persistence)
 * - On other pages: restores the saved global scroll position
 */
export function restoreScrollPositions() {
  try {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    const onPlaylistPage = document.querySelector('.page#page-playlist.active');
    if (onPlaylistPage) {
      // Playlist page: always start at top
      mainContent.scrollTop = 0;
      return;
    }

    // Non-playlist pages: restore saved global scroll
    const saved = sessionStorage.getItem(SCROLL_KEY_MAIN);
    if (saved !== null) {
      mainContent.scrollTop = parseInt(saved, 10);
    }
  } catch (e) {
    console.warn('Scroll positions not restored:', e.message);
  }
}
