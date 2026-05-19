// Openfy Mobile Web Player
import { state, setAuth, clearAuth, updateUser, withBase } from '../modules/state.js';
import { api, loadTracks, loadUserUploads, loadMostPlayed, loadLastTrackPaused, loadUserQueue, loadUserPlayerState, signUp, signIn, tryAutoLogin as apiTryAutoLogin, createPlaylist, toggleLiked, loadPlaylists as apiLoadPlaylists, addTrackToPlaylist, removeTrackFromPlaylist, loadTrackPlaylists, runSearch, getArtist, getTrackStreamUrl, savePlayerState, followPlaylist, followAlbum, followArtist, unfollowPlaylist, unfollowAlbum, unfollowArtist, updateRegularPlaylistTrackCache, togglePlaylistShuffle, updateAlbumShuffle, checkIfLiked as apiCheckIfLiked } from '../modules/api.js';
import { formatDuration, getArtistDisplay, extractVibrantColors, seededColor } from '../modules/utils.js';
import { loadRecentSearches, addRecentSearch, removeRecentSearch } from '../modules/recent-searches.js';
import { queueSetList, queueJumpTo, queueInsert, queueSave, queueGet, queueLength, queueCurrentIndex, queueCurrentTrack, queueReorder as _queueReorder, setRenderCallback } from '../modules/queue-manager.js';

function reorderQueueSilent(fromIndex, toIndex) {
    setRenderCallback(null);
    _queueReorder(fromIndex, toIndex);
    setRenderCallback(() => renderNowPlayingQueue());
}

function updateTouchDragPosition() {
    if (!state._touchDragElement || !queueSheetContent.contains(state._touchDragElement)) return;

    const items = Array.from(queueSheetContent.querySelectorAll('.np-queue-item:not(.dragging)'));
    const dragY = state.lastDragY;
    if (dragY === null || items.length === 0) return;

    let insertBeforeEl = null;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rect = item.getBoundingClientRect();
        const itemMidY = rect.top + rect.height / 2;
        if (dragY < itemMidY) {
            insertBeforeEl = item;
            break;
        }
    }

    if (insertBeforeEl === state.lastInsertBeforeEl) return;

    const beforeRects = new Map();
    items.forEach(el => {
        beforeRects.set(el, el.getBoundingClientRect());
    });

    if (insertBeforeEl) {
        if (state._touchDragElement.nextSibling !== insertBeforeEl) {
            queueSheetContent.insertBefore(state._touchDragElement, insertBeforeEl);
        }
    } else {
        if (state._touchDragElement.nextSibling !== null) {
            queueSheetContent.appendChild(state._touchDragElement);
        }
    }

    items.forEach(el => {
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

// ─── State ───────────────────────────────────────────
let currentTrack = null;
let isPlaying = false;
let isLiked = false;
let repeatMode = 0; // 0=off, 1=all, 2=one
let shuffle = false;
let tracks = [];
let playlists = [];
let currentLibraryFilter = 'all';
var currentDetailId = null;
var currentDetailType = null;

// Playlist sheet state
let sheetPlaylists = [];
let sheetOriginalInPlaylist = new Set();
let sheetPendingInPlaylist = new Set();
let sheetSearchTimeout = null;

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
var previousPage = 'home';
var navigationHistory = [];
var currentHistoryIndex = -1;
var isNavigating = false;

function pageToUrl(pageName) {
    if (pageName === 'home') return '/';
    if (pageName === 'library') return '/library';
    if (pageName === 'search') return '/search';
    if (pageName.startsWith('detail:')) {
        const parts = pageName.split(':');
        const type = parts[1];
        const id = parts[2];
        if (type === 'artist') return '/artist/' + id;
        if (type === 'album') return '/album/' + id;
        if (type === 'playlist') return '/playlist/' + id;
    }
    return '/';
}

function urlToPage(url) {
    if (url === '/' || url === '') return { name: 'home' };
    if (url === '/library') return { name: 'library' };
    if (url === '/search') return { name: 'search' };
    if (url.startsWith('/artist/')) {
        return { name: 'detail', type: 'artist', id: url.split('/artist/')[1] };
    }
    if (url.startsWith('/album/')) {
        return { name: 'detail', type: 'album', id: url.split('/album/')[1] };
    }
    if (url.startsWith('/playlist/')) {
        return { name: 'detail', type: 'playlist', id: url.split('/playlist/')[1] };
    }
    return { name: 'home' };
}

function pushHistory(pageName) {
    const currentPath = getCurrentPath();
    if (currentHistoryIndex < navigationHistory.length - 1) {
        navigationHistory = navigationHistory.slice(0, currentHistoryIndex + 1);
    }
    if (currentPath && currentPath !== pageName) {
        navigationHistory.push(pageName);
        currentHistoryIndex = navigationHistory.length - 1;
        // Update browser URL
        const url = pageToUrl(pageName);
        if (window.location.pathname !== url) {
            history.pushState({ pageIndex: currentHistoryIndex }, '', url);
        }
    }
}

function getCurrentPath() {
    if (currentHistoryIndex >= 0 && currentHistoryIndex < navigationHistory.length) {
        return navigationHistory[currentHistoryIndex];
    }
    return null;
}

function updateBackButton(forceShow = null) {
    if (forceShow !== null) {
        $('top-bar-back').style.display = forceShow ? 'flex' : 'none';
        return;
    }
    const detailPage = pages.detail.classList.contains('active');
    $('top-bar-back').style.display = (detailPage && currentHistoryIndex > 0) ? 'flex' : 'none';
}

function navigateToPath(path, isBackNav = false) {
    const parsed = urlToPage(path);
    
    if (parsed.name === 'home' || parsed.name === 'library' || parsed.name === 'search') {
        showPage(parsed.name, null, null, isBackNav);
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navItem = document.querySelector('.nav-item[data-page="' + parsed.name + '"]');
        if (navItem) navItem.classList.add('active');
    } else if (parsed.name === 'detail') {
        // Fetch the item data and open detail
        fetchDetailItem(parsed.type, parsed.id, isBackNav);
    }
}

async function fetchDetailItem(type, id, isBackNav) {
    try {
        let item = { id: id, type: type };
        if (type === 'artist') {
            const data = await api("/artists/" + id);
            item.name = data.name || data.title;
            item.image_url = data.image_url;
        } else if (type === 'album') {
            const data = await api("/albums/" + id);
            item.name = data.title || data.name;
            item.image_url = data.image_url;
            item.is_followed = data.is_followed;
            item.shuffle = data.shuffle;
        } else if (type === 'playlist') {
            const data = await api("/playlists/" + id);
            item.name = data.name;
            item.image_url = data.image_url;
            item.is_public = data.is_public;
            item.is_owner = data.is_owner;
            item.is_followed = data.is_followed;
        }
        openDetail(item, type, isBackNav);
    } catch (e) {
        console.error('Failed to fetch detail item:', e);
        showPage('home');
    }
}

function goBackMobile() {
    if (currentHistoryIndex <= 0) {
        history.replaceState({ pageIndex: 0 }, '', '/');
        showPage('home');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelector('.nav-item[data-page="home"]').classList.add('active');
        return;
    }
    currentHistoryIndex--;
    const previousPath = navigationHistory[currentHistoryIndex];
    const url = pageToUrl(previousPath);
    history.pushState({ pageIndex: currentHistoryIndex }, '', url);
    
    if (previousPath === 'home' || previousPath === 'library' || previousPath === 'search') {
        showPage(previousPath, null, null, true);
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navItem = document.querySelector('.nav-item[data-page="' + previousPath + '"]');
        if (navItem) navItem.classList.add('active');
    } else if (previousPath.startsWith('detail:')) {
        const parts = previousPath.split(':');
        const type = parts[1];
        const id = parts[2];
        const item = JSON.parse(decodeURIComponent(parts[3] || '{}'));
        openDetail(item, type, true);
    }
    updateBackButton();
}

// Handle browser back/forward buttons
window.addEventListener('popstate', function(e) {
    if (isNavigating) return;
    isNavigating = true;
    
    const state = e.state;
    if (state && state.pageIndex !== undefined) {
        currentHistoryIndex = state.pageIndex;
        const previousPath = navigationHistory[currentHistoryIndex];
        if (previousPath) {
            if (previousPath === 'home' || previousPath === 'library' || previousPath === 'search') {
                showPage(previousPath, null, null, true);
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                const navItem = document.querySelector('.nav-item[data-page="' + previousPath + '"]');
                if (navItem) navItem.classList.add('active');
            } else if (previousPath.startsWith('detail:')) {
                const parts = previousPath.split(':');
                const type = parts[1];
                const id = parts[2];
                const item = JSON.parse(decodeURIComponent(parts[3] || '{}'));
                openDetail(item, type, true);
            }
        }
    } else {
        // Fallback: parse current URL
        navigateToPath(window.location.pathname, true);
    }
    updateBackButton();
    
    setTimeout(() => { isNavigating = false; }, 100);
});

function showPage(name, detailType = null, detailItem = null, isBackNav = false) {
    if (!pages[name]) return;
    var closePlayer = pages.nowPlaying.classList.contains('active') && name !== 'nowPlaying';
    document.body.className = '';
    if (closePlayer) {
        previousPage = name;
        document.body.style.background = '#000';
        if (currentTrack) $('mini-player').style.display = 'flex';
        if (pages[name]) pages[name].classList.add('active');
        document.body.classList.add('page-' + name);
        var _h = name === 'home';
        $('top-bar-greeting').style.display = _h ? 'block' : 'none';
        $('top-bar-profile').style.display = _h ? 'flex' : 'none';
        $('top-bar-search').style.display = 'none';
        if (name === 'detail') {
            var tb = $('top-bar');
            tb.style.transition = 'none';
            tb.style.background = 'transparent';
            void tb.offsetHeight;
            tb.style.transition = '';
            updateBackButton(currentHistoryIndex > 0);
        } else {
            $('top-bar').style.background = '';
            updateBackButton(false);
        }
        pages.nowPlaying.classList.add('slide-down');
        pages.nowPlaying.addEventListener('animationend', function handler() {
            pages.nowPlaying.removeEventListener('animationend', handler);
            pages.nowPlaying.classList.remove('active', 'slide-down');
        });
        return;
    }
    if (name !== 'nowPlaying') {
        previousPage = name;
        if (!isBackNav) {
            if (name === 'detail' && detailType && detailItem) {
                const detailPath = 'detail:' + detailType + ':' + detailItem.id + ':' + encodeURIComponent(JSON.stringify({
                    id: detailItem.id,
                    type: detailType,
                    name: detailItem.name || detailItem.title,
                    image_url: detailItem.image_url,
                    is_liked: detailItem.is_liked,
                    is_public: detailItem.is_public,
                    is_owner: detailItem.is_owner,
                    is_followed: detailItem.is_followed,
                    shuffle: detailItem.shuffle
                }));
                pushHistory(detailPath);
            } else if (name !== 'detail') {
                pushHistory(name);
            }
        }
    }
    if (name !== 'nowPlaying') {
        Object.values(pages).forEach(function(p) { if (p) p.classList.remove('active'); });
    }
    if (name === 'nowPlaying') {
        pages.nowPlaying.classList.add('active');
        document.body.style.background = '';
        $('mini-player').style.display = 'none';
        syncShuffleUI();
        return;
    }
    document.body.style.background = '#000';
    if (currentTrack) $('mini-player').style.display = 'flex';
    if (pages[name]) pages[name].classList.add('active');
    document.body.classList.add('page-' + name);
    var isHome = name === 'home';
    $('top-bar-greeting').style.display = isHome ? 'block' : 'none';
    $('top-bar-profile').style.display = isHome ? 'flex' : 'none';
    $('top-bar-search').style.display = 'none';
    if (name === 'detail') {
        var tb2 = $('top-bar');
        tb2.style.transition = 'none';
        tb2.style.background = 'transparent';
        void tb2.offsetHeight;
        tb2.style.transition = '';
        updateBackButton(currentHistoryIndex > 0);
    } else {
        $('top-bar').style.background = '';
        updateBackButton(false);
    }
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
    goBackMobile();
});

$('np-down-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    e.preventDefault();
    var target = previousPage || 'home';
    if (target === 'nowPlaying') target = 'home';
    showPage(target);
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
    // Initialize navigation history with home page
    navigationHistory = ['home'];
    currentHistoryIndex = 0;
    
    // Set initial browser state
    history.replaceState({ pageIndex: 0 }, '', '/');
    
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
    state.userPlaylists = allPlaylists;
    updateRegularPlaylistTrackCache();
    renderHorizCards('most-played-grid', mostPlayed);
    const chunkSize = 9;
    for (let i = 0; i < 3; i++) {
        renderHorizCards('tracks-row-' + i, tracks.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    renderLibraryItems(getFilteredLibraryItems());
    preloadLibraryImages(allPlaylists);
    preloadTrackImages(allTracks);
    renderRecentSearches();
    const queueData = await loadUserQueue();
    if (queueData) {
        queueSetList(queueData.tracks, queueData.index);
        const restored = queueCurrentTrack();
        if (restored) playTrack(restored, false);
    } else {
        const lastTrack = await loadLastTrackPaused();
        if (lastTrack) {
            queueSetList([lastTrack], 0);
            playTrack(lastTrack, false);
        }
    }
    await loadUserPlayerState();
    shuffle = state.shuffle;
    repeatMode = 0;
    repeatCount = 0;
    state.repeatState = 'off';
    $('np-repeat').classList.toggle('active', false);
    $('np-repeat').classList.toggle('loop-twice', false);
    const dot = $('np-repeat').querySelector('.repeat-dot');
    if (dot) dot.style.display = '';
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
    queueSetList(list, index);
    try {
        playTrack(queueCurrentTrack());
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

function renderArtistAlbums(artistData) {
    if (!artistData || !artistData.albums || !artistData.albums.length) return;
    var el = $('detail-albums');
    var grid = $('detail-albums-grid');
    if (!el || !grid) return;
    grid.innerHTML = '';
    artistData.albums.forEach(function(album) {
        var card = document.createElement('div');
        card.className = 'card';
        var artUrl = album.image_url
            ? withBase(album.image_url)
            : withBase("/albums/" + album.id + "/artwork");
        card.innerHTML = `
            <div class="card-img-wrap">
                <img class="card-img" src="${artUrl}" alt="" loading="lazy"
                     onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
                <div class="card-img-placeholder" style="display:none"><i class="fa-solid fa-compact-disc"></i></div>
            </div>
            <div class="card-title">${escapeHtml(album.title || 'Unknown')}</div>
            <div class="card-subtitle">Album</div>
        `;
        card.addEventListener('click', function() {
            openDetail({ id: album.id, type: 'album', name: album.title, image_url: album.image_url }, 'album');
        });
        grid.appendChild(card);
    });
    el.style.display = 'block';
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
            queueInsert(track);
        } else if (action === 'add-playlist') {
            if (!state.authHash) {
                alert('Please log in to manage playlists.');
                return;
            }
            currentTrack = track;
            await showPlaylistSheet();
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
                const tid = currentTrack?.id || currentTrack?.track_id;
                if (tid === track.id) syncLikeButtonMobile();
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
    function timestampForLibraryItem(item) {
        const primary = Date.parse(item.followed_at || '');
        if (!Number.isNaN(primary)) return primary;
        const fallback = Date.parse(item.created_at || '');
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
    items.slice().sort(function(a, b) {
        if (a.is_liked && !b.is_liked) return -1;
        if (!a.is_liked && b.is_liked) return 1;
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const rankDiff = libraryTypeRank(a) - libraryTypeRank(b);
        if (rankDiff !== 0) return rankDiff;
        return timestampForLibraryItem(b) - timestampForLibraryItem(a);
    }).forEach(item => {
        const el = document.createElement('div');
        el.className = 'lib-item';
        const isAlbum = item.type === 'album';
        const isArtist = item.type === 'artist';
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
            const placeholderIcon = isArtist ? 'fa-solid fa-microphone-lines' : 'fa-solid fa-list';
            el.innerHTML = `
                <div class="lib-item-art${isArtist ? ' lib-item-art-artist' : ''}">
                    ${artUrl
                        ? `<img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
                        : ''
                    }
                    <div class="lib-item-art-placeholder"${artUrl ? ' style="display:none"' : ''}><i class="${placeholderIcon}"></i></div>
                </div>
                <div class="lib-item-meta">
                    <div class="lib-item-title">${escapeHtml(item.name)}</div>
                    <div class="lib-item-sub">${isArtist ? 'Artist' : (item.is_public ? 'Public' : 'Private') + ' ' + (isAlbum ? 'album' : 'playlist')}</div>
                </div>
            `;
        }
        el.addEventListener('click', () => openDetail(item, isArtist ? 'artist' : (isAlbum ? 'album' : 'playlist')));
        container.appendChild(el);
    });
}

function preloadLibraryImages(items) {
    items.forEach(item => {
        if (item.is_liked) return;
        const isAlbum = item.type === 'album';
        const artUrl = item.image_url || (item.id ? withBase((isAlbum ? "/albums/" : "/playlists/") + item.id + (isAlbum ? "/artwork" : "/cover")) : null);
        if (artUrl) {
            const img = new Image();
            img.src = artUrl;
        }
    });
}

function preloadTrackImages(items) {
    items.forEach(item => {
        if (!item.id) return;
        const img = new Image();
        img.src = withBase("/tracks/" + item.id + "/artwork");
    });
}

function getFilteredLibraryItems() {
    if (currentLibraryFilter === 'all') {
        return playlists;
    }
    if (currentLibraryFilter === 'playlists') {
        return playlists.filter(p => p.is_liked || p.type === 'playlist');
    }
    if (currentLibraryFilter === 'albums') {
        return playlists.filter(p => p.type === 'album');
    }
    if (currentLibraryFilter === 'artists') {
        return playlists.filter(p => p.type === 'artist');
    }
    return playlists;
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

function renderArtistTracks(trackList) {
    var container = $('detail-tracks');
    container.innerHTML = '';
    if (!trackList || !trackList.length) return;

    var header = document.createElement('div');
    header.className = 'detail-tracks-header';
    header.innerHTML = '<span>Popular</span>';
    container.appendChild(header);

    var maxTracks = Math.min(trackList.length, 10);
    var isExpanded = false;

    function renderVisible() {
        var rows = container.querySelectorAll('.detail-track');
        rows.forEach(function(r, idx) {
            if (idx >= 5) {
                r.style.display = isExpanded ? '' : 'none';
            }
        });
        var showMore = container.querySelector('.artist-show-more');
        if (showMore) {
            showMore.textContent = isExpanded ? 'Show less' : 'Show more';
        }
    }

    for (var i = 0; i < maxTracks; i++) {
        (function(index) {
            var track = trackList[index];
            var el = document.createElement('div');
            el.className = 'detail-track';
            if (index >= 5) el.style.display = 'none';
            var artUrl = track.id ? withBase("/tracks/" + track.id + "/artwork") : null;
            el.innerHTML = `
                <span class="detail-track-num">${index + 1}</span>
                <div class="detail-track-body">
                    ${artUrl ? `<div class="detail-track-art"><img src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none'" /></div>` : ''}
                    <div class="detail-track-info">
                        <div class="detail-track-title">${escapeHtml(track.title || track.name || 'Unknown')}</div>
                        <div class="detail-track-artist">${escapeHtml(getArtistDisplay(track))}</div>
                    </div>
                </div>
                <span class="detail-track-duration">${formatDuration(track.duration || track.duration_ms)}</span>
            `;
            el.addEventListener('click', function() {
                queueSetList(trackList, index);
                playTrack(track);
            });
            container.appendChild(el);
        })(i);
    }

    if (trackList.length > 5) {
        var showMore = document.createElement('button');
        showMore.className = 'artist-show-more';
        showMore.textContent = 'Show more';
        showMore.addEventListener('click', function() {
            isExpanded = !isExpanded;
            renderVisible();
        });
        container.appendChild(showMore);
    }
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
            queueSetList(trackList, i);
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

async function refreshLibrary() {
    try {
        var data = await apiLoadPlaylists();
        if (data) {
            playlists = data;
            state.userPlaylists = data;
            renderLibraryItems(getFilteredLibraryItems());
        }
    } catch (e) {
        console.error('Failed to refresh library:', e);
    }
}

// ─── Detail View ─────────────────────────────────────
async function openDetail(item, type, isBackNavigation = false) {
    currentDetailId = item.id;
    currentDetailType = type;
    showPage('detail', type, item, isBackNavigation);
    var detailPage = $('page-detail');
    if (detailPage) detailPage.scrollTop = 0;
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
                : type === 'artist'
                    ? (item.image_url || null)
                    : withBase("/tracks/" + item.id + "/artwork");
        art.onerror = function() { this.style.display = 'none'; placeholder.style.display = 'flex'; };
        if (artUrl) {
            art.src = artUrl;
            art.style.display = 'block';
            placeholder.style.display = 'none';
        } else {
            art.style.display = 'none';
            placeholder.style.display = 'flex';
        }
        updateGradient($('detail-gradient'), artUrl);
    }

    title.textContent = item.title || item.name || 'Unknown';
    if (item.is_liked) {
        subtitle.textContent = 'Playlist';
    } else if (type === 'artist') {
        subtitle.textContent = 'Artist';
    } else if (type === 'playlist') {
        subtitle.textContent = item.is_public ? 'Public playlist' : 'Private playlist';
    } else if (type === 'album') {
        subtitle.textContent = 'Album';
    } else if (type === 'track') {
        subtitle.textContent = getArtistDisplay(item);
    }

    var albumsEl = $('detail-albums');
    var albumsGrid = $('detail-albums-grid');
    if (albumsEl) albumsEl.style.display = 'none';
    if (albumsGrid) albumsGrid.innerHTML = '';

    let tracksList = [];
    if (type === 'track') {
        tracksList = [item];
    } else if (type === 'artist') {
        try {
            const artistData = await api("/artists/" + item.id);
            renderArtistAlbums(artistData);
            if (artistData && artistData.tracks) {
                tracksList = [...artistData.tracks].sort(function(a, b) {
                    return (b.play_count || 0) - (a.play_count || 0);
                });
            }
        } catch (e) {
            console.error('Failed to load artist tracks:', e);
        }
    } else if (type === 'album') {
        try {
            const albumData = await api("/albums/" + item.id);
            if (albumData) {
                item.is_followed = albumData.is_followed;
                item.shuffle = albumData.shuffle;
            }
            tracksList = (albumData && albumData.tracks) ? albumData.tracks.map(t => t.track) : [];
            if (tracksList.length === 0) {
                const apiTracks = await api("/playlists/" + item.id + "/tracks");
                tracksList = apiTracks.map(t => t.track);
            }
        } catch (e) {
            console.error('Failed to load album tracks:', e);
        }
    } else {
        try {
            const apiTracks = await api("/playlists/" + item.id + "/tracks");
            tracksList = apiTracks.map(t => t.track);
        } catch (e) {
            console.error('Failed to load tracks:', e);
        }
    }
    if (type === 'artist') {
        renderArtistTracks(tracksList);
    } else {
        renderTracks(tracksList);
    }

    var followBtn = $('detail-follow-btn');
    var isLoggedIn = !!state.currentUser;
    if (type === 'track' || !isLoggedIn) {
        followBtn.style.display = 'none';
    } else if (type === 'playlist' && (!item.is_public || item.is_liked || item.is_owner)) {
        followBtn.style.display = 'none';
    } else {
        var isFollowed = type === 'artist'
            ? state.userPlaylists.some(function(p) { return p.type === 'artist' && p.id === item.id && p.is_followed; })
            : !!item.is_followed;
        followBtn.style.display = 'flex';
        function updateFollowUI() {
            if (isFollowed) {
                followBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #000; font-size: 14px; display: flex; align-items: center; justify-content: center;"></i>';
                followBtn.style.cssText = 'padding: 8px !important; width: 28px !important; height: 28px !important; background: #1db954 !important; border: none !important; border-radius: 50% !important; display: flex !important; align-items: center !important; justify-content: center !important;';
                followBtn.title = 'Unfollow ' + (type === 'artist' ? 'artist' : type === 'album' ? 'album' : 'playlist');
            } else {
                followBtn.innerHTML = '<i class="fa-solid fa-plus" style="color: #b3b3b3; font-size: 20px; display: flex; align-items: center; justify-content: center;"></i>';
                followBtn.style.cssText = 'padding: 8px !important; width: 28px !important; height: 28px !important; background: none !important; border: none !important; display: flex !important; align-items: center !important; justify-content: center !important;';
                followBtn.title = 'Follow ' + (type === 'artist' ? 'artist' : type === 'album' ? 'album' : 'playlist');
            }
        }
        updateFollowUI();
        followBtn.onclick = function() {
            if (isFollowed && type !== 'artist') {
                var overlay = $('confirm-overlay');
                var titleEl = $('confirm-title-text');
                var msgEl = $('confirm-message');
                var delBtn = $('confirm-delete-btn');
                var cancelBtn = $('confirm-cancel-btn');
                if (type === 'album') {
                    titleEl.textContent = 'Remove from Library?';
                    msgEl.textContent = 'Remove "' + (item.title || item.name) + '" from your library?';
                    delBtn.textContent = 'Remove';
                } else {
                    titleEl.textContent = 'Unfollow Playlist?';
                    msgEl.textContent = 'Unfollow "' + (item.title || item.name) + '"?';
                    delBtn.textContent = 'Unfollow';
                }
                overlay.style.display = 'flex';
                delBtn.onclick = async function() {
                    overlay.style.display = 'none';
                    delBtn.onclick = null;
                    cancelBtn.onclick = null;
                    try {
                        if (type === 'album') await unfollowAlbum(item.id);
                        else await unfollowPlaylist(item.id);
                        item.is_followed = false;
                        isFollowed = false;
                        await refreshLibrary();
                        updateFollowUI();
                    } catch (e) { console.error('Unfollow failed:', e); }
                };
                cancelBtn.onclick = function() {
                    overlay.style.display = 'none';
                    delBtn.onclick = null;
                    cancelBtn.onclick = null;
                };
                return;
            }
            followAction();
        };
        async function followAction() {
            try {
                if (isFollowed) {
                    if (type === 'artist') await unfollowArtist(item.id);
                } else {
                    if (type === 'playlist') await followPlaylist(item.id);
                    else if (type === 'album') await followAlbum(item.id);
                    else if (type === 'artist') await followArtist(item.id);
                }
                isFollowed = !isFollowed;
                if (type === 'artist') {
                    await refreshLibrary();
                    isFollowed = state.userPlaylists.some(function(p) { return p.type === 'artist' && p.id === item.id && p.is_followed; });
                } else {
                    item.is_followed = isFollowed;
                    await refreshLibrary();
                }
                updateFollowUI();
            } catch (e) { console.error('Follow action failed:', e); }
        }
    }

    $('detail-play-btn').onclick = () => {
        if (tracksList.length > 0) {
            queueSetList(tracksList, 0);
            playTrack(queueCurrentTrack());
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
    if (item.shuffle !== undefined) {
        shuffle = !!item.shuffle;
        state.shuffle = shuffle;
    }
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
    syncLikeButtonMobile();

    // Verify like state with server
    const likeId = track.id || track.track_id;
    if (likeId && state.authHash) {
        apiCheckIfLiked(likeId).then(serverLiked => {
            if (serverLiked !== state.likedTrackIds.has(likeId)) {
                if (serverLiked) state.likedTrackIds.add(likeId);
                else state.likedTrackIds.delete(likeId);
                syncLikeButtonMobile();
            }
        }).catch(e => console.error('Failed to verify like state:', e));

        // Load track's playlist membership for in-playlist state
        loadTrackPlaylists(likeId).then(playlists => {
            const inRegular = playlists.some(pl =>
                !pl.is_liked && pl.is_owner && pl.type !== 'album' && pl.type !== 'artist'
            );
            if (inRegular) {
                state.trackIdsInRegularPlaylists.add(likeId);
            } else {
                state.trackIdsInRegularPlaylists.delete(likeId);
            }
            syncLikeButtonMobile();
        }).catch(e => console.error('Failed to load track playlists:', e));
    }

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

let repeatCount = 0;

function onTrackEnd() {
    if (repeatMode === 1) {
        repeatMode = 0;
        $('np-repeat').classList.remove('active', 'loop-twice');
        audio.currentTime = 0;
        audio.play();
        return;
    }
    if (repeatMode === 2) {
        if (repeatCount === 0) {
            repeatCount = 1;
            const dot = $('np-repeat').querySelector('.repeat-dot');
            if (dot) dot.style.display = 'none';
            audio.currentTime = 0;
            audio.play();
            return;
        } else {
            repeatCount = 0;
            $('np-repeat').classList.remove('active', 'loop-twice');
            repeatMode = 0;
            const dot = $('np-repeat').querySelector('.repeat-dot');
            if (dot) dot.style.display = '';
        }
    }
    let nextIndex;
    if (shuffle) {
        nextIndex = Math.floor(Math.random() * queueLength());
    } else {
        nextIndex = queueCurrentIndex() + 1;
    }
    if (nextIndex >= queueLength()) {
        isPlaying = false;
        updatePlayButtons();
        return;
    }
    queueJumpTo(nextIndex);
    queueSave();
    playTrack(queueCurrentTrack());
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
    if (queueLength() === 0) return;
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    const next = (queueCurrentIndex() - 1 + queueLength()) % queueLength();
    queueJumpTo(next);
    playTrack(queueCurrentTrack());
});

$('np-next').addEventListener('click', () => {
    if (queueLength() === 0) return;
    const next = (queueCurrentIndex() + 1) % queueLength();
    queueJumpTo(next);
    playTrack(queueCurrentTrack());
});

function syncShuffleUI() {
    const np = $('np-shuffle');
    const detail = $('detail-shuffle-btn');
    if (np) np.classList.toggle('active', shuffle);
    if (detail) detail.classList.toggle('active', shuffle);
}

$('np-shuffle').addEventListener('click', () => {
    shuffle = !shuffle;
    state.shuffle = shuffle;
    syncShuffleUI();
    savePlayerState();
});

$('detail-shuffle-btn').addEventListener('click', () => {
    shuffle = !shuffle;
    state.shuffle = shuffle;
    syncShuffleUI();
    savePlayerState();
    if (currentDetailId && currentDetailType === 'album') {
        updateAlbumShuffle(currentDetailId, shuffle);
    } else if (currentDetailId && currentDetailType === 'playlist') {
        togglePlaylistShuffle(currentDetailId, shuffle);
    }
});

$('np-repeat').addEventListener('click', () => {
    repeatMode = (repeatMode + 1) % 3;
    repeatCount = 0;
    $('np-repeat').classList.toggle('active', repeatMode > 0);
    $('np-repeat').classList.toggle('loop-twice', repeatMode === 2);
    const dot = $('np-repeat').querySelector('.repeat-dot');
    if (dot) dot.style.display = '';
});

// ─── Queue Panel ─────────────────────────────────────
function buildQueueItem(track, index, opts) {
    opts = opts || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    let className = 'np-queue-item';
    if (opts.isNext) className += ' next';
    if (opts.isCurrent) className += ' current';
    btn.className = className;
    btn.draggable = !opts.isCurrent;
    btn.dataset.index = index;
    btn.dataset.trackId = track && track.id != null ? String(track.id) : '';

    const artistText = getArtistDisplay(track) || 'Unknown';
    const seed = ((track.title || '') + ' ' + artistText).trim() || 'Openfy';

    const art = document.createElement('div');
    art.className = 'np-queue-art';
    art.style.setProperty('--queue-color', seededColor(seed));

    const img = document.createElement('img');
    img.alt = (track.title || 'Track') + ' artwork';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (track.id) {
        img.src = withBase('/tracks/' + track.id + '/artwork');
    }
    img.onerror = function() { img.remove(); };
    art.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'np-queue-meta';

    const titleEl = document.createElement('div');
    titleEl.className = 'np-queue-title';
    titleEl.textContent = track.title || '';

    const artistEl = document.createElement('div');
    artistEl.className = 'np-queue-artist';
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
            var safeName = escapeHtml(name || '');
            if (id) {
                return '<span class="clickable-artist" data-artist-id="' + id + '">' + safeName + '</span>';
            }
            return '<span>' + safeName + '</span>';
        }).join(', ');
    } else {
        artistEl.textContent = 'Unknown';
    }

    meta.appendChild(titleEl);
    meta.appendChild(artistEl);

    const badge = document.createElement('div');
    badge.className = 'np-queue-badge';
    badge.textContent = opts.badgeText || '';
    if (!badge.textContent) badge.style.display = 'none';

    if (opts.isCurrent) {
        const nowPlayingBadge = document.createElement('span');
        nowPlayingBadge.className = 'np-queue-now-playing';
        nowPlayingBadge.innerHTML = '<i class="fa-solid fa-music"></i> Now Playing';
        meta.appendChild(nowPlayingBadge);
    }

    btn.appendChild(art);
    btn.appendChild(meta);
    btn.appendChild(badge);

    btn.addEventListener('click', function(ev) {
        ev.preventDefault();
        if (ev.target.closest('.clickable-artist')) return;
        const queue = queueGet();
        if (!queue || !queue.length) return;
        const idx = parseInt(btn.dataset.index, 10);
        if (idx < 0 || idx >= queue.length) return;
        queueJumpTo(idx);
        playTrack(queueCurrentTrack());
        queueSave();
    });

    btn.addEventListener('touchstart', function(e) {
        if (opts.isCurrent) return;
        state._touchDragStartY = e.touches[0].clientY;
        state._touchDragStartX = e.touches[0].clientX;
        state._touchDragSourceIndex = parseInt(btn.dataset.index, 10);
        state._touchDragElement = btn;
        state._touchDragging = false;
        state._touchDragGhost = null;

        longPressTimer = setTimeout(() => {
            navigator.vibrate && navigator.vibrate(20);
            showContextMenu(track, queueGet(), parseInt(btn.dataset.index, 10));
        }, 400);
    }, { passive: true });

    btn.addEventListener('touchmove', function(e) {
        if (state._touchDragSourceIndex === null || state._touchDragSourceIndex === undefined) return;
        if (opts.isCurrent) return;

        const touchY = e.touches[0].clientY;
        const touchX = e.touches[0].clientX;
        const deltaY = Math.abs(touchY - state._touchDragStartY);
        const deltaX = Math.abs(touchX - state._touchDragStartX);

        if (!state._touchDragging && (deltaY > 10 || deltaX > 10)) {
            state._touchDragging = true;
            clearTimeout(longPressTimer);

            const ghost = btn.cloneNode(true);
            ghost.classList.add('dragging');
            ghost.style.position = 'fixed';
            ghost.style.zIndex = '9999';
            ghost.style.width = btn.offsetWidth + 'px';
            ghost.style.pointerEvents = 'none';
            ghost.style.opacity = '0.85';
            ghost.style.transform = 'rotate(1deg) scale(1.02)';
            ghost.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
            ghost.style.left = (touchX - btn.offsetWidth / 2) + 'px';
            ghost.style.top = (touchY - btn.offsetHeight / 2) + 'px';
            document.body.appendChild(ghost);
            state._touchDragGhost = ghost;

            btn.classList.add('dragging');
            btn.style.opacity = '0.3';
        }

        if (state._touchDragging) {
            if (e.cancelable) e.preventDefault();
            state.lastDragY = touchY;

            if (state._touchDragGhost) {
                state._touchDragGhost.style.left = (touchX - state._touchDragGhost.offsetWidth / 2) + 'px';
                state._touchDragGhost.style.top = (touchY - state._touchDragGhost.offsetHeight / 2) + 'px';
            }

            updateTouchDragPosition();
        }
    }, { passive: false });

    btn.addEventListener('touchend', function(e) {
        clearTimeout(longPressTimer);

        if (state._touchDragging && state._touchDragGhost) {
            const sourceIndex = state._touchDragSourceIndex;

            const items = Array.from(queueSheetContent.querySelectorAll('.np-queue-item:not(.dragging)'));
            if (items.length > 0 && sourceIndex !== null) {
                let insertBeforeQueueIndex = null;
                const dragY = state.lastDragY;
                if (dragY !== null) {
                    for (const item of items) {
                        const rect = item.getBoundingClientRect();
                        if (dragY < rect.top + rect.height / 2) {
                            insertBeforeQueueIndex = parseInt(item.dataset.index, 10);
                            break;
                        }
                    }
                }

                let actualToIndex;
                if (insertBeforeQueueIndex === null) {
                    const lastItem = items[items.length - 1];
                    actualToIndex = lastItem ? parseInt(lastItem.dataset.index, 10) + 1 : queueGet().length;
                } else {
                    actualToIndex = insertBeforeQueueIndex;
                }

                if (actualToIndex !== sourceIndex) {
                    reorderQueueSilent(sourceIndex, actualToIndex);
                    const queue = queueGet();
                    const allItems = Array.from(queueSheetContent.querySelectorAll('.np-queue-item'));
                    allItems.forEach(el => {
                        const trackId = el.dataset.trackId;
                        const newIdx = queue.findIndex(t => t && t.id == trackId);
                        if (newIdx !== -1) el.dataset.index = newIdx;
                    });
                }
            }

            state._touchDragGhost.remove();
            state._touchDragGhost = null;
            btn.classList.remove('dragging');
            btn.style.opacity = '';

            document.querySelectorAll('.np-queue-item.drag-over').forEach(el => {
                el.classList.remove('drag-over');
            });
            document.querySelectorAll('.np-queue-item').forEach(el => {
                el.style.transform = '';
                el.style.transition = '';
            });

            state._touchDragging = false;
            state._touchDragSourceIndex = null;
            state._touchDragElement = null;
            state.lastDragY = null;
            state.lastInsertBeforeEl = null;
        } else {
            state._touchDragStartY = null;
            state._touchDragStartX = null;
            state._touchDragSourceIndex = null;
            state._touchDragElement = null;
            state._touchDragging = false;
        }
    }, { passive: true });

    btn.addEventListener('touchcancel', function() {
        clearTimeout(longPressTimer);
        if (state._touchDragGhost) {
            state._touchDragGhost.remove();
            state._touchDragGhost = null;
        }
        btn.classList.remove('dragging');
        btn.style.opacity = '';
        document.querySelectorAll('.np-queue-item.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
        state._touchDragging = false;
        state._touchDragSourceIndex = null;
        state._touchDragElement = null;
        state.lastDragY = null;
        state.lastInsertBeforeEl = null;
    }, { passive: true });

    return btn;
}

function renderNowPlayingQueue() {
    const npQueueNext = $('queue-sheet-content');
    if (!npQueueNext) return;

    const queue = queueGet();
    const currentIndex = queueCurrentIndex();

    if (!queue || !queue.length || currentIndex < 0) {
        npQueueNext.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'np-queue-empty';
        empty.textContent = 'Play something to build a queue.';
        npQueueNext.appendChild(empty);
        state.lastRenderedIndices = [];
        return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) {
        npQueueNext.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'np-queue-empty';
        empty.textContent = 'End of queue.';
        npQueueNext.appendChild(empty);
        state.lastRenderedIndices = [];
        return;
    }

    const visibleCount = state.showFullQueue ? 6 : 1;
    const windowStart = nextIndex;
    const windowEnd = Math.min(nextIndex + visibleCount, queue.length);
    const newIndices = [];
    for (let i = windowStart; i < windowEnd; i++) newIndices.push(i);

    const oldRectsByTrackId = new Map();
    npQueueNext.querySelectorAll('.np-queue-item').forEach(el => {
        const trackId = el.dataset.trackId;
        if (trackId) oldRectsByTrackId.set(trackId, el.getBoundingClientRect());
    });

    npQueueNext.innerHTML = '';
    const mountedItems = [];

    newIndices.forEach(idx => {
        const track = queue[idx];
        const el = buildQueueItem(track, idx, { isCurrent: false, badgeText: '' });
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

function showQueueSheet() {
    state.showFullQueue = true;
    $('queue-sheet-title').textContent = 'QUEUE';
    $('queue-sheet').classList.add('expanded');
    $('queue-sheet-overlay').style.display = '';
    $('queue-sheet').style.display = '';
    
    // Force reflow then add visible class for smooth transition
    void $('queue-sheet').offsetHeight;
    $('queue-sheet-overlay').classList.add('visible');
    $('queue-sheet').classList.add('visible');
    
    // Render queue after sheet starts sliding up
    requestAnimationFrame(() => {
        renderNowPlayingQueue();
    });
}

function hideQueueSheet() {
    state.showFullQueue = false;
    $('queue-sheet').classList.remove('expanded');
    $('queue-sheet').style.transform = '';
    $('queue-sheet').style.transition = '';
    $('queue-sheet-overlay').classList.remove('visible');
    $('queue-sheet').classList.remove('visible');
    setTimeout(() => {
        $('queue-sheet-overlay').style.display = 'none';
        $('queue-sheet').style.display = 'none';
    }, 350);
}

$('np-queue-btn').addEventListener('click', () => {
    showQueueSheet();
});

// Queue sheet swipe-to-close
let queueSwipeStartY = 0;
let queueSwipeCurrentY = 0;
let isQueueSwiping = false;

$('queue-sheet').addEventListener('touchstart', function(e) {
    const content = $('queue-sheet-content');
    const isAtTop = content && content.scrollTop <= 0;
    if (e.target.closest('.np-queue-item') || !isAtTop) return;
    queueSwipeStartY = e.touches[0].clientY;
    isQueueSwiping = true;
    $('queue-sheet').style.transition = 'none';
}, { passive: true });

$('queue-sheet').addEventListener('touchmove', function(e) {
    if (!isQueueSwiping) return;
    queueSwipeCurrentY = e.touches[0].clientY;
    const deltaY = queueSwipeCurrentY - queueSwipeStartY;
    if (deltaY > 0) {
        if (e.cancelable) e.preventDefault();
        $('queue-sheet').style.transform = 'translateY(' + deltaY + 'px)';
    }
}, { passive: false });

$('queue-sheet').addEventListener('touchend', function() {
    if (!isQueueSwiping) return;
    isQueueSwiping = false;
    const deltaY = queueSwipeCurrentY - queueSwipeStartY;
    if (deltaY > 80) {
        $('queue-sheet').style.transition = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
        $('queue-sheet').style.transform = 'translateY(100%)';
        setTimeout(() => {
            $('queue-sheet').style.transform = '';
            $('queue-sheet').style.transition = '';
            hideQueueSheet();
        }, 350);
    } else {
        $('queue-sheet').style.transition = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
        $('queue-sheet').style.transform = '';
        setTimeout(() => {
            $('queue-sheet').style.transition = '';
        }, 350);
    }
    queueSwipeStartY = 0;
    queueSwipeCurrentY = 0;
});

$('queue-sheet-header').addEventListener('click', function(e) {
    e.preventDefault();
    const h3 = $('queue-sheet-title');
    const collapseDelay = 280;

    if (state.showFullQueue) {
        state.showFullQueue = false;
        h3.textContent = 'NEXT IN QUEUE';
        $('queue-sheet').classList.remove('expanded');
        state.collapseTimeout = setTimeout(function() {
            state.collapseTimeout = null;
            renderNowPlayingQueue();
        }, collapseDelay);
    } else {
        state.showFullQueue = true;
        h3.textContent = 'QUEUE';
        $('queue-sheet').classList.add('expanded');
        renderNowPlayingQueue();
    }
});

$('queue-sheet-overlay').addEventListener('click', () => {
    hideQueueSheet();
});

const queueSheetContent = $('queue-sheet-content');

$('queue-sheet-content').addEventListener('click', function(e) {
    const artistSpan = e.target.closest('.clickable-artist');
    if (artistSpan && artistSpan.dataset.artistId) {
        e.stopPropagation();
        e.preventDefault();
        const artistId = artistSpan.dataset.artistId;
        hideQueueSheet();
        openDetail({ id: artistId, type: 'artist', name: '' }, 'artist');
    }
});

let longPressTimer = null;

// ─── Like Button: tap=toggle liked, long press=playlist sheet ─────
(function() {
    let pressTimer = null;
    let longPressDone = false;
    const likeBtn = $('np-like-btn');

    function startPress() {
        longPressDone = false;
        pressTimer = setTimeout(function() {
            longPressDone = true;
            if (navigator.vibrate) navigator.vibrate(50);
            if (!currentTrack) return;
            if (!state.authHash) {
                alert('Please log in to manage playlists.');
                return;
            }
            showPlaylistSheet();
        }, 500);
    }

    function endPress(e) {
        clearTimeout(pressTimer);
        if (longPressDone) {
            e.preventDefault();
        }
    }

    function cancelPress() {
        clearTimeout(pressTimer);
    }

    likeBtn.addEventListener('touchstart', startPress, { passive: true });
    likeBtn.addEventListener('touchend', endPress);
    likeBtn.addEventListener('touchcancel', cancelPress);
    likeBtn.addEventListener('mousedown', startPress);
    likeBtn.addEventListener('mouseup', endPress);
    likeBtn.addEventListener('mouseleave', cancelPress);

    likeBtn.addEventListener('click', function(e) {
        if (longPressDone) {
            e.preventDefault();
            e.stopPropagation();
            longPressDone = false;
            return;
        }
        if (!currentTrack) return;
        if ($('np-like-btn').classList.contains('liked')) {
            if (!state.authHash) {
                alert('Please log in to manage playlists.');
                return;
            }
            showPlaylistSheet();
        } else {
            toggleLikeTrack();
        }
    });
})();

function syncLikeButtonMobile() {
    if (!currentTrack) return;
    const tid = currentTrack.id || currentTrack.track_id;
    const btn = $('np-like-btn');
    btn.classList.remove('liked', 'in-playlist');
    const icon = btn.querySelector('i');
    if (state.likedTrackIds.has(tid)) {
        isLiked = true;
        btn.classList.add('liked');
        icon.className = 'fa-solid fa-heart';
    } else if (state.trackIdsInRegularPlaylists.has(tid)) {
        isLiked = false;
        btn.classList.add('in-playlist');
    } else {
        isLiked = false;
        icon.className = 'fa-regular fa-heart';
    }
}

async function toggleLikeTrack() {
    if (!currentTrack) return;
    var tid = currentTrack.id || currentTrack.track_id;
    isLiked = !isLiked;
    $('np-like-btn').classList.remove('in-playlist');
    $('np-like-btn').classList.toggle('liked', isLiked);
    $('np-like-btn').querySelector('i').className = isLiked ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    if (isLiked) state.likedTrackIds.add(tid);
    else state.likedTrackIds.delete(tid);
    try {
        await toggleLiked(tid);
    } catch (e) {
        isLiked = !isLiked;
        $('np-like-btn').classList.remove('in-playlist');
        $('np-like-btn').classList.toggle('liked', isLiked);
        if (isLiked) state.likedTrackIds.add(tid);
        else state.likedTrackIds.delete(tid);
    }
    syncLikeButtonMobile();
}

// ─── Playlist Sheet ──────────────────────────────────
async function showPlaylistSheet() {
    const overlay = $('playlist-sheet-overlay');
    const sheet = $('playlist-sheet');
    const items = $('playlist-sheet-items');
    const searchInput = $('playlist-sheet-search-input');

    overlay.style.display = 'block';
    sheet.style.display = 'flex';
    searchInput.value = '';
    items.innerHTML = '<div class="playlist-sheet-empty">Loading...</div>';
    overlay.offsetHeight;
    overlay.classList.add('visible');
    sheet.classList.add('visible');

    try {
        const playlistsRes = await api('/playlists');
        sheetPlaylists = playlistsRes.filter(pl => {
            if (pl.is_liked) return false;
            if (pl.type === 'artist') return false;
            if (pl.type === 'album') return false;
            if (!pl.is_owner) return false;
            return true;
        });

        sheetOriginalInPlaylist.clear();
        sheetPendingInPlaylist.clear();

        const tid = currentTrack.id || currentTrack.track_id;
        if (tid) {
            try {
                const trackPlaylists = await loadTrackPlaylists(tid);
                for (const pl of trackPlaylists) {
                    sheetOriginalInPlaylist.add(pl.id);
                    sheetPendingInPlaylist.add(pl.id);
                }
            } catch (e) {
                console.warn('Could not fetch track playlists:', e);
            }
        }

        if (state.likedTrackIds.has(tid)) {
            sheetOriginalInPlaylist.add('liked');
            sheetPendingInPlaylist.add('liked');
        }

        buildSheetItems();
        updateSheetConfirmButton();
    } catch (err) {
        console.error('Failed to load playlists for sheet:', err);
        items.innerHTML = '<div class="playlist-sheet-empty">Failed to load playlists</div>';
    }
}

function hidePlaylistSheet() {
    const overlay = $('playlist-sheet-overlay');
    const sheet = $('playlist-sheet');
    sheet.style.transform = '';
    sheet.style.transition = '';
    overlay.classList.remove('visible');
    sheet.classList.remove('visible');
    const onTransitionEnd = function () {
        overlay.style.display = 'none';
        sheet.style.display = 'none';
        sheet.removeEventListener('transitionend', onTransitionEnd);
    };
    sheet.addEventListener('transitionend', onTransitionEnd);
    $('playlist-sheet-search-input').value = '';
    sheetPlaylists = [];
    sheetOriginalInPlaylist.clear();
    sheetPendingInPlaylist.clear();
}

function buildSheetItems(filter = '') {
    const items = $('playlist-sheet-items');
    items.innerHTML = '';
    const filterLower = filter.toLowerCase();

    // Liked Songs row
    const likedItem = document.createElement('div');
    likedItem.className = 'playlist-sheet-item';
    likedItem.dataset.playlistId = 'liked';
    if (!filterLower) {
        const thumb = document.createElement('div');
        thumb.className = 'sheet-thumb';
        const gradient = document.createElement('div');
        gradient.className = 'liked-gradient';
        gradient.innerHTML = '<i class="fa-solid fa-heart"></i>';
        thumb.appendChild(gradient);
        likedItem.appendChild(thumb);

        const name = document.createElement('div');
        name.className = 'sheet-name';
        name.textContent = 'Liked Songs';
        likedItem.appendChild(name);

        const checkbox = document.createElement('div');
        checkbox.className = 'sheet-checkbox' + (sheetPendingInPlaylist.has('liked') ? ' checked' : '');
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSheetPlaylist('liked', checkbox);
        });
        likedItem.appendChild(checkbox);

        likedItem.addEventListener('click', () => {
            toggleSheetPlaylist('liked', checkbox);
        });

        items.appendChild(likedItem);
    }

    const filtered = sheetPlaylists.filter(pl => {
        return pl.name.toLowerCase().includes(filterLower);
    });

    if (filtered.length === 0 && !filterLower) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'playlist-sheet-empty';
        emptyMsg.textContent = 'No playlists yet';
        items.appendChild(emptyMsg);
        return;
    }

    if (filtered.length === 0 && filterLower) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'playlist-sheet-empty';
        emptyMsg.textContent = 'No playlists match your search';
        items.appendChild(emptyMsg);
        return;
    }

    filtered.forEach(pl => {
        const item = document.createElement('div');
        item.className = 'playlist-sheet-item';
        item.dataset.playlistId = pl.id;

        const thumb = document.createElement('div');
        thumb.className = 'sheet-thumb';
        const coverUrl = withBase('/playlists/' + pl.id + '/cover');
        const img = document.createElement('img');
        img.src = coverUrl;
        img.alt = pl.name;
        img.onerror = function () {
            img.style.display = 'none';
            thumb.innerHTML = '<i class="fa-solid fa-list" style="color:#b3b3b3;font-size:1.2rem;"></i>';
        };
        thumb.appendChild(img);
        item.appendChild(thumb);

        const name = document.createElement('div');
        name.className = 'sheet-name';
        name.textContent = pl.name;
        item.appendChild(name);

        const checkbox = document.createElement('div');
        checkbox.className = 'sheet-checkbox' + (sheetPendingInPlaylist.has(pl.id) ? ' checked' : '');
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSheetPlaylist(pl.id, checkbox);
        });
        item.appendChild(checkbox);

        item.addEventListener('click', () => {
            toggleSheetPlaylist(pl.id, checkbox);
        });

        items.appendChild(item);
    });
}

function toggleSheetPlaylist(playlistId, checkboxEl) {
    const currentlyChecked = checkboxEl.classList.contains('checked');
    if (currentlyChecked) {
        sheetPendingInPlaylist.delete(playlistId);
        checkboxEl.classList.remove('checked');
    } else {
        sheetPendingInPlaylist.add(playlistId);
        checkboxEl.classList.add('checked');
    }
    updateSheetConfirmButton();
}

function updateSheetConfirmButton() {
    const hasChanges = sheetSetsDiffer();
    $('playlist-sheet-confirm').style.display = hasChanges ? 'block' : 'none';
}

function sheetSetsDiffer() {
    if (sheetPendingInPlaylist.size !== sheetOriginalInPlaylist.size) return true;
    for (const v of sheetPendingInPlaylist) if (!sheetOriginalInPlaylist.has(v)) return true;
    for (const v of sheetOriginalInPlaylist) if (!sheetPendingInPlaylist.has(v)) return true;
    return false;
}

async function applySheetChanges() {
    const tid = currentTrack.id || currentTrack.track_id;
    if (!tid) return;

    const toAdd = new Set();
    const toRemove = new Set();

    for (const id of sheetPendingInPlaylist) {
        if (!sheetOriginalInPlaylist.has(id)) toAdd.add(id);
    }
    for (const id of sheetOriginalInPlaylist) {
        if (!sheetPendingInPlaylist.has(id)) toRemove.add(id);
    }

    try {
        for (const pid of toAdd) {
            if (pid === 'liked') {
                await toggleLiked(tid);
                state.likedTrackIds.add(tid);
            } else {
                await addTrackToPlaylist(pid, tid);
                state.trackIdsInRegularPlaylists.add(tid);
            }
        }
        for (const pid of toRemove) {
            if (pid === 'liked') {
                await toggleLiked(tid);
                state.likedTrackIds.delete(tid);
            } else {
                await removeTrackFromPlaylist(pid, tid);
                state.trackIdsInRegularPlaylists.delete(tid);
            }
        }

        // Update like button UI
        syncLikeButtonMobile();

        hidePlaylistSheet();
    } catch (e) {
        console.error('Failed to apply playlist changes:', e);
        alert('Failed to update playlists: ' + e.message);
    }
}

$('playlist-sheet-overlay').addEventListener('click', hidePlaylistSheet);
$('playlist-sheet-cancel').addEventListener('click', hidePlaylistSheet);
$('playlist-sheet-confirm').addEventListener('click', applySheetChanges);

// Playlist sheet swipe-to-close
let playlistSwipeStartY = 0;
let playlistSwipeCurrentY = 0;
let isPlaylistSwiping = false;

$('playlist-sheet').addEventListener('touchstart', function(e) {
    const items = $('playlist-sheet-items');
    const isAtTop = items && items.scrollTop <= 0;
    if (!isAtTop) return;
    playlistSwipeStartY = e.touches[0].clientY;
    isPlaylistSwiping = true;
    $('playlist-sheet').style.transition = 'none';
}, { passive: true });

$('playlist-sheet').addEventListener('touchmove', function(e) {
    if (!isPlaylistSwiping) return;
    playlistSwipeCurrentY = e.touches[0].clientY;
    const deltaY = playlistSwipeCurrentY - playlistSwipeStartY;
    if (deltaY > 0) {
        if (e.cancelable) e.preventDefault();
        $('playlist-sheet').style.transform = 'translateY(' + deltaY + 'px)';
    }
}, { passive: false });

$('playlist-sheet').addEventListener('touchend', function() {
    if (!isPlaylistSwiping) return;
    isPlaylistSwiping = false;
    const deltaY = playlistSwipeCurrentY - playlistSwipeStartY;
    if (deltaY > 80) {
        $('playlist-sheet').style.transition = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
        $('playlist-sheet').style.transform = 'translateY(100%)';
        setTimeout(() => {
            $('playlist-sheet').style.transform = '';
            $('playlist-sheet').style.transition = '';
            hidePlaylistSheet();
        }, 350);
    } else {
        $('playlist-sheet').style.transition = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
        $('playlist-sheet').style.transform = '';
        setTimeout(() => {
            $('playlist-sheet').style.transition = '';
        }, 350);
    }
    playlistSwipeStartY = 0;
    playlistSwipeCurrentY = 0;
});
$('playlist-sheet-search-input').addEventListener('input', () => {
    clearTimeout(sheetSearchTimeout);
    sheetSearchTimeout = setTimeout(() => {
        buildSheetItems($('playlist-sheet-search-input').value);
    }, 200);
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
        currentLibraryFilter = btn.dataset.filter;
        renderLibraryItems(getFilteredLibraryItems());
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
