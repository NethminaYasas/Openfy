import { state, withBase } from './state.js';
import { api, setAuthenticatedImage, loadTracks as apiLoadTracks, loadUserUploads as apiLoadUserUploads, loadMostPlayed as apiLoadMostPlayed, refreshManualUploadSetting } from './api.js';
import { getArtistDisplay, formatTotalDuration, createPlaylistIconSvg, buildPlaylistCover as buildPlaylistCoverUtil, drawCanvas, seededColor } from './utils.js';
import { playTrack, setQueueFromList, loadTrackPaused, renderNowPlayingQueue, setCurrentPlayingPlaylistId, getCurrentTrackId, getCurrentIndex, getCurrentPlayingPlaylistId } from './audio-player.js';
import { getGradientManager } from './gradient-manager.js';
import { saveScrollPositions, restoreScrollPositions, resetPlaylistScroll } from './scroll-manager.js';

export const pages = {
  home: null,
  library: null,
  playlist: null,
  admin: null,
  settings: null,
  profile: null,
  
  init() {
    this.home = document.getElementById("page-home");
    this.library = document.getElementById("page-library");
    this.playlist = document.getElementById("page-playlist");
    this.admin = document.getElementById("page-admin");
    this.settings = document.getElementById("page-settings");
    this.profile = document.getElementById("page-profile");
  },
  
  get(key) {
    return this[key];
  }
};

export function setUrl(path) {
  const baseUrl = window.location.origin + window.location.pathname;
  if (window.location.pathname !== path) {
    history.pushState(null, '', path);
  }
}

export function setActivePage(pageId, updateUrl = true) {
  // Save scroll positions before switching (except when navigating TO playlist — playlist scroll is always reset)
  if (pageId !== 'playlist') {
    saveScrollPositions();
  }

  ['home', 'library', 'playlist', 'admin', 'settings', 'profile'].forEach(function(key) {
    var p = pages[key];
    if (p && p.classList) p.classList.remove("active");
  });
  var target = pages[pageId] || pages.home;
  if (target && target.classList) target.classList.add("active");
  document.querySelectorAll(".nav-link").forEach(function(link) { link.classList.toggle("active", link.dataset.page === pageId); });
if (pageId === "library" && state.authHash) {
      loadUserUploads();
      refreshManualUploadSetting();
      const manualSection = document.getElementById("manual-upload-section");
      if (manualSection) {
        manualSection.style.display = state.manualAudioUploadEnabled ? "block" : "none";
      }
    }
  if (pageId === "profile" && state.currentUser) {
    populateProfilePage();
  }
  
  document.getElementById('app-main').classList.toggle('home-page', pageId === 'home');
  document.getElementById('app-main').classList.toggle('playlist-page', pageId === 'playlist');

  if (updateUrl) {
    if (pageId === 'home') {
      setUrl('/');
    } else if (pageId === 'library') {
      setUrl('/library');
    } else if (pageId === 'settings') {
      setUrl('/settings');
    } else if (pageId === 'profile') {
      setUrl('/profile');
    } else if (pageId === 'admin') {
      setUrl('/admin');
    } else if (pageId === 'playlist' && state.currentPlaylistId) {
      setUrl('/playlist/' + state.currentPlaylistId);
    }
  }

  if (getGradientManager()) {
    const event = new CustomEvent('pageNavigated', {
      detail: { pageId }
    });
    document.dispatchEvent(event);
  }

  // Restore/reset scroll after DOM updates — ensures content is rendered before applying scroll
  requestAnimationFrame(() => {
    if (pageId === 'playlist') {
      resetPlaylistScroll();
    } else {
      restoreScrollPositions();
    }
  });
}

export function navigateFromUrl() {
  const path = window.location.pathname;
  const hash = window.location.hash;

  if (path === '/' || path === '' || path === '/home') {
    setActivePage('home');
  } else if (path === '/library') {
    setActivePage('library');
  } else if (path === '/settings') {
    setActivePage('settings');
  } else if (path === '/profile') {
    setActivePage('profile');
  } else if (path === '/admin') {
    setActivePage('admin');
  } else if (path.startsWith('/playlist/')) {
    const playlistId = path.split('/playlist/')[1];
    if (playlistId) {
      openPlaylistById(playlistId);
    } else {
      setActivePage('home');
    }
  } else {
    setActivePage('home');
  }
}

export async function openPlaylistById(playlistId) {
  state.currentPlaylistId = playlistId;
  const { api } = await import('./api.js');
  try {
    var pl = await api("/playlists/" + playlistId);
    openPlaylist(playlistId);
    setActivePage("playlist", true);
  } catch (err) {
    console.error("Failed to open playlist:", err);
    setActivePage("home");
  }
}

export async function loadTracks() {
  const tracks = await apiLoadTracks();
  renderTracks(tracks);
  return tracks;
}

export async function loadUserUploads() {
  const tracks = await apiLoadUserUploads();
  renderUploads(tracks);
  return tracks;
}

export async function loadMostPlayed() {
  const tracks = await apiLoadMostPlayed();
  renderMostPlayed(tracks);
  return tracks;
}

export function buildTrackCard(track, list, index) {
  var card = document.createElement("div");
  card.className = "card";

  var artContainer = document.createElement("div");
  artContainer.className = "artwork-container";

  var art = createArtCanvas(track.title, getArtistDisplay(track));
  var img = document.createElement("img");
  img.className = "card-img";
  img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
  img.alt = track.title;
  img.style.display = "none";

  img.addEventListener("load", function() {
    art.style.display = "none";
    img.style.display = "block";
  });
  img.addEventListener("error", function() {
    img.style.display = "none";
    art.style.display = "block";
  });

  artContainer.appendChild(art);
  artContainer.appendChild(img);
  card.appendChild(artContainer);

  var title = document.createElement("p");
  title.className = "card-title";
  title.textContent = track.title;
  var info = document.createElement("p");
  info.className = "card-info";
  info.textContent = getArtistDisplay(track);
  card.appendChild(title);
  card.appendChild(info);

  card.addEventListener("click", function() {
    setCurrentPlayingPlaylistId(null);
    if (window.updateLibraryPlayingState) window.updateLibraryPlayingState();
    setQueueFromList(list, index);
    if (state.currentQueue.length) playTrack(state.currentQueue[state.currentIndex]);
  });

  card.addEventListener("contextmenu", function(e) {
    e.preventDefault();
    if (window.showTrackContextMenu) window.showTrackContextMenu(e, track);
  });

  return card;
}

function createArtCanvas(title, artist) {
  var canvas = document.createElement("canvas");
  canvas.className = "art-canvas";
  canvas.width = 180;
  canvas.height = 180;
  drawCanvas(canvas, title, artist);
  return canvas;
}

export function renderTracks(tracks) {
  const container = document.getElementById('tracks-grid');
  if (!container) return;

  container.innerHTML = '';

  if (!tracks.length) {
    const emptyCard = document.createElement('div');
    emptyCard.className = 'card';
    emptyCard.innerHTML = '<p class="card-title">No tracks yet</p><p class="card-info">Download a track to start</p>';
    container.appendChild(emptyCard);
    updateTrackRowScrollButtons();
    return;
  }

  const maxTracksPerRow = 8;
  const rows = [];
  for (let i = 0; i < tracks.length; i += maxTracksPerRow) {
    const rowTracks = tracks.slice(i, i + maxTracksPerRow);
    rows.push(rowTracks);
  }

  rows.forEach((rowTracks, rowIndex) => {
    const rowWrapper = document.createElement('div');
    rowWrapper.className = 'track-row-wrapper';
    rowWrapper.style.marginTop = rowIndex === 0 ? '1.5rem' : '1rem';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
    prevBtn.id = `track-row-prev-${rowIndex}`;
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

    const rowContainer = document.createElement('div');
    rowContainer.className = 'track-row-container';

    const trackRow = document.createElement('div');
    trackRow.className = 'track-row';
    trackRow.id = `tracks-grid-${rowIndex}`;

    const baseIndex = rowIndex * maxTracksPerRow;
    rowTracks.forEach(function(track, idx) {
      const globalIndex = baseIndex + idx;
      const card = buildTrackCard(track, tracks, globalIndex);
      card.classList.add('track-row-card');

      if (!state.existingLibraryTracks.has(track.id)) {
        card.classList.add('new-track');
        card.style.animationDelay = `${idx * 0.1}s`;
        state.existingLibraryTracks.add(track.id);
      }

      trackRow.appendChild(card);
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
    nextBtn.id = `track-row-next-${rowIndex}`;
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

    rowWrapper.appendChild(prevBtn);
    rowWrapper.appendChild(rowContainer);
    rowWrapper.appendChild(nextBtn);
    container.appendChild(rowWrapper);

    rowContainer.appendChild(trackRow);
  });

  if (state.tracksInitTimeout) clearTimeout(state.tracksInitTimeout);
  state.tracksInitTimeout = setTimeout(() => {
    initTrackRowScrolling(rows, 'track-row-', 'tracks-grid-');
  }, 100);
}

export function renderUploads(tracks) {
  const container = document.getElementById('uploads-grid');
  if (!container) return;

  container.innerHTML = '';

  if (!tracks.length) {
    const emptyCard = document.createElement('div');
    emptyCard.className = 'card';
    emptyCard.innerHTML = '<p class="card-title">No uploads yet</p><p class="card-info">Upload a track to see it here</p>';
    container.appendChild(emptyCard);
    return;
  }

  const maxTracksPerRow = 8;
  const rows = [];
  for (let i = 0; i < tracks.length; i += maxTracksPerRow) {
    const rowTracks = tracks.slice(i, i + maxTracksPerRow);
    rows.push(rowTracks);
  }

  rows.forEach((rowTracks, rowIndex) => {
    const rowWrapper = document.createElement('div');
    rowWrapper.className = 'track-row-wrapper';
    rowWrapper.style.marginTop = rowIndex === 0 ? '1.5rem' : '1rem';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
    prevBtn.id = `uploads-row-prev-${rowIndex}`;
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

    const rowContainer = document.createElement('div');
    rowContainer.className = 'track-row-container';

    const trackRow = document.createElement('div');
    trackRow.className = 'track-row';
    trackRow.id = `uploads-grid-${rowIndex}`;

    const baseIndex = rowIndex * maxTracksPerRow;
    rowTracks.forEach(function(track, idx) {
      const globalIndex = baseIndex + idx;
      const card = buildTrackCard(track, tracks, globalIndex);
      card.classList.add('track-row-card');

      if (!state.existingLibraryTracks.has(track.id)) {
        card.classList.add('new-track');
        card.style.animationDelay = `${idx * 0.1}s`;
        state.existingLibraryTracks.add(track.id);
      }

      trackRow.appendChild(card);
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
    nextBtn.id = `uploads-row-next-${rowIndex}`;
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

    rowWrapper.appendChild(prevBtn);
    rowWrapper.appendChild(rowContainer);
    rowWrapper.appendChild(nextBtn);
    container.appendChild(rowWrapper);

    rowContainer.appendChild(trackRow);
  });

  if (state.uploadsInitTimeout) clearTimeout(state.uploadsInitTimeout);
  state.uploadsInitTimeout = setTimeout(() => {
    initTrackRowScrolling(rows, 'uploads-row-', 'uploads-grid-');
  }, 100);
}

export function renderMostPlayed(tracks) {
  const container = document.getElementById('most-played-grid');
  if (!container) return;

  container.innerHTML = '';

  if (!tracks.length) {
    const emptyCard = document.createElement('div');
    emptyCard.className = 'card';
    emptyCard.innerHTML = '<p class="card-title">No most played tracks yet</p><p class="card-info">Play some tracks to see them here</p>';
    container.appendChild(emptyCard);
    updateTrackRowScrollButtons();
    return;
  }

  const maxTracksPerRow = 9;
  const rows = [];
  for (let i = 0; i < tracks.length; i += maxTracksPerRow) {
    const rowTracks = tracks.slice(i, i + maxTracksPerRow);
    rows.push(rowTracks);
  }

  rows.forEach((rowTracks, rowIndex) => {
    const rowWrapper = document.createElement('div');
    rowWrapper.className = 'track-row-wrapper';
    rowWrapper.style.marginTop = rowIndex === 0 ? '1.5rem' : '1rem';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
    prevBtn.id = `most-played-row-prev-${rowIndex}`;
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

    const rowContainer = document.createElement('div');
    rowContainer.className = 'track-row-container';

    const trackRow = document.createElement('div');
    trackRow.className = 'track-row';
    trackRow.id = `most-played-grid-${rowIndex}`;

    const baseIndex = rowIndex * maxTracksPerRow;
    rowTracks.forEach(function(track, idx) {
      const globalIndex = baseIndex + idx;
      const card = buildTrackCard(track, tracks, globalIndex);
      card.classList.add('track-row-card');

      if (!state.existingMostPlayedTracks.has(track.id)) {
        card.classList.add('new-track');
        card.style.animationDelay = `${idx * 0.1}s`;
        state.existingMostPlayedTracks.add(track.id);
      }

      trackRow.appendChild(card);
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
    nextBtn.id = `most-played-row-next-${rowIndex}`;
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

    rowWrapper.appendChild(prevBtn);
    rowWrapper.appendChild(rowContainer);
    rowWrapper.appendChild(nextBtn);
    container.appendChild(rowWrapper);

    rowContainer.appendChild(trackRow);
  });

  if (state.mostPlayedInitTimeout) clearTimeout(state.mostPlayedInitTimeout);
  state.mostPlayedInitTimeout = setTimeout(() => {
    initTrackRowScrolling(rows, 'most-played-row-', 'most-played-grid-');
  }, 100);
}

function initTrackRowScrolling(rows, rowKeyPrefix, trackRowIdPrefix) {
  rows.forEach((_, rowIndex) => {
    const prevBtn = document.getElementById(`${rowKeyPrefix}prev-${rowIndex}`);
    const nextBtn = document.getElementById(`${rowKeyPrefix}next-${rowIndex}`);
    if (!prevBtn || !nextBtn || !prevBtn.isConnected || !nextBtn.isConnected) return;
    const trackRow = document.getElementById(`${trackRowIdPrefix}${rowIndex}`);
    const rowContainer = prevBtn.nextElementSibling;

    if (trackRow && rowContainer && rowContainer.isConnected && trackRow.isConnected) {
      const rowKey = `${rowKeyPrefix}${rowIndex}`;
      if (!(rowKey in state.scrollPositions)) {
        state.scrollPositions[rowKey] = 0;
      }

      function getCardWidth() {
        const card = trackRow.querySelector('.track-row-card');
        const gap = parseFloat(getComputedStyle(trackRow).gap) || 16;
        const w = card ? card.offsetWidth : 0;
        return (w > 0 ? w : 160) + gap;
      }

      let showPrevBtn = false;
      let showNextBtn = false;

      prevBtn.onclick = (e) => {
        e.preventDefault();
        const step = getCardWidth() * 2;
        state.scrollPositions[rowKey] = Math.max(0, state.scrollPositions[rowKey] - step);
        trackRow.style.transform = `translateX(-${state.scrollPositions[rowKey]}px)`;
        updateButtonStates();
      };

      nextBtn.onclick = (e) => {
        e.preventDefault();
        const step = getCardWidth() * 2;
        const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
        state.scrollPositions[rowKey] = Math.min(maxScroll, state.scrollPositions[rowKey] + step);
        trackRow.style.transform = `translateX(-${state.scrollPositions[rowKey]}px)`;
        updateButtonStates();
      };

      const wrapper = prevBtn.parentElement;

      wrapper.onmouseenter = () => {
        showPrevBtn = true;
        showNextBtn = true;
        updateProximityVisibility();
      };

      wrapper.onmouseleave = () => {
        showPrevBtn = false;
        showNextBtn = false;
        updateProximityVisibility();
      };

      function updateProximityVisibility() {
        prevBtn.classList.toggle('visible', showPrevBtn);
        nextBtn.classList.toggle('visible', showNextBtn);
        prevBtn.classList.toggle('prev-visible', showPrevBtn);
        nextBtn.classList.toggle('next-visible', showNextBtn);
      }

      function updateButtonStates() {
        const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
        const isAtStart = state.scrollPositions[rowKey] <= 0;
        const isAtEnd = state.scrollPositions[rowKey] >= maxScroll;

        if (maxScroll <= 0) {
          prevBtn.classList.add('hidden');
          nextBtn.classList.add('hidden');
        } else {
          prevBtn.classList.toggle('hidden', isAtStart);
          nextBtn.classList.toggle('hidden', isAtEnd);
        }

        updateProximityVisibility();
      }

      trackRow.style.transition = 'transform 0.3s ease-out';
      trackRow.style.transform = `translateX(-${state.scrollPositions[rowKey]}px)`;

      updateButtonStates();
    }
  });
}

export function updateTrackRowScrollButtons() {
  const updateForContainer = (containerSelector, idPrefix) => {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    const wrappers = container.querySelectorAll('.track-row-wrapper');
    wrappers.forEach((wrapper, rowIndex) => {
      const prevBtn = wrapper.querySelector(`#${idPrefix}-prev-${rowIndex}`);
      const nextBtn = wrapper.querySelector(`#${idPrefix}-next-${rowIndex}`);
      const rowContainer = wrapper.querySelector('.track-row-container');
      const trackRow = wrapper.querySelector('.track-row');

      if (!prevBtn || !nextBtn || !rowContainer || !trackRow) return;
      if (!prevBtn.isConnected || !nextBtn.isConnected) return;

      const rowKey = `${idPrefix}-${rowIndex}`;
      if (!(rowKey in state.scrollPositions)) {
        state.scrollPositions[rowKey] = 0;
        trackRow.style.transform = 'translateX(0)';
      }

      const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
      
      if (state.scrollPositions[rowKey] > maxScroll) {
        state.scrollPositions[rowKey] = maxScroll;
        trackRow.style.transform = `translateX(-${maxScroll}px)`;
      }

      const isAtStart = state.scrollPositions[rowKey] <= 0;
      const isAtEnd = state.scrollPositions[rowKey] >= maxScroll;

      prevBtn.classList.remove('hidden', 'visible', 'prev-visible', 'next-visible');
      nextBtn.classList.remove('hidden', 'visible', 'prev-visible', 'next-visible');

      if (maxScroll <= 0) {
        prevBtn.classList.add('hidden');
        nextBtn.classList.add('hidden');
      } else {
        if (isAtStart) {
          prevBtn.classList.add('hidden');
        } else {
          prevBtn.classList.add('visible', 'prev-visible');
        }
        if (isAtEnd) {
          nextBtn.classList.add('hidden');
        } else {
          nextBtn.classList.add('visible', 'next-visible');
        }
      }
    });
  };

  updateForContainer('#most-played-grid', 'most-played-row');
  updateForContainer('#uploads-grid', 'uploads-row');
  updateForContainer('#tracks-grid', 'track-row');
}

export function updateAllScrollButtonStates() {
  updateTrackRowScrollButtons();
}

export function buildPlaylistCover(tracks, playlist) {
  buildPlaylistCoverUtil(tracks, playlist);
}

export async function openPlaylist(playlistId) {
  const { api } = await import('./api.js');
  state.currentPlaylistId = playlistId;
  try {
    var pl = await api("/playlists/" + playlistId);
    var tracks = await api("/playlists/" + playlistId + "/tracks");

    var ownerName = pl.user ? pl.user.name : 'User';

    document.getElementById('playlist-name').textContent = pl.name;
    document.getElementById('playlist-type').textContent = Boolean(pl.is_public) ? 'Public Playlist' : 'Private Playlist';
    document.getElementById('playlist-meta').innerHTML =
      '<div class="playlist-meta-avatar"></div>' +
      ownerName + ' • ' + formatTotalDuration(tracks);

    buildPlaylistCover(tracks, pl);

    if (pl.shuffle) {
      document.getElementById('playlist-shuffle-btn').classList.add('active');
    } else {
      document.getElementById('playlist-shuffle-btn').classList.remove('active');
    }

    window.currentPlaylistData = pl;
    const isOwner = state.currentUser && pl.user && pl.user.auth_hash === state.authHash;
    const isPublic = Boolean(pl.is_public);
    const isLiked = Boolean(pl.is_liked);
    updatePlaylistMenu(isPublic, isOwner, isLiked);

    if (pl && pl.is_liked) {
      document.getElementById('playlist-gradient').style.background =
        'linear-gradient(180deg, #4a1a6b 0%, #121212 100%)';
    } else {
      const coverPath = "/playlists/" + pl.id + "/cover?v=" + Date.now();
      fetch(withBase(coverPath), { headers: { 'x-auth-hash': state.authHash } })
        .then(res => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.blob();
        })
        .then(blob => {
          const objectUrl = URL.createObjectURL(blob);
          extractVibrantColors(objectUrl).then(colors => {
            if (state.currentPlaylistId == pl.id) {
              document.getElementById('playlist-gradient').style.background =
                `linear-gradient(180deg, ${colors[0]} 0%, ${colors[1]} 50%, #121212 100%)`;
            }
            URL.revokeObjectURL(objectUrl);
          });
        })
        .catch(err => {
          if (state.currentPlaylistId == pl.id) {
            document.getElementById('playlist-gradient').style.background =
              'linear-gradient(180deg, #282828 0%, #121212 100%)';
          }
        });
    }

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
        var duration = formatDuration(track.duration);

        var artworkUrl = (track.album && track.album.artwork_path) ?
          withBase('/tracks/' + track.id + '/artwork?v=' + (track.updated_at || '')) : '';

        row.innerHTML =
          '<span class="ps-row-num">' + (i + 1) + '</span>' +
          '<span class="ps-row-art">' + (artworkUrl ? '<img src="' + artworkUrl + '" alt="">' : '') + '</span>' +
          '<span class="ps-row-title">' +
          '<span class="ps-row-title-song">' + (track.title || '') + '</span>' +
          '<span class="ps-row-title-artist">' + artistName + '</span>' +
          '</span>' +
          '<span class="ps-row-duration">' + duration + '</span>';

        row.addEventListener('click', function() {
          setQueueFromList(tracks.map(function(t) { return t.track; }), i);
          setCurrentPlayingPlaylistId(state.currentPlaylistId);

          var playlistShuffle = document.getElementById('playlist-shuffle-btn').classList.contains('active');
          if (state.shuffle !== playlistShuffle) {
            state.shuffle = playlistShuffle;
            document.getElementById("btn-shuffle").classList.toggle("active", state.shuffle);
            if (state.shuffle) {
              const { shuffleQueueOnce } = require('./audio-player.js');
              shuffleQueueOnce();
            } else {
              const { unshuffleQueue } = require('./audio-player.js');
              unshuffleQueue();
            }
            scheduleQueueSave();
            savePlayerState();
          }

          if (window.updateLibraryPlayingState) window.updateLibraryPlayingState();
          if (state.currentQueue.length) playTrack(state.currentQueue[state.currentIndex]);
        });

        container.appendChild(row);
      });
    }

    window.currentPlaylistTracks = tracks;

    const playlistPlayBtn = document.getElementById("playlist-play-btn");
    if (state.currentPlayingPlaylistId === playlistId && !audioPlayer.paused) {
      playlistPlayBtn.classList.add('playing');
    } else {
      playlistPlayBtn.classList.remove('playing');
    }

    setActivePage("playlist");
  } catch (err) { console.error(err); }
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return "00:00";
  var mins = Math.floor(seconds / 60);
  var secs = Math.round(seconds % 60).toString().padStart(2, "0");
  if (secs === "60") {
    secs = "00";
    mins += 1;
  }
  return mins + ":" + secs;
}

import { extractVibrantColors } from './utils.js';
import { shuffleQueueOnce, unshuffleQueue, scheduleQueueSave } from './audio-player.js';
import { savePlayerState } from './api.js';
import { audioPlayer } from './audio-player.js';

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

export function renderLibrary() {
  const libBox = document.getElementById("lib-box");
  if (!libBox) return;
  
  libBox.innerHTML = "";
  state.userPlaylists.sort(function(a, b) {
    if (a.is_liked && !b.is_liked) return -1;
    if (!a.is_liked && b.is_liked) return 1;
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  
  state.userPlaylists.forEach(function(pl) {
    var item = document.createElement("div");
    item.className = "lib-item";
    item.setAttribute("data-playlist-id", pl.id);
    var bg = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";

    var cover = document.createElement("div");
    cover.className = "lib-item-cover";

    if (pl.is_liked) {
      cover.style.background = "linear-gradient(135deg,#450af5,#c4efd9)";
      cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
    } else {
      cover.style.background = "transparent";
      var img = document.createElement("img");
      img.alt = escapeHtml(pl.name || "Playlist");
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.onerror = function() {
        img.style.display = "none";
        cover.style.background = "#282828";
        cover.appendChild(createPlaylistIconSvg());
      };
      cover.appendChild(img);
      setAuthenticatedImage(
        img,
        "/playlists/" + pl.id + "/cover?v=" + Date.now(),
        function() {
          img.style.display = "none";
          cover.style.background = "#282828";
          cover.appendChild(createPlaylistIconSvg());
        }
      );
    }

    var info = document.createElement("div");
    info.className = "lib-item-info";

    var nameEl = document.createElement("p");
    nameEl.className = "lib-item-name";
    nameEl.appendChild(document.createTextNode(pl.name || ""));

    var typeEl = document.createElement("p");
    typeEl.className = "lib-item-type";
    if (pl.pinned) {
      var pinSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      pinSvg.setAttribute("class", "library-pin-icon");
      pinSvg.setAttribute("viewBox", "0 0 16 16");
      pinSvg.setAttribute("width", "14");
      pinSvg.setAttribute("height", "14");
      pinSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      pinSvg.setAttribute("fill", "#1ed760");
      pinSvg.setAttribute("aria-hidden", "true");
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M11.609 1.858a1.22 1.22 0 0 0-1.727 0L5.92 5.82l-2.867.768 6.359 6.359.768-2.867 3.962-3.963a1.22 1.22 0 0 0 0-1.726zM8.822 .797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
      pinSvg.appendChild(path);
      typeEl.appendChild(pinSvg);
      typeEl.appendChild(document.createTextNode(" "));
    }
    typeEl.appendChild(document.createTextNode("Playlist"));

    info.appendChild(nameEl);
    info.appendChild(typeEl);

    item.appendChild(cover);
    item.appendChild(info);
    item.addEventListener("click", function() { openPlaylist(pl.id); });
    item.addEventListener("contextmenu", function(e) {
      e.preventDefault();
      if (window.showContextMenu) window.showContextMenu(e, pl);
    });
    libBox.appendChild(item);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export async function loadPlaylists() {
  const { loadPlaylists: loadPlaylistsApi } = await import('./api.js');
  state.userPlaylists = await loadPlaylistsApi();
  const { updateRegularPlaylistTrackCache } = await import('./api.js');
  await updateRegularPlaylistTrackCache();
  renderLibrary();
}

export async function populateProfilePage() {
  if (!state.currentUser) return;
  
  const profilePageUsername = document.getElementById("profile-page-username");
  const profilePageAuthHash = document.getElementById("profile-page-auth-hash");
  const profilePageMemberSince = document.getElementById("profile-page-member-since");
  const profileLikedCount = document.getElementById("profile-liked-count");
  const profileUploadsCount = document.getElementById("profile-uploads-count");
  const profilePlaylistsCount = document.getElementById("profile-playlists-count");
  
  if (profilePageUsername) profilePageUsername.textContent = state.currentUser.name || "N/A";
  if (profilePageAuthHash) profilePageAuthHash.textContent = state.authHash || "N/A";
  
  const createdAt = state.currentUser.created_at || "N/A";
  if (createdAt !== "N/A" && profilePageMemberSince) {
    try {
      const date = new Date(createdAt);
      profilePageMemberSince.textContent = date.toISOString().split('T')[0];
    } catch (e) {
      profilePageMemberSince.textContent = createdAt;
    }
  } else if (profilePageMemberSince) {
    profilePageMemberSince.textContent = "N/A";
  }

  const regularPlaylists = state.userPlaylists.filter(pl => !pl.is_liked);
  if (profilePlaylistsCount) profilePlaylistsCount.textContent = regularPlaylists.length;

  // Get liked songs count
  const likedPlaylist = state.userPlaylists.find(pl => pl.is_liked);
  if (likedPlaylist) {
    try {
      const likedTracks = await api("/playlists/" + likedPlaylist.id + "/tracks");
      if (profileLikedCount) profileLikedCount.textContent = likedTracks.length || 0;
    } catch (e) {
      if (profileLikedCount) profileLikedCount.textContent = "0";
    }
  } else {
    if (profileLikedCount) profileLikedCount.textContent = "0";
  }

  // Get uploads count from library tracks
  try {
    const libraryTracks = await api("/tracks");
    const userTracks = libraryTracks.filter(t => t.user_hash === state.authHash);
    if (profileUploadsCount) profileUploadsCount.textContent = userTracks.length || 0;
  } catch (e) {
    if (profileUploadsCount) profileUploadsCount.textContent = "0";
  }
}

export function renderSearchDropdown(results) {
  const searchDropdown = document.getElementById("search-dropdown");
  if (!searchDropdown) return;
  
  const items = Array.isArray(results) ? results : [];
  searchDropdown.innerHTML = "";
  searchDropdown.style.display = "block";

  const inner = document.createElement("div");
  inner.className = "search-dropdown-inner";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-dropdown-empty";
    empty.textContent = "No results.";
    inner.appendChild(empty);
    searchDropdown.appendChild(inner);
    return;
  }

  items.forEach(function(track, index) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-result";

    const artistText = getArtistDisplay(track) || "Unknown";
    const seed = ((track.title || "") + " " + artistText).trim() || "Openfy";

    const art = document.createElement("div");
    art.className = "search-result-art";
    art.style.setProperty("--sr-color", seededColor(seed));

    const img = document.createElement("img");
    img.alt = (track.title || "Track") + " artwork";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
    img.onerror = function() { img.remove(); };
    art.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "search-result-meta";

    const titleEl = document.createElement("div");
    titleEl.className = "search-result-title";
    titleEl.textContent = track.title || "";

    const artistEl = document.createElement("div");
    artistEl.className = "search-result-artist";
    artistEl.textContent = artistText;

    meta.appendChild(titleEl);
    meta.appendChild(artistEl);

    btn.appendChild(art);
    btn.appendChild(meta);

    btn.addEventListener("click", function(ev) {
      ev.preventDefault();
      setQueueFromList(items, index);
      if (state.currentQueue.length) playTrack(state.currentQueue[state.currentIndex]);
      hideSearchDropdown();
      document.getElementById("search-input").blur();
    });

    inner.appendChild(btn);
  });

  searchDropdown.appendChild(inner);
}

export function hideSearchDropdown() {
  const searchDropdown = document.getElementById("search-dropdown");
  if (!searchDropdown) return;
  searchDropdown.style.display = "none";
  searchDropdown.innerHTML = "";
}