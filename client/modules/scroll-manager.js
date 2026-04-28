/**
 * Scroll Manager Module
 *
 * Handles scroll position persistence across SPA navigation.
 * - Main content and sidebar library scroll positions are saved/restored via sessionStorage
 * - Playlist songs list always resets to top on open
 */

const SCROLL_KEYS = {
  MAIN: 'openfy:mainScroll'
};

/**
 * Save current scroll positions to sessionStorage
 * Called before page navigation
 */
export function saveScrollPositions() {
  try {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      sessionStorage.setItem(SCROLL_KEYS.MAIN, mainContent.scrollTop);
    }
  } catch (e) {
    // sessionStorage unavailable (private mode, etc.) — fail silently
    console.warn('Scroll positions not saved:', e.message);
  }
}

/**
 * Restore saved scroll positions from sessionStorage
 * Called after page content is fully rendered
 */
export function restoreScrollPositions() {
  try {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      const saved = sessionStorage.getItem(SCROLL_KEYS.MAIN);
      if (saved !== null) {
        mainContent.scrollTop = parseInt(saved, 10);
      }
    }
  } catch (e) {
    console.warn('Scroll positions not restored:', e.message);
  }
}

/**
 * Reset playlist page scroll to top
 * Called when a playlist page is opened (main-content is the scroll container)
 */
export function resetPlaylistScroll() {
  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.scrollTop = 0;
  }
}
