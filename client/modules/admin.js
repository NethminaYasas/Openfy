import { state } from './state.js';
import { loadAdminStats, loadAdminSettings, updateAdminSettings, loadUsersList, deleteUser, loadTracksList, deleteTrack } from './api.js';
import { formatDuration, escapeHtml } from './utils.js';

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
    
    const tzSelect = document.getElementById("server-timezone-select");
    if (tzSelect && data.timezone) {
      tzSelect.value = data.timezone;
    }
  } catch (err) {
    console.error("Failed to load admin settings:", err);
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
  
  const adminManualUploadToggle = document.getElementById("manual-upload-enabled-admin");
  const timezoneSelect = document.getElementById("server-timezone-select");
  
  let searchTimeout = null;
  let librarySearchTimeout = null;
  
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
    const { setActivePage } = require('./ui.js');
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
  
  adminManualUploadToggle?.addEventListener("change", function() {
    toggleManualUploadSetting(this);
  });
  
  timezoneSelect?.addEventListener("change", function() {
    updateTimezoneSetting(this);
  });
}