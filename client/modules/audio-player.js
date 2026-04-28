import { state, withBase } from './state.js';
import { getTrackStreamUrl, saveQueueToServer, savePlayerState, checkIfLiked as apiCheckIfLiked } from './api.js';
import { getArtistDisplay, formatDuration, drawCanvas, clearCanvas, queueArtworkUrl, seededColor, extractVibrantColors } from './utils.js';
import { emitTrackChanged, getGradientManager } from './gradient-manager.js';

const MAX_QUEUE_CAPACITY = 20;

export const audioPlayer = {
  current: null,
  queueSaveTimeout: null,
  
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
    });
    
    this.current.addEventListener("pause", () => {
      document.getElementById("btn-play").classList.remove("playing");
      document.getElementById("progress-container").classList.remove("active");
      updateMediaSessionPlaybackState('paused');
      updatePlaylistPlayButtonState();
    });
    
    this.current.addEventListener("ended", () => handleTrackEnded());
    this.current.addEventListener("timeupdate", () => handleTimeUpdate());
    this.current.addEventListener("durationchange", () => handleDurationChange());
  },
  
  get element() { return this.current; },
  
  get src() { return this.current?.src; },
  set src(val) { if (this.current) this.current.src = val; },
  
  get paused() { return this.current?.paused; },
  get duration() { return this.current?.duration || 0; },
  get currentTime() { return this.current?.currentTime || 0; },
  set currentTime(val) { if (this.current) this.current.currentTime = val; },
  
  get volume() { return this.current?.volume || 1; },
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
    if (state.repeatCount < 2) {
      state.repeatCount++;
      if (state.repeatCount >= 2) {
        document.getElementById("btn-repeat").classList.add("loop-twice");
      }
      playTrack(state.currentQueue[state.currentIndex]);
    } else {
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

export function togglePlay() {
  if (!audioPlayer.src || audioPlayer.src === window.location.href) {
    if (state.currentTrackId && state.currentQueue.length && state.currentIndex >= 0) {
      playTrack(state.currentQueue[state.currentIndex]);
      return;
    }
    return;
  }
  if (audioPlayer.paused) { audioPlayer.play().catch(function(err) { console.error(err); }); } else { audioPlayer.pause(); }
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
  scheduleQueueSave();
}

export function playTrack(track) {
  console.log('Playing track:', track.title);
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
  document.getElementById("now-artist").textContent = getArtistDisplay(track) || "";
  
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
  document.getElementById("now-artist").textContent = getArtistDisplay(track) || "";
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
  npArtist.textContent = getArtistDisplay(track) || "Unknown";
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
  
  if (state.likedTrackIds.has(track.id)) {
    npLikeBtn.classList.add("liked");
    npLikeBtn.innerHTML = '<i class="fa-solid fa-heart"></i>';
    npLikeBtn.setAttribute("aria-label", "Remove from Liked Songs");
    npLikeBtn.setAttribute("title", "Remove from Liked Songs");
  } else if (state.trackIdsInRegularPlaylists.has(track.id)) {
    npLikeBtn.classList.add("in-playlist");
    npLikeBtn.innerHTML = '';
    npLikeBtn.setAttribute("aria-label", "Added to playlist");
    npLikeBtn.setAttribute("title", "Added to playlist");
  } else {
    npLikeBtn.innerHTML = '';
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

export function setQueueFromList(list, startIndex) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) {
    state.currentQueue = [];
    state.currentIndex = -1;
    state.queueOriginal = null;
    renderNowPlayingQueue();
    scheduleQueueSave();
    return;
  }

  const idx = Math.max(0, Math.min((startIndex | 0), arr.length - 1));
  // Take full queue up to MAX_QUEUE_CAPACITY, starting from beginning
  state.currentQueue = arr.slice(0, MAX_QUEUE_CAPACITY);
  state.currentIndex = idx;
  state.queueOriginal = null;
  shuffleQueueOnce();
  renderNowPlayingQueue();
  scheduleQueueSave();
}

export function reorderQueue(fromIndex, toIndex) {
  if (!Array.isArray(state.currentQueue) || fromIndex < 0 || fromIndex >= state.currentQueue.length) return;
  if (toIndex < 0 || toIndex > state.currentQueue.length) return;
  if (fromIndex === toIndex) return;

  const insertAt = toIndex;
  const prevCurrentIndex = state.currentIndex;

  const [track] = state.currentQueue.splice(fromIndex, 1);
  state.currentQueue.splice(insertAt, 0, track);

  if (prevCurrentIndex >= 0 && prevCurrentIndex < state.currentQueue.length) {
    if (fromIndex === prevCurrentIndex) {
      state.currentIndex = insertAt;
    } else if (fromIndex < prevCurrentIndex && insertAt >= prevCurrentIndex) {
      state.currentIndex = prevCurrentIndex - 1;
    } else if (fromIndex > prevCurrentIndex && insertAt <= prevCurrentIndex) {
      state.currentIndex = prevCurrentIndex + 1;
    } else {
      state.currentIndex = prevCurrentIndex;
    }
  }

  state.shuffle = false;
  const btnShuffle = document.getElementById("btn-shuffle");
  if (btnShuffle) btnShuffle.classList.remove("active");
  state.queueOriginal = null;

  renderNowPlayingQueue();
  scheduleQueueSave();
}

export function enforceQueueCapacity() {
  if (state.currentQueue.length <= MAX_QUEUE_CAPACITY) return;
  const excess = state.currentQueue.length - MAX_QUEUE_CAPACITY;
  const removableBefore = Math.min(excess, state.currentIndex);
  if (removableBefore > 0) {
    state.currentQueue.splice(0, removableBefore);
    state.currentIndex -= removableBefore;
  }
  const remainingExcess = state.currentQueue.length - MAX_QUEUE_CAPACITY;
  if (remainingExcess > 0) {
    state.currentQueue.splice(state.currentIndex + 1, remainingExcess);
  }
}

export function shuffleQueueOnce() {
  if (!state.shuffle) return;
  if (!Array.isArray(state.currentQueue) || state.currentQueue.length < 2) return;
  if (state.currentIndex < 0) return;

  if (!state.queueOriginal) state.queueOriginal = state.currentQueue.slice();

  const start = state.currentIndex + 1;
  const suffix = state.currentQueue.slice(start);
  for (let i = suffix.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = suffix[i];
    suffix[i] = suffix[j];
    suffix[j] = tmp;
  }
  state.currentQueue = state.currentQueue.slice(0, start).concat(suffix);
}

export function unshuffleQueue() {
  if (!state.queueOriginal) return;
  const activeTrackId = state.currentTrackId;
  state.currentQueue = state.queueOriginal.slice();
  state.queueOriginal = null;
  if (activeTrackId) {
    const idx = indexOfTrackId(state.currentQueue, activeTrackId);
    if (idx !== -1) state.currentIndex = idx;
  }
  scheduleQueueSave();
}

function indexOfTrackId(queue, trackId, startFrom) {
  if (!trackId || !Array.isArray(queue)) return -1;
  const startIdx = startFrom !== undefined ? startFrom : 0;
  for (let i = startIdx; i < queue.length; i++) {
    if (queue[i] && queue[i].id == trackId) return i;
  }
  return -1;
}

export function scheduleQueueSave() {
  if (state.queueSaveTimeout) clearTimeout(state.queueSaveTimeout);
  state.queueSaveTimeout = setTimeout(() => {
    saveQueueToServer();
  }, 1000);
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
  artistEl.textContent = artistText;

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
    if (!state.currentQueue || !state.currentQueue.length) return;
    if (index < 0 || index >= state.currentQueue.length) return;
    state.currentIndex = index;
    state.repeatState = "off";
    state.repeatCount = 0;
    document.getElementById("btn-repeat").classList.remove("active", "loop-twice");
    playTrack(state.currentQueue[state.currentIndex]);
    scheduleQueueSave();
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