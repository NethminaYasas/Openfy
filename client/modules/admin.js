import { state } from './state.js';
import { loadAdminStats, loadAdminSettings, updateAdminSettings, loadUsersList, deleteUser, loadTracksList, deleteTrack, loadAlbumsList, deleteAlbum, loadAdminRegistrationMode, updateAdminRegistrationMode, createInvite, loadInvites, revokeInvite } from './api.js';
import { formatDuration, escapeHtml } from './utils.js';
import { applyPlaylistImportUI, setActivePage } from './ui.js';

export function updateAdminButtonVisibility() {
  const adminBtn = document.getElementById("admin-btn");
  if (adminBtn) {
    adminBtn.style.display = state.isAdmin ? "flex" : "none";
  }
}

export async function loadAdminStatsUI() {
  if (!state.isAdmin) return;
  try {
    const stats = await loadAdminStats();
    const totalUsersEl = document.getElementById("stat-total-users");
    const onlineUsersEl = document.getElementById("stat-online-users");
    const storageUsedEl = document.getElementById("stat-storage-used");
    
    if (totalUsersEl) totalUsersEl.textContent = stats.total_users;
    if (onlineUsersEl) onlineUsersEl.textContent = stats.online_users;
    
    if (storageUsedEl) {
      const bytes = stats.total_storage_bytes;
      let formatted = "0 B";
      if (bytes > 0) {
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        formatted = parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      }
      storageUsedEl.textContent = formatted;
    }
  } catch (err) {
    console.error("Failed to load admin stats:", err);
  }
}

export async function loadAdminSettingsUI() {
  if (!state.isAdmin) return;
  try {
    const data = await loadAdminSettings();
    applyManualUploadUI(!!data.manual_audio_upload_enabled);
    applyPlaylistImportUI(!!data.playlist_import_enabled);

    const tzSelect = document.getElementById("server-timezone-select");
    if (tzSelect && data.timezone) {
      tzSelect.value = data.timezone;
    }
  } catch (err) {
    console.error("Failed to load admin settings:", err);
  }
  await loadRegistrationModeUI();
}

let currentRegistrationMode = null;

export function applyRegistrationModeUI(mode) {
  currentRegistrationMode = mode === "invite" ? "invite" : "open";

  const description = document.getElementById("registration-mode-description");
  const openBtn = document.getElementById("registration-mode-open");
  const inviteBtn = document.getElementById("registration-mode-invite");
  const hint = document.getElementById("invites-mode-hint");

  if (description) {
    description.textContent = currentRegistrationMode === "open"
      ? "Current mode: Open — anyone can register without an invite."
      : "Current mode: Invite-only — a valid invite code is required to register.";
  }
  if (openBtn) openBtn.classList.toggle("active", currentRegistrationMode === "open");
  if (inviteBtn) inviteBtn.classList.toggle("active", currentRegistrationMode === "invite");
  if (hint) hint.style.display = currentRegistrationMode === "open" ? "flex" : "none";
}

export async function loadRegistrationModeUI() {
  if (!state.isAdmin) return;
  try {
    const data = await loadAdminRegistrationMode();
    applyRegistrationModeUI(data && data.mode);
  } catch (err) {
    console.error("Failed to load registration mode:", err);
  }
}

export async function updateRegistrationModeUI(mode) {
  if (!state.isAdmin) return;
  if (mode === currentRegistrationMode) return;
  if (mode === "open") {
    const confirmed = confirm("Anyone will be able to register without an invite. Continue?");
    if (!confirmed) return;
  }

  const openBtn = document.getElementById("registration-mode-open");
  const inviteBtn = document.getElementById("registration-mode-invite");
  const statusEl = document.getElementById("registration-mode-status");
  if (openBtn) openBtn.disabled = true;
  if (inviteBtn) inviteBtn.disabled = true;
  if (statusEl) statusEl.textContent = "Updating...";

  try {
    const data = await updateAdminRegistrationMode(mode);
    applyRegistrationModeUI(data && data.mode);
    if (statusEl) statusEl.textContent = "Registration mode updated.";
  } catch (err) {
    console.error("Failed to update registration mode:", err);
    alert("Failed to update registration mode: " + err.message);
    if (statusEl) statusEl.textContent = "";
    if (currentRegistrationMode) applyRegistrationModeUI(currentRegistrationMode);
  } finally {
    if (openBtn) openBtn.disabled = false;
    if (inviteBtn) inviteBtn.disabled = false;
  }
}

function normalizeInviteStatus(status) {
  return ["active", "used", "expired", "revoked"].includes(status) ? status : "expired";
}

function formatInviteDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleDateString();
}

export async function loadInvitesListUI() {
  const container = document.getElementById("invites-table-container");
  const tableBody = document.getElementById("invites-table-body");
  if (!container || !tableBody) return;

  try {
    const data = await loadInvites();
    const invites = (data && data.invites) || [];
    container.style.display = "block";
    tableBody.innerHTML = "";

    if (invites.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 9;
      td.style.textAlign = "center";
      td.textContent = "No invites yet";
      row.appendChild(td);
      tableBody.appendChild(row);
      return;
    }

    invites.forEach(invite => {
      const status = normalizeInviteStatus(invite.status);
      const row = document.createElement("tr");

      const prefixTd = document.createElement("td");
      prefixTd.textContent = (invite.code_prefix || "") + "\u2026";

      const noteTd = document.createElement("td");
      noteTd.textContent = invite.note || "-";

      const usesTd = document.createElement("td");
      usesTd.textContent = String(invite.use_count || 0) + "/" + String(invite.max_uses || 1);

      const statusTd = document.createElement("td");
      const statusEl = document.createElement("span");
      statusEl.className = "invite-status " + status;
      statusEl.textContent = status;
      statusTd.appendChild(statusEl);

      const creatorTd = document.createElement("td");
      creatorTd.textContent = invite.created_by || "-";

      const createdTd = document.createElement("td");
      createdTd.textContent = formatInviteDate(invite.created_at);

      const expiresTd = document.createElement("td");
      expiresTd.textContent = invite.expires_at ? formatInviteDate(invite.expires_at) : "Never";

      const redeemersTd = document.createElement("td");
      const redeemers = Array.isArray(invite.redeemers) ? invite.redeemers : [];
      redeemersTd.textContent = redeemers.length ? redeemers.join(", ") : "-";

      const actionsTd = document.createElement("td");
      if (status === "active") {
        const revokeBtn = document.createElement("button");
        revokeBtn.className = "btn-delete";
        revokeBtn.dataset.inviteId = invite.id || "";
        revokeBtn.textContent = "Revoke";
        actionsTd.appendChild(revokeBtn);
      } else {
        actionsTd.textContent = "-";
      }

      row.appendChild(prefixTd);
      row.appendChild(noteTd);
      row.appendChild(usesTd);
      row.appendChild(statusTd);
      row.appendChild(creatorTd);
      row.appendChild(createdTd);
      row.appendChild(expiresTd);
      row.appendChild(redeemersTd);
      row.appendChild(actionsTd);
      tableBody.appendChild(row);
    });

    tableBody.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", async function() {
        const inviteId = this.dataset.inviteId;
        const confirmed = confirm("Revoke this invite? Anyone holding the code will no longer be able to register with it.");
        if (!confirmed) return;

        this.disabled = true;
        this.textContent = "Revoking...";

        try {
          await revokeInvite(inviteId);
          alert("Invite revoked");
          loadInvitesListUI();
        } catch (err) {
          alert("Failed to revoke invite: " + err.message);
          this.disabled = false;
          this.textContent = "Revoke";
        }
      });
    });
  } catch (err) {
    console.error("Failed to load invites:", err);
    tableBody.innerHTML = "";
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
    td.style.textAlign = "center";
    td.style.color = "#e74c3c";
    td.textContent = "Error loading invites. Admin access required.";
    row.appendChild(td);
    tableBody.appendChild(row);
  }
}

export async function createInviteFromForm() {
  if (!state.isAdmin) return;

  const maxUsesInput = document.getElementById("invite-max-uses");
  const expiresInput = document.getElementById("invite-expires-days");
  const noteInput = document.getElementById("invite-note");
  const statusEl = document.getElementById("invite-create-status");
  const createBtn = document.getElementById("invite-create-btn");

  const payload = {};
  const maxUses = parseInt(maxUsesInput && maxUsesInput.value, 10);
  payload.max_uses = (!isNaN(maxUses) && maxUses > 0) ? maxUses : 1;
  const days = parseInt(expiresInput && expiresInput.value, 10);
  if (!isNaN(days) && days > 0) payload.expires_in_days = days;
  const note = noteInput ? noteInput.value.trim() : "";
  if (note) payload.note = note;

  if (createBtn) {
    createBtn.disabled = true;
    createBtn.textContent = "Creating...";
  }
  if (statusEl) statusEl.textContent = "";

  try {
    const invite = await createInvite(payload);
    if (invite && invite.code) showInviteReveal(invite.code);
    if (maxUsesInput) maxUsesInput.value = "1";
    if (expiresInput) expiresInput.value = "";
    if (noteInput) noteInput.value = "";
    if (statusEl) statusEl.textContent = "Invite created.";
    loadInvitesListUI();
  } catch (err) {
    console.error("Failed to create invite:", err);
    alert("Failed to create invite: " + err.message);
  } finally {
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = "Create Invite";
    }
  }
}

export function showInviteReveal(code) {
  const reveal = document.getElementById("invite-code-reveal");
  const codeEl = document.getElementById("invite-code-text");
  const linkEl = document.getElementById("invite-link-text");
  if (!reveal || !codeEl || !linkEl) return;
  codeEl.textContent = code;
  linkEl.textContent = location.origin + "/?invite=" + encodeURIComponent(code);
  reveal.style.display = "flex";
}

export function dismissInviteReveal() {
  const reveal = document.getElementById("invite-code-reveal");
  const codeEl = document.getElementById("invite-code-text");
  const linkEl = document.getElementById("invite-link-text");
  if (!reveal) return;
  reveal.style.display = "none";
  if (codeEl) codeEl.textContent = "";
  if (linkEl) linkEl.textContent = "";
}

function copyInviteValue(el, btn) {
  if (!el) return;
  const text = el.textContent || "";
  if (!text) return;

  const succeeded = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  };

  const legacyCopy = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(textarea);
    return ok;
  };

  const manualFallback = () => {
    const selection = window.getSelection && window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    alert("Automatic copy failed. The text is selected — press Ctrl+C (Cmd+C on Mac) to copy it.");
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(succeeded).catch(() => {
      if (legacyCopy()) succeeded(); else manualFallback();
    });
  } else if (legacyCopy()) {
    succeeded();
  } else {
    manualFallback();
  }
}

export function applyManualUploadUI(enabled) {
  state.manualAudioUploadEnabled = !!enabled;
  const manualUploadSection = document.getElementById("manual-upload-section");
  const manualUploadButton = document.getElementById("manual-upload-button");
  const manualFileInput = document.getElementById("manual-file-input");
  const manualUploadStatus = document.getElementById("manual-upload-status");
  const adminManualUploadToggle = document.getElementById("manual-upload-enabled-admin");
  
  if (manualUploadSection) {
    manualUploadSection.style.display = state.manualAudioUploadEnabled ? "block" : "none";
  }
  if (manualUploadButton) {
    manualUploadButton.disabled = !state.manualAudioUploadEnabled;
  }
  if (manualFileInput) {
    manualFileInput.disabled = !state.manualAudioUploadEnabled;
    if (!state.manualAudioUploadEnabled) {
      manualFileInput.value = "";
    }
  }
  if (adminManualUploadToggle) {
    adminManualUploadToggle.checked = state.manualAudioUploadEnabled;
  }
  if (manualUploadStatus && !state.manualAudioUploadEnabled) {
    manualUploadStatus.style.display = "none";
    manualUploadStatus.textContent = "";
  }
}

export async function toggleManualUploadSetting(checkbox, applyUI = true) {
  const enabled = !!checkbox.checked;
  checkbox.disabled = true;
  try {
    const data = await updateAdminSettings({ manual_audio_upload_enabled: enabled });
    if (applyUI) {
      applyManualUploadUI(!!data.manual_audio_upload_enabled);
    }
  } catch (err) {
    console.error("Failed to update manual upload setting:", err);
    checkbox.checked = !enabled;
    alert("Failed to update manual upload setting: " + err.message);
  } finally {
    checkbox.disabled = false;
  }
}

export async function togglePlaylistImportSetting(checkbox, applyUI = true) {
  const enabled = !!checkbox.checked;
  checkbox.disabled = true;
  try {
    const data = await updateAdminSettings({ playlist_import_enabled: enabled });
    if (applyUI) {
      applyPlaylistImportUI(!!data.playlist_import_enabled);
    }
  } catch (err) {
    console.error("Failed to update playlist import setting:", err);
    checkbox.checked = !enabled;
    alert("Failed to update playlist import setting: " + err.message);
  } finally {
    checkbox.disabled = false;
  }
}

export async function updateTimezoneSetting(select) {
  const tz = select.value;
  select.disabled = true;
  try {
    await updateAdminSettings({ timezone: tz });
  } catch (err) {
    console.error("Failed to update timezone:", err);
    alert("Failed to update timezone: " + err.message);
  } finally {
    select.disabled = false;
  }
}

export async function loadUsersListUI(searchQuery = "") {
  const container = document.getElementById("users-table-container");
  const tableBody = document.getElementById("users-table-body");
  if (!container || !tableBody) return;

  try {
    const users = await loadUsersList(searchQuery);
    container.style.display = "block";
    tableBody.innerHTML = "";
    
    if (!users || users.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.style.textAlign = "center";
      td.textContent = "No users found";
      row.appendChild(td);
      tableBody.appendChild(row);
      return;
    }

    users.forEach(user => {
      const row = document.createElement("tr");

      const nameTd = document.createElement("td");
      const isSelf = user.id === state.currentUser?.id;
      nameTd.textContent = (user.name || "") + (isSelf ? " (You)" : "");

      const hashTd = document.createElement("td");
      const hashSpan = document.createElement("span");
      hashSpan.className = "user-hash";
      hashSpan.textContent = user.auth_hash || "";
      hashSpan.title = user.auth_hash || "";
      hashTd.appendChild(hashSpan);

      const roleTd = document.createElement("td");
      const role = document.createElement("span");
      role.className = "user-role " + (user.is_admin ? "admin" : "user");
      role.textContent = user.is_admin ? "Admin" : "User";
      roleTd.appendChild(role);

      const countTd = document.createElement("td");
      countTd.textContent = String(user.uploaded_tracks_count || 0);

      const actionsTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "btn-delete";
      delBtn.dataset.userId = user.id || "";
      delBtn.textContent = "Delete";
      if (isSelf) delBtn.disabled = true;
      actionsTd.appendChild(delBtn);

      row.appendChild(nameTd);
      row.appendChild(hashTd);
      row.appendChild(roleTd);
      row.appendChild(countTd);
      row.appendChild(actionsTd);
      tableBody.appendChild(row);
    });

    tableBody.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", async function() {
        const userId = this.dataset.userId;
        const confirmed = confirm("Are you sure you want to delete this user? Their playlists will be removed and tracks will become unowned. This cannot be undone.");
        if (!confirmed) return;

        this.disabled = true;
        this.textContent = "Deleting...";

        try {
          await deleteUser(userId);
          alert("User deleted successfully");
          loadUsersListUI(searchQuery);
        } catch (err) {
          alert("Failed to delete user: " + err.message);
          this.disabled = false;
          this.textContent = "Delete";
        }
      });
    });

  } catch (err) {
    console.error("Failed to load users:", err);
    tableBody.innerHTML = "";
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.style.textAlign = "center";
    td.style.color = "#e74c3c";
    td.textContent = "Error loading users. Admin access required.";
    row.appendChild(td);
    tableBody.appendChild(row);
  }
}

export async function loadTracksListUI(searchQuery = "") {
  const container = document.getElementById("library-table-container");
  const tableBody = document.getElementById("library-table-body");
  if (!container || !tableBody) return;

  try {
    const tracks = await loadTracksList(searchQuery);
    container.style.display = "block";
    tableBody.innerHTML = "";
    
    if (!tracks || tracks.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.style.textAlign = "center";
      td.textContent = "No tracks found";
      row.appendChild(td);
      tableBody.appendChild(row);
      return;
    }

    tracks.forEach(track => {
      const row = document.createElement("tr");

      const titleTd = document.createElement("td");
      titleTd.textContent = track.title || "";

      const artistTd = document.createElement("td");
      artistTd.textContent = track.artist_name || "";

      const userTd = document.createElement("td");
      userTd.textContent = track.user_name || "";

      const playsTd = document.createElement("td");
      playsTd.textContent = String(track.play_count || 0);

      const durTd = document.createElement("td");
      durTd.textContent = formatDuration(track.duration);

      const actionsTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "btn-delete";
      delBtn.dataset.trackId = track.id || "";
      delBtn.textContent = "Delete";
      actionsTd.appendChild(delBtn);

      row.appendChild(titleTd);
      row.appendChild(artistTd);
      row.appendChild(userTd);
      row.appendChild(playsTd);
      row.appendChild(durTd);
      row.appendChild(actionsTd);
      tableBody.appendChild(row);
    });

    tableBody.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", async function() {
        const trackId = this.dataset.trackId;
        const confirmed = confirm("Are you sure you want to delete this track? This cannot be undone.");
        if (!confirmed) return;

        this.disabled = true;
        this.textContent = "Deleting...";

        try {
          await deleteTrack(trackId);
          alert("Track deleted successfully");
          loadTracksListUI(searchQuery);
        } catch (err) {
          alert("Failed to delete track: " + err.message);
          this.disabled = false;
          this.textContent = "Delete";
        }
      });
    });
  } catch (err) {
    console.error("Failed to load tracks:", err);
    tableBody.innerHTML = "";
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.style.textAlign = "center";
    td.style.color = "#e74c3c";
    td.textContent = "Error loading tracks. Admin access required.";
    row.appendChild(td);
    tableBody.appendChild(row);
  }
}

export async function loadAlbumsListUI(searchQuery = "") {
  const container = document.getElementById("albums-table-container");
  const tableBody = document.getElementById("albums-table-body");
  if (!container || !tableBody) return;

  try {
    const albums = await loadAlbumsList(searchQuery);
    container.style.display = "block";
    tableBody.innerHTML = "";
    
    if (!albums || albums.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.style.textAlign = "center";
      td.textContent = "No albums found";
      row.appendChild(td);
      tableBody.appendChild(row);
      return;
    }

    albums.forEach(album => {
      const row = document.createElement("tr");

      const titleTd = document.createElement("td");
      titleTd.textContent = album.title || "Untitled Album";

      const artistTd = document.createElement("td");
      artistTd.textContent = album.artist_name || "Unknown Artist";

      const countTd = document.createElement("td");
      countTd.textContent = String(album.track_count || 0);

      const dateTd = document.createElement("td");
      dateTd.textContent = album.created_at ? new Date(album.created_at).toLocaleDateString() : "-";

      const actionsTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "btn-delete";
      delBtn.dataset.albumId = album.id || "";
      delBtn.textContent = "Delete";
      actionsTd.appendChild(delBtn);

      row.appendChild(titleTd);
      row.appendChild(artistTd);
      row.appendChild(countTd);
      row.appendChild(dateTd);
      row.appendChild(actionsTd);
      tableBody.appendChild(row);
    });

    tableBody.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", async function() {
        const albumId = this.dataset.albumId;
        const confirmed = confirm("Are you sure you want to delete this album? ALL tracks in this album will be deleted from the server. This cannot be undone.");
        if (!confirmed) return;

        this.disabled = true;
        this.textContent = "Deleting...";

        try {
          await deleteAlbum(albumId);
          alert("Album and its tracks deleted successfully");
          loadAlbumsListUI(searchQuery);
        } catch (err) {
          alert("Failed to delete album: " + err.message);
          this.disabled = false;
          this.textContent = "Delete";
        }
      });
    });

  } catch (err) {
    console.error("Failed to load albums:", err);
    tableBody.innerHTML = "";
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.style.textAlign = "center";
    td.style.color = "#e74c3c";
    td.textContent = "Error loading albums. Admin access required.";
    row.appendChild(td);
    tableBody.appendChild(row);
  }
}

export function initAdminEventListeners() {
  const viewUsersBtn = document.getElementById("view-users-btn");
  const adminDashboard = document.getElementById("admin-dashboard");
  const adminUsersView = document.getElementById("admin-users-view");
  const adminUsersBack = document.getElementById("admin-users-back");
  const adminBackHome = document.getElementById("admin-back-home");
  const usersSearchInput = document.getElementById("users-search-input");
  
  const viewLibraryBtn = document.getElementById("view-library-btn");
  const adminLibraryView = document.getElementById("admin-library-view");
  const adminLibraryBack = document.getElementById("admin-library-back");
  const librarySearchInput = document.getElementById("library-search-input");

  const viewAlbumsBtn = document.getElementById("view-albums-btn");
  const adminAlbumsView = document.getElementById("admin-albums-view");
  const adminAlbumsBack = document.getElementById("admin-albums-back");
  const albumsSearchInput = document.getElementById("albums-search-input");
  
  const adminManualUploadToggle = document.getElementById("manual-upload-enabled-admin");
  const playlistImportToggle = document.getElementById("playlist-import-enabled-admin");
  const timezoneSelect = document.getElementById("server-timezone-select");

  const viewInvitesBtn = document.getElementById("view-invites-btn");
  const adminInvitesView = document.getElementById("admin-invites-view");
  const adminInvitesBack = document.getElementById("admin-invites-back");
  const invitesRefreshBtn = document.getElementById("invites-refresh-btn");
  const inviteCreateBtn = document.getElementById("invite-create-btn");
  const registrationModeOpenBtn = document.getElementById("registration-mode-open");
  const registrationModeInviteBtn = document.getElementById("registration-mode-invite");
  const inviteCodeCopyBtn = document.getElementById("invite-code-copy-btn");
  const inviteLinkCopyBtn = document.getElementById("invite-link-copy-btn");
  const inviteRevealDismissBtn = document.getElementById("invite-code-dismiss-btn");
  
  let searchTimeout = null;
  let librarySearchTimeout = null;
  let albumsSearchTimeout = null;
  
  viewUsersBtn?.addEventListener("click", function() {
    adminDashboard.style.display = "none";
    adminUsersView.style.display = "flex";
    loadUsersListUI();
  });
  
  adminUsersBack?.addEventListener("click", function() {
    adminUsersView.style.display = "none";
    adminDashboard.style.display = "block";
  });
  
  adminBackHome?.addEventListener("click", function(event) {
    event.preventDefault();
    setActivePage("home");
  });
  
  usersSearchInput?.addEventListener("input", function() {
    clearTimeout(searchTimeout);
    const query = this.value.trim();
    searchTimeout = setTimeout(() => {
      loadUsersListUI(query);
    }, 300);
  });
  
  viewLibraryBtn?.addEventListener("click", function() {
    adminDashboard.style.display = "none";
    adminLibraryView.style.display = "flex";
    loadTracksListUI();
  });
  
  adminLibraryBack?.addEventListener("click", function() {
    adminLibraryView.style.display = "none";
    adminDashboard.style.display = "block";
  });
  
  librarySearchInput?.addEventListener("input", function() {
    clearTimeout(librarySearchTimeout);
    const query = this.value.trim();
    librarySearchTimeout = setTimeout(() => {
      loadTracksListUI(query);
    }, 300);
  });

  viewAlbumsBtn?.addEventListener("click", function() {
    adminDashboard.style.display = "none";
    adminAlbumsView.style.display = "flex";
    loadAlbumsListUI();
  });
  
  adminAlbumsBack?.addEventListener("click", function() {
    adminAlbumsView.style.display = "none";
    adminDashboard.style.display = "block";
  });
  
  albumsSearchInput?.addEventListener("input", function() {
    clearTimeout(albumsSearchTimeout);
    const query = this.value.trim();
    albumsSearchTimeout = setTimeout(() => {
      loadAlbumsListUI(query);
    }, 300);
  });
  
  adminManualUploadToggle?.addEventListener("change", function() {
    toggleManualUploadSetting(this);
  });

  playlistImportToggle?.addEventListener("change", function() {
    togglePlaylistImportSetting(this);
  });

  timezoneSelect?.addEventListener("change", function() {
    updateTimezoneSetting(this);
  });

  viewInvitesBtn?.addEventListener("click", function() {
    adminDashboard.style.display = "none";
    adminInvitesView.style.display = "flex";
    loadInvitesListUI();
  });

  adminInvitesBack?.addEventListener("click", function() {
    adminInvitesView.style.display = "none";
    adminDashboard.style.display = "block";
  });

  invitesRefreshBtn?.addEventListener("click", function() {
    loadInvitesListUI();
  });

  inviteCreateBtn?.addEventListener("click", function() {
    createInviteFromForm();
  });

  registrationModeOpenBtn?.addEventListener("click", function() {
    updateRegistrationModeUI("open");
  });

  registrationModeInviteBtn?.addEventListener("click", function() {
    updateRegistrationModeUI("invite");
  });

  inviteCodeCopyBtn?.addEventListener("click", function() {
    copyInviteValue(document.getElementById("invite-code-text"), this);
  });

  inviteLinkCopyBtn?.addEventListener("click", function() {
    copyInviteValue(document.getElementById("invite-link-text"), this);
  });

  inviteRevealDismissBtn?.addEventListener("click", function() {
    dismissInviteReveal();
  });
}