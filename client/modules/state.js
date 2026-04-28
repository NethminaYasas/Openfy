export const state = {
  apiBase: localStorage.getItem("openfy_api") || "",
  authHash: localStorage.getItem("openfy_auth") || "",
  currentUser: null,
  isAdmin: false,
  currentPlaylistId: null,
  userPlaylists: [],
  
  currentQueue: [],
  currentIndex: -1,
  currentTrackId: null,
  currentPlayingPlaylistId: null,
  repeatState: "off",
  repeatCount: 0,
  shuffle: false,
  queueOriginal: null,
  
  scrollPositions: {},
  manualAudioUploadEnabled: true,
  
  currentStreamToken: null,
  currentStreamTokenTrackId: null,
  
  existingLibraryTracks: new Set(),
  existingMostPlayedTracks: new Set(),
  
  trackIdsInRegularPlaylists: new Set(),
  likedTrackIds: new Set(),
  
  lastTrackUpdate: 0,
  lastSearchResults: [],
  
  showFullQueue: false,
  collapseTimeout: null,
  
  currentContextPlaylist: null,
  currentContextTrack: null,
  currentContextQueueIndex: null,
  currentTrackContextFromQueuePanel: false,
  pendingActionPlaylistId: null,
  
  dragSourceIndex: null,
  draggedElement: null,
  lastInsertBeforeEl: null,
  lastRenderedIndices: [],
  
  trackPlaylistRemovalMenu: null,
  currentTrackPlaylistsCache: [],
  
  updateCheckInterval: null,
  activeDownloadPoll: null,
  
  searchDebounceTimer: null,
  queueSaveTimeout: null,
  tracksInitTimeout: null,
  uploadsInitTimeout: null,
  mostPlayedInitTimeout: null,
  
  currentTimeout: null,
  submenuSearchTimeout: null,
  lastDragY: null,
  
  lastPlaylistResults: [],
};

export function withBase(path) {
  return state.apiBase ? state.apiBase + path : path;
}

export function apiHeaders() {
  const h = {};
  if (state.authHash) h["x-auth-hash"] = state.authHash;
  return h;
}

export function setAuth(authHash, user) {
  state.authHash = authHash;
  state.currentUser = user;
  state.isAdmin = user.is_admin || false;
  localStorage.setItem("openfy_auth", authHash);
}

export function clearAuth() {
  state.authHash = "";
  state.currentUser = null;
  state.isAdmin = false;
  localStorage.removeItem("openfy_auth");
}

export function updateUser(user) {
  state.currentUser = user;
  if (user) {
    state.isAdmin = user.is_admin || false;
  }
}