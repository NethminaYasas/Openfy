// Openfy Mobile Web Player
import { state, setAuth, clearAuth, updateUser, withBase } from '../modules/state.js';
import { api, loadTracks, loadUserUploads, loadMostPlayed, loadLastTrackPaused, loadUserQueue, loadUserPlayerState, signUp, signIn, tryAutoLogin as apiTryAutoLogin, createPlaylist, toggleLiked, loadPlaylists as apiLoadPlaylists, addTrackToPlaylist, runSearch, runSpotifySearch, getArtist } from '../modules/api.js';
import { formatDuration } from '../modules/utils.js';

// ─── State ───────────────────────────────────────────
let currentTrack = null;
let queue = [];
let queueIndex = -1;
let isPlaying = false;
let isLiked = false;
let volume = parseInt(localStorage.getItem('mobile-volume') || '100');
let repeatMode = 0; // 0=off, 1=all, 2=one
let shuffle = false;
let tracks = [];
let playlists = [];

const audio = document.getElementById('audio-player');

// ─── DOM refs ────────────────────────────────────────
const $ = id => document.getElementById(id);
const pages = {
    home: $('page-home'),
    search: $('page-search'),
    library: $('page-library'),
    detail: $('page-detail'),
    nowPlaying: $('page-now-playing'),
};

// ─── Auth ────────────────────────────────────────────
const authOverlay = $('auth-overlay');
const signinBtn = $('signin-btn');
const signinHash = $('signin-hash');
const signinStatus = $('signin-status');
const signupBtn = $('signup-btn');
const signupName = $('signup-name');
const signupStatus = $('signup-status');
const showSignup = $('show-signup');
const showSignin = $('show-signin');
const backToSignin = $('back-to-signin');

showSignup.addEventListener('click', e => {
    e.preventDefault();
    $('auth-signin').style.display = 'none';
    $('auth-signup').style.display = 'flex';
    backToSignin.style.display = 'block';
});

showSignin.addEventListener('click', e => {
    e.preventDefault();
    $('auth-signin').style.display = 'flex';
    $('auth-signup').style.display = 'none';
    backToSignin.style.display = 'none';
});

signinBtn.addEventListener('click', async () => {
    const hash = signinHash.value.trim();
    if (!hash) return;
    signinBtn.disabled = true;
    signinBtn.querySelector('.btn-text').textContent = 'Logging in...';
    try {
        const res = await signIn(hash);
        setAuth(res.user, hash);
        await initApp();
        signinStatus.textContent = '';
    } catch (e) {
        signinStatus.textContent = e.message || 'Login failed';
    }
    signinBtn.disabled = false;
    signinBtn.querySelector('.btn-text').textContent = 'Log In';
});

signupBtn.addEventListener('click', async () => {
    const name = signupName.value.trim();
    if (!name) return;
    signupBtn.disabled = true;
    signupBtn.querySelector('.btn-text').textContent = 'Signing up...';
    try {
        const res = await signUp(name);
        setAuth(res.user, res.auth_hash);
        await initApp();
        signupStatus.textContent = '';
    } catch (e) {
        signupStatus.textContent = e.message || 'Sign up failed';
    }
    signupBtn.disabled = false;
    signupBtn.querySelector('.btn-text').textContent = 'Sign Up';
});

// ─── Navigation ──────────────────────────────────────
function showPage(name) {
    Object.values(pages).forEach(p => p.classList.remove('active'));
    if (name === 'nowPlaying') {
        pages.nowPlaying.classList.add('active');
        pages.nowPlaying.style.display = 'flex';
        $('app').style.display = 'none';
        document.body.style.background = '#121212';
        return;
    }
    pages.nowPlaying.style.display = 'none';
    $('app').style.display = 'flex';
    document.body.style.background = '#000';
    const page = pages[name];
    if (page) page.classList.add('active');
    $('top-bar-back').style.display = name === 'detail' ? 'flex' : 'none';
    $('top-bar-brand').style.display = name === 'detail' ? 'none' : 'block';
    $('top-bar-search').style.display = 'none';
}

document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        const page = item.dataset.page;
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        showPage(page);
        if (page === 'search') $('search-page-input').focus();
    });
});

$('top-bar-back').addEventListener('click', () => {
    showPage('home');
    document.querySelector('.nav-item[data-page="home"]').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-page="home"]').classList.add('active');
});

// ─── Detail -> Now Playing ──────────────────────────
$('detail-play-btn').addEventListener('click', () => {
    showPage('nowPlaying');
});

$('np-down-btn').addEventListener('click', () => {
    showPage('home');
});

$('mini-player').addEventListener('click', () => {
    showPage('nowPlaying');
});

// ─── Load Data ───────────────────────────────────────
async function initApp() {
    authOverlay.style.display = 'none';
    $('app').style.display = 'flex';
    await loadHome();
    await loadLibrary();
}

async function loadHome() {
    try {
        const mostPlayed = await loadMostPlayed();
        renderCards('most-played-grid', mostPlayed, true);
        const allTracks = await loadTracks();
        tracks = allTracks;
        renderCards('tracks-grid', allTracks.slice(0, 10));
    } catch (e) {
        console.error('Failed to load home:', e);
    }
}

async function loadLibrary() {
    try {
        playlists = await apiLoadPlaylists();
        renderLibraryItems(playlists);
    } catch (e) {
        console.error('Failed to load library:', e);
    }
}

// ─── Render Helpers ──────────────────────────────────
function renderCards(gridId, items, isMostPlayed = false) {
    const grid = $(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    items.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'card';
        const artUrl = item.album?.images?.[0]?.url || item.image_url;
        card.innerHTML = `
            ${artUrl
                ? `<img class="card-img" src="${artUrl}" alt="" loading="lazy" />`
                : `<div class="card-img-placeholder"><i class="fa-solid fa-music"></i></div>`
            }
            <div class="card-title">${escapeHtml(item.title || item.name || 'Unknown')}</div>
            <div class="card-subtitle">${escapeHtml(item.artist || item.artist_name || '')}</div>
        `;
        card.addEventListener('click', () => openDetail(item, isMostPlayed ? 'most-played' : 'track'));
        grid.appendChild(card);
    });
}

function renderLibraryItems(items) {
    const container = $('library-items');
    container.innerHTML = '';
    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'lib-item';
        const artUrl = item.cover_url;
        el.innerHTML = `
            <div class="lib-item-art">
                ${artUrl
                    ? `<img src="${artUrl}" alt="" loading="lazy" />`
                    : `<div class="lib-item-art-placeholder"><i class="fa-solid fa-list"></i></div>`
                }
            </div>
            <div class="lib-item-meta">
                <div class="lib-item-title">${escapeHtml(item.name)}</div>
                <div class="lib-item-sub">${item.is_public ? 'Public' : 'Private'} playlist</div>
            </div>
        `;
        el.addEventListener('click', () => openDetail(item, 'playlist'));
        container.appendChild(el);
    });
}

function renderSearchResults(results) {
    const container = $('search-results');
    container.innerHTML = '';
    results.forEach(item => {
        const el = document.createElement('div');
        el.className = 'search-result-item';
        const artUrl = item.album?.images?.[0]?.url || item.image_url;
        el.innerHTML = `
            <div class="search-result-art">
                ${artUrl
                    ? `<img src="${artUrl}" alt="" loading="lazy" />`
                    : `<div class="search-result-art-placeholder"><i class="fa-solid fa-music"></i></div>`
                }
            </div>
            <div class="search-result-meta">
                <div class="search-result-title">${escapeHtml(item.title || item.name || '')}</div>
                <div class="search-result-sub">${escapeHtml(item.artist || item.artist_name || 'Track')}</div>
            </div>
        `;
        el.addEventListener('click', () => playTrack(item));
        container.appendChild(el);
    });
}

function renderTracks(trackList) {
    const container = $('detail-tracks');
    container.innerHTML = '';
    trackList.forEach((track, i) => {
        const el = document.createElement('div');
        el.className = 'detail-track';
        const artUrl = track.album?.images?.[0]?.url || track.image_url;
        el.innerHTML = `
            <span class="detail-track-num">${i + 1}</span>
            <div style="display:flex;align-items:center;gap:0.75rem;min-width:0;flex:1;">
                ${artUrl ? `<div class="detail-track-art"><img src="${artUrl}" alt="" loading="lazy" /></div>` : ''}
                <div class="detail-track-info">
                    <div class="detail-track-title">${escapeHtml(track.title || track.name || 'Unknown')}</div>
                    <div class="detail-track-artist">${escapeHtml(track.artist || track.artist_name || '')}</div>
                </div>
            </div>
            <span class="detail-track-duration">${formatDuration(track.duration || track.duration_ms)}</span>
        `;
        el.addEventListener('click', () => playTrack(track));
        container.appendChild(el);
    });
}

// ─── Detail View ─────────────────────────────────────
function openDetail(item, type) {
    showPage('detail');
    const title = $('detail-title');
    const subtitle = $('detail-subtitle');
    const art = $('detail-art-img');
    const placeholder = $('detail-art-placeholder');
    const gradient = $('detail-gradient');

    const artUrl = item.album?.images?.[0]?.url || item.image_url || item.cover_url;

    if (artUrl) {
        art.src = artUrl;
        art.style.display = 'block';
        placeholder.style.display = 'none';
    } else {
        art.style.display = 'none';
        placeholder.style.display = 'flex';
    }

    title.textContent = item.title || item.name || 'Unknown';
    subtitle.textContent = item.artist || item.artist_name || item.is_public ? 'Playlist' : '';

    const tracksList = item.tracks || (type === 'track' ? [item] : []);
    renderTracks(tracksList);

    // Play button action
    $('detail-play-btn').onclick = () => {
        if (tracksList.length > 0) {
            queue = tracksList;
            queueIndex = 0;
            playTrack(queue[queueIndex]);
            showPage('nowPlaying');
        }
    };
}

// ─── Player ──────────────────────────────────────────
function playTrack(track) {
    if (!track) return;
    currentTrack = track;
    isPlaying = true;

    const title = track.title || track.name || 'Unknown';
    const artist = track.artist || track.artist_name || '';
    const artUrl = track.album?.images?.[0]?.url || track.image_url;
    const audioUrl = track.audio_url || track.file_path || track.stream_url;

    // Update mini player
    $('mini-player').style.display = 'flex';
    $('mini-player-title').textContent = title;
    $('mini-player-artist').textContent = artist;
    const miniImg = $('mini-player-img');
    const miniPlaceholder = $('mini-player-art-placeholder');
    if (artUrl) {
        miniImg.src = artUrl;
        miniImg.style.display = 'block';
        miniPlaceholder.style.display = 'none';
    }

    // Update now playing
    $('np-title').textContent = title;
    $('np-artist').textContent = artist;
    const npImg = $('np-art-img');
    const npPlaceholder = document.querySelector('.np-art-placeholder');
    if (artUrl) {
        npImg.src = artUrl;
        npImg.style.display = 'block';
        npPlaceholder.style.display = 'none';
    } else {
        npImg.style.display = 'none';
        npPlaceholder.style.display = 'flex';
    }

    updatePlayButtons();

    if (audioUrl) {
        audio.src = withBase ? withBase(audioUrl) : audioUrl;
        audio.play().catch(() => {});
    } else {
        // Simulate play for UI demo
        updateProgressDisplay();
    }

    audio.addEventListener('timeupdate', updateProgressDisplay);
    audio.addEventListener('ended', onTrackEnd);
}

function updateProgressDisplay() {
    const curr = audio.duration ? audio.currentTime : 0;
    const dur = audio.duration || currentTrack?.duration || currentTrack?.duration_ms || 0;
    const pct = dur > 0 ? (curr / dur) * 100 : 0;

    $('np-curr-time').textContent = formatTime(curr);
    $('np-total-time').textContent = formatTime(dur);
    $('np-progress-fill').style.width = pct + '%';
    $('mini-player-progress').style.width = pct + '%';

    // Update time on mini player
    const remaining = dur - curr;
    if (remaining > 0 && remaining < 30) {
        // Show remaining on mini player
    }
}

function onTrackEnd() {
    if (repeatMode === 2) {
        audio.currentTime = 0;
        audio.play();
        return;
    }
    if (shuffle) {
        queueIndex = Math.floor(Math.random() * queue.length);
    } else {
        queueIndex++;
    }
    if (queueIndex >= queue.length) {
        if (repeatMode === 1) {
            queueIndex = 0;
        } else {
            isPlaying = false;
            updatePlayButtons();
            return;
        }
    }
    playTrack(queue[queueIndex]);
}

function updatePlayButtons() {
    const icon = isPlaying ? 'pause' : 'play';
    const showIcon = icon === 'play' ? 'block' : 'none';
    const showPause = icon === 'pause' ? 'block' : 'none';

    document.querySelectorAll('.play-icon').forEach(el => el.style.display = showIcon);
    document.querySelectorAll('.pause-icon').forEach(el => el.style.display = showPause);
}

function togglePlayback() {
    if (!currentTrack) return;
    if (audio.src) {
        if (audio.paused) {
            audio.play();
            isPlaying = true;
        } else {
            audio.pause();
            isPlaying = false;
        }
    } else {
        isPlaying = !isPlaying;
    }
    updatePlayButtons();
}

// ─── Player Controls ─────────────────────────────────
$('np-play-btn').addEventListener('click', togglePlayback);
$('mini-player-play-btn').addEventListener('click', e => {
    e.stopPropagation();
    togglePlayback();
});

$('np-prev').addEventListener('click', () => {
    if (queue.length === 0) return;
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    queueIndex = (queueIndex - 1 + queue.length) % queue.length;
    playTrack(queue[queueIndex]);
});

$('np-next').addEventListener('click', () => {
    if (queue.length === 0) return;
    queueIndex = (queueIndex + 1) % queue.length;
    playTrack(queue[queueIndex]);
});

$('np-shuffle').addEventListener('click', () => {
    shuffle = !shuffle;
    $('np-shuffle').classList.toggle('active');
});

$('np-repeat').addEventListener('click', () => {
    repeatMode = (repeatMode + 1) % 3;
    $('np-repeat').classList.toggle('active', repeatMode > 0);
    $('np-repeat').style.color = repeatMode === 2 ? '#1DB954' : repeatMode === 1 ? '#1DB954' : '#b3b3b3';
});

$('np-like-btn').addEventListener('click', async () => {
    if (!currentTrack) return;
    isLiked = !isLiked;
    $('np-like-btn').classList.toggle('liked', isLiked);
    $('np-like-btn').querySelector('i').className = isLiked ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    try {
        await toggleLiked(currentTrack.id || currentTrack.track_id);
    } catch (e) {
        isLiked = !isLiked;
        $('np-like-btn').classList.toggle('liked', isLiked);
    }
});

// Volume
$('np-volume-slider').addEventListener('input', e => {
    volume = parseInt(e.target.value);
    audio.volume = volume / 100;
    e.target.style.setProperty('--volume', volume + '%');
    localStorage.setItem('mobile-volume', volume);
    const icon = $('np-volume-icon');
    icon.className = volume === 0 ? 'fa-solid fa-volume-xmark' : volume < 50 ? 'fa-solid fa-volume-low' : 'fa-solid fa-volume-high';
});

$('np-volume-slider').value = volume;
$('np-volume-slider').style.setProperty('--volume', volume + '%');
audio.volume = volume / 100;

// Progress bar seeking
$('np-progress-bar').addEventListener('click', e => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
});

// ─── Search ──────────────────────────────────────────
let searchTimeout;

$('search-page-input').addEventListener('input', e => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) {
        $('search-results-section').style.display = 'none';
        $('browse-grid').style.display = 'flex';
        return;
    }
    $('search-results-section').style.display = 'block';
    $('browse-grid').style.display = 'none';
    searchTimeout = setTimeout(() => performSearch(q), 300);
});

async function performSearch(q) {
    try {
        const localResults = await runSearch(q);
        const spotifyResults = await runSpotifySearch(q);
        const all = [...(localResults || []), ...(spotifyResults || [])];
        renderSearchResults(all);
    } catch (e) {
        console.error('Search failed:', e);
    }
}

// ─── Library filter ──────────────────────────────────
document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// ─── Audio events ───────────────────────────────────
audio.addEventListener('play', () => { isPlaying = true; updatePlayButtons(); });
audio.addEventListener('pause', () => { isPlaying = false; updatePlayButtons(); });

// ─── Bootstrap ──────────────────────────────────────
async function bootstrap() {
    try {
        const res = await apiTryAutoLogin();
        if (res && res.user) {
            setAuth(res.user, res.auth_hash);
            await initApp();
            return;
        }
    } catch (e) {
        // Not logged in
    }
    authOverlay.style.display = 'flex';
}

bootstrap();

// ─── Helpers ─────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
