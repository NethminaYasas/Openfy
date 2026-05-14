// Openfy Mobile Web Player
import { state, setAuth, clearAuth, updateUser, withBase } from '../modules/state.js';
import { api, loadTracks, loadUserUploads, loadMostPlayed, loadLastTrackPaused, loadUserQueue, loadUserPlayerState, signUp, signIn, tryAutoLogin as apiTryAutoLogin, createPlaylist, toggleLiked, loadPlaylists as apiLoadPlaylists, addTrackToPlaylist, runSearch, getArtist, getTrackStreamUrl } from '../modules/api.js';
import { formatDuration, getArtistDisplay, extractVibrantColors } from '../modules/utils.js';
import { loadRecentSearches, addRecentSearch, removeRecentSearch } from '../modules/recent-searches.js';

// ─── State ───────────────────────────────────────────
let currentTrack = null;
let queue = [];
let queueIndex = -1;
let isPlaying = false;
let isLiked = false;
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
        const user = await signIn(hash);
        setAuth(hash, user);
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
        const user = await signUp(name);
        setAuth(user.auth_hash, user);
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
    document.body.className = '';
    if (pages.nowPlaying.classList.contains('active') && name !== 'nowPlaying') {
        document.body.style.background = '#000';
        if (currentTrack) $('mini-player').style.display = 'flex';
        var target = pages[name];
        if (target) target.classList.add('active');
        document.body.classList.add('page-' + name);
        var isHome = name === 'home';
        $('top-bar-back').style.display = name === 'detail' ? 'flex' : 'none';
        $('top-bar-greeting').style.display = isHome ? 'block' : 'none';
        $('top-bar-profile').style.display = isHome ? 'flex' : 'none';
        $('top-bar-search').style.display = 'none';
        pages.nowPlaying.classList.add('slide-down');
        pages.nowPlaying.addEventListener('animationend', function handler() {
            pages.nowPlaying.removeEventListener('animationend', handler);
            pages.nowPlaying.classList.remove('active', 'slide-down');
        });
        return;
    }
    Object.values(pages).forEach(p => p.classList.remove('active'));
    if (name === 'nowPlaying') {
        pages.nowPlaying.classList.add('active');
        document.body.style.background = '#121212';
        $('top-bar-greeting').style.display = 'none';
        $('top-bar-profile').style.display = 'none';
        $('mini-player').style.display = 'none';
        syncShuffleUI();
        return;
    }
    document.body.style.background = '#000';
    if (currentTrack) $('mini-player').style.display = 'flex';
    const page = pages[name];
    if (page) page.classList.add('active');
    document.body.classList.add('page-' + name);
    var isHome = name === 'home';
    $('top-bar-back').style.display = name === 'detail' ? 'flex' : 'none';
    $('top-bar-greeting').style.display = isHome ? 'block' : 'none';
    $('top-bar-profile').style.display = isHome ? 'flex' : 'none';
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
    showPage('library');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-page="library"]').classList.add('active');
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

$('top-bar-profile').addEventListener('click', (e) => {
    e.stopPropagation();
    $('profile-dropdown').classList.toggle('active');
});

document.addEventListener('click', () => {
    $('profile-dropdown').classList.remove('active');
});

$('profile-dropdown').addEventListener('click', (e) => {
    e.stopPropagation();
});

$('profile-dropdown-profile').addEventListener('click', () => {
    $('profile-dropdown').classList.remove('active');
    if (state.currentUser) {
        window.location.href = '/profile/' + state.currentUser.id;
    }
});

$('profile-dropdown-settings').addEventListener('click', () => {
    $('profile-dropdown').classList.remove('active');
    window.location.href = '/settings';
});

$('profile-dropdown-logout').addEventListener('click', async () => {
    $('profile-dropdown').classList.remove('active');
    clearAuth();
    location.reload();
});

if (state.currentUser && state.currentUser.is_admin) {
    $('profile-dropdown-admin').style.display = 'flex';
}
$('profile-dropdown-admin').addEventListener('click', () => {
    $('profile-dropdown').classList.remove('active');
    window.location.href = '/admin';
});

// ─── Load Data ───────────────────────────────────────
async function initApp() {
    authOverlay.style.display = 'none';
    $('app').style.display = 'flex';
    var hr = new Date().getHours();
    var greeting = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    $('top-bar-greeting').textContent = greeting;

    var profileIcon = $('top-bar-profile-icon');
    var profileImg = $('top-bar-profile-img');
    if (state.currentUser) {
        $('profile-dropdown-name').textContent = state.currentUser.name;
        if (state.currentUser.is_admin) {
            $('profile-dropdown-admin').style.display = 'flex';
        }
        profileImg.src = withBase('/users/' + state.currentUser.id + '/avatar');
        profileImg.onload = function() {
            profileIcon.style.display = 'none';
            profileImg.style.display = 'block';
        };
        profileImg.onerror = function() {
            profileImg.style.display = 'none';
            profileIcon.style.display = 'flex';
        };
    }
    const [mostPlayed, allTracks, allPlaylists] = await Promise.all([
        loadMostPlayed(),
        loadTracks(),
        apiLoadPlaylists()
    ]);
    tracks = allTracks;
    playlists = allPlaylists;
    renderHorizCards('most-played-grid', mostPlayed);
    const chunkSize = 9;
    for (let i = 0; i < 3; i++) {
        renderHorizCards('tracks-row-' + i, tracks.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    renderLibraryItems(playlists);
    renderRecentSearches();
    const lastTrack = await loadLastTrackPaused();
    if (lastTrack) {
        playTrack(lastTrack, false);
    }
    await loadUserPlayerState();
    shuffle = state.shuffle;
    syncShuffleUI();
}

// ─── Render Helpers ──────────────────────────────────
function renderCards(gridId, items, isMostPlayed = false) {
    const grid = $(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    items.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'card';
        const artUrl = item.id ? withBase("/tracks/" + item.id + "/artwork") : null;
        card.innerHTML = `
            <div class="card-img-wrap">
                ${artUrl
                    ? `<img class="card-img" src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                    : ''
                }
                <div class="card-img-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="fa-solid fa-music"></i></div>
            </div>
            <div class="card-title">${escapeHtml(item.title || item.name || 'Unknown')}</div>
            <div class="card-subtitle">${escapeHtml(getArtistDisplay(item))}</div>
        `;
        attachCardHandlers(card, item, items, i);
        grid.appendChild(card);
    });
}

function attachCardHandlers(card, item, list, index) {
    let longPressTimer = null;
    let isLongPress = false;
    let startX = 0;
    let startY = 0;

    card.addEventListener('touchstart', e => {
        isLongPress = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        longPressTimer = setTimeout(() => {
            isLongPress = true;
            navigator.vibrate && navigator.vibrate(20);
            showContextMenu(item, list, index);
        }, 400);
    }, { passive: true });

    card.addEventListener('touchend', e => {
        clearTimeout(longPressTimer);
        if (isLongPress) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (dx * dx + dy * dy < 100) {
            playFromList(list, index);
        }
    }, { passive: true });

    card.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
    }, { passive: true });

    // Mouse fallback for desktop testing
    card.addEventListener('click', e => {
        if (!isLongPress) {
            playFromList(list, index);
        }
    });
}

function playFromList(list, index) {
    if (!list || !list.length) return;
    queue = list;
    queueIndex = index;
    try {
        playTrack(list[index]);
    } catch (e) {
        console.error('playTrack error:', e);
    }
}

function renderHorizCards(gridId, items) {
    const grid = $(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    items.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'card';
        const artUrl = item.id ? withBase("/tracks/" + item.id + "/artwork") : null;
        card.innerHTML = `
            <div class="card-img-wrap">
                ${artUrl
                    ? `<img class="card-img" src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                    : ''
                }
                <div class="card-img-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="fa-solid fa-music"></i></div>
            </div>
            <div class="card-title">${escapeHtml(item.title || item.name || 'Unknown')}</div>
            <div class="card-subtitle">${escapeHtml(getArtistDisplay(item))}</div>
        `;
        attachCardHandlers(card, item, items, i);
        grid.appendChild(card);
    });
}

function renderHorizPlaylists(gridId, items) {
    const grid = $(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    items.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'card';
        const isAlbum = item.type === 'album';
        const artUrl = item.image_url || (item.id ? withBase((isAlbum ? "/albums/" : "/playlists/") + item.id + (isAlbum ? "/artwork" : "/cover")) : null);
        card.innerHTML = `
            <div class="card-img-wrap">
                ${artUrl
                    ? `<img class="card-img" src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                    : ''
                }
                <div class="card-img-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="fa-solid fa-list"></i></div>
            </div>
            <div class="card-title">${escapeHtml(item.name || 'Playlist')}</div>
            <div class="card-subtitle">${item.is_public ? 'Public' : 'Private'} ${isAlbum ? 'album' : 'playlist'}</div>
        `;
        card.addEventListener('click', () => openDetail(item, isAlbum ? 'album' : 'playlist'));
        grid.appendChild(card);
    });
}

function renderTrackRows(containerId, items) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = '';
    items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'track-row-item';
        const artUrl = item.id ? withBase("/tracks/" + item.id + "/artwork") : null;
        row.innerHTML = `
            <div class="track-row-art">
                ${artUrl
                    ? `<img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                    : ''
                }
                <div class="track-row-art-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="fa-solid fa-music"></i></div>
            </div>
            <div class="track-row-meta">
                <div class="track-row-title">${escapeHtml(item.title || item.name || 'Unknown')}</div>
                <div class="track-row-artist">${escapeHtml(getArtistDisplay(item))}</div>
            </div>
            <span class="track-row-duration">${formatDuration(item.duration || item.duration_ms)}</span>
        `;
        attachRowHandlers(row, item, items, i);
        container.appendChild(row);
    });
}

function attachRowHandlers(row, item, list, index) {
    let longPressTimer = null;
    let isLongPress = false;
    let startX = 0;
    let startY = 0;

    row.addEventListener('touchstart', e => {
        isLongPress = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        longPressTimer = setTimeout(() => {
            isLongPress = true;
            navigator.vibrate && navigator.vibrate(20);
            showContextMenu(item, list, index);
        }, 400);
    }, { passive: true });

    row.addEventListener('touchend', e => {
        clearTimeout(longPressTimer);
        if (isLongPress) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (dx * dx + dy * dy < 100) {
            playFromList(list, index);
        }
    }, { passive: true });

    row.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
    }, { passive: true });

    row.addEventListener('click', () => {
        if (!isLongPress) {
            playFromList(list, index);
        }
    });
}

// ─── Context Menu ────────────────────────────────
let ctxTrack = null;
let ctxList = null;
let ctxIndex = -1;

function showContextMenu(track, list, index) {
    ctxTrack = track;
    ctxList = list;
    ctxIndex = index;
    const overlay = $('ctx-overlay');
    const menu = $('ctx-menu');

    $('ctx-header-title').textContent = track.title || track.name || 'Unknown';
    $('ctx-header-artist').textContent = getArtistDisplay(track);
    const artUrl = track.id ? withBase("/tracks/" + track.id + "/artwork") : null;
    const img = $('ctx-header-img');
    const placeholder = document.querySelector('.ctx-art-placeholder');
    if (artUrl) {
        img.src = artUrl;
        img.style.display = 'block';
        placeholder.style.display = 'none';
    } else {
        img.style.display = 'none';
        placeholder.style.display = 'flex';
    }

    const likeText = $('ctx-like-text');
    const liked = state.likedTrackIds && state.likedTrackIds.has(track.id);
    likeText.textContent = liked ? 'Remove from Likes' : 'Like';
    const likeIcon = document.querySelector('.ctx-item[data-action="like"] i');
    likeIcon.className = liked ? 'fa-solid fa-heart' : 'fa-regular fa-heart';

    overlay.style.display = 'block';
    menu.style.display = 'block';
}

function hideContextMenu() {
    $('ctx-overlay').style.display = 'none';
    $('ctx-menu').style.display = 'none';
    ctxTrack = null;
}

document.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', async () => {
        const track = ctxTrack;
        if (!track) return;
        const action = item.dataset.action;
        hideContextMenu();

        if (action === 'play') {
            playTrack(track);
        } else if (action === 'add-queue') {
            queue.push(track);
        } else if (action === 'add-playlist') {
            // TODO: show playlist picker
        } else if (action === 'like') {
            try {
                await toggleLiked(track.id);
                if (state.likedTrackIds) {
                    if (state.likedTrackIds.has(track.id)) {
                        state.likedTrackIds.delete(track.id);
                    } else {
                        state.likedTrackIds.add(track.id);
                    }
                }
            } catch (e) {
                console.error('Toggle like failed:', e);
            }
        }
    });
});

$('ctx-overlay').addEventListener('click', hideContextMenu);

function renderLibraryItems(items) {
    const container = $('library-items');
    container.innerHTML = '';
    items.slice().sort(function(a, b) {
        if (a.is_liked && !b.is_liked) return -1;
        if (!a.is_liked && b.is_liked) return 1;
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }).forEach(item => {
        const el = document.createElement('div');
        el.className = 'lib-item';
        const isAlbum = item.type === 'album';
        if (item.is_liked) {
            el.innerHTML = `
                <div class="lib-item-art lib-item-art-liked">
                    <i class="fa-solid fa-heart"></i>
                </div>
                <div class="lib-item-meta">
                    <div class="lib-item-title">${escapeHtml(item.name)}</div>
                    <div class="lib-item-sub">Playlist</div>
                </div>
            `;
        } else {
            const artUrl = item.image_url || (item.id ? withBase((isAlbum ? "/albums/" : "/playlists/") + item.id + (isAlbum ? "/artwork" : "/cover")) : null);
            el.innerHTML = `
                <div class="lib-item-art">
                    ${artUrl
                        ? `<img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                        : ''
                    }
                    <div class="lib-item-art-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="fa-solid fa-list"></i></div>
                </div>
                <div class="lib-item-meta">
                    <div class="lib-item-title">${escapeHtml(item.name)}</div>
                    <div class="lib-item-sub">${item.is_public ? 'Public' : 'Private'} ${isAlbum ? 'album' : 'playlist'}</div>
                </div>
            `;
        }
        el.addEventListener('click', () => openDetail(item, isAlbum ? 'album' : 'playlist'));
        container.appendChild(el);
    });
}

function renderSearchResults(results) {
    const container = $('search-results');
    container.innerHTML = '';
    results.forEach(item => {
        if (!item.id) return;
        const el = document.createElement('div');
        el.className = 'search-result-item';
        const artUrl = withBase("/tracks/" + item.id + "/artwork");
        const title = item.title || item.name || 'Unknown';
        const artist = getArtistDisplay(item);
        el.innerHTML = `
            <div class="search-result-art">
                <img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
                <div class="search-result-art-placeholder" style="display:none"><i class="fa-solid fa-music"></i></div>
            </div>
            <div class="search-result-meta">
                <div class="search-result-title">${escapeHtml(title)}</div>
                <div class="search-result-sub">${escapeHtml(artist)}</div>
            </div>
        `;
        el.addEventListener('click', () => {
            addRecentSearch(state.authHash || '', {
                id: item.id,
                title: title,
                artist: artist
            });
            playTrack(item);
        });
        container.appendChild(el);
    });
}

function renderTracks(trackList) {
    const container = $('detail-tracks');
    container.innerHTML = '';
    trackList.forEach((track, i) => {
        const el = document.createElement('div');
        el.className = 'detail-track';
        const artUrl = track.id ? withBase("/tracks/" + track.id + "/artwork") : null;
        el.innerHTML = `
            <span class="detail-track-num">${i + 1}</span>
            <div class="detail-track-body">
                ${artUrl ? `<div class="detail-track-art"><img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none'" /></div>` : ''}
                <div class="detail-track-info">
                    <div class="detail-track-title">${escapeHtml(track.title || track.name || 'Unknown')}</div>
                    <div class="detail-track-artist">${escapeHtml(getArtistDisplay(track))}</div>
                </div>
            </div>
            <span class="detail-track-duration">${formatDuration(track.duration || track.duration_ms)}</span>
        `;
        el.addEventListener('click', () => {
            queue = trackList;
            queueIndex = i;
            playTrack(track);
        });
        container.appendChild(el);
    });
}

// ─── Gradient ────────────────────────────────────────
async function updateGradient(el, artUrl) {
    if (!el) return;
    if (!artUrl) {
        el.style.setProperty('--gradient-start', '#555555');
        el.style.setProperty('--gradient-mid', '#333333');
        return;
    }
    try {
        const colors = await extractVibrantColors(artUrl);
        el.style.setProperty('--gradient-start', colors[0]);
        el.style.setProperty('--gradient-mid', colors[1]);
    } catch (e) {
        el.style.setProperty('--gradient-start', '#555555');
        el.style.setProperty('--gradient-mid', '#333333');
    }
}

// ─── Detail View ─────────────────────────────────────
async function openDetail(item, type) {
    showPage('detail');
    const title = $('detail-title');
    const subtitle = $('detail-subtitle');
    const art = $('detail-art-img');
    const placeholder = $('detail-art-placeholder');

    if (item.is_liked) {
        art.style.display = 'none';
        placeholder.style.background = 'linear-gradient(135deg, #450af5, #c4efd9)';
        placeholder.innerHTML = '<i class="fa-solid fa-heart" style="font-size: 3rem; color: #fff;"></i>';
        placeholder.style.display = 'flex';
        updateGradient($('detail-gradient'), null);
    } else {
        placeholder.style.background = '#2a2a2a';
        placeholder.innerHTML = '<i class="fa-solid fa-music"></i>';
        const artUrl = type === 'album'
            ? withBase("/albums/" + item.id + "/artwork")
            : type === 'playlist'
                ? withBase("/playlists/" + item.id + "/cover")
                : withBase("/tracks/" + item.id + "/artwork");
        art.onerror = function() { this.style.display = 'none'; placeholder.style.display = 'flex'; };
        art.src = artUrl;
        art.style.display = 'block';
        placeholder.style.display = 'none';
        updateGradient($('detail-gradient'), artUrl);
    }

    title.textContent = item.title || item.name || 'Unknown';
    if (item.is_liked) {
        subtitle.textContent = 'Playlist';
    } else if (type === 'playlist') {
        subtitle.textContent = item.is_public ? 'Public playlist' : 'Private playlist';
    } else if (type === 'album') {
        subtitle.textContent = 'Album';
    } else {
        subtitle.textContent = getArtistDisplay(item);
    }

    let tracksList = [];
    if (type === 'track') {
        tracksList = [item];
    } else {
        try {
            const apiTracks = await api("/playlists/" + item.id + "/tracks");
            tracksList = apiTracks.map(t => t.track);
        } catch (e) {
            console.error('Failed to load tracks:', e);
        }
    }
    renderTracks(tracksList);

    $('detail-play-btn').onclick = () => {
        if (tracksList.length > 0) {
            queue = tracksList;
            queueIndex = 0;
            playTrack(queue[queueIndex]);
            showPage('nowPlaying');
        }
    };

    var detailPage = $('page-detail');
    var gradEl = $('detail-gradient');
    var onScroll = function() {
        var scrollTop = detailPage.scrollTop;
        var maxScroll = 350;
        var opacity = Math.max(0, 1 - scrollTop / maxScroll);
        gradEl.style.opacity = opacity;
    };
    syncShuffleUI();

    detailPage.removeEventListener('scroll', detailPage._gradientScroll);
    detailPage._gradientScroll = onScroll;
    detailPage.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
}

// ─── Player ──────────────────────────────────────────
function playTrack(track, autoPlay = true) {
    if (!track) return;
    currentTrack = track;
    isPlaying = autoPlay;
    queueIndex = -1;

    const title = track.title || track.name || 'Unknown';
    const artist = getArtistDisplay(track);
    const artUrl = track.id ? withBase("/tracks/" + track.id + "/artwork") : null;

    // Update mini player
    if (!pages.nowPlaying.classList.contains('active')) {
        $('mini-player').style.display = 'flex';
    }
    $('mini-player-title').textContent = title;
    $('mini-player-artist').textContent = artist;
    var miniEl = $('mini-player');
    var miniImg = $('mini-player-img');
    var miniPlaceholder = document.querySelector('.mini-player-art-placeholder');
    if (miniPlaceholder && artUrl && miniImg) {
        miniImg.src = artUrl;
        miniImg.style.display = 'block';
        miniPlaceholder.style.display = 'none';
    } else if (miniPlaceholder) {
        miniPlaceholder.style.display = 'flex';
    }
    if (artUrl) {
        extractVibrantColors(artUrl).then(function(colors) {
            miniEl.style.background = 'linear-gradient(135deg, ' + colors[0] + ', ' + colors[1] + ')';
        }).catch(function() {
            miniEl.style.background = '#1a1a1a';
        });
    } else {
        miniEl.style.background = '#1a1a1a';
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

    updateGradient($('np-gradient'), artUrl);

    updatePlayButtons();

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title,
            artist: artist,
            album: track.album || '',
            artwork: artUrl ? [
                { src: artUrl, sizes: '256x256', type: 'image/jpeg' },
                { src: artUrl, sizes: '512x512', type: 'image/jpeg' }
            ] : []
        });
        navigator.mediaSession.playbackState = autoPlay ? 'playing' : 'paused';
        navigator.mediaSession.setActionHandler('play', () => {
            if (audio.paused) togglePlayback();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (!audio.paused) togglePlayback();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            $('np-prev').click();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            $('np-next').click();
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.fastSeek && !('fastSeek' in audio)) return;
            audio.currentTime = details.seekTime;
        });
    }

    const tid = track.id;
    if (autoPlay) {
        getTrackStreamUrl(tid)
            .then(streamUrl => {
                if (currentTrack?.id !== tid) return;
                audio.src = streamUrl;
                return audio.play();
            })
            .catch(err => {
                if (err.name === 'AbortError') return;
                console.error('playback failed:', err);
            });

        audio.addEventListener('timeupdate', updateProgressDisplay);
        audio.addEventListener('ended', onTrackEnd);
    }
}

function updateProgressDisplay() {
    const curr = audio.duration ? audio.currentTime : 0;
    const dur = audio.duration || currentTrack?.duration || currentTrack?.duration_ms || 0;
    const pct = dur > 0 ? (curr / dur) * 100 : 0;

    $('np-curr-time').textContent = formatTime(curr);
    $('np-total-time').textContent = formatTime(dur);
    $('np-progress-fill').style.width = pct + '%';
    $('mini-player-progress').style.width = pct + '%';

    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
            navigator.mediaSession.setPositionState({
                duration: dur,
                playbackRate: 1,
                position: curr
            });
        } catch (_) {}
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
        isPlaying = true;
        const tid = currentTrack.id;
        getTrackStreamUrl(tid)
            .then(streamUrl => {
                if (currentTrack?.id !== tid) return;
                audio.src = streamUrl;
                return audio.play();
            })
            .catch(err => {
                if (err.name === 'AbortError') return;
                console.error('playback failed:', err);
            });
        audio.addEventListener('timeupdate', updateProgressDisplay);
        audio.addEventListener('ended', onTrackEnd);
    }
    updatePlayButtons();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
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

function syncShuffleUI() {
    const np = $('np-shuffle');
    const detail = $('detail-shuffle-btn');
    if (np) np.classList.toggle('active', shuffle);
    if (detail) detail.classList.toggle('active', shuffle);
}

$('np-shuffle').addEventListener('click', () => {
    shuffle = !shuffle;
    syncShuffleUI();
});

$('detail-shuffle-btn').addEventListener('click', () => {
    shuffle = !shuffle;
    syncShuffleUI();
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

// Progress bar seeking
const npBar = $('np-progress-bar');
let seeking = false;

function seekFromEvent(e) {
    if (!audio.duration) return;
    const rect = npBar.getBoundingClientRect();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    $('np-progress-fill').style.width = pct * 100 + '%';
    audio.currentTime = pct * audio.duration;
}

npBar.addEventListener('mousedown', e => { seeking = true; seekFromEvent(e); });
document.addEventListener('mousemove', e => { if (seeking) seekFromEvent(e); });
document.addEventListener('mouseup', () => { seeking = false; });

npBar.addEventListener('touchstart', e => { seeking = true; seekFromEvent(e); }, { passive: true });
document.addEventListener('touchmove', e => { if (seeking) seekFromEvent(e); }, { passive: true });
document.addEventListener('touchend', () => { seeking = false; });

// ─── Search ──────────────────────────────────────────
let searchTimeout;

function renderRecentSearches() {
    const container = $('recent-searches');
    container.innerHTML = '';
    const items = loadRecentSearches(state.authHash || '');
    if (!items.length) {
        container.innerHTML = '<div class="recent-search-empty">No recent searches.</div>';
        return;
    }
    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'recent-search-item';
        const artUrl = item.id ? withBase("/tracks/" + item.id + "/artwork") : null;
        el.innerHTML = `
            <div class="search-result-art">
                ${artUrl
                    ? `<img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                    : ''
                }
                <div class="search-result-art-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="fa-solid fa-music"></i></div>
            </div>
            <div class="search-result-meta">
                <div class="search-result-title">${escapeHtml(item.title || '')}</div>
                <div class="search-result-sub">${escapeHtml(item.artist || 'Unknown')}</div>
            </div>
            <button class="recent-search-remove"><i class="fa-solid fa-xmark"></i></button>
        `;
        el.querySelector('.recent-search-remove').addEventListener('click', e => {
            e.stopPropagation();
            removeRecentSearch(state.authHash || '', item.id);
            renderRecentSearches();
        });
        el.addEventListener('click', () => {
            api("/tracks/" + item.id).then(track => {
                if (!track) return;
                addRecentSearch(state.authHash || '', {
                    id: item.id,
                    title: track.title || item.title,
                    artist: getArtistDisplay(track) || item.artist
                });
                renderRecentSearches();
                playTrack(track);
            }).catch(() => {
                playTrack(item);
            });
        });
        container.appendChild(el);
    });
}

$('search-page-input').addEventListener('input', e => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) {
        $('search-results-section').style.display = 'none';
        $('recent-searches-section').style.display = 'block';
        renderRecentSearches();
        return;
    }
    $('search-results-section').style.display = 'block';
    $('recent-searches-section').style.display = 'none';
    searchTimeout = setTimeout(() => performSearch(q), 300);
});

async function performSearch(q) {
    try {
        const localResults = await runSearch(q);
        renderSearchResults(localResults || []);
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
audio.addEventListener('play', () => {
    isPlaying = true;
    updatePlayButtons();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
    isPlaying = false;
    updatePlayButtons();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});

// ─── Bootstrap ──────────────────────────────────────
async function bootstrap() {
    try {
        const user = await apiTryAutoLogin();
        if (user) {
            setAuth(state.authHash, user);
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
