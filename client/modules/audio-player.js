import { state, withBase } from './state.js';
import { getTrackStreamUrl, savePlayerState, checkIfLiked as apiCheckIfLiked } from './api.js';
import { getArtistDisplay, formatDuration, drawCanvas, clearCanvas, queueArtworkUrl, seededColor, extractVibrantColors, escapeHtml } from './utils.js';
import { emitTrackChanged, getGradientManager } from './gradient-manager.js';
import { setUrl, setActivePage } from './ui.js';
import {
  queueSetList, queueReorder as _queueReorder, queueInsert, queueRemove,
  queueShuffle, queueUnshuffle, queueEnforceCap, queueSave, queueClear,
  queueJumpTo, QUEUE_MAX_CAP, setRenderCallback
} from './queue-manager.js';

const MAX_QUEUE_CAPACITY = QUEUE_MAX_CAP;

// Register the render callback immediately so queue-manager can call
// renderNowPlayingQueue synchronously (avoids the circular async import path).
// renderNowPlayingQueue is defined later in this file but the reference is
// captured by closure, so it will resolve correctly when called.
setRenderCallback(() => renderNowPlayingQueue());

export const audioPlayer = {
  current: null,
  queueSaveTimeout: null,
  prevVolume: null,
  
  init() {
    this.current = document.getElementById('audio-player');
    this.current.volume = 1;
    
    this.current.addEventListener("loadedmetadata", () => {
      document.getElementById("tot-time").textContent = formatDuration(this.current.duration);
    });
    
    this.current.addEventListener("play", () => {
      document.getElementById("btn-play").classList.add("playing");
      document.getElementById("progress-container").classList.add("active");
      updateMediaSessionPlaybackState('playing');
      updateTabTitle();
      updatePlaylistPlayButtonState();
      updateArtistPlayButtonState();
    });

    this.current.addEventListener("pause", () => {
      document.getElementById("btn-play").classList.remove("playing");
      document.getElementById("progress-container").classList.remove("active");
      updateMediaSessionPlaybackState('paused');
      updatePlaylistPlayButtonState();
      updateArtistPlayButtonState();
    });
    
    this.current.addEventListener("ended", () => handleTrackEnded());
    this.current.addEventListener("timeupdate", () => handleTimeUpdate());
    this.current.addEventListener("durationchange", () => handleDurationChange());
  },
  
  get element() { return this.current; },
  get dataset() { return this.current?.dataset; },
  
  get src() { return this.current?.src; },
  set src(val) { if (this.current) this.current.src = val; },
  
  get paused() { return this.current?.paused; },
  get duration() { return this.current?.duration || 0; },
  get currentTime() { return this.current?.currentTime || 0; },
  set currentTime(val) { if (this.current) this.current.currentTime = val; },
  
  get volume() { return this.current?.volume ?? 1; },
  set volume(val) { if (this.current) this.current.volume = val; },
  
  play() { return this.current?.play(); },
  pause() { this.current?.pause(); }
};

function updateMediaSessionPlaybackState(playbackState) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playbackState;
  }
}

function updateTabTitle() {
  if (state.currentQueue.length && state.currentIndex >= 0 && state.currentIndex < state.currentQueue.length) {
    var track = state.currentQueue[state.currentIndex];
    var artistTitle = (track.artists && track.artists.length > 0 && track.artists[0].name) || (track.artist && track.artist.name) || "Unknown";
    document.title = (track.title || "Openfy") + " - " + artistTitle;
  }
}

function updatePlaylistPlayButtonState() {
  const playlistPlayBtn = document.getElementById("playlist-play-btn");
  if (!playlistPlayBtn) return;
  if (state.currentPlayingPlaylistId === state.currentPlaylistId && !audioPlayer.paused) {
    playlistPlayBtn.classList.add('playing');
  } else {
    playlistPlayBtn.classList.remove('playing');
  }
}

function updateArtistPlayButtonState() {
  const artistPlayBtn = document.getElementById("artist-play-btn");
  if (!artistPlayBtn) return;
  const currentArtistPlaylistId = 'artist-' + state.currentArtistId;
  if (state.currentPlayingPlaylistId === currentArtistPlaylistId && !audioPlayer.paused) {
    artistPlayBtn.classList.add('playing');
  } else {
    artistPlayBtn.classList.remove('playing');
  }
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const artworkUrl = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
  const artistName = (track.artists && track.artists.length > 0 && track.artists[0].name) || (track.artist && track.artist.name) || "Unknown";
  const albumTitle = track.album?.title || "";
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "",
      artist: artistName,
      album: albumTitle,
      artwork: [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }]
    });
  } catch (e) {
    console.warn('MediaSession metadata error:', e.message);
  }
}

function handleTimeUpdate() {
  var pct = audioPlayer.duration ? (audioPlayer.currentTime / audioPlayer.duration) * 100 : 0;
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("curr-time").textContent = formatDuration(audioPlayer.currentTime);
  
  if (!audioPlayer.paused && audioPlayer.duration) {
    requestAnimationFrame(smoothProgress);
  }
  
  let lastMediaSessionUpdate = 0;
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
    const now = Date.now();
    if (now - lastMediaSessionUpdate < 100) return;
    lastMediaSessionUpdate = now;
    if (audioPlayer.duration) {
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

let smoothProgressRunning = false;
function smoothProgress() {
  if (!audioPlayer.paused && audioPlayer.duration) {
    document.getElementById("curr-time").textContent = formatDuration(audioPlayer.currentTime);
    var pct = audioPlayer.duration ? (audioPlayer.currentTime / audioPlayer.duration) * 100 : 0;
    document.getElementById("progress-fill").style.width = pct + "%";
    requestAnimationFrame(smoothProgress);
  }
}
requestAnimationFrame(smoothProgress);

function handleDurationChange() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (audioPlayer.duration) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audioPlayer.duration,
        playbackRate: audioPlayer.playbackRate,
        position: audioPlayer.currentTime
      });
    } catch (e) {}
  }
}

function handleTrackEnded() {
  if (state.repeatState === "loop-once") {
    state.repeatState = "off";
    document.getElementById("btn-repeat").classList.remove("active", "loop-twice");
    playTrack(state.currentQueue[state.currentIndex]);
  } else if (state.repeatState === "loop-twice") {
    if (state.repeatCount === 0) {
      state.repeatCount = 1;
      // Hide the '1' dot after first loop completes (one repeat used, one remains)
      const btn = document.getElementById("btn-repeat");
      const dot = btn.querySelector(".repeat-dot");
      if (dot) dot.style.display = "none";
      playTrack(state.currentQueue[state.currentIndex]);
    } else {
      // Final loop finished, move to next track
      state.repeatCount = 0;
      document.getElementById("btn-repeat").classList.remove("active", "loop-twice");
      playByIndex(state.currentIndex + 1, false);
    }
  } else {
    var nextIndex = (state.currentIndex + 1) % state.currentQueue.length;
    if (nextIndex === 0) {
      document.title = "Openfy - Web Player";
      state.currentPlayingPlaylistId = null;
      updateLibraryPlayingState();
    } else {
      playByIndex(state.currentIndex + 1, false);
    }
  }
}

export async function togglePlay() {
  if (!audioPlayer.src || audioPlayer.src === window.location.href) {
    if (state.currentTrackId && state.currentQueue.length && state.currentIndex >= 0) {
      playTrack(state.currentQueue[state.currentIndex]);
      return;
    }
    return;
  }
  if (audioPlayer.paused) {
    try {
      await audioPlayer.play();
    } catch (err) {
      console.error("Play failed:", err.message);
      // Check if it's an HTTP error (expired token) - try fetching fresh stream URL
      if (err.name === "AbortError" || err.message?.includes("404") || err.message?.includes("401") || err.message?.includes("500")) {
        const currentTrack = state.currentQueue[state.currentIndex];
        if (currentTrack) {
          console.log("Stream URL expired, fetching fresh URL...");
          // Clear the stale token so getTrackStreamUrl fetches a new one
          state.currentStreamToken = null;
          state.currentStreamTokenTrackId = null;
          try {
            const streamUrl = await getTrackStreamUrl(currentTrack.id);
            audioPlayer.src = streamUrl;
            await audioPlayer.play();
          } catch (retryErr) {
            console.error("Retry failed:", retryErr.message);
          }
        }
      }
    }
  } else {
    audioPlayer.pause();
  }
}

export function playByIndex(index, fromRepeat) {
      
  if (!state.currentQueue.length) return;
  if (index < 0 || index >= state.currentQueue.length) return;
  state.currentIndex = index;
  if (!fromRepeat) {
    state.repeatState = "off";
    state.repeatCount = 0;
    document.getElementById("btn-repeat").classList.remove("active", "loop-twice");
  }
  playTrack(state.currentQueue[state.currentIndex]);
  // Don't save queue on auto play - only save on user actions
  // This prevents queue reordering when tracks change automatically
}

export function playTrack(track) {
  state.currentTrackId = track.id;
  state.currentStreamToken = null;
  state.currentStreamTokenTrackId = null;
  updateMediaSession(track);
  
  getTrackStreamUrl(track.id)
    .then(function(streamUrl) {
      audioPlayer.src = streamUrl;
      return audioPlayer.play();
    })
    .catch(function(err) { console.error(err); });
  
  document.getElementById("now-title").textContent = track.title || "";
  document.getElementById("now-artist").innerHTML = makeArtistClickable(track) || "";

  var artistTitle = (track.artists && track.artists.length > 0 && track.artists[0].name) || (track.artist && track.artist.name) || "Unknown";
  document.title = (track.title || "Openfy") + " - " + artistTitle;
  
  clearCanvas(document.getElementById("now-cover"));
  document.getElementById("now-cover").classList.remove("visible");
  
  emitTrackChanged(track);
  
  var img = new Image();
  img.onload = function() {
    var ctx = document.getElementById("now-cover").getContext("2d");
    ctx.clearRect(0, 0, document.getElementById("now-cover").width, document.getElementById("now-cover").height);
    var size = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, document.getElementById("now-cover").width, document.getElementById("now-cover").height);
    document.getElementById("now-cover").classList.add("visible");
  };
  img.onerror = function() {
    drawCanvas(document.getElementById("now-cover"), track.title, getArtistDisplay(track) || "");
    document.getElementById("now-cover").classList.add("visible");
  };
  img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
  
  updateNowPlaying(track);
  renderNowPlayingQueue();
  
  const npLikeBtn = document.getElementById("np-like-btn");
  if (state.authHash) {
    npLikeBtn.classList.remove("hidden");
    npLikeBtn.classList.remove("liked", "adding");
    npLikeBtn.innerHTML = "";
    checkIfLiked(track.id);
  } else {
    npLikeBtn.classList.add("hidden");
  }
  
  hideRemovalMenuIfVisible();
}

export async function loadTrackPaused(track, preserveQueue = false) {
  console.log('Loading track (paused):', track.title);
  state.currentTrackId = track.id;
  state.currentStreamToken = null;
  state.currentStreamTokenTrackId = null;
  updateMediaSession(track);
  
  if (!preserveQueue) {
    setQueueFromList([track], 0);
  }
  
  getTrackStreamUrl(track.id)
    .then(function(streamUrl) {
      audioPlayer.src = streamUrl;
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
    })
    .catch(function(err) { console.error(err); });
  
  document.getElementById("now-title").textContent = track.title || "";
  document.getElementById("now-artist").innerHTML = makeArtistClickable(track) || "";
  clearCanvas(document.getElementById("now-cover"));
  document.getElementById("now-cover").classList.remove("visible");
  
  emitTrackChanged(track);
  
  var img = new Image();
  img.onload = function() {
    var ctx = document.getElementById("now-cover").getContext("2d");
    ctx.clearRect(0, 0, document.getElementById("now-cover").width, document.getElementById("now-cover").height);
    var size = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, document.getElementById("now-cover").width, document.getElementById("now-cover").height);
    document.getElementById("now-cover").classList.add("visible");
  };
  img.onerror = function() {
    drawCanvas(document.getElementById("now-cover"), track.title, getArtistDisplay(track) || "");
    document.getElementById("now-cover").classList.add("visible");
  };
  img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
  
  updateNowPlaying(track);
  renderNowPlayingQueue();
  
  const npLikeBtn = document.getElementById("np-like-btn");
  if (state.authHash) {
    npLikeBtn.classList.remove("hidden");
    npLikeBtn.classList.remove("liked", "adding");
    npLikeBtn.innerHTML = "";
    checkIfLiked(track.id);
  } else {
    npLikeBtn.classList.add("hidden");
  }
  
  document.getElementById("btn-play").classList.remove("playing");
  document.getElementById("progress-container").classList.remove("active");
  
  hideRemovalMenuIfVisible();
}

async function checkIfLiked(trackId) {
  if (!state.authHash) {
    document.getElementById("np-like-btn").classList.add("hidden");
    return;
  }
  try {
    const res = await apiCheckIfLiked(trackId);
    if (res) {
      state.likedTrackIds.add(trackId);
    } else {
      state.likedTrackIds.delete(trackId);
    }
    if (state.currentTrackId === trackId) {
      syncLikeButtonState({ id: trackId });
    }
  } catch (e) {
    console.error("checkIfLiked error:", e);
    if (state.currentTrackId === trackId) {
      syncLikeButtonState({ id: trackId });
    }
  }
}

// Helper to create clickable artist HTML with inline onclick
function makeArtistClickable(track) {
  var artistNames = [];
  var artistIds = [];
  if (track.artists && track.artists.length > 0) {
    track.artists.forEach(function(a) {
      artistNames.push(a.name);
      if (a.id) artistIds.push(a.id);
    });
  } else if (track.artist && track.artist.name) {
    artistNames.push(track.artist.name);
    if (track.artist.id) artistIds.push(track.artist.id);
  }
  if (artistNames.length > 0) {
    return artistNames.map(function(name, i) {
      var id = artistIds[i] || '';
      var safeName = escapeHtml(name || "");
      if (id) {
        return '<span class="clickable-artist" onclick="window.handleArtistClick(event, \'' + id + '\')">' + safeName + '</span>';
      }
      return '<span class="clickable-artist">' + safeName + '</span>';
    }).join(', ');
  }
  return "Unknown";
}

export function updateNowPlaying(track) {
  const npPlaceholder = document.getElementById("np-placeholder");
  const npTrack = document.getElementById("np-track");
  const npTitle = document.getElementById("np-title");
  const npArtist = document.getElementById("np-artist");
  const npCover = document.getElementById("np-cover");
  const npImg = document.getElementById("np-img");

  npPlaceholder.style.display = "none";
  npTrack.style.display = "flex";
  npTitle.textContent = track.title || "";
  npArtist.innerHTML = makeArtistClickable(track);
  clearCanvas(npCover);
  npCover.style.display = "none";
  npImg.style.display = "none";
  
  var npImgEl = new Image();
  npImgEl.onload = function() {
    npImg.src = npImgEl.src;
    npImg.style.display = "block";
    npCover.style.display = "none";
  };
  npImgEl.onerror = function() {
    drawCanvas(npCover, track.title, getArtistDisplay(track) || "");
    npCover.style.display = "block";
    npImg.style.display = "none";
  };
  npImgEl.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
  
  syncLikeButtonState(track);
}

export function syncLikeButtonState(track) {
  const npLikeBtn = document.getElementById("np-like-btn");
  if (!npLikeBtn) return;  
  npLikeBtn.disabled = false;
  npLikeBtn.classList.remove("liked", "adding", "in-playlist");
  npLikeBtn.innerHTML = '';
  
  if (state.likedTrackIds.has(track.id)) {
    npLikeBtn.classList.add("liked");
    npLikeBtn.innerHTML = '<i class="fa-solid fa-heart"></i>';
    npLikeBtn.setAttribute("aria-label", "Remove from Liked Songs");
    npLikeBtn.setAttribute("title", "Remove from Liked Songs");
  } else if (state.trackIdsInRegularPlaylists.has(track.id)) {
    npLikeBtn.classList.add("in-playlist");
    npLikeBtn.setAttribute("aria-label", "Added to playlist");
    npLikeBtn.setAttribute("title", "Added to playlist");
  } else {
    npLikeBtn.setAttribute("aria-label", "Add to Liked Songs");
    npLikeBtn.setAttribute("title", "Add to Liked Songs");
  }
}

function hideRemovalMenuIfVisible() {
  const menu = document.getElementById("np-playlist-removal-menu");
  if (menu && menu.classList.contains("visible")) {
    menu.classList.remove("visible");
  }
}

/**
 * setQueueFromList — delegates to queue-manager.queueSetList.
 * Kept exported so all existing callers continue to work unchanged.
 */
export function setQueueFromList(list, startIndex) {
  queueSetList(list, startIndex);
}

/**
 * reorderQueue — delegates to queue-manager.queueReorder.
 * fromIndex and toIndex are queue-array positions (pre-removal).
 */
export function reorderQueue(fromIndex, toIndex) {
  _queueReorder(fromIndex, toIndex);
}

/** enforceQueueCapacity — delegates to queue-manager. */
export function enforceQueueCapacity() {
  queueEnforceCap();
}

/** shuffleQueueOnce — delegates to queue-manager. */
export function shuffleQueueOnce() {
  queueShuffle();
}

/** unshuffleQueue — delegates to queue-manager. */
export function unshuffleQueue() {
  queueUnshuffle();
}

// localStorage reader — still useful for startup restore.
export function loadQueueLocal() {
  try {
    const idsJson = localStorage.getItem('openfy_queue');
    const indexStr = localStorage.getItem('openfy_queue_index');
    if (idsJson) {
      const ids   = JSON.parse(idsJson);
      const index = parseInt(indexStr, 10) || 0;
      return { track_ids: ids, current_index: index };
    }
  } catch (err) {
    console.error('loadQueueLocal error:', err);
  }
  return null;
}

/**
 * scheduleQueueSave — kept for backward-compat with any caller that
 * still imports it.  All real work is delegated to queue-manager.
 */
export function scheduleQueueSave() {
  queueSave();
}

export function getQueue() {
  return state.currentQueue;
}

export function getCurrentIndex() {
  return state.currentIndex;
}

export function setCurrentIndex(idx) {
  state.currentIndex = idx;
}

export function getRepeatState() {
  return state.repeatState;
}

export function setRepeatState(val) {
  state.repeatState = val;
}

export function getRepeatCount() {
  return state.repeatCount;
}

export function setRepeatCount(val) {
  state.repeatCount = val;
}

export function getShuffle() {
  return state.shuffle;
}

export function setShuffle(val) {
  state.shuffle = val;
}

export function getCurrentTrackId() {
  return state.currentTrackId;
}

export function getCurrentPlayingPlaylistId() {
  return state.currentPlayingPlaylistId;
}

export function setCurrentPlayingPlaylistId(id) {
  state.currentPlayingPlaylistId = id;
}

function updateLibraryPlayingState() {
  var allItems = document.querySelectorAll('.lib-item');
  allItems.forEach(function(item) { item.classList.remove('playing'); });
  if (state.currentPlayingPlaylistId) {
    var playingItem = document.querySelector('.lib-item[data-playlist-id="' + state.currentPlayingPlaylistId + '"]');
    if (playingItem) {
      playingItem.classList.add('playing');
    }
  }
}

export function buildQueueItem(track, index, opts) {
  opts = opts || {};
  const btn = document.createElement("button");
  btn.type = "button";
  let className = "np-queue-item";
  if (opts.isNext) className += " next";
  if (opts.isCurrent) className += " current";
  btn.className = className;
  btn.draggable = !opts.isCurrent;
  btn.dataset.index = index;
  btn.dataset.trackId = track && track.id != null ? String(track.id) : "";

  const artistText = getArtistDisplay(track) || "Unknown";
  const seed = ((track.title || "") + " " + artistText).trim() || "Openfy";

  const art = document.createElement("div");
  art.className = "np-queue-art";
  art.style.setProperty("--queue-color", seededColor(seed));

  const img = document.createElement("img");
  img.alt = (track.title || "Track") + " artwork";
  img.loading = "lazy";
  img.decoding = "async";
  img.src = queueArtworkUrl(track);
  img.onerror = function() { img.remove(); };
  art.appendChild(img);

  const meta = document.createElement("div");
  meta.className = "np-queue-meta";

  const titleEl = document.createElement("div");
  titleEl.className = "np-queue-title";
  titleEl.textContent = track.title || "";

  const artistEl = document.createElement("div");
  artistEl.className = "np-queue-artist";
  // Make each artist name clickable individually
  var artistNames = [];
  var artistIds = [];
  if (track.artists && track.artists.length > 0) {
    track.artists.forEach(function(a) {
      artistNames.push(a.name);
      if (a.id) artistIds.push(a.id);
    });
  } else if (track.artist && track.artist.name) {
    artistNames.push(track.artist.name);
    if (track.artist.id) artistIds.push(track.artist.id);
  }
  if (artistNames.length > 0) {
    artistEl.innerHTML = artistNames.map(function(name, i) {
      var id = artistIds[i] || '';
      var safeName = escapeHtml(name || "");
      if (id) {
        return '<span class="clickable-artist" onclick="window.handleArtistClick(event, \'' + id + '\')">' + safeName + '</span>';
      }
      return '<span>' + safeName + '</span>';
    }).join(', ');
  } else {
    artistEl.textContent = "Unknown";
  }

  meta.appendChild(titleEl);
  meta.appendChild(artistEl);

  const badge = document.createElement("div");
  badge.className = "np-queue-badge";
  badge.textContent = opts.badgeText || "";
  if (!badge.textContent) badge.style.display = "none";

  if (opts.isCurrent) {
    const nowPlayingBadge = document.createElement("span");
    nowPlayingBadge.className = "np-queue-now-playing";
    nowPlayingBadge.innerHTML = '<i class="fa-solid fa-music"></i> Now Playing';
    meta.appendChild(nowPlayingBadge);
  }

  btn.appendChild(art);
  btn.appendChild(meta);
  btn.appendChild(badge);

  btn.addEventListener("click", function(ev) {
    ev.preventDefault();
    // Don't play track if clicking on artist name
    if (ev.target.closest('.clickable-artist')) return;
    if (!state.currentQueue || !state.currentQueue.length) return;
    if (index < 0 || index >= state.currentQueue.length) return;
    queueJumpTo(index);
    state.repeatState = "off";
    state.repeatCount = 0;
    document.getElementById("btn-repeat").classList.remove("active", "loop-twice");
    playTrack(state.currentQueue[state.currentIndex]);
    queueSave();
  });

  btn.addEventListener("contextmenu", function(ev) {
    ev.preventDefault();
    window.showTrackContextMenu && window.showTrackContextMenu(ev, track, { fromQueuePanel: true, queueIndex: index });
  });

  btn.addEventListener("dragstart", function(ev) {
    if (opts.isCurrent) {
      ev.preventDefault();
      return;
    }
    state.dragSourceIndex = index;
    state.draggedElement = btn;
    btn.classList.add("dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.setData("text/plain", index.toString());
      ev.dataTransfer.effectAllowed = "move";
    }
    state.lastDragY = ev.clientY;
    state.lastInsertBeforeEl = null;
  });

  btn.addEventListener("dragend", function(ev) {
    btn.classList.remove("dragging");
    document.querySelectorAll('.np-queue-item').forEach(el => {
      el.style.transform = '';
      el.style.transition = '';
    });
    document.querySelectorAll(".np-queue-item.drag-over").forEach(function(el) {
      el.classList.remove("drag-over");
    });
    state.dragSourceIndex = null;
    state.draggedElement = null;
    state.lastDragY = null;
    state.lastInsertBeforeEl = null;
  });

  btn.addEventListener("drag", function(ev) {
    state.lastDragY = ev.clientY;
  });

  return btn;
}

export function renderNowPlayingQueue() {
  const npNextPanel = document.getElementById("np-next-panel");
  const npQueueNext = document.getElementById("np-queue-next");
  if (!npNextPanel || !npQueueNext) return;

  npNextPanel.style.display = "";

  if (!state.currentQueue || !state.currentQueue.length || state.currentIndex < 0) {
    npQueueNext.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "np-queue-empty";
    empty.textContent = "Play something to build a queue.";
    npQueueNext.appendChild(empty);
    state.lastRenderedIndices = [];
    return;
  }

  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.currentQueue.length) {
    npQueueNext.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "np-queue-empty";
    empty.textContent = "End of queue.";
    npQueueNext.appendChild(empty);
    state.lastRenderedIndices = [];
    return;
  }

  const visibleCount = state.showFullQueue ? 6 : 1;
  const windowStart = nextIndex;
  const windowEnd = Math.min(nextIndex + visibleCount, state.currentQueue.length);
  const newIndices = [];
  for (let i = windowStart; i < windowEnd; i++) newIndices.push(i);

  const oldRectsByTrackId = new Map();
  npQueueNext.querySelectorAll('.np-queue-item').forEach(el => {
    const trackId = el.dataset.trackId;
    if (trackId) oldRectsByTrackId.set(trackId, el.getBoundingClientRect());
  });

  npQueueNext.innerHTML = "";
  const mountedItems = [];

  newIndices.forEach(idx => {
    const track = state.currentQueue[idx];
    const el = buildQueueItem(track, idx, { isCurrent: false, badgeText: "" });
    npQueueNext.appendChild(el);
    mountedItems.push(el);
  });

  mountedItems.forEach(el => {
    const trackId = el.dataset.trackId;
    const oldRect = trackId ? oldRectsByTrackId.get(trackId) : null;
    const newRect = el.getBoundingClientRect();

    if (oldRect) {
      const deltaX = oldRect.left - newRect.left;
      const deltaY = oldRect.top - newRect.top;
      if (deltaX !== 0 || deltaY !== 0) {
        el.style.transition = 'none';
        el.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
        el.offsetHeight;
        el.style.transition = 'transform 0.24s ease';
        el.style.transform = '';
      }
    } else {
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      el.offsetHeight;
      el.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      el.style.opacity = '';
      el.style.transform = '';
    }
  });

  setTimeout(() => {
    if (!npQueueNext) return;
    npQueueNext.querySelectorAll('.np-queue-item').forEach(el => {
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
    });
  }, 260);

  state.lastRenderedIndices = newIndices;
}

export function toggleFullQueue() {
  state.showFullQueue = !state.showFullQueue;
}

export function getShowFullQueue() {
  return state.showFullQueue;
}

export function setShowFullQueue(val) {
  state.showFullQueue = val;
}

export function getCollapseTimeout() {
  return state.collapseTimeout;
}

export function setCollapseTimeout(val) {
  state.collapseTimeout = val;
}

export { updateLibraryPlayingState };
