import { state, setAuth, clearAuth, updateUser, withBase } from './state.js';
import { signUp, signIn, tryAutoLogin as apiTryAutoLogin, refreshManualUploadSetting, updateLibraryState, updateUploadPreference } from './api.js';

let intendedUrl = null;

export function saveIntendedUrl() {
  const path = window.location.pathname;
  if (path !== '/' && path !== '' && path !== '/home' && path !== '/index.html') {
    intendedUrl = path;
    localStorage.setItem('openfy_intended_url', path);
  } else {
    intendedUrl = null;
    localStorage.removeItem('openfy_intended_url');
  }
}

export function getAndClearIntendedUrl() {
  const url = localStorage.getItem('openfy_intended_url');
  localStorage.removeItem('openfy_intended_url');
  return url;
}

export async function handleSignUp(name, onSuccess, onError) {
  try {
    const user = await signUp(name);
    setAuth(user.auth_hash, user);
    return { success: true, user };
  } catch (err) {
    if (onError) onError(err.message);
    return { success: false, error: err.message };
  }
}

export async function handleSignIn(hash, onSuccess, onError) {
  try {
    const user = await signIn(hash);
    setAuth(user.auth_hash, user);
    if (onSuccess) onSuccess(user);
    return { success: true, user };
  } catch (err) {
    if (onError) onError(err.message);
    return { success: false, error: err.message };
  }
}

export async function handleAutoLogin() {
  const user = await apiTryAutoLogin();
  if (user) {
    updateUser(user);
    return true;
  }
  return false;
}

export function handleLogout(authOverlay, appMain, topBar, npLikeBtn, adminBtn, updateAdminButtonVisibility) {
  clearAuth();
  npLikeBtn.classList.add("hidden");
  if (updateAdminButtonVisibility) updateAdminButtonVisibility();
  document.title = "Openfy - Web Player";
  authOverlay.style.display = "flex";
  appMain.style.display = "none";
  document.getElementById('app-main').classList.remove('home-page');
  topBar.style.display = "none";
}

export function isLoggedIn() {
  return !!state.authHash && !!state.currentUser;
}

export function getCurrentUser() {
  return state.currentUser;
}

export function getAuthHash() {
  return state.authHash;
}

export function isAdminUser() {
  return state.isAdmin;
}