import { state, withBase, apiHeaders, setAuth } from './state.js';

export async function api(url, opts) {
  opts = opts || {};
  const headers = Object.assign({}, apiHeaders(), opts.headers || {});
  if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  console.log("API request:", url, "Headers:", headers);
  const res = await fetch(withBase(url), Object.assign({}, opts, { headers: headers }));
  console.log("API response status:", res.status);
  if (!res.ok) {
    const text = await res.text();
    console.log("API error body:", text);
    throw new Error(text || ("HTTP " + res.status));
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export async function getTrackStreamUrl(trackId) {
  if (!state.authHash) throw new Error("Not authenticated");
  if (!state.currentStreamToken || state.currentStreamTokenTrackId !== trackId) {
    const tokenRes = await api("/tracks/" + trackId + "/stream-token");
    state.currentStreamToken = tokenRes.token;
    state.currentStreamTokenTrackId = trackId;
  }
  return withBase("/tracks/" + trackId + "/stream?token=" + encodeURIComponent(state.currentStreamToken));
}

export async function setAuthenticatedImage(img, path, onFailure) {
  try {
    const response = await fetch(withBase(path), { headers: apiHeaders() });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const blob = await response.blob();
    if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(blob);
    img.dataset.objectUrl = objectUrl;
    img.src = objectUrl;
  } catch (err) {
    if (onFailure) onFailure(err);
  }
}

export async function loadTracks() {
  try { var data = await api("/tracks?limit=24"); return Array.isArray(data) ? data : []; } catch (err) { console.error(err); return []; }
}

export async function loadUserUploads() {
  if (!state.authHash) return [];
  try {
    var url = "/tracks?limit=24&user_hash=" + encodeURIComponent(state.authHash);
    var data = await api(url);
    return Array.isArray(data) ? data : [];
  } catch (err) { console.error(err); return []; }
}

export async function loadMostPlayed() {
  try {
    var data = await api("/tracks/most-played?limit=9");
    return Array.isArray(data) ? data : [];
  } catch (err) { console.error(err); return []; }
}

export async function loadLastTrackPaused() {
  if (!state.authHash) return null;
  try {
    var data = await api("/user/last-track");
    if (data && data.id) {
      return data;
    }
  } catch (err) { console.error("Failed to load last track:", err); }
  return null;
}

export async function loadUserQueue() {
  if (!state.authHash) return false;
  try {
    const data = await api("/user/queue");
    if (!data || !data.queue || !data.queue.length) return false;
    const trackIds = data.queue;
    const savedIndex = data.current_index || 0;
    const tracksResponse = await api("/tracks/batch?ids=" + encodeURIComponent(trackIds.join(",")));
    const tracks = Array.isArray(tracksResponse) ? tracksResponse : [];
    if (tracks.length) {
      return { tracks, index: Math.min(savedIndex, tracks.length - 1) };
    }
    return false;
  } catch (err) {
    console.error("Failed to load user queue:", err);
    return false;
  }
}

export async function loadUserPlayerState() {
  if (!state.authHash) return;
  try {
    const data = await api("/user/player-state");
    if (data) {
      if (data.shuffle !== undefined) {
        state.shuffle = !!data.shuffle;
      }
      if (data.repeat_state) {
        state.repeatState = data.repeat_state;
      }
    }
  } catch (err) { console.error("Failed to load player state:", err); }
}

export async function saveQueueToServer() {
  if (!state.authHash) return;
  try {
    const payload = {
      track_ids: state.currentQueue.map(t => t.id),
      current_index: state.currentIndex
    };
    await api("/user/queue", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Failed to save queue:", err);
  }
}

export async function savePlayerState() {
  if (!state.authHash) return;
  api("/user/player-state", {
    method: "PUT",
    body: JSON.stringify({ shuffle: state.shuffle, repeat_state: state.repeatState })
  }).catch(err => console.error("Failed to save player state:", err));
}

export async function uploadFromFile(file) {
  if (!state.manualAudioUploadEnabled) {
    throw new Error("Manual audio file uploads are currently disabled by admin.");
  }
  if (!state.currentUser || (!state.currentUser.is_admin && !state.currentUser.upload_enabled)) {
    throw new Error("Uploads are disabled for your account.");
  }
  const formData = new FormData();
  formData.append("file", file);
  await api("/tracks/upload", {
    method: "POST",
    body: formData
  });
}

export async function downloadFromLink(url) {
  if (!state.currentUser || (!state.currentUser.is_admin && !state.currentUser.upload_enabled)) {
    throw new Error("Uploads are disabled for your account.");
  }
  var jobData = await api("/downloads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: url, source: "spotiflac" }) });
  return jobData.id;
}

export async function pollJobStatus(jobId) {
  return await api("/downloads/" + jobId);
}

export async function runSearch(query) {
  const q = query;
  var data = await api("/search?q=" + encodeURIComponent(q) + "&limit=12");
  return Array.isArray(data) ? data : [];
}

export async function checkForTrackUpdates() {
  try {
    var response = await api("/tracks/updates?since=" + state.lastTrackUpdate);
    if (response.has_updates) {
      console.log("New tracks detected, refreshing...");
      state.lastTrackUpdate = response.timestamp;
      return true;
    }
  } catch (err) {
    console.error("Error checking for updates:", err);
  }
  return false;
}

export async function refreshManualUploadSetting() {
  if (!state.authHash) {
    state.manualAudioUploadEnabled = true;
    return;
  }
  try {
    const data = await api("/system/settings");
    const enabled = !!data.manual_audio_upload_enabled;
    state.manualAudioUploadEnabled = enabled;
  } catch (err) {
    console.error("Failed to load system settings:", err);
    state.manualAudioUploadEnabled = true;
  }
}

export async function checkIfLiked(trackId) {
  if (!state.authHash) return false;
  try {
    const res = await api("/liked/" + trackId);
    return res.liked;
  } catch (e) {
    console.error("checkIfLiked error:", e);
    return false;
  }
}

export async function loadPlaylists() {
  var url = "/playlists";
  url += (url.includes('?') ? '&' : '?') + '_=' + Date.now();
  return await api(url);
}

export async function loadUserPlaylists() {
  return await api("/playlists");
}

export async function updateRegularPlaylistTrackCache() {
  state.trackIdsInRegularPlaylists.clear();
  state.likedTrackIds.clear();
  const regularPlaylists = state.userPlaylists.filter(pl => !pl.is_liked);
  const likedPlaylist = state.userPlaylists.find(pl => pl.is_liked);
  const results = await Promise.all(
    regularPlaylists.map(async (pl) => {
      try {
        const tracks = await api("/playlists/" + pl.id + "/tracks");
        return tracks.map(pt => pt.track.id);
      } catch (e) {
        console.error("Failed to load tracks for playlist:", pl.name, e);
        return [];
      }
    })
  );
  results.forEach(ids => { for (const id of ids) state.trackIdsInRegularPlaylists.add(id); });
  if (likedPlaylist) {
    try {
      const tracks = await api("/playlists/" + likedPlaylist.id + "/tracks");
      for (const pt of tracks) state.likedTrackIds.add(pt.track.id);
    } catch (e) {
      console.error("Failed to load liked tracks", e);
    }
  }
}

export async function loadTrackPlaylists(trackId) {
  return await api("/tracks/" + trackId + "/playlists");
}

export async function tryAutoLogin() {
  if (!state.authHash) { console.log("No auth hash stored"); return null; }
  try {
    var url = withBase("/auth/me");
    console.log("Auto-login fetching:", url, "with hash:", state.authHash);
    var res = await fetch(url, { headers: { "x-auth-hash": state.authHash } });
    console.log("Auto-login response status:", res.status);
    if (res.ok) {
      var user = await res.json();
      console.log("Auto-login user:", user);
      if (user && user.name) {
        return user;
      }
    } else {
      var errText = await res.text();
      console.log("Auto-login failed:", res.status, errText);
    }
  } catch (err) {
    console.error("Auto-login error:", err);
  }
  return null;
}

export async function signUp(name) {
  var user = await api("/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
  return user;
}

export async function signIn(hash) {
  var user = await api("/auth/signin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth_hash: hash }) });
  return user;
}

export async function createPlaylist(name) {
  return await api("/playlists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) });
}

export async function renamePlaylist(playlistId, name) {
  return await api("/playlists/" + playlistId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) });
}

export async function deletePlaylist(playlistId) {
  return await api("/playlists/" + playlistId, { method: "DELETE" });
}

export async function togglePlaylistPin(playlistId, pinned) {
  return await api("/playlists/" + playlistId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: pinned }) });
}

export async function togglePlaylistVisibility(playlistId, isPublic) {
  return await api("/playlists/" + playlistId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_public: isPublic }) });
}

export async function togglePlaylistShuffle(playlistId, shuffle) {
  return await api("/playlists/" + playlistId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shuffle: shuffle }) });
}

export async function addTrackToPlaylist(playlistId, trackId) {
  return await api("/playlists/" + playlistId + "/tracks?track_id=" + trackId, { method: "POST" });
}

export async function removeTrackFromPlaylist(playlistId, trackId) {
  return await api("/playlists/" + playlistId + "/tracks/" + trackId, { method: "DELETE" });
}

export async function toggleLiked(trackId) {
  return await api("/liked/" + trackId, { method: "POST" });
}

export async function isTrackInAnyRegularPlaylist(trackId) {
  if (state.trackIdsInRegularPlaylists.size > 0) {
    return state.trackIdsInRegularPlaylists.has(trackId);
  }
  const regularPlaylists = state.userPlaylists.filter(pl => !pl.is_liked);
  for (const pl of regularPlaylists) {
    try {
      const tracks = await api("/playlists/" + pl.id + "/tracks");
      if (tracks.some(pt => pt.track.id === trackId)) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

export async function loadAdminStats() {
  if (!state.isAdmin) return;
  return await api("/admin/stats");
}

export async function loadAdminSettings() {
  if (!state.isAdmin) return;
  return await api("/admin/settings");
}

export async function updateAdminSettings(settings) {
  if (!state.isAdmin) return;
  return await api("/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
}

export async function loadUsersList(searchQuery = "") {
  const url = searchQuery.trim() ? `/admin/users?q=${encodeURIComponent(searchQuery.trim())}` : "/admin/users";
  return await api(url);
}

export async function deleteUser(userId) {
  return await api(`/admin/users/${userId}`, { method: "DELETE" });
}

export async function loadTracksList(searchQuery = "") {
  const url = searchQuery.trim() ? `/admin/tracks?q=${encodeURIComponent(searchQuery.trim())}` : "/admin/tracks";
  return await api(url);
}

export async function deleteTrack(trackId) {
  return await api(`/admin/tracks/${trackId}`, { method: "DELETE" });
}

export async function updateLibraryState(minimized) {
  return await api("/user/library-state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ library_minimized: minimized }) });
}

export async function updateUploadPreference(enabled) {
  return await api("/user/upload-preference", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upload_enabled: enabled }) });
}