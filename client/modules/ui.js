import { state, withBase } from './state.js';
import { api, setAuthenticatedImage, loadTracks as apiLoadTracks, loadUserUploads as apiLoadUserUploads, loadMostPlayed as apiLoadMostPlayed, refreshManualUploadSetting, getArtist, runSearch, runSpotifySearch, followAlbum } from './api.js';
import { getArtistDisplay, formatTotalDuration, createPlaylistIconSvg, createAlbumIconSvg, buildPlaylistCover as buildPlaylistCoverUtil, drawCanvas, seededColor } from './utils.js';
import { addRecentSearch, loadRecentSearches, removeRecentSearch } from './recent-searches.js';
import { playTrack, setQueueFromList, loadTrackPaused, renderNowPlayingQueue, setCurrentPlayingPlaylistId, getCurrentTrackId, getCurrentIndex, getCurrentPlayingPlaylistId } from './audio-player.js';
import { getGradientManager } from './gradient-manager.js';
import { saveScrollPositions, restoreScrollPositions } from './scroll-manager.js';

let renderLibraryId = 0;

// Navigation history stack for back button
let navigationHistory = [];
let currentHistoryIndex = -1;

export const pages = {
  home: null,
  library: null,
  playlist: null,
  admin: null,
  settings: null,
  profile: null,
  artist: null,
  search: null,

  init() {
    this.home = document.getElementById("page-home");
    this.library = document.getElementById("page-library");
    this.playlist = document.getElementById("page-playlist");
    this.admin = document.getElementById("page-admin");
    this.settings = document.getElementById("page-settings");
    this.profile = document.getElementById("page-profile");
    this.artist = document.getElementById("page-artist");
    this.search = document.getElementById("page-search");
  },
  
  get(key) {
    return this[key];
  }
};

// Click handler for artist name navigation
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('clickable-artist')) {
    const artistId = e.target.dataset.artistId;
    if (artistId) {
      setUrl('/artist/' + artistId);
      setActivePage('artist');
    }
  }
});

export function setUrl(path) {
  const baseUrl = window.location.origin + window.location.pathname;
  if (window.location.pathname !== path) {
    history.pushState(null, '', path);
  }
}

function getCurrentPath() {
  return window.location.pathname;
}

function getPathForPage(pageId) {
  if (pageId === 'home') return '/';
  if (pageId === 'library') return '/library';
  if (pageId === 'settings') return '/settings';
  if (pageId === 'profile') return '/profile';
  if (pageId === 'admin') return '/admin';
  if (pageId === 'playlist' && state.currentPlaylistId) {
    const type = (window.currentPlaylistData && window.currentPlaylistData.type === 'album') ? 'album' : 'playlist';
    return '/' + type + '/' + state.currentPlaylistId;
  }
  if (pageId === 'artist' && state.currentArtistId) {
    return '/artist/' + state.currentArtistId;
  }
  return '/';
}

function updateBackButton() {
  const backBtn = document.getElementById('top-bar-back');
  if (!backBtn) return;
  
  const shouldShow = currentHistoryIndex > 0;
  backBtn.style.display = shouldShow ? 'flex' : 'none';
}

export function goBack() {
  if (currentHistoryIndex <= 0) return;
  
  currentHistoryIndex--;
  const previousPath = navigationHistory[currentHistoryIndex];
  
  // Update URL without adding to history
  history.replaceState(null, '', previousPath);
  
  // Navigate to the previous page
  navigateFromUrl();
}

export function setActivePage(pageId, updateUrl = true, isBackNavigation = false) {
  // Check for /artist/ route in URL - only on initial load, not when explicitly navigating away
  const pathname = window.location.pathname;
  const explicitPages = ['home', 'library', 'playlist', 'profile', 'admin', 'settings'];
  if (pathname.startsWith("/artist/") && pageId === "artist") {
    const artistId = pathname.split("/artist/")[1];
    if (artistId) {
      state.currentArtistId = artistId;
    }
  }

  // Determine currently active page EXACTLY before switching pageId
  const currentActivePage = document.querySelector('.page.active');
  const isLeavingPlaylist = currentActivePage && currentActivePage.id === 'page-playlist';
  const isLeavingArtist = currentActivePage && currentActivePage.id === 'page-artist';

  // Track navigation history (skip for back button navigations)
  if (!isBackNavigation) {
    const currentPath = getCurrentPath();
    const newPath = getPathForPage(pageId);
    
    // Remove any forward history if we're navigating to a new page
    if (currentHistoryIndex < navigationHistory.length - 1) {
      navigationHistory = navigationHistory.slice(0, currentHistoryIndex + 1);
    }
    
    // Only add to history if path is different
    if (currentPath && currentPath !== newPath) {
      navigationHistory.push(newPath);
      currentHistoryIndex = navigationHistory.length - 1;
    }
  }

  // Update back button visibility
  updateBackButton();

  // Only save scroll if leaving a non-playlist page (playlist scroll never persists to global)
  // Also skip saving for artist page (scroll should reset on both artist and home)
  if (!isLeavingPlaylist && !isLeavingArtist) {
    saveScrollPositions();
  }

  ['home', 'library', 'playlist', 'admin', 'settings', 'profile', 'artist', 'search'].forEach(function(key) {
    var p = pages[key];
    if (p && p.classList) p.classList.remove("active");
  });
  var target = pages[pageId] || pages.home;
  if (target && target.classList) {
    target.classList.add("active");
  }
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
  if (pageId === "artist") {
    // Get artist ID from state (set during URL parsing) or URL params
    var artistId = state.currentArtistId;
    if (!artistId) {
      const urlParams = new URLSearchParams(window.location.search);
      artistId = urlParams.get("id");
    }
    if (artistId) {
      loadArtistPage(artistId);
    }
    var p = pages.artist;
  }
  
  document.getElementById('app-main').classList.toggle('home-page', pageId === 'home');
  document.getElementById('app-main').classList.toggle('playlist-page', pageId === 'playlist' || pageId === 'artist');

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
      const type = (window.currentPlaylistData && window.currentPlaylistData.type === 'album') ? 'album' : 'playlist';
      setUrl('/' + type + '/' + state.currentPlaylistId);
    } else if (pageId === 'artist' && state.currentArtistId) {
      setUrl('/artist/' + state.currentArtistId);
    }
  }

  // Always dispatch pageNavigated event (not just when gradient manager exists)
  const event = new CustomEvent('pageNavigated', {
    detail: { pageId }
  });
  document.dispatchEvent(event);

  // Restore scroll after DOM updates — ensures content is rendered before applying scroll
  requestAnimationFrame(() => {
    restoreScrollPositions();
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
  } else if (path.startsWith('/playlist/') || path.startsWith('/album/')) {
    const isAlbum = path.startsWith('/album/');
    const playlistId = path.split(isAlbum ? '/album/' : '/playlist/')[1];
    if (playlistId) {
      openPlaylistById(playlistId, isAlbum);
    } else {
      setActivePage('home');
    }
  } else if (path.startsWith('/artist/')) {
    const artistId = path.split('/artist/')[1];
    if (artistId) {
      state.currentArtistId = artistId;
      setActivePage('artist');
    } else {
      setActivePage('home');
    }
  } else {
    setActivePage('home');
  }
}

export async function openPlaylistById(playlistId, isAlbum = false) {
  state.currentPlaylistId = playlistId;
  try {
    // Just call openPlaylist with the correct isAlbum parameter
    // openPlaylist will handle fetching the data
    await openPlaylist(playlistId, isAlbum);
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

export async function loadArtistPage(artistId) {
    // Scroll to top when visiting artist page
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        mainContent.scrollTop = 0;
    }

    // Clear current artist data before loading new artist
    const artistImageEl = document.getElementById("artist-image");
    const artistMosaicEl = document.getElementById("artist-mosaic");
    const artistGradient = document.getElementById("artist-gradient");
    if (artistImageEl) {
        artistImageEl.src = "";
        artistImageEl.style.display = "none";
    }
    if (artistMosaicEl) {
        artistMosaicEl.innerHTML = "";
        artistMosaicEl.style.display = "none";
    }
    if (artistGradient) {
        artistGradient.style.background = "linear-gradient(180deg, #282828 0%, #121212 100%)";
    }
    const songsList = document.getElementById("artist-songs-list");
    if (songsList) {
        songsList.innerHTML = "";
    }
    const albumsGrid = document.getElementById("artist-albums-grid");
    if (albumsGrid) {
        albumsGrid.innerHTML = "";
    }

    try {
        const artist = await getArtist(artistId);
        if (!artist) {
            console.error("Artist not found");
            return;
        }

        document.getElementById("artist-name").textContent = artist.name;
        const artistFollowBtn = document.getElementById("artist-follow-btn");
        if (artistFollowBtn) {
            const followedArtist = state.userPlaylists.find(function(item) {
                return item.type === "artist" && item.id === artist.id && item.is_followed;
            });
            artistFollowBtn.dataset.followed = followedArtist ? "1" : "0";
            if (followedArtist) {
                artistFollowBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #000; font-size: 14px; display: flex; align-items: center; justify-content: center;"></i>';
                artistFollowBtn.style.cssText = 'padding: 8px !important; width: 28px !important; height: 28px !important; min-width: 24px !important; min-height: 24px !important; background: #1db954 !important; border: none !important; border-radius: 50% !important; display: flex !important; align-items: center !important; justify-content: center !important;';
                artistFollowBtn.title = 'Unfollow artist';
            } else {
                artistFollowBtn.innerHTML = '<i class="fa-solid fa-plus" style="color: #b3b3b3; font-size: 20px; display: flex; align-items: center; justify-content: center;"></i>';
                artistFollowBtn.style.cssText = 'padding: 8px !important; width: 28px !important; height: 28px !important; min-width: 24px !important; min-height: 24px !important; background: none !important; border: none !important; display: flex !important; align-items: center !important; justify-content: center !important;';
                artistFollowBtn.title = 'Follow artist';
            }
        }

        // Update meta (track count)
        const trackCount = artist.tracks?.length || 0;
        document.getElementById("artist-meta").textContent = `${trackCount} track${trackCount !== 1 ? "s" : ""}`;

        // Show artist image if available
        const artistImageEl = document.getElementById("artist-image");
        const artistMosaicEl = document.getElementById("artist-mosaic");
        if (artist.image_url) {
            artistImageEl.src = artist.image_url;
            artistImageEl.style.display = "block";
            artistMosaicEl.style.display = "none";

            // Extract colors from artist image for gradient
            fetch(artist.image_url)
                .then(res => {
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    return res.blob();
                })
                .then(blob => {
                    const objectUrl = URL.createObjectURL(blob);
                    extractVibrantColors(objectUrl).then(colors => {
                        document.getElementById('artist-gradient').style.background =
                            `linear-gradient(180deg, ${colors[0]} 0%, ${colors[1]} 50%, #121212 100%)`;
                        URL.revokeObjectURL(objectUrl);
                    });
                })
                .catch(() => {
                    document.getElementById('artist-gradient').style.background =
                        'linear-gradient(180deg, #282828 0%, #121212 100%)';
                });
        } else {
            artistImageEl.style.display = "none";
            artistMosaicEl.style.display = "grid";

            // Trigger background refresh if missing image
            api("/artists/" + artistId + "/refresh-image").catch(() => {});
            
            // Also refresh album images in background
            api("/artists/" + artistId + "/refresh-albums").catch(() => {});

            // Show default gradient for artist page
            document.getElementById('artist-gradient').style.background =
                'linear-gradient(180deg, #442c68 0%, #121212 100%)';

            // Set gradient from track artwork only when no artist image
            if (artist.tracks && artist.tracks.length > 0) {
                // Build fallback mosaic from tracks
                const tracksForMosaic = artist.tracks.slice(0, 4);
                artistMosaicEl.innerHTML = '';
                tracksForMosaic.forEach(t => {
                    if (t.album && t.album.artwork_path) {
                        const item = document.createElement('div');
                        item.className = 'playlist-mosaic-item';
                        const img = document.createElement('img');
                        img.src = withBase('/tracks/' + t.id + '/artwork?v=' + (t.updated_at || ''));
                        item.appendChild(img);
                        artistMosaicEl.appendChild(item);
                    }
                });

                if (artist.tracks[0].album && artist.tracks[0].album.artwork_path) {
                    const artworkUrl = '/tracks/' + artist.tracks[0].id + '/artwork?v=' + (artist.tracks[0].updated_at || '');
                    fetch(withBase(artworkUrl), { headers: { 'x-auth-hash': state.authHash } })
                        .then(res => {
                            if (!res.ok) throw new Error("HTTP " + res.status);
                            return res.blob();
                        })
                        .then(blob => {
                            const objectUrl = URL.createObjectURL(blob);
                            extractVibrantColors(objectUrl).then(colors => {
                                document.getElementById('artist-gradient').style.background =
                                    `linear-gradient(180deg, ${colors[0]} 0%, ${colors[1]} 50%, #121212 100%)`;
                                URL.revokeObjectURL(objectUrl);
                            });
                        })
                        .catch(() => {
                            document.getElementById('artist-gradient').style.background =
                                'linear-gradient(180deg, #282828 0%, #121212 100%)';
                        });
                }
            }
        }

        // Render tracks in playlist-songs-list - simplified for artist
        const songsList = document.getElementById("artist-songs-list");
        songsList.innerHTML = "";

        // Add "Popular" header
        var headerRow = document.createElement('div');
        headerRow.className = 'artist-songs-header';
        headerRow.innerHTML = '<span class="ash-title">Popular</span>';
        songsList.appendChild(headerRow);

        if (artist.tracks && artist.tracks.length > 0) {
            // Sort tracks by play count descending
            var sortedTracks = [...artist.tracks].sort((a, b) => (b.play_count || 0) - (a.play_count || 0));

            // Check if already expanded (persist state)
            let isExpanded = songsList.classList.contains('artist-tracks-expanded');

            // Render all tracks (up to 10), hiding tracks 6-10 initially
            const maxTracks = Math.min(sortedTracks.length, 10);
            for (let index = 0; index < maxTracks; index++) {
                const track = sortedTracks[index];
                var row = document.createElement('div');
                row.className = 'artist-song-row' + (index >= 5 && !isExpanded ? ' artist-track-hidden' : '');
                var duration = track.duration ? formatDuration(track.duration) : '';
                var plays = track.play_count !== undefined ? track.play_count : 0;
                var artworkUrl = '';
                if (track.album) {
                    if (track.album.artwork_path) {
                        artworkUrl = withBase('/tracks/' + track.id + '/artwork?v=' + (track.updated_at || ''));
                    } else if (track.album.image_url) {
                        artworkUrl = track.album.image_url;
                    }
                }
                row.innerHTML =
                    '<span class="ps-row-num">' + (index + 1) + '</span>' +
                    '<span class="ps-row-art">' + (artworkUrl ? '<img src="' + artworkUrl + '" alt="">' : '') + '</span>' +
                    '<span class="ps-row-title">' +
                    '<span class="ps-row-title-song">' + escapeHtml(track.title || '') + '</span>' +
                    '</span>' +
                    '<span class="ps-row-plays">' + plays + '</span>' +
                    '<span class="ps-row-duration">' + duration + '</span>';
                row.addEventListener('click', function() {
                    // Don't do anything if clicking the currently playing track
                    if (state.currentTrackId === track.id) return;
                    setQueueFromList(sortedTracks, index);
                    if (state.currentQueue.length) playTrack(state.currentQueue[state.currentIndex]);
                });
                row.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    if (window.showTrackContextMenu) window.showTrackContextMenu(e, track);
                });
                songsList.appendChild(row);
            }

            // Show more/Show less button if more than 5 tracks
            if (sortedTracks.length > 5) {
                var showMoreBtn = document.createElement('div');
                showMoreBtn.className = 'artist-show-more';
                showMoreBtn.textContent = isExpanded ? 'Show less' : 'Show more';
                showMoreBtn.addEventListener('click', function() {
                    isExpanded = !isExpanded;
                    songsList.classList.toggle('artist-tracks-expanded', isExpanded);
                    // Toggle visibility of tracks 6-10
                    const rows = songsList.querySelectorAll('.artist-song-row');
                    rows.forEach((row, idx) => {
                        if (idx >= 5) {
                            row.classList.toggle('artist-track-hidden', !isExpanded);
                        }
                    });
                    // Update button text
                    showMoreBtn.textContent = isExpanded ? 'Show less' : 'Show more';
                });
                songsList.appendChild(showMoreBtn);
            }
        }

        // Render Albums
        const albumsSection = document.getElementById("artist-albums-section");
        const albumsGrid = document.getElementById("artist-albums-grid");
        if (albumsSection && albumsGrid) {
            albumsGrid.innerHTML = "";
            if (artist.albums && artist.albums.length > 0) {
                albumsSection.style.display = "block";
                artist.albums.forEach(album => {
                    const card = buildAlbumCard(album);
                    albumsGrid.appendChild(card);
                });
            } else {
                albumsSection.style.display = "none";
            }
        }

        // Mark as loaded to fade in content
        document.getElementById("page-artist").classList.add("loaded");
    } catch (error) {
        console.error("Failed to load artist:", error);
    }
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
  // Handle multiple artists - create clickable spans for each
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
    info.innerHTML = artistNames.map(function(name, i) {
      var id = artistIds[i] || '';
      return '<span class="clickable-artist"' + (id ? ' data-artist-id="' + id + '"' : '') + '>' + escapeHtml(name || '') + '</span>';
    }).join(', ');
  } else {
    info.textContent = "Unknown";
  }
  card.appendChild(title);
  card.appendChild(info);

  card.addEventListener("click", function(e) {
    // Don't do anything if clicking the currently playing track
    if (e.target.classList.contains('clickable-artist')) return;
    if (state.currentTrackId === track.id) return;

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

export function buildAlbumCard(album) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.flex = "0 0 180px";

    const artContainer = document.createElement("div");
    artContainer.className = "artwork-container";

    // Handle both Album model objects and Playlist objects (type="album")
    const isPlaylist = album.type === "album";
    const albumTitle = album.title || album.name || "Unknown Album";
    const artistName = album.artist ? album.artist.name : "Unknown Artist";

    const art = createArtCanvas(albumTitle, artistName);
    const img = document.createElement("img");
    img.className = "card-img";

    // Set artwork URL based on object type
    if (isPlaylist) {
        // Playlist object (type="album") - use image_url or playlist artwork endpoint
        img.src = album.image_url ? withBase(album.image_url) : withBase("/playlists/" + album.id + "/artwork?v=" + (album.created_at || ""));
    } else {
        // Album model object - use created_at for cache busting
        img.src = withBase("/albums/" + album.id + "/artwork?v=" + (album.created_at || Date.now()));
    }
    img.alt = albumTitle;
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
 
    const titleEl = document.createElement("p");
    titleEl.className = "card-title";
    titleEl.textContent = albumTitle;
 
    const info = document.createElement("p");
    info.className = "card-info clickable-artist";
    info.textContent = artistName;
    const artistId = album.artist_id || (album.artist && album.artist.id);
    if (artistId) {
        info.dataset.artistId = artistId;
    }
 
    card.appendChild(titleEl);
    card.appendChild(info);
 
    card.addEventListener("click", (e) => {
        if (e.target.classList.contains('clickable-artist') || e.target.closest('.card-follow-btn')) return;
        
        // Navigate based on object type
        const isPlaylist = album.type === "album";
        if (isPlaylist) {
            // Playlist object - navigate to /playlist/ or /album/ based on type
            history.pushState(null, '', '/album/' + album.id);
        } else {
            // Album model object
            history.pushState(null, '', '/album/' + album.id);
        }
        
        if (window.navigateFromUrl) {
            window.navigateFromUrl();
        } else {
            // Fallback if not exposed globally
            import('./ui.js').then(ui => {
                if (ui.openPlaylistById) {
                    ui.openPlaylistById(album.id, true);
                }
            });
        }
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
        }
        if (isAtEnd) {
          nextBtn.classList.add('hidden');
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
  var mosaic = document.getElementById('playlist-mosaic');
  if (!mosaic) return;
  mosaic.innerHTML = '';

  // For albums, use the album's image_url if available
  if (playlist && playlist.type === 'album' && playlist.image_url) {
    var wrapper = document.createElement('div');
    wrapper.className = 'playlist-mosaic-item';
    wrapper.style.gridColumn = '1 / -1';
    wrapper.style.gridRow = '1 / -1';

    var coverImg = document.createElement('img');
    coverImg.style.width = '100%';
    coverImg.style.height = '100%';
    coverImg.style.objectFit = 'cover';
    coverImg.src = withBase(playlist.image_url);
    coverImg.onerror = function() {
      buildPlaylistCoverUtil(tracks, playlist);
    };
    wrapper.appendChild(coverImg);
    mosaic.appendChild(wrapper);
    return;
  }

  buildPlaylistCoverUtil(tracks, playlist);
}

export async function openPlaylist(playlistId, isAlbum = false) {
  const { api } = await import('./api.js');
  state.currentPlaylistId = playlistId;
  try {
    const endpoint = isAlbum ? "/albums/" + playlistId : "/playlists/" + playlistId;
    var pl = await api(endpoint);

    // Check if access is denied (private playlist for non-owner)
    if (pl.access_denied) {
      // Show blurred UI for private playlist
      document.getElementById('playlist-name').textContent = pl.name;
      document.getElementById('playlist-name').classList.add('blurred-text');
      document.getElementById('playlist-type').textContent = 'Private Playlist';
      document.getElementById('playlist-type').classList.add('blurred-text');

      // Show blur overlay on playlist cover
      const mosaic = document.getElementById('playlist-mosaic');
      if (mosaic) {
        mosaic.classList.add('blurred-cover');
        // Add private overlay
        let overlay = mosaic.querySelector('.private-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'private-overlay';
          overlay.innerHTML = '<i class="fa-solid fa-lock"></i><span>Private Playlist</span>';
          mosaic.appendChild(overlay);
        }
        overlay.style.display = 'flex';
      }

      // Hide playlist actions and show full blur on songs container
      document.getElementById('playlist-actions').classList.add('hidden');
      const songsContainer = document.getElementById('playlist-songs-list');
      songsContainer.innerHTML = '';
      songsContainer.classList.add('blurred-songs');

      // Blur the songs header (table headers)
      const songsHeader = document.querySelector('.playlist-songs-header');
      if (songsHeader) songsHeader.classList.add('blurred-text');

      // Add full-cover blur overlay
      const blurOverlay = document.createElement('div');
      blurOverlay.className = 'private-playlist-full-blur';
      blurOverlay.innerHTML = '<i class="fa-solid fa-lock"></i><span>Private Playlist</span>';
      songsContainer.appendChild(blurOverlay);

      // Hide playlist meta (owner info)
      const playlistMeta = document.getElementById('playlist-meta');
      if (playlistMeta) playlistMeta.style.display = 'none';

      // Set playlist data but don't load tracks
      window.currentPlaylistData = pl;
      return;
    }

    var tracks = pl.tracks;
    if (!tracks) {
        tracks = await api("/playlists/" + playlistId + "/tracks");
    }
    
    // Normalize tracks format for albums (tracks are returned directly, not wrapped in {track: ...})
    if (pl.type === 'album' && tracks.length > 0 && !tracks[0].track) {
        tracks = tracks.map(function(track, index) {
            return { position: index, track: track };
        });
    }

    // Remove any blur classes if access is granted
    document.getElementById('playlist-name').classList.remove('blurred-text');
    document.getElementById('playlist-type').classList.remove('blurred-text');
    const songsHeader = document.querySelector('.playlist-songs-header');
    if (songsHeader) songsHeader.classList.remove('blurred-text');
    const mosaic = document.getElementById('playlist-mosaic');
    if (mosaic) {
      mosaic.classList.remove('blurred-cover');
      const overlay = mosaic.querySelector('.private-overlay');
      if (overlay) overlay.style.display = 'none';
    }
    document.getElementById('playlist-actions').classList.remove('hidden');
    const songsContainer = document.getElementById('playlist-songs-list');
    songsContainer.classList.remove('blurred-songs');
    const blurMessage = songsContainer.querySelector('.private-playlist-blur-message');
    if (blurMessage) blurMessage.remove();
    const fullBlur = songsContainer.querySelector('.private-playlist-full-blur');
    if (fullBlur) fullBlur.remove();

    // Show playlist meta
    const playlistMeta = document.getElementById('playlist-meta');
    if (playlistMeta) playlistMeta.style.display = '';

    var ownerName = pl.user ? pl.user.name : 'User';
    if (pl.type === 'album' && pl.owner_name) {
      ownerName = pl.owner_name;
    }
    var ownerAvatar = pl.user?.avatar_path;
    var ownerId = pl.user?.id;

    document.getElementById('playlist-name').textContent = pl.name;
    const isLiked = pl.is_liked === true;
    let typeText = pl.type === 'album' ? 'Album' : (Boolean(pl.is_public) ? 'Public Playlist' : 'Private Playlist');
    if (isLiked) typeText = 'Playlist';
    document.getElementById('playlist-type').textContent = typeText;

    let avatarHtml = '';
    if (pl.type === 'album') {
      let artist = tracks.length > 0 && tracks[0].track && tracks[0].track.artist;
      // Fallback to artists array if primary artist field is missing
      if (!artist && tracks.length > 0 && tracks[0].track && tracks[0].track.artists && tracks[0].track.artists.length > 0) {
        artist = tracks[0].track.artists[0];
      }

      if (artist && artist.image_url) {
        avatarHtml = `<img src="${artist.image_url}" class="playlist-owner-avatar album-artist-avatar" alt="${ownerName}">`;
      } else {
        avatarHtml = '<div class="playlist-meta-avatar"></div>';
        // Trigger background refresh if artist ID is known
        if (artist && artist.id) {
          api("/artists/" + artist.id + "/refresh-image").catch(() => {});
        }
      }
    } else if (ownerAvatar && ownerId) {
      avatarHtml = `<img src="${withBase('/users/' + ownerId + '/avatar?t=' + Date.now())}" class="playlist-owner-avatar" alt="${ownerName}">`;
    } else {
      avatarHtml = '<div class="playlist-meta-avatar"></div>';
    }

    const ownerNameHtml = (pl.type === 'album' && tracks.length > 0 && tracks[0].track && tracks[0].track.artist && tracks[0].track.artist.id)
      ? `<span class="playlist-owner-name clickable-artist album-meta-artist" data-artist-id="${tracks[0].track.artist.id}">${ownerName}</span>`
      : `<span class="playlist-owner-name">${ownerName}</span>`;

    const totalDuration = formatTotalDuration(tracks);
    document.getElementById('playlist-meta').innerHTML =
      avatarHtml +
      ownerNameHtml + (totalDuration ? ' • ' + totalDuration : '');

    buildPlaylistCover(tracks, pl);

    if (pl.shuffle) {
      document.getElementById('playlist-shuffle-btn').classList.add('active');
    } else {
      document.getElementById('playlist-shuffle-btn').classList.remove('active');
    }

    // Use is_owner from API response (more reliable)
    const isOwner = pl.is_owner === true;
    const isPublic = pl.is_public === true;
    const isFollowed = pl.is_followed === true;

    updatePlaylistMenu(isPublic, isOwner, isLiked, isFollowed);

    // Update follow button visibility
    window.currentPlaylistFollowed = isFollowed;
    window.currentPlaylistIsOwner = isOwner;
    const followBtn = document.getElementById('playlist-follow-btn');
    if (followBtn) {
      // Show follow button for public playlists where user is NOT owner and IS logged in
      // (either to follow, or to show the checkmark if already following)
      const isLoggedIn = !!state.currentUser;
      const isAlbum = pl.type === 'album';
      // Show follow button for public playlists user doesn't own, OR for any album
      const showFollow = (isPublic && !isLiked && !isOwner && isLoggedIn) || (isAlbum && isLoggedIn);
      if (showFollow) {
        followBtn.style.setProperty('display', 'flex', 'important');
        // Update icon based on follow state - keep both states with same dimensions
        const baseStyle = 'padding: 8px !important; width: auto !important; height: auto !important; min-width: 24px !important; min-height: 24px !important;';
        if (isFollowed) {
          // Show green circle with black checkmark
          followBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #000; font-size: 14px; display: flex; align-items: center; justify-content: center;"></i>';
          followBtn.style.cssText = baseStyle + ' background: #1db954 !important; border: none !important; border-radius: 50% !important; display: flex !important; align-items: center !important; justify-content: center !important; width: 28px !important; height: 28px !important;';
          followBtn.classList.add('followed');
          followBtn.title = 'Unfollow playlist';
        } else {
          // Show plus in circle (not following)
          followBtn.innerHTML = '<i class="fa-solid fa-plus" style="color: #b3b3b3; font-size: 20px; display: flex; align-items: center; justify-content: center;"></i>';
          followBtn.style.cssText = baseStyle + ' background: none !important; border: none !important; display: flex !important; align-items: center !important; justify-content: center !important; width: 28px !important; height: 28px !important;';
          followBtn.classList.remove('followed');
          followBtn.title = 'Follow playlist';
        }
      } else {
        followBtn.style.setProperty('display', 'none', 'important');
      }
    }

    // Store playlist data for follow button access
    window.currentPlaylistData = pl;

    if (pl && pl.is_liked) {
      document.getElementById('playlist-gradient').style.background =
        'linear-gradient(180deg, #4a1a6b 0%, #121212 100%)';
    } else {
      const coverPath = isAlbum ? "/albums/" + pl.id + "/artwork" : "/playlists/" + pl.id + "/cover";
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
          '<span class="ps-row-title-song">' + escapeHtml(track.title || '') + '</span>' +
          '<span class="ps-row-title-artist">' + escapeHtml(artistName) + '</span>' +
          '</span>' +
          '<span class="ps-row-duration">' + duration + '</span>';

        row.addEventListener('click', function() {
          // Don't do anything if clicking the currently playing track
          if (state.currentTrackId === track.id) return;

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

        // Right-click context menu
        row.addEventListener('contextmenu', function(e) {
          e.preventDefault();
          if (window.showTrackContextMenu) window.showTrackContextMenu(e, track);
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
    window.currentPlaylistData = pl;
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

function updatePlaylistMenu(isPublic, isOwner, isLiked, isFollowed) {
  const playlistMenuBtn = document.getElementById("playlist-menu-btn");
  const playlistVisibilityItem = document.getElementById("playlist-visibility-item");
  const playlistVisibilityIcon = document.getElementById("playlist-visibility-icon");
  const playlistVisibilityText = document.getElementById("playlist-visibility-text");

  if (playlistMenuBtn) {
    playlistMenuBtn.classList.remove("hidden");
  }

  const isAlbum = window.currentPlaylistData && window.currentPlaylistData.type === 'album';

  // Hide visibility toggle for Liked Songs, non-owners, followed playlists, or albums
  if (isLiked || !isOwner || isFollowed || isAlbum) {
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

  // Also hide Rename and Delete for albums
  const renameItem = document.getElementById("playlist-rename-item");
  const deleteItem = document.getElementById("playlist-delete-item");
  if (isAlbum) {
    if (renameItem) renameItem.style.display = "none";
    if (deleteItem) deleteItem.style.display = "none";
  } else {
    if (renameItem) renameItem.style.display = "flex";
    if (deleteItem) deleteItem.style.display = "flex";
  }
}

export function renderLibrary() {
  renderLibraryId++;
  const currentRenderId = renderLibraryId;

  const libBox = document.getElementById("lib-box");
  if (!libBox) return;

  libBox.innerHTML = "";
  function timestampForLibraryItem(item) {
    const primary = Date.parse(item.followed_at || "");
    if (!Number.isNaN(primary)) return primary;
    const fallback = Date.parse(item.created_at || "");
    if (!Number.isNaN(fallback)) return fallback;
    return 0;
  }
  function libraryTypeRank(item) {
    if (item.is_liked) return 0;
    if (item.type === 'playlist') return 1;
    if (item.type === 'album') return 2;
    if (item.type === 'artist') return 3;
    return 4;
  }
  state.userPlaylists.sort(function(a, b) {
    if (a.is_liked && !b.is_liked) return -1;
    if (!a.is_liked && b.is_liked) return 1;
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    const rankDiff = libraryTypeRank(a) - libraryTypeRank(b);
    if (rankDiff !== 0) return rankDiff;
    return timestampForLibraryItem(b) - timestampForLibraryItem(a);
  });
  
  state.userPlaylists.forEach(function(pl) {
    var item = document.createElement("div");
    item.className = "lib-item";
    item.setAttribute("data-playlist-id", pl.id);
    var bg = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";

    var cover = document.createElement("div");
    cover.className = "lib-item-cover";
    if (pl.type === 'artist') {
      cover.classList.add("lib-item-cover-artist");
    }

    if (pl.is_liked) {
      cover.style.background = "linear-gradient(135deg,#450af5,#c4efd9)";
      cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
    } else {
      // Default cover: solid gray background with music icon
      cover.style.background = "#3a3a3a";
      cover.style.display = "flex";
      cover.style.alignItems = "center";
      cover.style.justifyContent = "center";
      var icon;
      if (pl.type === 'album') {
        icon = createAlbumIconSvg();
      } else if (pl.type === 'artist') {
        icon = document.createElement("i");
        icon.className = "fa-solid fa-microphone-lines";
        icon.style.color = "#b3b3b3";
      } else {
        icon = createPlaylistIconSvg();
      }
      cover.appendChild(icon);

      // For albums, always try to load the artwork.
      // For playlists, only try if it has tracks (need 4+ for meaningful collage fallback)
      var trackCount = pl.track_count || 0;
      if (pl.type === 'album' || trackCount >= 1 || (pl.type === 'artist' && pl.image_url)) {
        // Try to load custom cover (collage from tracks)
        var img = document.createElement("img");
        img.alt = escapeHtml(pl.name || "Playlist");
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
        img.style.display = "none";
        img.style.position = "absolute";
        img.style.top = "0";
        img.style.left = "0";
        cover.style.position = "relative";
        img.onload = function() {
          if (renderLibraryId !== currentRenderId) return;
          img.style.display = "block";
          cover.style.background = "transparent";
          if (icon && icon.parentNode === cover) {
            cover.removeChild(icon);
          }
        };
        img.onerror = function() {
          if (renderLibraryId !== currentRenderId) return;
        };
        cover.appendChild(img);
        if (pl.type === 'artist') {
          img.src = pl.image_url;
        } else {
          setAuthenticatedImage(
            img,
            pl.type === 'album' ? "/albums/" + pl.id + "/artwork" : "/playlists/" + pl.id + "/cover",
            function() {
              if (renderLibraryId !== currentRenderId) return;
            }
          );
        }
      }
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
    // Priority labeling: Liked Songs -> Album -> Followed/Own Playlists
    if (pl.is_liked) {
      var trackCount = pl.track_count || 0;
      typeEl.appendChild(document.createTextNode("Playlist • " + trackCount + " song" + (trackCount !== 1 ? "s" : "")));
    } else if (pl.type === 'album') {
      typeEl.appendChild(document.createTextNode("Album" + (pl.owner_name ? " • " + pl.owner_name : "")));
    } else if (pl.type === 'artist') {
      typeEl.appendChild(document.createTextNode("Artist"));
    } else if (pl.is_followed) {
      typeEl.appendChild(document.createTextNode("Public Playlist"));
    } else {
      typeEl.appendChild(document.createTextNode("Playlist"));
    }

    info.appendChild(nameEl);
    info.appendChild(typeEl);

    item.appendChild(cover);
    item.appendChild(info);
    item.addEventListener("click", function() {
      if (pl.type === 'artist') {
        state.currentArtistId = pl.id;
        setUrl('/artist/' + pl.id);
        setActivePage('artist');
        return;
      }
      openPlaylist(pl.id, pl.type === 'album');
    });
    if (pl.type !== 'artist') {
      item.addEventListener("contextmenu", function(e) {
        e.preventDefault();
        if (window.showContextMenu) window.showContextMenu(e, pl);
      });
    }
    libBox.appendChild(item);
  });
}

export async function renderSearch(query) {
  // Show search page
  const searchPage = document.getElementById("page-search");
  const searchQueryDisplay = document.getElementById("search-query-display");
  const searchLocalResults = document.getElementById("search-local-results");
  const searchSpotifyResults = document.getElementById("search-spotify-results");

  if (!searchPage) {
    console.error("searchPage element not found!");
    return;
  }

  // Update header
  searchQueryDisplay.textContent = "Search Results";

  // Set active page immediately so user sees the search page
  setActivePage('search');

  // Show loading state
  searchLocalResults.innerHTML = '<p class="empty-message">Searching library...</p>';
  searchSpotifyResults.innerHTML = '<p class="empty-message">Searching Spotify...</p>';

  // Load real data
  let localResults = [];
  let spotifyResults = [];

  try {
    localResults = await runSearch(query).catch(() => []);
  } catch (e) {}

  try {
    spotifyResults = await runSpotifySearch(query, 20).catch(() => []);
  } catch (e) {}

  // Render local results
  if (localResults.length === 0) {
    searchLocalResults.innerHTML = '<p class="empty-message">No tracks found in your library</p>';
  } else {
    searchLocalResults.innerHTML = '';
    localResults.forEach((track, index) => {
      const card = buildTrackCard(track, localResults, index);
      card.style.flex = '0 0 auto';
      card.style.width = '180px';
      searchLocalResults.appendChild(card);
    });
  }

  // Render Spotify results
  if (spotifyResults.length === 0) {
    searchSpotifyResults.innerHTML = '<p class="empty-message">No results found</p>' +
      '<p class="empty-message" style="font-size:0.8rem;margin-top:0.5rem;">' +
      'Can\'t find a track? Try pasting the Apple Music URL directly in the search bar.</p>';
  } else {
    searchSpotifyResults.innerHTML = '';
    spotifyResults.forEach(track => {
      const card = buildSpotifyTrackCard(track);
      card.style.flex = '0 0 auto';
      card.style.width = '180px';
      searchSpotifyResults.appendChild(card);
    });
  }
}

function createTrackRowWithScroll(cards, rowIndex, prefix) {
  const rowWrapper = document.createElement('div');
  rowWrapper.className = 'track-row-wrapper';
  rowWrapper.style.marginTop = '1rem';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
  prevBtn.id = `${prefix}-prev-${rowIndex}`;
  prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

  const rowContainer = document.createElement('div');
  rowContainer.className = 'track-row-container';

  const trackRow = document.createElement('div');
  trackRow.className = 'track-row';
  trackRow.id = `${prefix}-grid-${rowIndex}`;

  cards.forEach(card => {
    card.classList.add('track-row-card');
    trackRow.appendChild(card);
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
  nextBtn.id = `${prefix}-next-${rowIndex}`;
  nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

  rowWrapper.appendChild(prevBtn);
  rowWrapper.appendChild(rowContainer);
  rowWrapper.appendChild(nextBtn);
  rowContainer.appendChild(trackRow);

  // Initialize scrolling after a short delay
  setTimeout(() => {
    initTrackRowScrolling([cards.length], prefix + '-', prefix + '-grid-');
  }, 100);

  return rowWrapper;
}

function buildSpotifyTrackCard(track) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.trackId = track.spotify_url;

  const artContainer = document.createElement("div");
  artContainer.className = "artwork-container";

  // Generate a colored placeholder art for Spotify tracks
  const art = createArtCanvas(track.track_name, track.artist_name);

  if (track.cover_art) {
    const img = document.createElement("img");
    img.className = "card-img";
    img.src = track.cover_art;
    img.alt = track.track_name;
    img.loading = "lazy";

    img.addEventListener("load", function() {
      art.style.display = "none";
      img.style.display = "block";
    });
    img.addEventListener("error", function() {
      img.style.display = "none";
      art.style.display = "block";
    });
    artContainer.appendChild(img);
  }

  artContainer.appendChild(art);
  card.appendChild(artContainer);

  const title = document.createElement("p");
  title.className = "card-title";
  title.textContent = track.track_name;

  const info = document.createElement("p");
  info.className = "card-info";
  info.innerHTML = '<span class="spotify-artist">' + escapeHtml(track.artist_name || '') + '</span>';

  card.appendChild(title);
  card.appendChild(info);

  // Click to download and play
  card.addEventListener("click", () => {
    if (track.spotify_url && window.downloadAndPlayTrack) {
      window.downloadAndPlayTrack(track);
    }
  });

  return card;
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

  // Avatar handling (preserve edit overlay)
  const profileAvatar = document.getElementById('profile-avatar');
  if (profileAvatar) {
    // Remove existing icon or img only (not edit overlay)
    const oldIcon = profileAvatar.querySelector('i.fa-user');
    if (oldIcon) oldIcon.remove();
    const oldImg = profileAvatar.querySelector('img.avatar-img');
    if (oldImg) oldImg.remove();

    if (state.currentUser?.avatar_path) {
      const img = document.createElement('img');
      img.src = withBase(`/users/${state.currentUser.id}/avatar?t=${Date.now()}`);
      img.alt = 'Avatar';
      img.className = 'avatar-img';
      profileAvatar.appendChild(img);
    } else {
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-user';
      profileAvatar.appendChild(icon);
    }
  }

  const profilePageUsername = document.getElementById("profile-page-username");
  const profilePageMemberSince = document.getElementById("profile-page-member-since");
  const profileLikedCount = document.getElementById("profile-liked-count");
  const profileUploadsCount = document.getElementById("profile-uploads-count");
  const profilePlaylistsCount = document.getElementById("profile-playlists-count");

  if (profilePageUsername) profilePageUsername.textContent = state.currentUser.name || "N/A";

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

  // Separate local tracks from Spotify results
  const localTracks = items.filter(t => t.id && !t.spotify_url);
  const spotifyTracks = items.filter(t => t.spotify_url);

  // Render local tracks first
  localTracks.forEach(function(track, index) {
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
      // Don't do anything if clicking the currently playing track
      if (state.currentTrackId === track.id) {
        hideSearchDropdown();
        return;
      }
      setQueueFromList(items, index);
      if (state.currentQueue.length) playTrack(state.currentQueue[state.currentIndex]);
      addRecentSearch(state.authHash || '', {
        id: track.id,
        title: track.title,
        artist: getArtistDisplay(track)
      });
      hideSearchDropdown();
      document.getElementById("search-input").blur();
    });

    inner.appendChild(btn);
  });

  // Render Spotify results
  if (spotifyTracks.length > 0) {
    // Add a divider if there are local results
    if (localTracks.length > 0) {
      const divider = document.createElement("div");
      divider.className = "search-dropdown-divider";
      divider.textContent = "Search Results";
      inner.appendChild(divider);
    }

    spotifyTracks.forEach(function(track) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-result search-result-spotify";

      const artistText = track.artist_name || "Unknown";
      const trackTitle = track.track_name || "Unknown Track";
      const seed = (trackTitle + " " + artistText).trim() || "Spotify";

      const art = document.createElement("div");
      art.className = "search-result-art";
      art.style.setProperty("--sr-color", seededColor(seed));

      // Use Spotify cover art if available, otherwise use placeholder
      if (track.cover_art) {
        const img = document.createElement("img");
        img.alt = trackTitle + " artwork";
        img.loading = "lazy";
        img.decoding = "async";
        img.src = track.cover_art;
        img.onerror = function() { img.remove(); };
        art.appendChild(img);
      }

      const meta = document.createElement("div");
      meta.className = "search-result-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "search-result-title";
      titleEl.textContent = trackTitle;

      const artistEl = document.createElement("div");
      artistEl.className = "search-result-artist";
      artistEl.textContent = artistText;

      // Add Spotify badge
      const spotifyBadge = document.createElement("span");
      spotifyBadge.className = "spotify-badge";
      spotifyBadge.innerHTML = '<i class="fa-solid fa-download"></i> Download';

      meta.appendChild(titleEl);
      meta.appendChild(artistEl);
      meta.appendChild(spotifyBadge);

      btn.appendChild(art);
      btn.appendChild(meta);

      btn.addEventListener("click", function(ev) {
        ev.preventDefault();
        // Download and play the track instead of opening in browser
        if (track.spotify_url && window.downloadAndPlayTrack) {
          window.downloadAndPlayTrack(track);
        }
        hideSearchDropdown();
        document.getElementById("search-input").blur();
      });

      inner.appendChild(btn);
    });
  }

  searchDropdown.appendChild(inner);
}

export function renderRecentSearchDropdown(recentItems) {
  const searchDropdown = document.getElementById("search-dropdown");
  if (!searchDropdown) return;

  searchDropdown.innerHTML = "";
  searchDropdown.style.display = "block";

  const inner = document.createElement("div");
  inner.className = "search-dropdown-inner";

  if (!recentItems.length) {
    const empty = document.createElement("div");
    empty.className = "search-dropdown-empty";
    empty.textContent = "No recent searches.";
    inner.appendChild(empty);
    searchDropdown.appendChild(inner);
    return;
  }

  const header = document.createElement("div");
  header.className = "search-dropdown-header";
  header.textContent = "Recent Searches";
  inner.appendChild(header);

  recentItems.forEach(function(item) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-result recent-search-item";

    const seed = (item.title + " " + item.artist).trim() || "Openfy";
    const art = document.createElement("div");
    art.className = "search-result-art";
    art.style.setProperty("--sr-color", seededColor(seed));

    const img = document.createElement("img");
    img.alt = (item.title || "Track") + " artwork";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = withBase("/tracks/" + item.id + "/artwork?v=" + Date.now());
    img.onerror = function() { img.remove(); };
    art.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "search-result-meta";

    const titleEl = document.createElement("div");
    titleEl.className = "search-result-title";
    titleEl.textContent = item.title || "";

    const artistEl = document.createElement("div");
    artistEl.className = "search-result-artist";
    artistEl.textContent = item.artist || "Unknown";

    meta.appendChild(titleEl);
    meta.appendChild(artistEl);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "search-result-remove";
    removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    removeBtn.title = "Remove from recent";
    removeBtn.addEventListener("click", function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      removeRecentSearch(state.authHash || '', item.id);
      const updatedRecent = loadRecentSearches(state.authHash || '');
      if (updatedRecent.length) {
        renderRecentSearchDropdown(updatedRecent);
      } else {
        hideSearchDropdown();
      }
    });

    btn.appendChild(art);
    btn.appendChild(meta);
    btn.appendChild(removeBtn);

    btn.addEventListener("click", async function(ev) {
      ev.preventDefault();
      try {
        const track = await api("/tracks/" + item.id);
        // Don't do anything if clicking the currently playing track
        if (state.currentTrackId === track.id) return;
        setQueueFromList([track], 0);
        if (state.currentQueue.length) playTrack(state.currentQueue[state.currentIndex]);
      } catch (err) {
        console.error("Failed to load track:", err);
      }
      addRecentSearch(state.authHash || '', {
        id: item.id,
        title: item.title,
        artist: item.artist
      });
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

export function applyPlaylistImportUI(enabled) {
  state.playlistImportEnabled = !!enabled;
  const playlistImportToggle = document.getElementById("playlist-import-enabled-admin");
  const importOption = document.getElementById("import-playlist-option");

  if (playlistImportToggle) {
    playlistImportToggle.checked = state.playlistImportEnabled;
  }
  if (importOption) {
    importOption.style.display = state.playlistImportEnabled ? "flex" : "none";
  }
}
