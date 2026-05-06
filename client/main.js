import { state, setAuth, clearAuth, updateUser, withBase } from './modules/state.js';
import { api, loadTracks, loadUserUploads, loadMostPlayed, loadLastTrackPaused, loadUserQueue, loadUserPlayerState, refreshManualUploadSetting, loadPlaylists as apiLoadPlaylists, updateRegularPlaylistTrackCache, savePlayerState, signUp, signIn, tryAutoLogin as apiTryAutoLogin, createPlaylist, toggleLiked, addTrackToPlaylist, removeTrackFromPlaylist, renamePlaylist, deletePlaylist, togglePlaylistPin, togglePlaylistVisibility, togglePlaylistShuffle, downloadFromLink, pollJobStatus, runSearch, runSpotifySearch, uploadAvatar, getArtist, setAuthenticatedImage } from './modules/api.js';
import { escapeHtml, formatDuration, getArtistDisplay, formatTotalDuration, createPlaylistIconSvg, drawCanvas, clearCanvas, seededColor, queueArtworkUrl, positionRemovalMenu, buildMosaicFallback } from './modules/utils.js';
import { initGradient, destroyGradient, emitTrackChanged } from './modules/gradient-manager.js';
import { saveIntendedUrl, getAndClearIntendedUrl } from './modules/auth.js';
import { audioPlayer, togglePlay, playByIndex, playTrack, loadTrackPaused, setQueueFromList, reorderQueue, enforceQueueCapacity, shuffleQueueOnce, unshuffleQueue, scheduleQueueSave, renderNowPlayingQueue, buildQueueItem, getShowFullQueue, setShowFullQueue, getCollapseTimeout, setCollapseTimeout, syncLikeButtonState, updateNowPlaying } from './modules/audio-player.js';
import { pages, setActivePage, navigateFromUrl, loadTracks as uiLoadTracks, loadUserUploads as uiLoadUserUploads, loadMostPlayed as uiLoadMostPlayed, renderTracks, renderUploads, renderMostPlayed, buildTrackCard, buildPlaylistCover, openPlaylist, openPlaylistById, renderLibrary, loadPlaylists, populateProfilePage, renderSearchDropdown, renderRecentSearchDropdown, hideSearchDropdown, updateTrackRowScrollButtons, updateAllScrollButtonStates, setUrl, renderSearch } from './modules/ui.js';
import { loadRecentSearches, addRecentSearch } from './modules/recent-searches.js';
import { updateAdminButtonVisibility, loadAdminStatsUI, loadAdminSettingsUI, applyManualUploadUI, loadUsersListUI, loadTracksListUI, initAdminEventListeners } from './modules/admin.js';

// Global function for artist navigation
window.navigateToArtist = function(artistId) {
  state.currentArtistId = artistId;
  setUrl('/artist/' + artistId);
  setActivePage('artist');
};

// Global handler for clickable artist names - stops propagation to prevent track play
window.handleArtistClick = function(event, artistId) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  window.navigateToArtist(artistId);
};

const MAX_QUEUE_CAPACITY = 20;

// Gradient animation for auth page
function animateAuthGradient() {
  const gradientEl = document.getElementById('auth-bg-gradient');
  if (!gradientEl) return;
  
  // First: fade in the green gradient
  let startTime = performance.now();
  const fadeInDuration = 300; // 300ms fade-in
  
  function fadeInGradient(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / fadeInDuration, 1);
    
    gradientEl.style.opacity = progress;
    
    if (progress < 1) {
      requestAnimationFrame(fadeInGradient);
    } else {
      // After fade-in completes, start color transition
      startColorTransition();
    }
  }
  
  function startColorTransition() {
    const colors = [
      { r: 29, g: 185, b: 84 },   // green
      { r: 120, g: 185, b: 29 },  // yellow-green
      { r: 185, g: 185, b: 29 },  // yellow
      { r: 185, g: 120, b: 29 },  // orange
      { r: 220, g: 38, b: 38 }    // red
    ];
    
    const duration = 4000; // 4 seconds for color transition
    startTime = performance.now();
    
    function updateGradient(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Calculate which segment
      const segment = progress * (colors.length - 1);
      const index = Math.floor(segment);
      const localProgress = segment - index;
      
      if (index >= colors.length - 1) {
        applyGradientColor(gradientEl, colors[colors.length - 1]);
        return;
      }
      
      const start = colors[index];
      const end = colors[index + 1];
      
      const r = Math.round(start.r + (end.r - start.r) * localProgress);
      const g = Math.round(start.g + (end.g - start.g) * localProgress);
      const b = Math.round(start.b + (end.b - start.b) * localProgress);
      
      applyGradientColor(gradientEl, { r, g, b });
      
      if (progress < 1) {
        requestAnimationFrame(updateGradient);
      }
    }
    
    requestAnimationFrame(updateGradient);
  }
  
  // Start the fade-in animation
  requestAnimationFrame(fadeInGradient);
}

function applyGradientColor(element, color) {
  element.style.background = `radial-gradient(ellipse at 50% 30%, rgba(${color.r}, ${color.g}, ${color.b}, 0.15) 0%, transparent 60%), radial-gradient(ellipse at 80% 80%, rgba(${color.r}, ${color.g}, ${color.b}, 0.08) 0%, transparent 50%)`;
}

// Auth helper functions
function showAuthStatus(elementId, message, type = "error") {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className = "auth-status " + type;
}

function clearAuthStatus(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = "";
  el.className = "auth-status";
}

function updateUserAvatarDisplay(avatarPath, user = null) {
  const userIcon = document.getElementById("user-icon");
  if (!userIcon) return;

  const userId = user?.id || state.currentUser?.id;
  if (!userId) return;

  if (avatarPath) {
    // Show avatar image — remove FA classes to prevent pseudo-element
    userIcon.classList.add("user-avatar-mode");
    userIcon.classList.remove("fa-solid", "fa-user");
    userIcon.innerHTML = "";
    const img = document.createElement("img");
    img.src = withBase(`/users/${userId}/avatar?t=${Date.now()}`);
    img.alt = "Avatar";
    img.className = "user-avatar-sm";
    userIcon.appendChild(img);
  } else {
    // Revert to default FA icon
    userIcon.classList.remove("user-avatar-mode");
    userIcon.classList.add("fa-solid", "fa-user");
    userIcon.innerHTML = "";
  }
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle("loading", loading);
  btn.disabled = loading;
  const text = btn.querySelector(".btn-text");
  const loader = btn.querySelector(".btn-loader");
  if (text) text.style.visibility = loading ? "hidden" : "visible";
  if (loader) loader.style.display = loading ? "inline-block" : "none";
}

window.addEventListener('popstate', navigateFromUrl);

document.addEventListener('DOMContentLoaded', async function() {
  pages.init();
  
  audioPlayer.init();
  
  initEventListeners();
  
  initHashModalHandlers();
  
  initPlaylistHandlers();

  initArtistHandlers();

  initContextMenuHandlers();
  
  initAdminEventListeners();
  
  initUploadHandlers();
  
  initLibraryToggle();
  
  initVolumeControls();
  
  initProgressBar();
  
  initMediaSession();
  
  initKeyboardControls();
  
  initResizeObserver();

  // Navigate to URL BEFORE any async operations - this sets the correct page immediately
  // before authentication check, so there's no flash
  navigateFromUrl();

  const ok = await tryAutoLogin();
  if (!ok) {
    document.getElementById("auth-overlay").style.display = "flex";
    animateAuthGradient();
    document.getElementById("app-main").style.display = "none";
    saveIntendedUrl();
  } else {
    // Already navigated above - just load data
    await uiLoadTracks();
    await uiLoadMostPlayed();
    await loadPlaylists();
    await uiLoadUserUploads();
  }
});

async function tryAutoLogin() {
  const user = await apiTryAutoLogin();
  if (user) {
    updateUser(user);
    updateAdminButtonVisibility();
    document.getElementById("auth-overlay").style.display = "none";
    document.getElementById("app-main").style.display = "flex";
    document.getElementById("top-bar").style.display = "flex";
    document.getElementById("dropdown-username").textContent = user.name;
    updateUserAvatarDisplay(user.avatar_path, user);
    document.getElementById("np-like-btn").classList.add("hidden");
    await uiLoadTracks();
    await loadPlaylists();
    await uiLoadUserUploads();
    await loadUserPlayerState();
    
    const btnShuffle = document.getElementById("btn-shuffle");
    const btnRepeat = document.getElementById("btn-repeat");
    if (btnShuffle) btnShuffle.classList.toggle("active", state.shuffle);
    if (btnRepeat) {
      btnRepeat.classList.toggle("active", state.repeatState === "loop-once");
      btnRepeat.classList.toggle("loop-twice", state.repeatState === "loop-twice");
    }
    
    document.getElementById('app-main').classList.add('home-page');
    initGradient();
    
    const queueData = await loadUserQueue();
    if (!queueData) {
      const lastTrack = await loadLastTrackPaused();
      if (lastTrack) {
        audioPlayer.src = "";
        audioPlayer.pause();
        document.getElementById("btn-play").classList.remove("playing");
        document.getElementById("progress-container").classList.remove("active");
        loadTrackPaused(lastTrack, true);
      }
    } else {
      setQueueFromList(queueData.tracks, queueData.index);
      const currentTrack = state.currentQueue[state.currentIndex];
      if (currentTrack) {
        loadTrackPaused(currentTrack, true);
      }
    }

    if (window.refreshUploadState) window.refreshUploadState();
    await refreshManualUploadSetting();
    applyManualUploadUI(state.manualAudioUploadEnabled);
    if (window.refreshLibraryState) window.refreshLibraryState();

    startUpdateChecker();

    // Don't navigate here - let the outer navigateFromUrl() at line 199 handle all navigation
    // This prevents double-navigation issues when user manually logs in

    return true;
  }
  return false;
}

function initEventListeners() {
  document.getElementById("top-bar-home").addEventListener("click", function(event) {
    event.preventDefault();
    setActivePage("home");
  });

  document.querySelectorAll(".nav-link").forEach(function(link) {
    link.addEventListener("click", function(event) {
      event.preventDefault();
      setActivePage(link.dataset.page || "home");
    });
  });
  
  document.getElementById("back-to-home").addEventListener("click", function(event) {
    event.preventDefault();
    setActivePage("home");
  });
  
  document.getElementById("download-button").addEventListener("click", function(event) {
    event.preventDefault();
    handleDownloadFromLink();
  });

  const manualUploadButton = document.getElementById("manual-upload-button");
  manualUploadButton?.addEventListener("click", function(event) {
    event.preventDefault();
    handleManualUpload();
  });

  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", function() {
    if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = setTimeout(handleSearch, 150);
  });
  
  searchInput.addEventListener("keydown", async function(ev) {
    if (ev.key === "Escape") {
      hideSearchDropdown();
      searchInput.blur();
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      var query = searchInput.value.trim();
      if (query) {
        // Hide dropdown and navigate to search results page
        hideSearchDropdown();
        await renderSearch(query);
        searchInput.blur();
      }
    }
  });

  searchInput.addEventListener("focus", function() {
    const query = this.value.trim();
    if (!query) {
      const recentItems = loadRecentSearches(state.authHash || '');
      if (recentItems.length) {
        renderRecentSearchDropdown(recentItems);
      } else {
        hideSearchDropdown();
      }
    }
  });

  const btnPlay = document.getElementById("btn-play");
  btnPlay.addEventListener("click", async function(event) {
    event.preventDefault();
    await togglePlay();
  });

  const btnPrev = document.getElementById("btn-prev");
  btnPrev.addEventListener("click", function(event) {
    event.preventDefault();
    if (audioPlayer.currentTime > 3) {
      audioPlayer.currentTime = 0;
    } else {
      playByIndex(state.currentIndex - 1);
    }
  });

  const btnNext = document.getElementById("btn-next");
  btnNext.addEventListener("click", function(event) {
    event.preventDefault();
    playByIndex(state.currentIndex + 1);
  });

  document.addEventListener("click", function(ev) {
    const searchDropdown = document.getElementById("search-dropdown");
    if (!searchDropdown || searchDropdown.style.display === "none") return;
    const searchBar = ev.target && ev.target.closest ? ev.target.closest(".search-bar") : null;
    if (!searchBar) hideSearchDropdown();
  });

  const btnShuffle = document.getElementById("btn-shuffle");
  btnShuffle.addEventListener("click", function(event) {
    event.preventDefault();
    state.shuffle = !state.shuffle;
    btnShuffle.classList.toggle("active", state.shuffle);
    if (state.shuffle) {
      shuffleQueueOnce();
      scheduleQueueSave();
    } else {
      unshuffleQueue();
    }
    renderNowPlayingQueue();
    savePlayerState();
  });

  const btnRepeat = document.getElementById("btn-repeat");
  btnRepeat.addEventListener("click", function(event) {
    event.preventDefault();
    if (state.repeatState === "off") {
      state.repeatState = "loop-once";
      state.repeatCount = 0;
      btnRepeat.classList.add("active");
      btnRepeat.classList.remove("loop-twice");
    } else if (state.repeatState === "loop-once") {
      state.repeatState = "loop-twice";
      state.repeatCount = 0;
      btnRepeat.classList.add("loop-twice");
      btnRepeat.classList.remove("active");
      // Ensure dot is visible when entering loop-twice mode
      const dot = btnRepeat.querySelector(".repeat-dot");
      if (dot) dot.style.display = "";
    } else {
      state.repeatState = "off";
      state.repeatCount = 0;
      btnRepeat.classList.remove("active", "loop-twice");
    }
    savePlayerState();
  });

  const npLikeBtn = document.getElementById("np-like-btn");
  npLikeBtn.addEventListener("click", async function(event) {
    event.preventDefault();
    if (!state.currentTrackId) return;
    if (!state.authHash) {
      alert("Please log in to manage playlists.");
      return;
    }
    event.stopPropagation();

    // Check current state based on button classes
    const isLiked = state.likedTrackIds.has(state.currentTrackId);
    const isInPlaylist = state.trackIdsInRegularPlaylists.has(state.currentTrackId);

    if (isLiked && isInPlaylist) {
      // Track is both liked AND in a playlist - show full modal
      await showAddToPlaylistModal();
    } else if (isLiked) {
      // Track is only liked - show full modal
      await showAddToPlaylistModal();
    } else if (isInPlaylist) {
      // Track is only in playlist(s) - show full modal
      await showAddToPlaylistModal();
    } else {
      // Plus icon - add directly to liked songs
      await addToLikedSongsDirect();
    }
    npLikeBtn.disabled = false;
  });

  // Add track directly to liked songs (no modal)
  async function addToLikedSongsDirect() {
    if (!state.currentTrackId || !state.authHash) return;
    try {
      await toggleLiked(state.currentTrackId);
      state.likedTrackIds.add(state.currentTrackId);
      syncLikeButtonState({ id: state.currentTrackId });
      // Show brief feedback animation
      npLikeBtn.classList.add('adding');
      setTimeout(() => npLikeBtn.classList.remove('adding'), 400);
    } catch (err) {
      console.error("Failed to add to liked songs:", err);
      alert("Failed to add to liked songs: " + err.message);
    }
  }

  // Show removal menu for liked songs
  window.showRemovalMenuForLiked = async function() {
    const removalMenu = document.getElementById("np-playlist-removal-menu");
    const removalItems = document.getElementById("np-playlist-removal-items");
    if (!removalMenu || !removalItems || !state.currentTrackId) return;

    removalItems.innerHTML = '<div class="submenu-loading">Loading...</div>';
    positionRemovalMenu(removalMenu, npLikeBtn);
    removalMenu.classList.add("visible");

    // For liked songs, just show a single option to remove
    removalItems.innerHTML = '';
    const removeItem = document.createElement('button');
    removeItem.className = 'submenu-item';
    removeItem.innerHTML = '<span class="submenu-playlist-name">Remove from Liked Songs</span>';
    removeItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await toggleLiked(state.currentTrackId);
        state.likedTrackIds.delete(state.currentTrackId);
        removalMenu.classList.remove("visible");
        syncLikeButtonState({ id: state.currentTrackId });
      } catch (err) {
        console.error("Failed to remove from liked songs:", err);
        alert("Failed to remove from liked songs: " + err.message);
      }
    });
    removalItems.appendChild(removeItem);
  };

  // Show removal menu with both liked songs and playlist options
  window.showRemovalMenuAllOptions = async function() {
    const removalMenu = document.getElementById("np-playlist-removal-menu");
    const removalItems = document.getElementById("np-playlist-removal-items");
    if (!removalMenu || !removalItems || !state.currentTrackId) return;

    removalItems.innerHTML = '<div class="submenu-loading">Loading...</div>';
    positionRemovalMenu(removalMenu, npLikeBtn);
    removalMenu.classList.add("visible");

    if (!state.currentUser) {
      removalItems.innerHTML = '<div class="submenu-error">Not logged in</div>';
      return;
    }

    try {
      // Load all playlists
      const playlists = await api("/playlists");
      state.userPlaylists = playlists;

      // Find playlists containing the current track
      const results = await Promise.all(
        playlists.map(async (pl) => {
          if (pl.is_liked) return { pl, hasTrack: false }; // Skip liked songs
          const trackIds = new Set();
          try {
            const tracks = await api("/playlists/" + pl.id + "/tracks");
            for (const pt of tracks) trackIds.add(pt.track.id);
          } catch (e) {
            console.error("Failed to load tracks for playlist:", pl.name, e);
          }
          return { pl, hasTrack: trackIds.has(state.currentTrackId) };
        })
      );

      // Filter to playlists that contain the track
      const playlistsWithTrack = results.filter(r => r.hasTrack && !r.pl.is_liked);

      // Build the menu items
      removalItems.innerHTML = '';

      // Add "Remove from Liked Songs" option
      const likedItem = document.createElement('button');
      likedItem.className = 'submenu-item';
      likedItem.innerHTML = '<span class="submenu-playlist-name">Remove from Liked Songs</span>';
      likedItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await toggleLiked(state.currentTrackId);
          state.likedTrackIds.delete(state.currentTrackId);
          removalMenu.classList.remove("visible");
          syncLikeButtonState({ id: state.currentTrackId });
        } catch (err) {
          console.error("Failed to remove from liked songs:", err);
          alert("Failed to remove from liked songs: " + err.message);
        }
      });
      removalItems.appendChild(likedItem);

      // Add divider if there are playlists
      if (playlistsWithTrack.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'submenu-divider';
        removalItems.appendChild(divider);

        // Add playlist items
        playlistsWithTrack.forEach(({ pl }) => {
          const item = document.createElement('button');
          item.className = 'submenu-item';
          item.dataset.playlistId = pl.id;

          const nameSpan = document.createElement('span');
          nameSpan.className = 'submenu-playlist-name';
          nameSpan.textContent = pl.name;
          item.appendChild(nameSpan);

          item.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
              await removeTrackFromPlaylist(pl.id, state.currentTrackId);
              state.trackIdsInRegularPlaylists.delete(state.currentTrackId);
              removalMenu.classList.remove("visible");
              await loadPlaylists();
              syncLikeButtonState({ id: state.currentTrackId });
            } catch (err) {
              console.error("Failed to remove track:", err);
              alert("Failed to remove track: " + err.message);
            }
          });

          removalItems.appendChild(item);
        });
      }
    } catch (err) {
      console.error("Failed to load playlists:", err);
      removalItems.innerHTML = '<div class="submenu-error">Failed to load</div>';
    }
  };

  // Show removal menu for playlist
  window.showRemovalMenu = async function() {
    const removalMenu = document.getElementById("np-playlist-removal-menu");
    const removalItems = document.getElementById("np-playlist-removal-items");
    if (!removalMenu || !removalItems || !state.currentTrackId) return;

    removalItems.innerHTML = '<div class="submenu-loading">Loading...</div>';
    positionRemovalMenu(removalMenu, npLikeBtn);
    removalMenu.classList.add("visible");

    if (!state.currentUser) {
      removalItems.innerHTML = '<div class="submenu-error">Not logged in</div>';
      return;
    }

    try {
      // Load all playlists
      const playlists = await api("/playlists");
      state.userPlaylists = playlists;

      // Find playlists containing the current track
      const results = await Promise.all(
        playlists.map(async (pl) => {
          if (pl.is_liked) return { pl, hasTrack: false }; // Skip liked songs
          const trackIds = new Set();
          try {
            const tracks = await api("/playlists/" + pl.id + "/tracks");
            for (const pt of tracks) trackIds.add(pt.track.id);
          } catch (e) {
            console.error("Failed to load tracks for playlist:", pl.name, e);
          }
          return { pl, hasTrack: trackIds.has(state.currentTrackId) };
        })
      );

      // Filter to only playlists that contain the track
      const playlistsWithTrack = results.filter(r => r.hasTrack && !r.pl.is_liked);

      removalItems.innerHTML = '';
      if (playlistsWithTrack.length === 0) {
        removalItems.innerHTML = '<div class="submenu-empty">Track not in any playlist</div>';
        return;
      }

      playlistsWithTrack.forEach(({ pl }) => {
        const item = document.createElement('button');
        item.className = 'submenu-item';
        item.dataset.playlistId = pl.id;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'submenu-playlist-name';
        nameSpan.textContent = pl.name;
        item.appendChild(nameSpan);

        item.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await removeTrackFromPlaylist(pl.id, state.currentTrackId);
            state.trackIdsInRegularPlaylists.delete(state.currentTrackId);
            // Refresh to update
            removalMenu.classList.remove("visible");
            await loadPlaylists();
            syncLikeButtonState({ id: state.currentTrackId });
          } catch (err) {
            console.error("Failed to remove track:", err);
            alert("Failed to remove track: " + err.message);
          }
        });

        removalItems.appendChild(item);
      });
    } catch (err) {
      console.error("Failed to load playlists:", err);
      removalItems.innerHTML = '<div class="submenu-error">Failed to load</div>';
    }
  };

  const queueHeader = document.getElementById("queue-header");
  queueHeader?.addEventListener("click", function(e) {
    e.preventDefault();
    const h3 = queueHeader.querySelector("h3");
    const collapseDelay = 280;

    if (state.showFullQueue) {
      state.showFullQueue = false;
      h3.textContent = "NEXT IN QUEUE";
      document.getElementById("np-next-panel").classList.remove("expanded");

      if (state.collapseTimeout) {
        clearTimeout(state.collapseTimeout);
        state.collapseTimeout = null;
      }

      state.collapseTimeout = setTimeout(function() {
        state.collapseTimeout = null;
        renderNowPlayingQueue();
      }, collapseDelay);
    } else {
      state.showFullQueue = true;
      h3.textContent = "QUEUE";
      document.getElementById("np-next-panel").classList.add("expanded");
      if (state.collapseTimeout) {
        clearTimeout(state.collapseTimeout);
        state.collapseTimeout = null;
      }
      renderNowPlayingQueue();
    }
  });

  const userIcon = document.getElementById("user-icon");
  userIcon.addEventListener("click", function(event) {
    event.stopPropagation();
    document.getElementById("user-dropdown").classList.toggle("visible");
  });

  const userDropdown = document.getElementById("user-dropdown");
  userDropdown.addEventListener("click", function(event) {
    event.stopPropagation();
  });

  document.addEventListener("click", function(event) {
    const userMenu = document.getElementById("user-menu");
    if (userMenu && !userMenu.contains(event.target)) {
      document.getElementById("user-dropdown").classList.remove("visible");
    }
  });

  document.getElementById("profile-btn").addEventListener("click", function() {
    if (!state.currentUser) return;
    document.getElementById("user-dropdown").classList.remove("visible");
    populateProfilePage();
    setActivePage("profile");
  });

  document.getElementById("profile-back-home").addEventListener("click", function() {
    setActivePage("home");
  });

  document.getElementById("settings-btn").addEventListener("click", function() {
    document.getElementById("user-dropdown").classList.remove("visible");
    setActivePage("settings");
  });

  document.getElementById("settings-back-home").addEventListener("click", function() {
    setActivePage("home");
  });

  document.getElementById("logout-btn").addEventListener("click", function() {
    clearAuth();
    document.getElementById("dropdown-username").textContent = "";
    document.getElementById("np-like-btn").classList.add("hidden");
    updateAdminButtonVisibility();
    stopUpdateChecker();
    document.title = "Openfy - Web Player";
    document.getElementById("auth-overlay").style.display = "flex";
    animateAuthGradient();
    document.getElementById("user-dropdown").classList.remove("visible");
    document.getElementById("app-main").style.display = "none";
    document.getElementById('app-main').classList.remove('home-page');
    document.getElementById("top-bar").style.display = "none";
  });

  document.getElementById("signup-btn").addEventListener("click", async function() {
    var name = document.getElementById("signup-name").value.trim();
    if (!name) { showAuthStatus("signup-status", "Please enter a username.", "error"); return; }
    
    var btn = document.getElementById("signup-btn");
    setButtonLoading(btn, true);
    clearAuthStatus("signup-status");
    
    try {
      var user = await signUp(name);
      setAuth(user.auth_hash, user);
      updateAdminButtonVisibility();
      localStorage.setItem("openfy_auth", user.auth_hash);
      showHashModal(user.auth_hash);
      if (window.refreshUploadState) window.refreshUploadState();
      await refreshManualUploadSetting();
      applyManualUploadUI(state.manualAudioUploadEnabled);
      if (window.refreshLibraryState) window.refreshLibraryState();
    } catch (err) { showAuthStatus("signup-status", err.message || "Sign up failed.", "error"); }
    finally { setButtonLoading(btn, false); }
  });

  document.getElementById("signin-btn").addEventListener("click", async function() {
    var hash = document.getElementById("signin-hash").value.trim();
    if (!hash) { showAuthStatus("signin-status", "Please enter your auth hash.", "error"); return; }
    
    var btn = document.getElementById("signin-btn");
    setButtonLoading(btn, true);
    clearAuthStatus("signin-status");
    
    try {
      var user = await signIn(hash);
      setAuth(user.auth_hash, user);
      updateAdminButtonVisibility();
      localStorage.setItem("openfy_auth", user.auth_hash);
      document.getElementById("auth-overlay").style.display = "none";
      document.getElementById("app-main").style.display = "flex";
      document.getElementById("top-bar").style.display = "flex";
      document.getElementById("dropdown-username").textContent = user.name;
      updateUserAvatarDisplay(user.avatar_path, user);
      document.getElementById("np-like-btn").classList.add("hidden");
      await uiLoadTracks();
      await loadPlaylists();
      await uiLoadUserUploads();
      await loadUserPlayerState();
      const btnShuffleSignin = document.getElementById("btn-shuffle");
      const btnRepeatSignin = document.getElementById("btn-repeat");
      if (btnShuffleSignin) btnShuffleSignin.classList.toggle("active", state.shuffle);
      if (btnRepeatSignin) {
        btnRepeatSignin.classList.toggle("active", state.repeatState === "loop-once");
        btnRepeatSignin.classList.toggle("loop-twice", state.repeatState === "loop-twice");
      }
      const hasQueue = await loadUserQueue();
      if (!hasQueue) {
        const lastTrack = await loadLastTrackPaused();
        if (lastTrack) {
          audioPlayer.src = "";
          audioPlayer.pause();
          document.getElementById("btn-play").classList.remove("playing");
          document.getElementById("progress-container").classList.remove("active");
          loadTrackPaused(lastTrack, true);
        }
      } else {
        const currentTrack = state.currentQueue[state.currentIndex];
        if (currentTrack) {
          loadTrackPaused(currentTrack, true);
        }
      }

      if (window.refreshUploadState) window.refreshUploadState();
      await refreshManualUploadSetting();
      applyManualUploadUI(state.manualAudioUploadEnabled);
      if (window.refreshLibraryState) window.refreshLibraryState();

      await uiLoadMostPlayed();
      startUpdateChecker();

      const urlToNavigate = getAndClearIntendedUrl();
      if (urlToNavigate) {
        navigateFromUrl();
      } else {
        setActivePage('home');
      }
    } catch (err) { showAuthStatus("signin-status", err.message || "Login failed. Check your hash.", "error"); }
    finally { setButtonLoading(btn, false); }
  });

// Import Spotify Playlist
async function importSpotifyPlaylist() {
    const urlInput = document.getElementById("import-playlist-url");
    const statusDiv = document.getElementById("import-modal-status");
    const importBtn = document.getElementById("import-modal-import");

    const spotifyUrl = urlInput.value.trim();
    if (!spotifyUrl) {
        alert("Please enter a Spotify playlist URL");
        return;
    }

    // Show loading state
    importBtn.disabled = true;
    statusDiv.style.display = "block";
    statusDiv.textContent = "Fetching playlist...";

    try {
        // Step 1: Call backend to get playlist data
        const response = await fetch("/playlists/import", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-auth-hash": state.authHash
            },
            body: JSON.stringify({ url: spotifyUrl })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Failed to fetch playlist");
        }

        const playlistData = await response.json();
        const tracks = playlistData.tracks || [];

        statusDiv.textContent = `Found ${tracks.length} tracks. Processing...`;

        const normalizeText = (value) =>
            (value || "")
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s]/gu, " ")
                .replace(/\s+/g, " ")
                .trim();
        const titleLooksSame = (a, b) => {
            const na = normalizeText(a);
            const nb = normalizeText(b);
            return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
        };
        const parseArtistTokens = (artistsValue) => {
            const raw = Array.isArray(artistsValue) ? artistsValue.join(", ") : (artistsValue || "");
            const normalized = normalizeText(raw);
            if (!normalized) return new Set();
            const tokens = normalized
                .split(/,| feat | ft | & | and /)
                .map((s) => s.trim())
                .filter(Boolean)
                .flatMap((s) => s.split(" ").filter((w) => w.length >= 3));
            return new Set(tokens);
        };
        const artistsOverlap = (a, b) => {
            const setA = parseArtistTokens(a);
            const setB = parseArtistTokens(b);
            if (!setA.size || !setB.size) return true;
            for (const token of setA) {
                if (setB.has(token)) return true;
            }
            return false;
        };

        // Step 2: Find existing tracks and tracks to download
        const existingTracks = [];
        const tracksToDownload = [];

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            statusDiv.textContent = `Checking track ${i + 1} of ${tracks.length}: ${track.name}`;

            // Deterministic path: if this Spotify track ID already exists locally, use it directly.
            const spotifyMatch = (track.spotify_url || "").match(/\/track\/([A-Za-z0-9]+)/);
            const spotifyId = spotifyMatch ? spotifyMatch[1] : null;
            if (spotifyId) {
                try {
                    const existingBySpotify = await api(`/tracks/by-spotify-id/${spotifyId}`);
                    if (existingBySpotify && existingBySpotify.id) {
                        existingTracks.push(existingBySpotify);
                        continue;
                    }
                } catch (e) {
                    // 404 is expected when not present; continue with fuzzy matching.
                }
            }

            // Search by title first (artist strings from external sources can vary widely)
            const searchQuery = encodeURIComponent(track.name || "");
            const searchResp = await fetch(`/search?q=${searchQuery}&limit=10`, {
                headers: { "x-auth-hash": state.authHash }
            });

            if (!searchResp.ok) {
                tracksToDownload.push(track);
                continue;
            }
            const searchResults = await searchResp.json();

            // Find match by title + artist + duration (±5 seconds)
            const trackDurationSec = Math.floor(track.duration_ms / 1000);
            let matchedTrack = null;

            const targetTitle = normalizeText(track.name);
            const targetArtists = track.artists || [];
            if (Array.isArray(searchResults)) {
                for (const result of searchResults) {
                    const resultDuration = result.duration || 0;
                    const resultDurationSec = Math.floor(resultDuration / 1000);
                    const durationDiff = Math.abs(resultDurationSec - trackDurationSec);
                    const resultTitle = normalizeText(result.title);
                    const resultArtists = Array.isArray(result.artists) ? result.artists.map((a) => a?.name || "") : [];
                    const titleMatches = titleLooksSame(resultTitle, targetTitle);
                    const artistMatches = artistsOverlap(targetArtists, resultArtists);

                    if (titleMatches && artistMatches && durationDiff <= 12) {
                        matchedTrack = result;
                        break;
                    }
                }
            }

            if (matchedTrack) {
                existingTracks.push(matchedTrack);
            } else {
                tracksToDownload.push(track);
            }
        }

        statusDiv.textContent = `Found ${existingTracks.length} existing tracks, ${tracksToDownload.length} to download`;

        // Step 3: Create playlist
        const playlistName = playlistData.name || "Imported Playlist";
        // Create playlist with current user as owner (use current auth hash)
        const playlistResp = await fetch("/playlists", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-auth-hash": state.authHash
            },
            body: JSON.stringify({ name: playlistName })
        });

        if (!playlistResp.ok) {
            throw new Error("Failed to create playlist");
        }

        const newPlaylist = await playlistResp.json();
        const playlistId = newPlaylist.id;

        // Step 4: Set visibility to public and cover image
        await fetch(`/playlists/${playlistId}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "x-auth-hash": state.authHash
            },
            body: JSON.stringify({
                is_public: true,
                image_url: playlistData.image_url || null
            })
        });

        // Step 6: Download missing tracks via the same "upload from link" flow and add to playlist
        const downloadedTrackIds = [];
        let knownUploadIds = new Set();
        try {
            const existingUploads = await api(`/tracks?limit=200&user_hash=${encodeURIComponent(state.authHash)}`);
            if (Array.isArray(existingUploads)) {
                existingUploads.forEach((t) => knownUploadIds.add(t.id));
            }
        } catch (e) {
            console.warn("Failed to preload user uploads before playlist import:", e);
        }

        for (let i = 0; i < tracksToDownload.length; i++) {
            const track = tracksToDownload[i];
            statusDiv.textContent = `Downloading ${i + 1} of ${tracksToDownload.length}: ${track.name}`;

            try {
                if (!track.spotify_url) continue;

                const jobId = await downloadFromLink(track.spotify_url);

                // Poll for completion with timeout (max 120 seconds)
                let completed = false;
                let trackId = null;
                let timeoutCounter = 0;
                const maxTimeout = 60; // 60 * 2 seconds = 120 seconds

                while (!completed && timeoutCounter < maxTimeout) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    timeoutCounter++;

                    const status = await pollJobStatus(jobId);

                    if (status.status === "completed") {
                        completed = true;
                        if (status.track_id) {
                            trackId = status.track_id;
                            break;
                        }
                        // Find newly uploaded track by diffing user upload IDs
                        const tracksList = await api(`/tracks?limit=200&user_hash=${encodeURIComponent(state.authHash)}`);
                        if (Array.isArray(tracksList) && tracksList.length > 0) {
                            const targetName = normalizeText(track.name);
                            const targetArtist = normalizeText((track.artists && track.artists[0]) || "");
                            for (const resultTrack of tracksList) {
                                if (knownUploadIds.has(resultTrack.id)) continue;
                                const resultTitle = normalizeText(resultTrack.title);
                                const resultArtists = Array.isArray(resultTrack.artists) ? resultTrack.artists : [];
                                const resultArtist = normalizeText(resultArtists[0]?.name || "");
                                if (resultTitle === targetName && (!targetArtist || resultArtist === targetArtist)) {
                                    trackId = resultTrack.id;
                                    break;
                                }
                            }
                            if (!trackId) {
                                console.warn("Could not safely resolve downloaded track id for:", track.name);
                            }
                            tracksList.forEach((t) => knownUploadIds.add(t.id));
                        }
                    } else if (status.status === "failed" || status.status === "error") {
                        completed = true;
                    }
                }

                // Handle timeout case
                if (!completed && timeoutCounter >= maxTimeout) {
                    console.warn(`Download timeout for track: ${track.name}`);
                    completed = true; // Exit loop but don't add track
                }

                if (trackId) {
                    downloadedTrackIds.push(trackId);

                    // Add to playlist
                    await addTrackToPlaylist(playlistId, trackId);
                }
            } catch (e) {
                console.warn("Failed to download track:", track.name, e);
            }
        }

        // Step 7: Add existing tracks to playlist
        for (const track of existingTracks) {
            try {
                await addTrackToPlaylist(playlistId, track.id);
            } catch (e) {
                console.warn("Failed to add existing track:", track.name);
            }
        }

        // Note: Don't need to follow - the user is already the owner of this playlist

        statusDiv.textContent = `Import complete! Added ${existingTracks.length + downloadedTrackIds.length} tracks.`;

        // Close modal and refresh playlists
        setTimeout(() => {
            document.getElementById("import-playlist-modal").style.display = "none";
            loadPlaylists();
        }, 2000);

    } catch (err) {
        statusDiv.textContent = "Error: " + err.message;
    } finally {
        importBtn.disabled = false;
    }
}

// Close modal when clicking overlay or cancel
  document.getElementById("signin-hash").addEventListener("keydown", function(e) {
    if (e.key === "Enter") document.getElementById("signin-btn").click();
  });
  document.getElementById("signup-name").addEventListener("keydown", function(e) {
    if (e.key === "Enter") document.getElementById("signup-btn").click();
  });

  // Toggle between signin and signup forms
  document.getElementById("show-signup")?.addEventListener("click", function(e) {
    e.preventDefault();
    document.getElementById("auth-signin").style.display = "none";
    document.getElementById("auth-signup").style.display = "flex";
    document.querySelector(".auth-switch").style.display = "none";
    document.getElementById("back-to-signin").style.display = "block";
    clearAuthStatus("signin-status");
  });

  document.getElementById("show-signin")?.addEventListener("click", function(e) {
    e.preventDefault();
    document.getElementById("auth-signup").style.display = "none";
    document.getElementById("auth-signin").style.display = "flex";
    document.querySelector(".auth-switch").style.display = "block";
    document.getElementById("back-to-signin").style.display = "none";
    clearAuthStatus("signup-status");
  });

  document.getElementById("new-playlist-btn").addEventListener("click", function(e) {
    e.stopPropagation();
    const dropdown = document.getElementById("playlist-action-dropdown");
    const btn = this.getBoundingClientRect();
    dropdown.style.top = (btn.bottom + 8) + "px";
    dropdown.style.left = (btn.left - 100) + "px";
    dropdown.classList.toggle("visible");
  });

  // Create a Playlist option
  document.getElementById("create-playlist-option").addEventListener("click", async function() {
    document.getElementById("playlist-action-dropdown").classList.remove("visible");
    try { await createPlaylist("My Playlist"); await loadPlaylists(); } catch (err) { alert("Failed: " + err.message); }
  });

  // Import a Playlist option - open modal
  document.getElementById("import-playlist-option").addEventListener("click", function() {
    document.getElementById("playlist-action-dropdown").classList.remove("visible");
    document.getElementById("import-playlist-modal").style.display = "flex";
    document.getElementById("import-playlist-url").value = "";
    document.getElementById("import-modal-status").style.display = "none";
  });

  // Close modal when clicking overlay or cancel
  document.getElementById("import-modal-overlay").addEventListener("click", function() {
    document.getElementById("import-playlist-modal").style.display = "none";
  });

  document.getElementById("import-modal-cancel").addEventListener("click", function() {
    document.getElementById("import-playlist-modal").style.display = "none";
  });

  // Connect import button to function
  document.getElementById("import-modal-import").addEventListener("click", importSpotifyPlaylist);

  document.getElementById("import-playlist-url").addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      importSpotifyPlaylist();
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", function(e) {
    const dropdown = document.getElementById("playlist-action-dropdown");
    const btn = document.getElementById("new-playlist-btn");
    if (dropdown.classList.contains("visible") && !dropdown.contains(e.target) && e.target !== btn) {
      dropdown.classList.remove("visible");
    }
  });

  const adminBtn = document.getElementById("admin-btn");
  adminBtn?.addEventListener("click", function() {
    document.getElementById("user-dropdown").classList.remove("visible");
    const adminDashboard = document.getElementById("admin-dashboard");
    const adminUsersView = document.getElementById("admin-users-view");
    const adminLibraryView = document.getElementById("admin-library-view");
    if (adminDashboard) adminDashboard.style.display = "block";
    if (adminUsersView) adminUsersView.style.display = "none";
    if (adminLibraryView) adminLibraryView.style.display = "none";
    loadAdminStatsUI();
    loadAdminSettingsUI();
    setActivePage("admin");
  });

  const npQueueNext = document.getElementById("np-queue-next");
  npQueueNext.addEventListener("dragover", function(ev) {
    ev.preventDefault();
    if (!state.draggedElement) return;
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    state.lastDragY = ev.clientY;
    updateDragPosition();
  });

  npQueueNext.addEventListener("dragleave", function(ev) {
    if (!npQueueNext.contains(ev.relatedTarget)) {
      document.querySelectorAll(".np-queue-item.drag-over").forEach(function(el) {
        el.classList.remove("drag-over");
      });
    }
  });

  npQueueNext.addEventListener("drop", function(ev) {
    ev.preventDefault();
    const sourceIndex = state.dragSourceIndex;

    if (sourceIndex === null || sourceIndex === undefined) return;

    // Get all non-dragging items to find drop target
    const siblings = Array.from(npQueueNext.querySelectorAll(".np-queue-item:not(.dragging)"));
    if (siblings.length === 0) return;

    // Use getInsertBeforeElement to find where the item should be inserted
    const insertBeforeEl = getInsertBeforeElement(npQueueNext);

    // Calculate target position in DOM
    let newPositionInDom = -1;
    if (insertBeforeEl) {
      newPositionInDom = siblings.indexOf(insertBeforeEl);
    } else {
      // Dropped at end (after all items)
      newPositionInDom = siblings.length;
    }

    if (newPositionInDom < 0) {
      return;
    }

    // Calculate the actual queue index (after current track)
    // currentIndex is the playing track. Visible queue starts at currentIndex + 1
    // DOM index 0 = queue index currentIndex + 1
    const queueStartIndex = state.currentIndex + 1;
    const newQueueIndex = queueStartIndex + newPositionInDom;

    const actualFromIndex = sourceIndex;
    const actualToIndex = newQueueIndex;

    if (actualToIndex !== actualFromIndex) {
      reorderQueue(actualFromIndex, actualToIndex);
    }

    // Clean up drag state
    state.dragSourceIndex = null;
    state.draggedElement = null;
  });

  document.getElementById('np-playlist-removal-menu');

  // Search page back button
  const searchBack = document.getElementById("search-back");
  if (searchBack) {
    searchBack.addEventListener("click", function() {
      setActivePage("home");
    });
  }
}

function updateDragPosition() {
  const npQueueNext = document.getElementById("np-queue-next");
  if (!state.draggedElement || !npQueueNext.contains(state.draggedElement)) return;

  const insertBeforeEl = getInsertBeforeElement(npQueueNext);

  if (insertBeforeEl === state.lastInsertBeforeEl) return;

  // Get all siblings BEFORE moving - their current data-index values
  const siblings = Array.from(npQueueNext.querySelectorAll('.np-queue-item:not(.dragging)'));
  const beforeRects = new Map();
  const oldIndices = new Map();
  siblings.forEach(el => {
    oldIndices.set(el, el.dataset.index);
    beforeRects.set(el, el.getBoundingClientRect());
  });

  if (insertBeforeEl) {
    if (state.draggedElement.nextSibling !== insertBeforeEl) {
      npQueueNext.insertBefore(state.draggedElement, insertBeforeEl);
    }
  } else {
    if (state.draggedElement.nextSibling !== null) {
      npQueueNext.appendChild(state.draggedElement);
    }
  }

  // Don't update the queue array here - that happens on drop
  // Just do visual feedback

  siblings.forEach(el => {
    const before = beforeRects.get(el);
    const after = el.getBoundingClientRect();
    const deltaX = before.left - after.left;
    const deltaY = before.top - after.top;
    if (deltaX !== 0 || deltaY !== 0) {
      el.style.transition = 'none';
      el.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      el.offsetHeight;
      el.style.transition = 'transform 0.15s ease';
      el.style.transform = '';
    }
  });

  document.querySelectorAll('.np-queue-item.drag-over').forEach(el => el.classList.remove('drag-over'));
  if (insertBeforeEl) {
    insertBeforeEl.classList.add('drag-over');
  }

  state.lastInsertBeforeEl = insertBeforeEl;
}

function getInsertBeforeElement(container) {
  const items = Array.from(container.querySelectorAll(".np-queue-item:not(.dragging)"));
  const dragY = state.lastDragY;
  if (dragY === null || items.length === 0) return null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rect = item.getBoundingClientRect();
    const itemMidY = rect.top + rect.height / 2;
    if (dragY < itemMidY) {
      return item;
    }
  }
  return null;
}

function initHashModalHandlers() {
  const hashModalOverlay = document.getElementById("hash-modal-overlay");
  const userAuthHash = document.getElementById("user-auth-hash");
  const copyHashBtn = document.getElementById("copy-hash-btn");
  const continueBtn = document.getElementById("continue-btn");

  window.showHashModal = function(hash) {
    userAuthHash.textContent = hash;
    document.getElementById("auth-overlay").style.display = "none";
    hashModalOverlay.style.display = "flex";
  };

  copyHashBtn.addEventListener("click", function() {
    const hash = userAuthHash.textContent;
    navigator.clipboard.writeText(hash).then(function() {
      const originalHTML = copyHashBtn.innerHTML;
      copyHashBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
      copyHashBtn.classList.add("copied");
      setTimeout(function() {
        copyHashBtn.innerHTML = originalHTML;
        copyHashBtn.classList.remove("copied");
      }, 2000);
    }).catch(function(err) {
      alert("Failed to copy: " + err.message);
    });
  });

  continueBtn.addEventListener("click", async function() {
    hashModalOverlay.style.display = "none";
    document.getElementById("auth-overlay").style.display = "none";
    document.getElementById("app-main").style.display = "flex";
    document.getElementById("top-bar").style.display = "flex";
    document.getElementById("dropdown-username").textContent = state.currentUser.name;
    updateUserAvatarDisplay(state.currentUser.avatar_path, state.currentUser);
    await uiLoadTracks();
    await loadPlaylists();
    await uiLoadUserUploads();
    await loadUserPlayerState();
    const hasQueue = await loadUserQueue();
    if (!hasQueue) {
      await loadLastTrackPaused();
    }
    document.getElementById('app-main').classList.add('home-page');
    initGradient();

    if (window.refreshUploadState) window.refreshUploadState();
    await refreshManualUploadSetting();
    applyManualUploadUI(state.manualAudioUploadEnabled);
    if (window.refreshLibraryState) window.refreshLibraryState();

    await uiLoadMostPlayed();
    startUpdateChecker();
  });

  hashModalOverlay.addEventListener("click", function(event) {
    if (event.target === hashModalOverlay) {
      hashModalOverlay.style.display = "none";
      document.getElementById("auth-overlay").style.display = "none";
      document.getElementById("app-main").style.display = "flex";
      document.getElementById("top-bar").style.display = "flex";
      document.getElementById("dropdown-username").textContent = state.currentUser.name;
    }
  });
}

function initPlaylistHandlers() {
  const playlistPlayBtn = document.getElementById("playlist-play-btn");
  playlistPlayBtn.addEventListener('click', function() {
    var tracks = window.currentPlaylistTracks;
    if (!tracks || tracks.length === 0) return;

    var isPlayingThisPlaylist = (state.currentPlayingPlaylistId === state.currentPlaylistId);
    var isAudioPlaying = !audioPlayer.paused;

    if (isPlayingThisPlaylist && state.currentQueue.length > 0) {
      if (isAudioPlaying) {
        audioPlayer.pause();
        playlistPlayBtn.classList.remove('playing');
      } else {
        audioPlayer.play();
        playlistPlayBtn.classList.add('playing');
      }
      return;
    }

    state.currentQueue = tracks.map(function(t) { return t.track; });
    state.currentPlayingPlaylistId = state.currentPlaylistId;

    var playlistShuffle = document.getElementById('playlist-shuffle-btn').classList.contains('active');
    state.shuffle = playlistShuffle;
    document.getElementById("btn-shuffle").classList.toggle("active", state.shuffle);
    
    if (state.shuffle) {
      for (let i = state.currentQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.currentQueue[i], state.currentQueue[j]] = [state.currentQueue[j], state.currentQueue[i]];
      }
    }

    if (window.updateLibraryPlayingState) window.updateLibraryPlayingState();
    playlistPlayBtn.classList.add('playing');
    if (state.currentQueue.length) {
      playTrack(state.currentQueue[0]);
    }
  });

  document.getElementById('playlist-shuffle-btn').addEventListener('click', async function() {
    var isActive = this.classList.toggle('active');
    
    if (state.currentPlaylistId) {
      try {
        await togglePlaylistShuffle(state.currentPlaylistId, isActive);
      } catch (err) { console.error("Failed to save shuffle state:", err); }
    }

    if (state.currentPlayingPlaylistId === state.currentPlaylistId) {
      state.shuffle = isActive;
      document.getElementById("btn-shuffle").classList.toggle("active", state.shuffle);
      if (state.shuffle) {
        shuffleQueueOnce();
      } else {
        unshuffleQueue();
      }
      scheduleQueueSave();
      renderNowPlayingQueue();
    }
  });

  // Update follow button state
  function updateFollowButtonState(isFollowing) {
    const followBtn = document.getElementById('playlist-follow-btn');
    if (!followBtn) return;
    // Keep both states with same dimensions
    const baseStyle = 'padding: 8px !important; width: auto !important; height: auto !important; min-width: 24px !important; min-height: 24px !important;';
    if (isFollowing) {
      // Show green circle with black checkmark - matches track in playlist icon
      followBtn.innerHTML = '';
      followBtn.style.cssText = baseStyle + ' background: #1db954 !important; border: none !important; border-radius: 50% !important; display: flex !important; align-items: center !important; justify-content: center !important; position: relative !important;';
      if (!document.getElementById('follow-btn-style')) {
        const style = document.createElement('style');
        style.id = 'follow-btn-style';
        style.textContent = '#playlist-follow-btn.followed::after { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(45deg); width: 3px; height: 6px; border: solid #000; border-width: 0 2px 2px 0; margin-bottom: 2px; }';
        document.head.appendChild(style);
      }
      followBtn.classList.add('followed');
      followBtn.title = 'Unfollow playlist';
    } else {
      // Show plus in circle (not following)
      followBtn.innerHTML = '<i class="fa-solid fa-plus" style="color: #b3b3b3; width: 1em; height: 1em; display: flex; align-items: center; justify-content: center;"></i>';
      followBtn.style.cssText = baseStyle + ' background: none !important; border: none !important; display: flex !important; align-items: center !important; justify-content: center !important;';
      followBtn.classList.remove('followed');
      followBtn.title = 'Follow playlist';
    }
  }

  // Expose for global access
  window.updateFollowButtonState = updateFollowButtonState;

  // Follow button click handler
  document.getElementById('playlist-follow-btn')?.addEventListener('click', async function() {
    const playlistId = state.currentPlaylistId;
    if (!playlistId || !state.currentUser) return;

    const playlist = window.currentPlaylistData;
    if (!playlist) return;

    try {
      const apiModule = await import("./modules/api.js");
      const followPlaylist = apiModule.followPlaylist || window.followPlaylist;
      const unfollowPlaylist = apiModule.unfollowPlaylist || window.unfollowPlaylist;

      if (playlist.is_followed) {
        // Show confirmation modal for unfollow
        const confirmOverlay = document.getElementById('confirm-modal-overlay');
        const confirmMessage = document.getElementById('confirm-message');
        const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
        const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

        confirmMessage.textContent = 'Remove "' + playlist.name + '" from your library?';
        confirmOverlay.style.display = 'flex';

        const handleUnfollow = async () => {
          confirmOverlay.style.display = 'none';
          confirmCancelBtn.removeEventListener('click', handleCancel);
          confirmDeleteBtn.removeEventListener('click', handleUnfollow);

          try {
            await unfollowPlaylist(playlistId);
            playlist.is_followed = false;
            window.currentPlaylistFollowed = false;
            // Refresh playlists in library
            await loadPlaylists();
            // Update button appearance
            updateFollowButtonState(false);
          } catch (err) {
            console.error("Failed to unfollow:", err);
          }
        };

        const handleCancel = () => {
          confirmOverlay.style.display = 'none';
          confirmCancelBtn.removeEventListener('click', handleCancel);
          confirmDeleteBtn.removeEventListener('click', handleUnfollow);
        };

        confirmDeleteBtn.textContent = 'Remove';
        confirmCancelBtn.addEventListener('click', handleCancel);
        confirmDeleteBtn.addEventListener('click', handleUnfollow);
      } else {
        await followPlaylist(playlistId);
        playlist.is_followed = true;
        window.currentPlaylistFollowed = true;
        // Refresh playlists in library
        await loadPlaylists();
        // Update button appearance
        updateFollowButtonState(true);
      }
    } catch (err) {
      console.error("Failed to toggle follow:", err);
    }
  });

  const playlistVisibilityItem = document.getElementById("playlist-visibility-item");
  playlistVisibilityItem?.addEventListener('click', async function() {
    if (!state.currentPlaylistId || !state.currentUser) return;

    const currentPlaylist = window.currentPlaylistData;
    if (!currentPlaylist) return;

    const newPublicState = !currentPlaylist.is_public;

    try {
      await togglePlaylistVisibility(state.currentPlaylistId, newPublicState);
      currentPlaylist.is_public = newPublicState;
      document.getElementById('playlist-type').textContent = newPublicState ? 'Public Playlist' : 'Private Playlist';
      const isOwner = state.currentUser && currentPlaylist.user && currentPlaylist.user.auth_hash === state.authHash;
      const isFollowed = currentPlaylist.is_followed || false;
      updatePlaylistMenu(newPublicState, isOwner, false, isFollowed);
      document.getElementById("playlist-menu-dropdown").classList.remove("visible");
    } catch (err) {
      console.error("Failed to toggle public state:", err);
    }
  });
}

function initArtistHandlers() {
  const artistPlayBtn = document.getElementById("artist-play-btn");
  if (!artistPlayBtn) return;

  artistPlayBtn.addEventListener('click', async function() {
    if (!state.currentArtistId) return;

    try {
      const artist = await getArtist(state.currentArtistId);
      if (!artist || !artist.tracks || artist.tracks.length === 0) return;

      var tracks = artist.tracks.map(function(t) { return t; });
      var isPlayingThisArtist = (state.currentPlayingPlaylistId === 'artist-' + state.currentArtistId);
      var isAudioPlaying = !audioPlayer.paused;

      if (isPlayingThisArtist && state.currentQueue.length > 0) {
        if (isAudioPlaying) {
          audioPlayer.pause();
          artistPlayBtn.classList.remove('playing');
        } else {
          audioPlayer.play();
          artistPlayBtn.classList.add('playing');
        }
        return;
      }

      state.currentQueue = tracks.map(function(t) { return t; });
      state.currentPlayingPlaylistId = 'artist-' + state.currentArtistId;

      var artistShuffle = document.getElementById('artist-shuffle-btn').classList.contains('active');
      state.shuffle = artistShuffle;
      document.getElementById("btn-shuffle").classList.toggle("active", state.shuffle);

      if (state.shuffle) {
        for (let i = state.currentQueue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [state.currentQueue[i], state.currentQueue[j]] = [state.currentQueue[j], state.currentQueue[i]];
        }
      }

      artistPlayBtn.classList.add('playing');
      if (state.currentQueue.length) {
        playTrack(state.currentQueue[0]);
      }
    } catch (err) {
      console.error("Failed to play artist tracks:", err);
    }
  });

  document.getElementById('artist-shuffle-btn').addEventListener('click', async function() {
    if (!state.currentArtistId) return;

    var isActive = this.classList.toggle('active');

    var currentArtistPlaylistId = 'artist-' + state.currentArtistId;
    if (state.currentPlayingPlaylistId === currentArtistPlaylistId) {
      state.shuffle = isActive;
      document.getElementById("btn-shuffle").classList.toggle("active", state.shuffle);
      if (state.shuffle) {
        shuffleQueueOnce();
      } else {
        unshuffleQueue();
      }
      scheduleQueueSave();
      renderNowPlayingQueue();
    }
  });
}

function updatePlaylistMenu(isPublic, isOwner, isLiked, isFollowed) {
  const playlistMenuBtn = document.getElementById("playlist-menu-btn");
  const playlistVisibilityItem = document.getElementById("playlist-visibility-item");
  const playlistVisibilityIcon = document.getElementById("playlist-visibility-icon");
  const playlistVisibilityText = document.getElementById("playlist-visibility-text");

  if (playlistMenuBtn) {
    playlistMenuBtn.classList.remove("hidden");
  }

  // Hide visibility toggle for Liked Songs, non-owners, or followed playlists
  if (isLiked || !isOwner || isFollowed) {
    if (playlistVisibilityItem) playlistVisibilityItem.style.display = "none";
  } else {
    if (playlistVisibilityItem) playlistVisibilityItem.style.display = "flex";
    if (isPublic) {
      if (playlistVisibilityIcon) playlistVisibilityIcon.className = "fa-solid fa-lock";
      if (playlistVisibilityText) playlistVisibilityText.textContent = "Make Private";
    } else {
      if (playlistVisibilityIcon) playlistVisibilityIcon.className = "fa-solid fa-network-wired";
      if (playlistVisibilityText) playlistVisibilityText.textContent = "Make Public";
    }
  }
}

function initContextMenuHandlers() {
  const contextMenuOverlay = document.getElementById("context-menu-overlay");
  const contextMenu = document.getElementById("context-menu");
  const ctxPin = document.getElementById("ctx-pin");
  const ctxRename = document.getElementById("ctx-rename");
  const ctxRemove = document.getElementById("ctx-remove");
  const ctxVisibility = document.getElementById("ctx-visibility");
  const ctxVisibilityIcon = document.getElementById("ctx-visibility-icon");
  const ctxVisibilityText = document.getElementById("ctx-visibility-text");
  const ctxUnfollow = document.getElementById("ctx-unfollow");
  const ctxTrackAddPlaylist = document.getElementById("ctx-track-add-playlist");
  const ctxPlaylistSubmenu = document.getElementById("ctx-playlist-submenu");
  const ctxSubmenuItems = document.getElementById("submenu-playlist-items");
  const ctxTrackAddQueue = document.getElementById("ctx-track-add-queue");
  const submenuSearchWrapper = document.getElementById("submenu-search-wrapper");
  const submenuSearchInput = document.getElementById("submenu-search-input");

  window.showContextMenu = showContextMenu;
  window.hideContextMenu = hideContextMenu;
  window.showTrackContextMenu = showTrackContextMenu;

  // Playlist menu button click handler
  const playlistMenuBtn = document.getElementById("playlist-menu-btn");
  if (playlistMenuBtn) {
    playlistMenuBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      const playlistData = window.currentPlaylistData;
      if (!playlistData) return;

      const rect = playlistMenuBtn.getBoundingClientRect();
      const fakeEvent = {
        clientX: rect.right + 5,
        clientY: rect.top
      };
      window.showContextMenu(fakeEvent, playlistData);
    });
  }

  function showContextMenu(e, playlist) {
    hideContextMenu();
    state.currentContextPlaylist = playlist;
    state.currentContextTrack = null;
    
    const menuWidth = 180;
    const menuHeight = 110;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) x -= menuWidth;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;
    contextMenu.style.left = x + "px";
    contextMenu.style.top = y + "px";

    const pinSpan = ctxPin.querySelector("span");
    pinSpan.textContent = playlist.pinned ? "Unpin" : "Pin";
    const pinIcon = ctxPin.querySelector("svg .pin-path");
    if (pinIcon) {
      if (playlist.pinned) {
        pinIcon.setAttribute("d", "M8.822 .797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
        pinIcon.setAttribute("fill", "#1ed760");
      } else {
        pinIcon.setAttribute("d", "M11.609 1.858a1.22 1.22 0 0 0-1.727 0L5.92 5.82l-2.867.768 6.359 6.359.768-2.867 3.962-3.963a1.22 1.22 0 0 0 0-1.726zM8.822 .797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
        pinIcon.setAttribute("fill", "#b3b3b3");
      }
    }

    // Check if user can edit (owner only, not for followed playlists)
    const canEdit = !playlist.is_liked && playlist.is_owner;
    // Check if this is a followed public playlist (not owned by user)
    const isFollowedPublic = playlist.is_followed && playlist.is_public && !playlist.is_owner;

    if (playlist.is_liked) {
      // Liked Songs: show all but disabled (grayed out)
      ctxRename.classList.add("disabled");
      ctxRemove.classList.add("disabled");
      ctxPin.classList.add("disabled");
      ctxVisibility.classList.add("disabled");
    } else if (isFollowedPublic) {
      // Followed public playlist: Pin + Rename enabled, Delete + Visibility hidden, Unfollow shown
      ctxRename.classList.remove("disabled");
      ctxPin.classList.remove("disabled");
      ctxRemove.classList.add("disabled");
      ctxVisibility.classList.add("disabled");
    } else if (playlist.is_owner) {
      // Owner's playlist: all enabled
      ctxRename.classList.remove("disabled");
      ctxRemove.classList.remove("disabled");
      ctxPin.classList.remove("disabled");
      ctxVisibility.classList.remove("disabled");
      // Update visibility icon and text based on current state
      if (playlist.is_public) {
        if (ctxVisibilityIcon) ctxVisibilityIcon.className = "fa-solid fa-lock";
        if (ctxVisibilityText) ctxVisibilityText.textContent = "Make Private";
      } else {
        if (ctxVisibilityIcon) ctxVisibilityIcon.className = "fa-solid fa-network-wired";
        if (ctxVisibilityText) ctxVisibilityText.textContent = "Make Public";
      }
    } else {
      // Followed private playlist (shouldn't happen but handle anyway)
      ctxRename.classList.add("disabled");
      ctxRemove.classList.add("disabled");
      ctxPin.classList.remove("disabled");
      ctxVisibility.classList.add("disabled");
    }

    ctxPin.style.display = '';
    ctxRename.style.display = '';
    ctxRemove.style.display = playlist.is_liked ? '' : (isFollowedPublic ? 'none' : '');
    ctxVisibility.style.display = playlist.is_liked ? 'none' : (isFollowedPublic ? 'none' : '');
    ctxUnfollow.style.display = isFollowedPublic ? '' : 'none';
    ctxTrackAddPlaylist.style.display = 'none';
    ctxTrackAddQueue.style.display = 'none';
    ctxPlaylistSubmenu.classList.remove('visible');
    ctxSubmenuItems.innerHTML = '';

    contextMenuOverlay.style.display = "block";
  }

  function hideContextMenu() {
    contextMenuOverlay.style.display = "none";
    ctxPlaylistSubmenu.classList.remove('visible');
    if (state.currentTimeout) {
      clearTimeout(state.currentTimeout);
      state.currentTimeout = null;
    }
    state.currentContextPlaylist = null;
    state.currentContextTrack = null;
    state.currentContextQueueIndex = null;
    state.currentTrackContextFromQueuePanel = false;
    state.pendingActionPlaylistId = null;
    const ctxTrackAddQueue = document.getElementById("ctx-track-add-queue");
    if (ctxTrackAddQueue) {
      ctxTrackAddQueue.dataset.action = "add";
      const label = ctxTrackAddQueue.querySelector("span");
      if (label) label.textContent = "Add to Queue";
    }
  }

  function showTrackContextMenu(e, track, opts) {
    opts = opts || {};
    hideContextMenu();

    state.currentContextTrack = track;
    state.currentContextPlaylist = null;
    state.currentContextQueueIndex = Number.isInteger(opts.queueIndex) ? opts.queueIndex : null;
    const openedFromQueuePanel = !!opts.fromQueuePanel;
    state.currentTrackContextFromQueuePanel = openedFromQueuePanel;

    const menuWidth = 180;
    const menuHeight = 110;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) x -= menuWidth;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;
    contextMenu.style.left = x + "px";
    contextMenu.style.top = y + "px";

    ctxPin.style.display = 'none';
    ctxRename.style.display = 'none';
    ctxRemove.style.display = 'none';
    ctxVisibility.style.display = 'none';
    ctxTrackAddPlaylist.style.display = '';
    ctxTrackAddQueue.style.display = '';
    contextMenu.insertBefore(ctxTrackAddQueue, ctxTrackAddPlaylist);
    ctxPlaylistSubmenu.classList.remove('visible');
    ctxSubmenuItems.innerHTML = '';
    
    if (openedFromQueuePanel) {
      ctxTrackAddQueue.dataset.action = "remove";
      const label = ctxTrackAddQueue.querySelector("span");
      if (label) label.textContent = "Remove from Queue";
      ctxTrackAddQueue.classList.remove('disabled');
    } else {
      ctxTrackAddQueue.dataset.action = "add";
      const label = ctxTrackAddQueue.querySelector("span");
      if (label) label.textContent = "Add to Queue";
      const queueWindowEnd = Math.min(state.currentIndex + 1 + 6, state.currentQueue.length);
      let isInVisibleQueue = false;
      for (let i = state.currentIndex + 1; i < queueWindowEnd; i++) {
        if (state.currentQueue[i] && state.currentQueue[i].id == track.id) {
          isInVisibleQueue = true;
          break;
        }
      }
      if (isInVisibleQueue) {
        ctxTrackAddQueue.classList.add('disabled');
      } else {
        ctxTrackAddQueue.classList.remove('disabled');
      }
    }

    contextMenuOverlay.style.display = "block";
  }

  ctxPin.addEventListener("click", async function() {
    if (!state.currentContextPlaylist || state.currentContextPlaylist.is_liked) return;
    var targetId = state.currentContextPlaylist.id;
    var isPinned = state.currentContextPlaylist.pinned;
    hideContextMenu();
    try {
      await togglePlaylistPin(targetId, !isPinned);
      // Update current playlist data to reflect new pin state immediately
      if (window.currentPlaylistData && window.currentPlaylistData.id === targetId) {
        window.currentPlaylistData.pinned = !isPinned;
      }
      await loadPlaylists();
    } catch (err) {
      alert("Failed to update pin: " + err.message);
    }
  });

  ctxRename.addEventListener("click", function() {
    if (!state.currentContextPlaylist || state.currentContextPlaylist.is_liked) return;
    var targetId = state.currentContextPlaylist.id;
    var targetName = state.currentContextPlaylist.name;
    hideContextMenu();
    state.pendingActionPlaylistId = targetId;
    document.getElementById("rename-input").value = targetName;
    document.getElementById("rename-modal-overlay").style.display = "flex";
    setTimeout(function() { document.getElementById("rename-input").focus(); }, 100);
  });

  ctxRemove.addEventListener("click", function() {
    if (!state.currentContextPlaylist || state.currentContextPlaylist.is_liked) return;
    var targetId = state.currentContextPlaylist.id;
    var targetName = state.currentContextPlaylist.name;
    hideContextMenu();
    state.pendingActionPlaylistId = targetId;
    document.getElementById("confirm-message").textContent = 'Delete playlist "' + targetName + '"?';
    document.getElementById("confirm-modal-overlay").style.display = "flex";
  });

  ctxVisibility.addEventListener("click", async function() {
    if (!state.currentContextPlaylist || state.currentContextPlaylist.is_liked) return;
    if (ctxVisibility.classList.contains('disabled')) return;

    const playlist = state.currentContextPlaylist;
    const newVisibility = !playlist.is_public;
    hideContextMenu();

    try {
      await togglePlaylistVisibility(playlist.id, newVisibility);
      // Update the playlist in state
      playlist.is_public = newVisibility ? 1 : 0;
      // Refresh library to show updated visibility
      renderLibrary();
      // Update current playlist data if open
      if (window.currentPlaylistData && window.currentPlaylistData.id === playlist.id) {
        window.currentPlaylistData.is_public = playlist.is_public;
        document.getElementById('playlist-type').textContent = newVisibility ? 'Public Playlist' : 'Private Playlist';
      }
    } catch (err) {
      console.error("Failed to toggle playlist visibility:", err);
    }
  });

  ctxUnfollow.addEventListener("click", async function() {
    if (!state.currentContextPlaylist) return;
    const playlist = state.currentContextPlaylist;
    const playlistId = playlist.id;
    const playlistName = playlist.name;
    hideContextMenu();

    // Show confirmation modal for unfollow
    const confirmOverlay = document.getElementById('confirm-modal-overlay');
    const confirmMessage = document.getElementById('confirm-message');
    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

    confirmMessage.textContent = 'Remove "' + playlistName + '" from your library?';
    confirmOverlay.style.display = 'flex';

    const handleUnfollow = async () => {
      confirmOverlay.style.display = 'none';
      confirmCancelBtn.removeEventListener('click', handleCancel);
      confirmDeleteBtn.removeEventListener('click', handleUnfollow);

      try {
        const apiModule = await import("./modules/api.js");
        const unfollowPlaylist = apiModule.unfollowPlaylist || window.unfollowPlaylist;
        await unfollowPlaylist(playlistId);
        // Refresh playlists in library
        await loadPlaylists();
        // Update the follow button if viewing this playlist
        if (state.currentPlaylistId === playlistId && window.currentPlaylistData) {
          window.currentPlaylistData.is_followed = false;
          window.currentPlaylistFollowed = false;
          updateFollowButtonState(false);
        }
      } catch (err) {
        console.error("Failed to unfollow:", err);
      }
    };

    const handleCancel = () => {
      confirmOverlay.style.display = 'none';
      confirmCancelBtn.removeEventListener('click', handleCancel);
      confirmDeleteBtn.removeEventListener('click', handleUnfollow);
    };

    confirmDeleteBtn.textContent = 'Remove';
    confirmCancelBtn.addEventListener('click', handleCancel);
    confirmDeleteBtn.addEventListener('click', handleUnfollow);
  });

  ctxTrackAddQueue.addEventListener("click", function() {
    if (ctxTrackAddQueue.classList.contains('disabled')) return;
    if (!state.currentContextTrack) return;
    const action = ctxTrackAddQueue.dataset.action || "add";
    if (action === "remove") {
      const removeIndex = state.currentContextQueueIndex;
      if (!Number.isInteger(removeIndex) || removeIndex <= state.currentIndex || removeIndex >= state.currentQueue.length) {
        hideContextMenu();
        return;
      }
      state.currentQueue.splice(removeIndex, 1);
      state.queueOriginal = null;
      renderNowPlayingQueue();
      scheduleQueueSave();
      hideContextMenu();
      return;
    }
    const track = state.currentContextTrack;
    const queueWindowEnd = Math.min(state.currentIndex + 1 + 6, state.currentQueue.length);
    let isInVisibleQueue = false;
    for (let i = state.currentIndex + 1; i < queueWindowEnd; i++) {
      if (state.currentQueue[i] && state.currentQueue[i].id == track.id) {
        isInVisibleQueue = true;
        break;
      }
    }
    if (isInVisibleQueue) {
      hideContextMenu();
      return;
    }
    const insertIndex = state.currentIndex + 1;
    state.currentQueue.splice(insertIndex, 0, track);
    enforceQueueCapacity();
    state.queueOriginal = null;
    renderNowPlayingQueue();
    scheduleQueueSave();
    hideContextMenu();
  });

  contextMenuOverlay.addEventListener("click", function(e) {
    if (e.target === contextMenuOverlay) {
      hideContextMenu();
    }
  });

  document.addEventListener("contextmenu", function(e) {
    var validTarget = e.target.closest('.track-card, .lib-item, .playlist-song-row, .np-queue-item');
    if (validTarget) {
      hideContextMenu();
      return;
    }
    e.preventDefault();
    hideContextMenu();
  }, true);

  const renameModalOverlay = document.getElementById("rename-modal-overlay");
  const renameInput = document.getElementById("rename-input");
  const renameCancelBtn = document.getElementById("rename-cancel-btn");
  const renameConfirmBtn = document.getElementById("rename-confirm-btn");

  renameCancelBtn.addEventListener("click", function() {
    renameModalOverlay.style.display = "none";
    state.pendingActionPlaylistId = null;
  });

  renameConfirmBtn.addEventListener("click", async function() {
    const newName = renameInput.value.trim();
    if (!newName || !state.pendingActionPlaylistId) {
      if (!newName) alert("Name cannot be empty.");
      return;
    }
    try {
      await renamePlaylist(state.pendingActionPlaylistId, newName);
      renameModalOverlay.style.display = "none";
      await loadPlaylists();
    } catch (err) {
      alert("Failed to rename: " + err.message);
    } finally {
      state.pendingActionPlaylistId = null;
    }
  });

  const confirmModalOverlay = document.getElementById("confirm-modal-overlay");
  const confirmCancelBtn = document.getElementById("confirm-cancel-btn");
  const confirmDeleteBtn = document.getElementById("confirm-delete-btn");

  confirmCancelBtn.addEventListener("click", function() {
    confirmModalOverlay.style.display = "none";
    state.pendingActionPlaylistId = null;
  });

  confirmDeleteBtn.addEventListener("click", async function() {
    if (!state.pendingActionPlaylistId) return;
    try {
      await deletePlaylist(state.pendingActionPlaylistId);
      confirmModalOverlay.style.display = "none";
      await loadPlaylists();
    } catch (err) {
      alert("Failed to delete: " + err.message);
    } finally {
      state.pendingActionPlaylistId = null;
    }
  });

  // Avatar Upload Modal Logic
  const avatarModalOverlay = document.getElementById("avatar-modal-overlay");
  const avatarFileInput = document.getElementById("avatar-file-input");
  const avatarSelectBtn = document.getElementById("avatar-select-btn");
  const avatarUploadBtn = document.getElementById("avatar-upload-btn");
  const avatarCancelBtn = document.getElementById("avatar-cancel-btn");
  const avatarRemoveBtn = document.getElementById("avatar-remove-btn");
  const cropControls = document.getElementById("crop-controls");
  const cropperCanvas = document.getElementById("avatar-cropper-canvas");
  const ctx = cropperCanvas ? cropperCanvas.getContext("2d") : null;

  let avatarCropperState = {
    image: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    lastX: 0,
    lastY: 0,
  };

  function openAvatarModal() {
    avatarModalOverlay.classList.add("visible");
    // Show Remove button only if user already has an avatar
    if (state.currentUser?.avatar_path) {
      avatarRemoveBtn.style.display = "";
      // Load existing avatar into cropper
      loadExistingAvatar();
    } else {
      avatarRemoveBtn.style.display = "none";
      resetAvatarCropper();
    }
  }

  function loadExistingAvatar() {
    if (!state.currentUser?.avatar_path) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function() {
      initCropper(img);
      drawCropper();
    };
    img.onerror = function() {
      console.error("Failed to load current avatar");
      resetAvatarCropper();
    };
    img.src = withBase("/users/" + state.currentUser.id + "/avatar?t=" + Date.now());
  }

  function closeAvatarModal() {
    avatarModalOverlay.classList.remove("visible");
    setTimeout(resetAvatarCropper, 200);
  }

  function resetAvatarCropper() {
    avatarCropperState = { image: null, zoom: 1, offsetX: 0, offsetY: 0, isDragging: false, lastX: 0, lastY: 0 };
    if (avatarFileInput) avatarFileInput.value = "";
    if (cropControls) cropControls.style.display = "none";
    if (avatarUploadBtn) avatarUploadBtn.disabled = true;
    if (ctx && cropperCanvas) {
      ctx.clearRect(0, 0, cropperCanvas.width, cropperCanvas.height);
    }
  }

  function drawCropper() {
    const { image, zoom, offsetX, offsetY } = avatarCropperState;
    if (!image || !ctx || !cropperCanvas) return;

    const size = 200;
    ctx.clearRect(0, 0, size, size);

    // Draw circular clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2, true);
    ctx.clip();

    // Calculate draw dimensions (image sized to cover the square canvas)
    const displaySize = size * zoom;
    const dx = size / 2 + offsetX;
    const dy = size / 2 + offsetY;

    if (image.width > image.height) {
      const h = displaySize * (image.height / image.width);
      ctx.drawImage(image, dx - displaySize / 2, dy - h / 2, displaySize, h);
    } else {
      const w = displaySize * (image.width / image.height);
      ctx.drawImage(image, dx - w / 2, dy - displaySize / 2, w, displaySize);
    }
    ctx.restore();
  }

  function initCropper(img) {
    avatarCropperState.image = img;
    avatarCropperState.zoom = 1;
    avatarCropperState.offsetX = 0;
    avatarCropperState.offsetY = 0;

    // Show crop controls only if not 1:1
    if (img.width !== img.height) {
      cropControls.style.display = "flex";
    } else {
      cropControls.style.display = "none";
    }

    avatarUploadBtn.disabled = false;
    if (cropperCanvas) {
      cropperCanvas.width = 200;
      cropperCanvas.height = 200;
      drawCropper();
    }
  }

  // File selection
  avatarFileInput.addEventListener("change", function() {
    const file = this.files[0];
    if (!file) return;

    // Size check
    if (file.size > 5 * 1024 * 1024) {
      alert("File too large — maximum 5MB");
      this.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = function(ev) {
      const img = new Image();
      img.onload = function() {
        initCropper(img);
        drawCropper();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  avatarSelectBtn.addEventListener("click", () => avatarFileInput.click());
  avatarCancelBtn.addEventListener("click", closeAvatarModal);
  avatarModalOverlay.addEventListener("click", (e) => {
    if (e.target === avatarModalOverlay) closeAvatarModal();
  });

  // Zoom slider
  document.getElementById("avatar-zoom").addEventListener("input", function(e) {
    avatarCropperState.zoom = parseFloat(e.target.value);
    drawCropper();
  });

  // Drag to pan
  if (cropperCanvas) {
    cropperCanvas.addEventListener("mousedown", (e) => {
      avatarCropperState.isDragging = true;
      avatarCropperState.lastX = e.clientX;
      avatarCropperState.lastY = e.clientY;
    });
  }
  window.addEventListener("mousemove", (e) => {
    if (!avatarCropperState.isDragging) return;
    const dx = e.clientX - avatarCropperState.lastX;
    const dy = e.clientY - avatarCropperState.lastY;
    avatarCropperState.offsetX += dx;
    avatarCropperState.offsetY += dy;
    avatarCropperState.lastX = e.clientX;
    avatarCropperState.lastY = e.clientY;
    drawCropper();
  });
  window.addEventListener("mouseup", () => {
    avatarCropperState.isDragging = false;
  });

  // Upload (crop + send)
  avatarUploadBtn.addEventListener("click", function() {
    const { image } = avatarCropperState;
    if (!image || !cropperCanvas || !ctx) return;

    cropperCanvas.toBlob(async function(blob) {
      const file = new File([blob], "avatar.jpg", { type: "image/jpeg" });
      try {
        const result = await uploadAvatar(file);
        // Update currentUser
        if (state.currentUser) {
          state.currentUser.avatar_path = result.avatar_path;
        }
        // Update UI avatars
        updateUserAvatarDisplay(result.avatar_path);
        closeAvatarModal();
        // Refresh profile page if visible
        if (document.getElementById('page-profile').classList.contains('active')) {
          populateProfilePage();
        }
      } catch (err) {
        alert("Failed to upload avatar: " + err.message);
      }
    }, "image/jpeg", 0.9);
  });

  // Remove avatar handler
  avatarRemoveBtn.addEventListener("click", async function() {
    if (!state.currentUser) return;
    if (!confirm("Remove your profile picture?")) return;
    try {
      await api("/users/avatar", { method: "DELETE" });
      state.currentUser.avatar_path = null;
      updateUserAvatarDisplay(null);
      closeAvatarModal();
      if (document.getElementById('page-profile').classList.contains('active')) {
        populateProfilePage();
      }
    } catch (err) {
      alert("Failed to remove avatar: " + err.message);
    }
  });

  // Edit overlay click handlers (profile page only)
  document.getElementById("profile-avatar-edit")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openAvatarModal();
  });

  ctxTrackAddPlaylist.addEventListener("mouseenter", function() {
    showPlaylistSubmenu();
  });

  ctxTrackAddPlaylist.addEventListener("mouseleave", function() {
    scheduleHideSubmenu();
  });

  ctxPlaylistSubmenu.addEventListener("mouseenter", function() {
    if (state.currentTimeout) {
      clearTimeout(state.currentTimeout);
      state.currentTimeout = null;
    }
  });

  ctxPlaylistSubmenu.addEventListener("mouseleave", function() {
    scheduleHideSubmenu();
  });

  submenuSearchInput.addEventListener("input", function() {
    clearTimeout(state.submenuSearchTimeout);
    state.submenuSearchTimeout = setTimeout(() => {
      filterSubmenuItems(this.value);
    }, 150);
  });

  function showPlaylistSubmenu() {
    if (state.currentTimeout) {
      clearTimeout(state.currentTimeout);
      state.currentTimeout = null;
    }
    ctxPlaylistSubmenu.style.top = ctxTrackAddPlaylist.offsetTop + "px";
    if (state.currentTrackContextFromQueuePanel) {
      ctxPlaylistSubmenu.style.left = "auto";
      ctxPlaylistSubmenu.style.right = "100%";
      ctxPlaylistSubmenu.style.marginLeft = "0";
      ctxPlaylistSubmenu.style.marginRight = "4px";
    } else {
      ctxPlaylistSubmenu.style.left = "100%";
      ctxPlaylistSubmenu.style.right = "auto";
      ctxPlaylistSubmenu.style.marginLeft = "4px";
      ctxPlaylistSubmenu.style.marginRight = "0";
    }
    ctxPlaylistSubmenu.classList.add('visible');
    submenuSearchWrapper.style.display = 'block';
    submenuSearchInput.value = '';
    submenuSearchInput.focus();
    const items = ctxSubmenuItems.querySelectorAll('.submenu-item');
    items.forEach(item => item.style.display = '');
    const emptyMsg = ctxSubmenuItems.querySelector('.submenu-search-empty');
    if (emptyMsg) emptyMsg.remove();
    if (!ctxSubmenuItems.hasChildNodes()) {
      ctxSubmenuItems.innerHTML = '<div class="submenu-loading">Loading...</div>';
      loadPlaylistSubmenuItems();
    }
  }

  function scheduleHideSubmenu() {
    state.currentTimeout = setTimeout(() => {
      ctxPlaylistSubmenu.classList.remove('visible');
      state.currentTimeout = null;
    }, 200);
  }

  async function loadPlaylistSubmenuItems() {
    if (!state.currentUser) {
      ctxSubmenuItems.innerHTML = '<div class="submenu-error">Not logged in</div>';
      return;
    }
    const sortedPlaylists = [...state.userPlaylists].sort(function(a, b) {
      if (a.is_liked && !b.is_liked) return -1;
      if (!a.is_liked && b.is_liked) return 1;
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    ctxSubmenuItems.innerHTML = '';
    if (sortedPlaylists.length === 0) {
      ctxSubmenuItems.innerHTML = '<div class="submenu-empty">No playlists yet.<br>Create one from the sidebar.</div>';
      state.lastPlaylistResults = [];
      return;
    }

    const results = await Promise.all(
      sortedPlaylists.map(async (pl) => {
        const trackIds = new Set();
        try {
          const tracks = await api("/playlists/" + pl.id + "/tracks");
          for (const pt of tracks) trackIds.add(pt.track.id);
        } catch (e) {
          console.error("Failed to load tracks for playlist:", pl.name, e);
        }
        return { pl, trackIds };
      })
    );

    ctxSubmenuItems.innerHTML = '';
    state.lastPlaylistResults = [];

    results.forEach(({ pl, trackIds }) => {
      const item = document.createElement('button');
      item.className = 'submenu-item';
      if (trackIds.has(state.currentContextTrack.id)) {
        item.classList.add('disabled');
        item.disabled = true;
      }

      const nameSpan = document.createElement('span');
      nameSpan.className = 'submenu-playlist-name';
      nameSpan.textContent = pl.name;
      item.dataset.playlistName = pl.name.toLowerCase();

      item.appendChild(nameSpan);

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pl.is_liked) {
          alert("Liked Songs is managed automatically. Use the heart button on tracks to add/remove.");
          return;
        }
        const confirmed = confirm(`Add this track to "${pl.name}"?`);
        if (confirmed) {
          addTrackToPlaylistInternal(pl.id, state.currentContextTrack);
        }
      });
      ctxSubmenuItems.appendChild(item);
      state.lastPlaylistResults.push(item);
    });

    const currentSearch = submenuSearchInput.value.trim();
    if (currentSearch) {
      filterSubmenuItems(currentSearch);
    }
  }

  function filterSubmenuItems(query) {
    const normalizedQuery = query.toLowerCase().trim();
    const items = ctxSubmenuItems.querySelectorAll('.submenu-item');
    let visibleCount = 0;
    items.forEach(item => {
      const name = item.dataset.playlistName || '';
      if (name.includes(normalizedQuery)) {
        item.style.display = '';
        visibleCount++;
      } else {
        item.style.display = 'none';
      }
    });

    const existingEmpty = ctxSubmenuItems.querySelector('.submenu-search-empty');
    if (visibleCount === 0 && !existingEmpty) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'submenu-search-empty';
      emptyMsg.textContent = 'No playlists match';
      emptyMsg.style.cssText = 'padding:0.6rem 1rem;color:#727272;font-size:0.85rem;text-align:center;';
      ctxSubmenuItems.appendChild(emptyMsg);
    } else if (existingEmpty) {
      existingEmpty.remove();
    }
  }

  async function addTrackToPlaylistInternal(playlistId, track) {
    try {
      await addTrackToPlaylist(playlistId, track.id);
      state.trackIdsInRegularPlaylists.add(track.id);
      if (state.currentTrackId === track.id) {
        syncLikeButtonState({ id: track.id });
      }
      hideContextMenu();
    } catch (err) {
      alert("Failed to add track to playlist: " + err.message);
    }
  }
}

function initUploadHandlers() {
  const uploadCheckbox = document.getElementById("upload-enabled");
  const uploadCheckboxSettings = document.getElementById("upload-enabled-settings");
  const sidebar = document.querySelector('.sidebar');

  window.refreshUploadState = function() {
    if (state.currentUser && typeof state.currentUser.upload_enabled !== 'undefined') {
      updateUploadUI(state.currentUser.upload_enabled);
    } else {
      const saved = localStorage.getItem("upload_enabled");
      if (saved !== null) {
        updateUploadUI(saved !== "false");
      } else {
        updateUploadUI(true);
      }
    }
  };

  function updateUploadUI(enabled) {
    if (uploadCheckbox) uploadCheckbox.checked = enabled;
    if (uploadCheckboxSettings) uploadCheckboxSettings.checked = enabled;
    if (sidebar) sidebar.classList.toggle('upload-disabled', !enabled);
    localStorage.setItem("upload_enabled", enabled);
  }

  window.refreshUploadState();

  if (uploadCheckbox) {
    uploadCheckbox.addEventListener("change", async function() {
      const enabled = this.checked;
      updateUploadUI(enabled);
      if (state.currentUser && state.authHash) {
        try {
          await api("/user/upload-preference", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ upload_enabled: enabled })
          });
          state.currentUser.upload_enabled = enabled;
        } catch (err) {
          console.error("Failed to update upload preference:", err);
          updateUploadUI(!enabled);
        }
      }
    });
  }

  if (uploadCheckboxSettings) {
    uploadCheckboxSettings.addEventListener("change", async function() {
      const enabled = this.checked;
      updateUploadUI(enabled);
      if (state.currentUser && state.authHash) {
        try {
          await api("/user/upload-preference", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ upload_enabled: enabled })
          });
          state.currentUser.upload_enabled = enabled;
        } catch (err) {
          console.error("Failed to update upload preference:", err);
          updateUploadUI(!enabled);
        }
      }
    });
  }
}

function initLibraryToggle() {
  const sidebar = document.querySelector('.sidebar');
  const sidebarToggleBtn = document.querySelector('.sidebar-toggle-container');

  window.refreshLibraryState = function() {
    if (state.currentUser && typeof state.currentUser.library_minimized !== 'undefined') {
      updateLibraryUI(state.currentUser.library_minimized);
    } else {
      const saved = localStorage.getItem("library_minimized");
      if (saved !== null) {
        updateLibraryUI(saved !== "false");
      } else {
        updateLibraryUI(false);
      }
    }
  };

  function updateLibraryUI(minimized) {
    if (sidebar) sidebar.classList.toggle('sidebar-minimized', minimized);
    localStorage.setItem("library_minimized", minimized);
  }

  window.refreshLibraryState();

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      const currentlyMinimized = sidebar && sidebar.classList.contains('sidebar-minimized');
      const newState = !currentlyMinimized;
      updateLibraryUI(newState);
      setTimeout(updateAllScrollButtonStates, 200);

      if (state.authHash) {
        api("/user/library-state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ library_minimized: newState })
        }).then(() => {
          if (state.currentUser) state.currentUser.library_minimized = newState;
        }).catch(err => {
          console.error("Failed to update library state:", err);
          updateLibraryUI(!newState);
        });
      }
    });
  }
}

function initVolumeControls() {
  const volumeSlider = document.getElementById("volume-slider");
  const volumeIcon = document.getElementById("volume-icon");

  volumeSlider.addEventListener("input", function() {
    audioPlayer.volume = volumeSlider.value / 100;
    volumeSlider.style.setProperty("--volume", volumeSlider.value + "%");
    volumeIcon.className = audioPlayer.volume === 0 ? "fa-solid fa-volume-xmark" : audioPlayer.volume < 0.5 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high";
  });
  volumeSlider.style.setProperty("--volume", "100%");

  volumeIcon.addEventListener("click", function() {
    if (audioPlayer.volume > 0) {
      audioPlayer.dataset.prevVolume = audioPlayer.volume;
      audioPlayer.volume = 0;
      volumeSlider.value = 0;
      volumeIcon.className = "fa-solid fa-volume-xmark";
    } else {
      var prev = parseFloat(audioPlayer.dataset.prevVolume) || 1;
      audioPlayer.volume = prev;
      volumeSlider.value = Math.round(prev * 100);
      volumeIcon.className = prev < 0.5 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high";
    }
  });
}

function initProgressBar() {
  const progressContainer = document.getElementById("progress-container");
  const progressTrack = document.getElementById("progress-track");
  const progressFill = document.getElementById("progress-fill");

  let isDragging = false;

  function seekFromEvent(e) {
    var rect = progressTrack.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    if (audioPlayer.duration) {
      audioPlayer.currentTime = (pct / 100) * audioPlayer.duration;
      progressFill.style.width = pct + "%";
      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
        try {
          navigator.mediaSession.setPositionState({
            duration: audioPlayer.duration,
            playbackRate: audioPlayer.playbackRate,
            position: audioPlayer.currentTime
          });
        } catch (e) {}
      }
    }
  }

  progressContainer.addEventListener("mousedown", function(e) {
    isDragging = true;
    progressContainer.classList.add("dragging");
    seekFromEvent(e);
  });

  progressContainer.addEventListener("touchstart", function(e) {
    isDragging = true;
    progressContainer.classList.add("dragging");
    seekFromEvent(e.touches[0]);
    e.preventDefault();
  }, { passive: false });

  document.addEventListener("mousemove", function(e) {
    if (isDragging) seekFromEvent(e);
  });

  document.addEventListener("touchmove", function(e) {
    if (isDragging) seekFromEvent(e.touches[0]);
  });

  document.addEventListener("mouseup", function() {
    if (isDragging) {
      isDragging = false;
      progressContainer.classList.remove("dragging");
    }
  });

  document.addEventListener("touchend", function() {
    if (isDragging) {
      isDragging = false;
      progressContainer.classList.remove("dragging");
    }
  });
}

function initMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function() {
      if (audioPlayer.paused && audioPlayer.src && audioPlayer.src !== window.location.href) {
        audioPlayer.play().catch(function(err) { console.error(err); });
      }
    });

    navigator.mediaSession.setActionHandler('pause', function() {
      if (!audioPlayer.paused) {
        audioPlayer.pause();
      }
    });

    navigator.mediaSession.setActionHandler('previoustrack', function() {
      if (state.currentQueue.length && state.currentIndex > 0) {
        playByIndex(state.currentIndex - 1, false);
      }
    });

    navigator.mediaSession.setActionHandler('nexttrack', function() {
      if (state.currentQueue.length && state.currentIndex < state.currentQueue.length - 1) {
        playByIndex(state.currentIndex + 1, false);
      }
    });

    navigator.mediaSession.setActionHandler('seekbackward', function() {
      if (audioPlayer.duration) {
        audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10);
        if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
          navigator.mediaSession.setPositionState({
            duration: audioPlayer.duration,
            playbackRate: audioPlayer.playbackRate,
            position: audioPlayer.currentTime
          });
        }
      }
    });

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
}

function initKeyboardControls() {
  document.addEventListener('keydown', async function(event) {
    if (event.code === 'Space' && event.target.tagName !== 'INPUT') {
      if (audioPlayer.src && audioPlayer.src !== window.location.href) {
        await togglePlay();
      }
      event.preventDefault();
    }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight' ||
        event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
    }
    
    if (event.key === "Escape") {
      hideContextMenu();
      hideRenameModal();
      hideConfirmModal();
      hideRemovalMenuIfVisible();
      hideAddToPlaylistModal();
    }
  });
}

function initResizeObserver() {
  const mainContentResizeObserver = new ResizeObserver(() => {
    updateTrackRowScrollButtons();
  });
  const mainContentEl = document.querySelector('.main-content');
  if (mainContentEl) {
    mainContentResizeObserver.observe(mainContentEl);
  }
  
  window.addEventListener("resize", function() {
    const npRemovalMenu = document.getElementById("np-playlist-removal-menu");
    if (npRemovalMenu && npRemovalMenu.classList.contains("visible")) {
      positionRemovalMenu(npRemovalMenu, document.getElementById("np-like-btn"));
    }
    const addPlaylistModalOverlay = document.getElementById("add-playlist-modal-overlay");
    if (addPlaylistModalOverlay && addPlaylistModalOverlay.style.display === "flex") {
      positionAddToPlaylistModal(document.getElementById("np-like-btn"));
    }
    updateAllScrollButtonStates();
  });
}

function startUpdateChecker() {
  if (state.updateCheckInterval) {
    clearInterval(state.updateCheckInterval);
  }
  state.updateCheckInterval = setInterval(checkForTrackUpdates, 5000);
}

function stopUpdateChecker() {
  if (state.updateCheckInterval) {
    clearInterval(state.updateCheckInterval);
    state.updateCheckInterval = null;
  }
}

async function checkForTrackUpdates() {
  try {
    var response = await api("/tracks/updates?since=" + state.lastTrackUpdate);
    if (response.has_updates) {
      console.log("New tracks detected, refreshing...");
      state.lastTrackUpdate = response.timestamp;
      await uiLoadTracks();
      await uiLoadMostPlayed();
      const libraryPage = document.getElementById("page-library");
      if (libraryPage && libraryPage.classList.contains('active')) {
        await uiLoadUserUploads();
      }
    }
  } catch (err) {
    console.error("Error checking for updates:", err);
  }
}

async function handleSearch() {
  var query = document.getElementById("search-input").value.trim();
  if (!query) {
    const recentItems = loadRecentSearches(state.authHash || '');
    if (recentItems.length) {
      renderRecentSearchDropdown(recentItems);
    } else {
      hideSearchDropdown();
    }
    return;
  }

  try {
    // Only run local library search on input (Spotify runs on Enter)
    const localResults = await runSearch(query).catch(() => []);
    state.lastSearchResults = localResults;
    renderSearchDropdown(localResults);
  } catch (err) {
    console.error(err);
    renderSearchDropdown([]);
  }
}

async function handleDownloadFromLink() {
  if (!state.currentUser || (!state.currentUser.is_admin && !state.manualAudioUploadEnabled)) {
    alert("Uploads are disabled for your account.");
    return;
  }
  var url = document.getElementById("download-url").value.trim();
  var progressDiv = document.getElementById("download-progress");
  var statusText = document.getElementById("download-status-text");
  var progressBar = document.getElementById("download-progress-bar");
  if (!url) { statusText.textContent = "Paste a link first."; progressDiv.style.display = "block"; return; }
  if (!url.startsWith("http")) { statusText.textContent = "Paste a valid https:// link."; progressDiv.style.display = "block"; return; }
  
  progressDiv.style.display = "block";
  statusText.textContent = "Queuing download…";
  progressBar.style.width = "0%";
  
  try {
    const jobId = await downloadFromLink(url);
    pollJobStatusUI(jobId);
  } catch (err) { console.error(err); statusText.textContent = "Download failed. " + (err.message || ""); progressBar.style.width = "100%"; progressBar.classList.add("progress-error"); }
}

function pollJobStatusUI(jobId) {
  var progressDiv = document.getElementById("download-progress");
  var statusText = document.getElementById("download-status-text");
  var progressBar = document.getElementById("download-progress-bar");

  if (state.activeDownloadPoll) {
    clearInterval(state.activeDownloadPoll);
    state.activeDownloadPoll = null;
  }

  var poll = setInterval(async function() {
    try {
      var job = await pollJobStatus(jobId);
      if (job.status === "completed") {
        clearInterval(poll);
        state.activeDownloadPoll = null;
        statusText.textContent = "Download completed.";
        progressBar.classList.remove("progress-indeterminate", "progress-error");
        progressBar.style.width = "100%";
        progressBar.classList.add("progress-complete");
        await uiLoadTracks();
        await uiLoadMostPlayed();
        await uiLoadUserUploads();
        document.getElementById("download-url").value = "";
        setTimeout(function() { 
          progressDiv.style.display = "none"; 
          progressBar.classList.remove("progress-complete");
          progressBar.style.width = "0%";
        }, 3000);
      } else if (job.status === "failed") {
        clearInterval(poll);
        state.activeDownloadPoll = null;
        statusText.textContent = "Download failed.";
        progressBar.classList.remove("progress-indeterminate");
        progressBar.style.width = "100%";
        progressBar.classList.add("progress-error");
        setTimeout(function() { progressBar.classList.remove("progress-error"); }, 500);
        var errorDetail = document.getElementById("download-error-detail");
        if (!errorDetail) {
          var detailP = document.createElement("p");
          detailP.id = "download-error-detail";
          detailP.style.cssText = "color: #b3b3b3; font-size: 0.75rem; margin-top: 0.5rem; white-space: pre-wrap; max-height: 100px; overflow-y: auto;";
          progressDiv.appendChild(detailP);
          errorDetail = detailP;
        }
        errorDetail.style.display = "block";
        errorDetail.textContent = job.log || "Unknown error.";
      } else {
        var log = job.log || "";
        var lines = log.split("\n").filter(function(l) { return l.trim(); });
        var trackName = "";
        var progressPercent = 0;
        
        for (var i = lines.length - 1; i >= 0; i--) {
          var line = lines[i];
          if (line.includes("Found:")) {
            trackName = line.split("Found:")[1].trim();
          }
          if (line.includes("Downloaded:")) {
            var mb = line.split("Downloaded:")[1].split(" MB |")[0];
            progressPercent = Math.min(85, (parseFloat(mb) / 8) * 100);
          } else if (line.includes("Metadata embedded")) {
            progressPercent = Math.max(progressPercent, 92);
          } else if (line.includes("Download complete:")) {
            progressPercent = Math.max(progressPercent, 95);
          } else if (line.includes("Scan complete")) {
            progressPercent = Math.max(progressPercent, 98);
          } else if (line.includes("Starting")) {
            progressPercent = Math.max(progressPercent, 5);
          }
        }
        
        if (trackName) {
          statusText.textContent = "Downloading: " + trackName;
        } else {
          var lastLine = lines[lines.length - 1] || (job.status + "...");
          if (lastLine.length > 60) lastLine = lastLine.substring(0, 60) + "...";
          statusText.textContent = lastLine;
        }
        
        if (progressPercent > 0) {
          progressBar.classList.remove("progress-indeterminate");
          progressBar.style.width = progressPercent + "%";
        } else {
          progressBar.classList.add("progress-indeterminate");
        }
      }
    } catch (err) { 
      clearInterval(poll);
      state.activeDownloadPoll = null;
      statusText.textContent = "Poll error: " + err.message; 
      progressBar.classList.remove("progress-indeterminate");
      progressBar.classList.add("progress-error");
    }
  }, 2000);
  
  state.activeDownloadPoll = poll;
}

// Download a track from Spotify/Apple Music link and auto-play when complete
window.downloadAndPlayTrack = async function(track) {
  if (!state.currentUser || (!state.currentUser.is_admin && !state.manualAudioUploadEnabled)) {
    alert("Uploads are disabled for your account.");
    return;
  }

  const spotifyUrl = track.spotify_url;
  if (!spotifyUrl) {
    console.error("No Spotify URL for track");
    return;
  }

  // Store the track info for matching later
  const downloadTrackTitle = track.track_name;
  const downloadTrackArtist = track.artist_name;

  // Get current user upload IDs before download so we can find the new one after
  // Only track user's own uploads - this is session-specific and avoids cross-user issues
  let existingUploadIds = new Set();
  if (state.authHash) {
    try {
      const existingUploads = await api("/tracks?limit=50&user_hash=" + encodeURIComponent(state.authHash));
      if (Array.isArray(existingUploads)) {
        existingUploads.forEach(t => existingUploadIds.add(t.id));
      }
    } catch (e) {
      console.error("Failed to get existing uploads:", e);
    }
  }

  // Show download progress UI
  var progressDiv = document.getElementById("download-progress");
  var statusText = document.getElementById("download-status-text");
  var progressBar = document.getElementById("download-progress-bar");

  progressDiv.style.display = "block";
  statusText.textContent = "Queuing download: " + (downloadTrackTitle || "...");
  progressBar.style.width = "0%";
  progressBar.classList.remove("progress-indeterminate", "progress-error", "progress-complete");

  try {
    // Start the download
    const jobId = await downloadFromLink(spotifyUrl);

    // Poll for completion with custom callback for auto-play
    await pollJobStatusForPlayback(jobId, downloadTrackTitle, downloadTrackArtist, existingUploadIds);
  } catch (err) {
    console.error("Download failed:", err);
    statusText.textContent = "Download failed: " + (err.message || "Unknown error");
    progressBar.classList.add("progress-error");
  }
};

// Poll for job status and auto-play when complete
function pollJobStatusForPlayback(jobId, downloadTrackTitle, downloadTrackArtist, existingUploadIds) {
  return new Promise((resolve, reject) => {
    var progressDiv = document.getElementById("download-progress");
    var statusText = document.getElementById("download-status-text");
    var progressBar = document.getElementById("download-progress-bar");

    // Normalize the search terms
    const searchTitle = (downloadTrackTitle || "").toLowerCase().trim();
    const searchArtist = (downloadTrackArtist || "").toLowerCase().trim();

    var poll = setInterval(async function() {
      try {
        var job = await pollJobStatus(jobId);
        if (job.status === "completed") {
          clearInterval(poll);
          state.activeDownloadPoll = null;
          statusText.textContent = "Download completed. Loading track...";
          progressBar.style.width = "100%";
          progressBar.classList.add("progress-complete");

          // Fetch only current user's uploads - session-specific, avoids cross-user issues
          const userUploads = state.authHash
            ? await api("/tracks?limit=50&user_hash=" + encodeURIComponent(state.authHash))
            : [];

          // Find the new track - one that wasn't in existingUploadIds
          let foundTrack = null;
          if (Array.isArray(userUploads)) {
            for (const t of userUploads) {
              if (!existingUploadIds.has(t.id)) {
                // This is a new upload - verify it matches our search
                const tTitle = (t.title || "").toLowerCase().trim();
                const tArtist = ((t.artist && t.artist.name) || "").toLowerCase().trim();

                // Match by title (and artist if available)
                if (tTitle.includes(searchTitle) || searchTitle.includes(tTitle)) {
                  foundTrack = t;
                  break;
                }
              }
            }

            // If still not found, take the first new upload
            if (!foundTrack) {
              for (const t of userUploads) {
                if (!existingUploadIds.has(t.id)) {
                  foundTrack = t;
                  break;
                }
              }
            }
          }

          if (foundTrack) {
            setQueueFromList([foundTrack], 0);
            playTrack(foundTrack);
            statusText.textContent = "Now playing: " + foundTrack.title;
          } else {
            // Fallback: try any track
            const allTracksData = await api("/tracks?limit=1");
            if (allTracksData && allTracksData.length > 0) {
              setQueueFromList([allTracksData[0]], 0);
              playTrack(allTracksData[0]);
              statusText.textContent = "Now playing: " + allTracksData[0].title;
            } else {
              statusText.textContent = "Download complete. Track added to library.";
            }
          }

          // Clear the download URL input
          document.getElementById("download-url").value = "";

          // Hide progress after a delay
          setTimeout(function() {
            progressDiv.style.display = "none";
            progressBar.classList.remove("progress-complete");
            progressBar.style.width = "0%";
          }, 3000);

          resolve();
        } else if (job.status === "failed") {
          clearInterval(poll);
          state.activeDownloadPoll = null;
          statusText.textContent = "Download failed.";
          progressBar.classList.add("progress-error");
          reject(new Error(job.log || "Download failed"));
        } else {
          // Still processing - update progress
          var log = job.log || "";
          var lines = log.split("\n").filter(function(l) { return l.trim(); });
          var trackName = "";
          var progressPercent = 0;

          for (var i = lines.length - 1; i >= 0; i--) {
            var line = lines[i];
            if (line.includes("Downloaded:")) {
              var mb = line.split("Downloaded:")[1].split(" MB |")[0];
              progressPercent = Math.min(85, (parseFloat(mb) / 8) * 100);
            } else if (line.includes("Metadata embedded")) {
              progressPercent = Math.max(progressPercent, 92);
            } else if (line.includes("Download complete:")) {
              progressPercent = Math.max(progressPercent, 95);
            } else if (line.includes("Scan complete")) {
              progressPercent = Math.max(progressPercent, 98);
            } else if (line.includes("Starting")) {
              progressPercent = Math.max(progressPercent, 5);
            }
          }

          if (trackName) {
            statusText.textContent = "Downloading: " + trackName;
          } else {
            var lastLine = lines[lines.length - 1] || (job.status + "...");
            if (lastLine.length > 60) lastLine = lastLine.substring(0, 60) + "...";
            statusText.textContent = lastLine;
          }

          if (progressPercent > 0) {
            progressBar.classList.remove("progress-indeterminate");
            progressBar.style.width = progressPercent + "%";
          } else {
            progressBar.classList.add("progress-indeterminate");
          }
        }
      } catch (err) {
        clearInterval(poll);
        state.activeDownloadPoll = null;
        statusText.textContent = "Poll error: " + err.message;
        progressBar.classList.remove("progress-indeterminate");
        progressBar.classList.add("progress-error");
        reject(err);
      }
    }, 2000);

    state.activeDownloadPoll = poll;
  });
}

async function handleManualUpload() {
  if (!state.manualAudioUploadEnabled) {
    alert("Manual audio file uploads are currently disabled by admin.");
    return;
  }
  if (!state.currentUser) {
    alert("Uploads are disabled for your account.");
    return;
  }
  var manualFileInput = document.getElementById("manual-file-input");
  if (!manualFileInput || !manualFileInput.files || !manualFileInput.files.length) {
    alert("Choose an audio file first.");
    return;
  }

  const selectedFile = manualFileInput.files[0];
  const formData = new FormData();
  formData.append("file", selectedFile);

  const manualUploadStatus = document.getElementById("manual-upload-status");
  const manualUploadButton = document.getElementById("manual-upload-button");
  
  if (manualUploadStatus) {
    manualUploadStatus.style.display = "block";
    manualUploadStatus.textContent = "Uploading file...";
  }
  if (manualUploadButton) {
    manualUploadButton.disabled = true;
  }

  try {
    await api("/tracks/upload", { method: "POST", body: formData });
    if (manualUploadStatus) {
      manualUploadStatus.textContent = "Upload complete.";
    }
    if (manualFileInput) {
      manualFileInput.value = "";
    }
    await uiLoadTracks();
    await uiLoadMostPlayed();
    await uiLoadUserUploads();
    setTimeout(function() {
      if (manualUploadStatus) {
        manualUploadStatus.style.display = "none";
        manualUploadStatus.textContent = "";
      }
    }, 2000);
  } catch (err) {
    if (manualUploadStatus) {
      manualUploadStatus.textContent = "Upload failed: " + err.message;
    } else {
      alert("Upload failed: " + err.message);
    }
  } finally {
    if (manualUploadButton) {
      manualUploadButton.disabled = !state.manualAudioUploadEnabled;
    }
  }
}

function hideRenameModal() {
  document.getElementById("rename-modal-overlay").style.display = "none";
}

function hideConfirmModal() {
  document.getElementById("confirm-modal-overlay").style.display = "none";
}

function hideRemovalMenuIfVisible() {
  const menu = document.getElementById("np-playlist-removal-menu");
  if (menu && menu.classList.contains("visible")) {
    menu.classList.remove("visible");
  }
}

const addPlaylistModalOverlay = document.getElementById("add-playlist-modal-overlay");
const addPlaylistModalWrapper = document.getElementById("add-playlist-modal-wrapper");
const addPlaylistModal = document.querySelector(".add-playlist-modal");
const addPlaylistNewRow = document.getElementById("add-playlist-new-row");
const addPlaylistItems = document.getElementById("add-playlist-items");
const addPlaylistSearchInput = document.getElementById("add-playlist-search-input");
const addPlaylistCancelBtn = document.getElementById("add-playlist-cancel-btn");
const addPlaylistConfirmBtn = document.getElementById("add-playlist-confirm-btn");

let allPlaylistsCache = [];
let modalOriginalInPlaylist = new Set();
let modalPendingInPlaylist = new Set();
let addPlaylistSearchTimeout = null;

window.showAddToPlaylistModal = showAddToPlaylistModal;
window.hideAddToPlaylistModal = hideAddToPlaylistModal;

function showAddToPlaylistModal() {
  return new Promise(async (resolve) => {
    if (addPlaylistModalOverlay.style.display === "flex") {
      resolve();
      return;
    }

    resetConfirmState();

    hideContextMenu();
    hideRemovalMenuIfVisible();

    positionAddToPlaylistModal(document.getElementById("np-like-btn"));

    try {
      const playlists = await api("/playlists");
      allPlaylistsCache = playlists;

      modalOriginalInPlaylist.clear();
      modalPendingInPlaylist.clear();

      if (state.currentTrackId) {
        try {
          const trackPlaylists = await api("/tracks/" + state.currentTrackId + "/playlists");
          for (const pl of trackPlaylists) {
            modalOriginalInPlaylist.add(pl.id);
            modalPendingInPlaylist.add(pl.id);
          }
        } catch (e) {
          console.warn("Could not fetch track playlists:", e);
        }
      }

      if (state.likedTrackIds.has(state.currentTrackId)) {
        modalOriginalInPlaylist.add('liked');
        modalPendingInPlaylist.add('liked');
      }

      buildAddToPlaylistItems(playlists);
      showConfirmButton();
      addPlaylistModalOverlay.style.display = "flex";
      setTimeout(() => addPlaylistSearchInput.focus(), 100);
      resolve();
    } catch (err) {
      console.error("Failed to load playlists for modal:", err);
      alert("Failed to load playlists: " + err.message);
      resolve();
    }
  });
}

function hideAddToPlaylistModal() {
  addPlaylistModalOverlay.style.display = "none";
  addPlaylistSearchInput.value = '';
  allPlaylistsCache = [];
  resetConfirmState();
}

function positionAddToPlaylistModal(anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  const wrapper = addPlaylistModalWrapper;

  const centerX = rect.left + rect.width / 2;
  wrapper.style.left = (centerX - wrapper.offsetWidth / 2) + 'px';

  const GAP = 8;
  wrapper.style.bottom = (window.innerHeight - rect.top + GAP) + 'px';
  wrapper.style.top = 'auto';
  wrapper.style.right = 'auto';
}

function resetConfirmState() {
  modalOriginalInPlaylist.clear();
  modalPendingInPlaylist.clear();
  addPlaylistConfirmBtn.style.display = 'none';
}

function showConfirmButton() {
  const hasChanges = setsDiffer(modalPendingInPlaylist, modalOriginalInPlaylist);
  addPlaylistConfirmBtn.style.display = hasChanges ? 'inline-block' : 'none';
}

function setsDiffer(a, b) {
  if (a.size !== b.size) return true;
  for (const v of a) if (!b.has(v)) return true;
  for (const v of b) if (!a.has(v)) return true;
  return false;
}

function buildAddToPlaylistItems(playlists, filter = '') {
  addPlaylistItems.innerHTML = '';

  const filterLower = filter.toLowerCase();

  const likedItem = document.createElement('div');
  likedItem.className = 'add-playlist-item';
  likedItem.dataset.playlistId = 'liked';
  if (!filterLower) {
    const thumb = document.createElement('div');
    thumb.className = 'add-playlist-thumb';
    thumb.style.background = 'linear-gradient(135deg,#450af5,#c4efd9)';
    const heart = document.createElement('i');
    heart.className = 'fa-solid fa-heart';
    heart.style.color = '#fff';
    thumb.appendChild(heart);
    likedItem.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'add-playlist-name';
    name.textContent = 'Liked Songs';
    likedItem.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'add-playlist-actions';

    const checkbox = document.createElement('div');
    checkbox.className = 'add-playlist-checkbox';
    if (modalPendingInPlaylist.has('liked')) {
      checkbox.classList.add('checked');
    }
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      handleLikedSongsToggle(checkbox);
    });
    actions.appendChild(checkbox);

    likedItem.appendChild(actions);
    if (!filterLower) {
      addPlaylistItems.appendChild(likedItem);
    }
  }

  const filtered = playlists.filter(pl => {
    if (pl.is_liked) return false;
    return pl.name.toLowerCase().includes(filterLower);
  });

  if (filtered.length === 0 && !filterLower) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'add-playlist-empty';
    emptyMsg.style.cssText = 'padding: 1rem; color: #727272; font-size: 0.875rem; text-align: center;';
    emptyMsg.textContent = 'No playlists yet';
    addPlaylistItems.appendChild(emptyMsg);
    return;
  }

  if (filtered.length === 0 && filterLower) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'add-playlist-empty';
    emptyMsg.style.cssText = 'padding: 1rem; color: #727272; font-size: 0.875rem; text-align: center;';
    emptyMsg.textContent = 'No playlists match your search';
    addPlaylistItems.appendChild(emptyMsg);
    return;
  }

  filtered.forEach(pl => {
    const item = document.createElement('div');
    item.className = 'add-playlist-item' + (pl.pinned ? ' pinned' : '');
    item.dataset.playlistId = pl.id;

    const thumb = document.createElement('div');
    thumb.className = 'add-playlist-thumb';
    if (pl.is_liked) {
      thumb.style.background = 'linear-gradient(135deg,#450af5,#c4efd9)';
      const heart = document.createElement('i');
      heart.className = 'fa-solid fa-heart';
      heart.style.color = '#fff';
      heart.style.fontSize = '1.25rem';
      thumb.appendChild(heart);
    } else {
      const img = document.createElement('img');
      img.alt = escapeHtml(pl.name);
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.onerror = function() {
        img.style.display = 'none';
        const fallback = createPlaylistIconSvg();
        fallback.style.width = '20px';
        fallback.style.height = '20px';
        thumb.appendChild(fallback);
      };
      thumb.appendChild(img);
      setAuthenticatedImage(img, "/playlists/" + pl.id + "/cover", function() {
        img.style.display = 'none';
        const fallback = createPlaylistIconSvg();
        fallback.style.width = '20px';
        fallback.style.height = '20px';
        thumb.appendChild(fallback);
      });
    }
    item.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'add-playlist-name';
    name.textContent = pl.name;
    item.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'add-playlist-actions';

    const pinSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    pinSvg.setAttribute("class", "add-playlist-pin");
    pinSvg.setAttribute("viewBox", "290 120 160 160");
    pinSvg.setAttribute("width", "14");
    pinSvg.setAttribute("height", "14");
    pinSvg.setAttribute("fill", pl.pinned ? "#1DB954" : "#b3b3b3");
    pinSvg.setAttribute("aria-hidden", "true");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", "translate(290, 120) scale(10)");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (pl.pinned) {
      path.setAttribute("d", "M8.822 .797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
    } else {
      path.setAttribute("d", "M11.609 1.858a1.22 1.22 0 0 0-1.727 0L5.92 5.82l-2.867.768 6.359 6.359.768-2.867 3.962-3.963a1.22 1.22 0 0 0 0-1.726zM8.822 .797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
    }
    g.appendChild(path);
    pinSvg.appendChild(g);
    actions.appendChild(pinSvg);

    const checkbox = document.createElement('div');
    checkbox.className = 'add-playlist-checkbox';
    if (modalPendingInPlaylist.has(pl.id)) {
      checkbox.classList.add('checked');
    }
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAddToPlaylistToggle(pl.id, checkbox);
    });
    actions.appendChild(checkbox);

    item.appendChild(actions);
    addPlaylistItems.appendChild(item);
  });
}

function filterAddToPlaylistItems() {
  buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
}

function handleAddToPlaylistToggle(playlistId, checkboxEl) {
  const currentlyChecked = checkboxEl.classList.contains('checked');
  const newChecked = !currentlyChecked;

  if (newChecked) {
    modalPendingInPlaylist.add(playlistId);
    checkboxEl.classList.add('checked');
  } else {
    modalPendingInPlaylist.delete(playlistId);
    checkboxEl.classList.remove('checked');
  }
  showConfirmButton();
}

function handleLikedSongsToggle(checkboxEl) {
  const currentlyChecked = checkboxEl.classList.contains('checked');

  if (currentlyChecked) {
    modalPendingInPlaylist.delete('liked');
    checkboxEl.classList.remove('checked');
    buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
  } else {
    modalPendingInPlaylist.add('liked');
    buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
    checkboxEl.classList.add('checked');
  }

  showConfirmButton();
}

addPlaylistSearchInput.addEventListener("input", function() {
  clearTimeout(addPlaylistSearchTimeout);
  addPlaylistSearchTimeout = setTimeout(filterAddToPlaylistItems, 150);
});

addPlaylistCancelBtn.addEventListener("click", hideAddToPlaylistModal);
addPlaylistNewRow.addEventListener("click", handleNewPlaylistClick);

addPlaylistModalOverlay.addEventListener("click", function(e) {
  if (e.target === addPlaylistModalOverlay || e.target === addPlaylistModalWrapper) {
    hideAddToPlaylistModal();
  }
});

addPlaylistModal.addEventListener("click", function(e) {
  e.stopPropagation();
});

addPlaylistConfirmBtn.addEventListener("click", async function() {
  await applyPendingChanges();
});

async function applyPendingChanges() {
  const toRemove = [...modalOriginalInPlaylist].filter(id => !modalPendingInPlaylist.has(id));
  const toAdd = [...modalPendingInPlaylist].filter(id => !modalOriginalInPlaylist.has(id));
  let createdNewPlaylist = false;

  try {
    for (const id of toRemove) {
      if (id === 'liked') {
        await toggleLiked(state.currentTrackId);
      } else {
        await removeTrackFromPlaylist(id, state.currentTrackId);
      }
    }
    for (const id of toAdd) {
      if (id === 'liked') {
        await toggleLiked(state.currentTrackId);
      } else {
        const pl = allPlaylistsCache.find(p => p.id === id);
        if (pl && pl._isNew) {
          const newPl = await createPlaylist(pl.name);
          const idx = allPlaylistsCache.findIndex(p => p.id === id);
          if (idx !== -1) allPlaylistsCache[idx] = { ...newPl, _isNew: false };
          if (!state.userPlaylists.some(p => p.id === newPl.id)) {
            state.userPlaylists.push(newPl);
            createdNewPlaylist = true;
          }
          await addTrackToPlaylist(newPl.id, state.currentTrackId);
        } else {
          await addTrackToPlaylist(id, state.currentTrackId);
        }
      }
    }
    if (state.currentTrackId) {
      if (modalPendingInPlaylist.has('liked')) {
        state.likedTrackIds.add(state.currentTrackId);
      } else {
        state.likedTrackIds.delete(state.currentTrackId);
      }
      const inRegular = [...modalPendingInPlaylist].some(id => id !== 'liked');
      if (inRegular) {
        state.trackIdsInRegularPlaylists.add(state.currentTrackId);
      } else {
        state.trackIdsInRegularPlaylists.delete(state.currentTrackId);
      }
      syncLikeButtonState({ id: state.currentTrackId });
    }
    if (createdNewPlaylist) {
      renderLibrary();
    }
    hideAddToPlaylistModal();
  } catch (err) {
    alert("Failed to save changes: " + err.message);
  }
}

function handleNewPlaylistClick() {
  const count = allPlaylistsCache.filter(p => !p.is_liked && !p._isNew).length;
  const newName = `My Playlist #${count + 1}`;
  const tempId = 'new-' + Date.now();

  const placeholder = {
    id: tempId,
    name: newName,
    is_liked: false,
    pinned: false,
    _isNew: true
  };
  allPlaylistsCache.push(placeholder);

  modalPendingInPlaylist.add(tempId);
  modalPendingInPlaylist.delete('liked');

  buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
  showConfirmButton();
}

document.addEventListener('animationend', function(e) {
  if (e.target.classList.contains('new-track')) {
    setTimeout(() => {
      e.target.classList.remove('new-track');
      e.target.style.animationDelay = '';
    }, 10);
  }
});

clearCanvas(document.getElementById("now-cover"));

renderNowPlayingQueue();
