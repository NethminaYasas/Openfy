import { state, setAuth, clearAuth, updateUser, withBase } from './modules/state.js';
import { api, loadTracks, loadUserUploads, loadMostPlayed, loadLastTrackPaused, loadUserQueue, loadUserPlayerState, refreshManualUploadSetting, loadPlaylists as apiLoadPlaylists, updateRegularPlaylistTrackCache, savePlayerState, signUp, signIn, tryAutoLogin as apiTryAutoLogin, createPlaylist, toggleLiked, addTrackToPlaylist, removeTrackFromPlaylist, renamePlaylist, deletePlaylist, togglePlaylistPin, togglePlaylistVisibility, togglePlaylistShuffle, downloadFromLink, pollJobStatus, runSearch } from './modules/api.js';
import { escapeHtml, formatDuration, getArtistDisplay, formatTotalDuration, createPlaylistIconSvg, drawCanvas, clearCanvas, seededColor, queueArtworkUrl, positionRemovalMenu, buildMosaicFallback } from './modules/utils.js';
import { initGradient, destroyGradient, emitTrackChanged } from './modules/gradient-manager.js';
import { saveIntendedUrl, getAndClearIntendedUrl } from './modules/auth.js';
import { audioPlayer, togglePlay, playByIndex, playTrack, loadTrackPaused, setQueueFromList, reorderQueue, enforceQueueCapacity, shuffleQueueOnce, unshuffleQueue, scheduleQueueSave, renderNowPlayingQueue, buildQueueItem, getShowFullQueue, setShowFullQueue, getCollapseTimeout, setCollapseTimeout, syncLikeButtonState, updateNowPlaying } from './modules/audio-player.js';
import { pages, setActivePage, navigateFromUrl, loadTracks as uiLoadTracks, loadUserUploads as uiLoadUserUploads, loadMostPlayed as uiLoadMostPlayed, renderTracks, renderUploads, renderMostPlayed, buildTrackCard, buildPlaylistCover, openPlaylist, openPlaylistById, renderLibrary, loadPlaylists, populateProfilePage, renderSearchDropdown, hideSearchDropdown, updateTrackRowScrollButtons, updateAllScrollButtonStates } from './modules/ui.js';
import { updateAdminButtonVisibility, loadAdminStatsUI, loadAdminSettingsUI, applyManualUploadUI, loadUsersListUI, loadTracksListUI, initAdminEventListeners } from './modules/admin.js';

const MAX_QUEUE_CAPACITY = 20;

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
  
  initContextMenuHandlers();
  
  initAdminEventListeners();
  
  initUploadHandlers();
  
  initLibraryToggle();
  
  initVolumeControls();
  
  initProgressBar();
  
  initMediaSession();
  
  initKeyboardControls();
  
  initResizeObserver();
  
  const ok = await tryAutoLogin();
  if (!ok) {
    document.getElementById("auth-overlay").style.display = "flex";
    document.getElementById("app-main").style.display = "none";
    saveIntendedUrl();
  } else {
    await uiLoadTracks();
    await uiLoadMostPlayed();
    await loadPlaylists();
    await uiLoadUserUploads();
  }
  
  navigateFromUrl();
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
    if (window.refreshLibraryState) window.refreshLibraryState();

    startUpdateChecker();

    const urlToNavigate = getAndClearIntendedUrl();
    if (urlToNavigate) {
      navigateFromUrl();
    } else {
      setActivePage('home');
    }

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
  
  searchInput.addEventListener("keydown", function(ev) {
    if (ev.key === "Escape") {
      hideSearchDropdown();
      searchInput.blur();
    }
  });

  const btnPlay = document.getElementById("btn-play");
  btnPlay.addEventListener("click", function(event) {
    event.preventDefault();
    togglePlay();
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
    await showAddToPlaylistModal();
    npLikeBtn.disabled = false;
  });

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
      if (window.refreshLibraryState) window.refreshLibraryState();

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

  // Enter key support for auth inputs
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

  document.getElementById("new-playlist-btn").addEventListener("click", async function() {
    try { await createPlaylist("My Playlist"); await loadPlaylists(); } catch (err) { alert("Failed: " + err.message); }
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
    const transferData = ev.dataTransfer ? ev.dataTransfer.getData("text/plain") : "";
    const transferIndex = Number.parseInt(transferData, 10);
    const sourceIndex = Number.isInteger(state.dragSourceIndex)
      ? state.dragSourceIndex
      : (Number.isInteger(transferIndex) ? transferIndex : null);
    if (sourceIndex === null) return;

    const allItems = Array.from(npQueueNext.querySelectorAll(".np-queue-item"));
    let movedEl = state.draggedElement;
    if (!movedEl || !npQueueNext.contains(movedEl)) {
      movedEl = npQueueNext.querySelector('.np-queue-item[data-index="' + sourceIndex + '"]');
    }
    if (!movedEl) return;

    const newVisualIndex = allItems.indexOf(movedEl);
    if (newVisualIndex === -1) return;

    const nextIndex = state.currentIndex + 1;
    const toIndex = nextIndex + newVisualIndex;

    if (toIndex === sourceIndex) return;

    reorderQueue(sourceIndex, toIndex);
  });

  document.getElementById('np-playlist-removal-menu');
}

function updateDragPosition() {
  const npQueueNext = document.getElementById("np-queue-next");
  if (!state.draggedElement || !npQueueNext.contains(state.draggedElement)) return;

  const insertBeforeEl = getInsertBeforeElement(npQueueNext);

  if (insertBeforeEl === state.lastInsertBeforeEl) return;

  const siblings = Array.from(npQueueNext.querySelectorAll('.np-queue-item:not(.dragging)'));
  const beforeRects = new Map();
  siblings.forEach(el => beforeRects.set(el, el.getBoundingClientRect()));

  if (insertBeforeEl) {
    if (state.draggedElement.nextSibling !== insertBeforeEl) {
      npQueueNext.insertBefore(state.draggedElement, insertBeforeEl);
    }
  } else {
    if (state.draggedElement.nextSibling !== null) {
      npQueueNext.appendChild(state.draggedElement);
    }
  }

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
    if (window.refreshLibraryState) window.refreshLibraryState();

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
      updatePlaylistMenu(newPublicState, isOwner, false);
      document.getElementById("playlist-menu-dropdown").classList.remove("visible");
    } catch (err) {
      console.error("Failed to toggle public state:", err);
    }
  });
}

function updatePlaylistMenu(isPublic, isOwner, isLiked) {
  const playlistMenuBtn = document.getElementById("playlist-menu-btn");
  const playlistVisibilityItem = document.getElementById("playlist-visibility-item");
  const playlistVisibilityIcon = document.getElementById("playlist-visibility-icon");
  const playlistVisibilityText = document.getElementById("playlist-visibility-text");

  if (playlistMenuBtn) {
    playlistMenuBtn.classList.remove("hidden");
  }

  if (isLiked || !isOwner) {
    if (playlistVisibilityItem) playlistVisibilityItem.style.display = "none";
  } else {
    if (playlistVisibilityItem) playlistVisibilityItem.style.display = "flex";
    if (isPublic) {
      if (playlistVisibilityIcon) playlistVisibilityIcon.className = "fa-solid fa-lock";
      if (playlistVisibilityText) playlistVisibilityText.textContent = "Make Private";
    } else {
      if (playlistVisibilityIcon) playlistVisibilityIcon.className = "fa-solid fa-globe";
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

    if (playlist.is_liked) {
      ctxRename.classList.add("disabled");
      ctxRemove.classList.add("disabled");
      ctxPin.classList.remove("disabled");
    } else {
      ctxRename.classList.remove("disabled");
      ctxRemove.classList.remove("disabled");
      ctxPin.classList.remove("disabled");
    }

    ctxPin.style.display = '';
    ctxRename.style.display = '';
    ctxRemove.style.display = '';
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
      await loadPlaylists();
    } catch (err) {
      alert("Failed to update pin: " + err.message);
    }
  });

  ctxRename.addEventListener("click", function() {
    if (!state.currentContextPlaylist || state.currentContextPlaylist.is_liked) return;
    state.pendingActionPlaylistId = state.currentContextPlaylist.id;
    var targetName = state.currentContextPlaylist.name;
    hideContextMenu();
    document.getElementById("rename-input").value = targetName;
    document.getElementById("rename-modal-overlay").style.display = "flex";
    setTimeout(function() { document.getElementById("rename-input").focus(); }, 100);
  });

  ctxRemove.addEventListener("click", function() {
    if (!state.currentContextPlaylist || state.currentContextPlaylist.is_liked) return;
    state.pendingActionPlaylistId = state.currentContextPlaylist.id;
    var targetName = state.currentContextPlaylist.name;
    hideContextMenu();
    document.getElementById("confirm-message").textContent = 'Delete playlist "' + targetName + '"?';
    document.getElementById("confirm-modal-overlay").style.display = "flex";
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
  document.addEventListener('keydown', function(event) {
    if (event.code === 'Space' && event.target.tagName !== 'INPUT') {
      if (audioPlayer.src && audioPlayer.src !== window.location.href) {
        togglePlay();
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
    hideSearchDropdown();
    return;
  }

  try {
    const results = await runSearch(query);
    state.lastSearchResults = results;
    renderSearchDropdown(results);
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

    positionAddToPlaylistModal(document.getElementById("np-likeBtn"));

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
      setAuthenticatedImage(img, "/playlists/" + pl.id + "/cover?v=" + Date.now(), function() {
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
    pinSvg.className = 'add-playlist-pin';
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