import assert from 'node:assert/strict';
import { test } from 'node:test';

class MemoryStorage extends Map {
  get length() { return this.size; }
  key(index) { return [...this.keys()][index] ?? null; }
  getItem(key) { return this.get(key) ?? null; }
  setItem(key, value) { this.set(key, String(value)); }
  removeItem(key) { this.delete(key); }
}

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const userId = '1a7b67a4-c8d7-4a3f-a01e-428682bd098f';
const otherUserId = 'c95dc4cb-e6dc-46d8-9b07-0ee639ad7752';
const historyKey = id => `openfy_recent_searches_${id}`;

globalThis.localStorage = new MemoryStorage();
const { state, setAuth, clearAuth } = await import('../modules/state.js');
const { addRecentSearch, loadRecentSearches, removeRecentSearch } = await import('../modules/recent-searches.js');
const { handleLogout } = await import('../modules/auth.js');

test('startup removes orphaned legacy credentials without requiring a login', async () => {
  localStorage.clear();
  localStorage.setItem(historyKey(hash), '[]');
  localStorage.setItem(historyKey(otherHash), '[]');
  localStorage.setItem(historyKey(userId), '[{"id":"saved"}]');
  localStorage.setItem('openfy_api', '/api');

  const { state: startupState } = await import('../modules/state.js?logged-out-startup');

  assert.equal(startupState.authHash, '');
  assert.equal(localStorage.getItem(historyKey(hash)), null);
  assert.equal(localStorage.getItem(historyKey(otherHash)), null);
  assert.deepEqual(loadRecentSearches(userId), [{ id: 'saved' }]);
  assert.equal(localStorage.getItem('openfy_api'), '/api');
});

test('startup removes legacy history while retaining the active login', async () => {
  localStorage.clear();
  localStorage.setItem('openfy_auth', hash);
  localStorage.setItem(historyKey(hash), '[]');

  const { state: startupState } = await import('../modules/state.js?logged-in-startup');

  assert.equal(startupState.authHash, hash);
  assert.equal(localStorage.getItem('openfy_auth'), hash);
  assert.equal(localStorage.getItem(historyKey(hash)), null);
});

test('logout removes credentials from storage and state while preserving public-ID history', () => {
  localStorage.clear();
  setAuth(hash, { id: userId, auth_hash: hash, is_admin: true });
  localStorage.setItem(historyKey(hash), '[]');
  localStorage.setItem(historyKey(otherHash), '[]');
  localStorage.setItem(historyKey(userId), '[{"id":"saved"}]');
  localStorage.setItem('unrelated', 'keep');

  clearAuth();

  assert.equal(state.authHash, '');
  assert.equal(state.currentUser, null);
  assert.equal(state.isAdmin, false);
  assert.equal(localStorage.getItem('openfy_auth'), null);
  assert.equal(localStorage.getItem(historyKey(hash)), null);
  assert.equal(localStorage.getItem(historyKey(otherHash)), null);
  assert.deepEqual(loadRecentSearches(userId), [{ id: 'saved' }]);
  assert.equal(localStorage.getItem('unrelated'), 'keep');
});

test('public-ID histories support add, reload and removal independently across logins', () => {
  localStorage.clear();
  setAuth(hash, { id: userId });
  addRecentSearch(state.currentUser.id, { id: 'track', title: 'Track', artist: 'Artist' });
  addRecentSearch(state.currentUser.id, { id: 'track', title: 'Track', artist: 'Artist' });
  clearAuth();
  setAuth(otherHash, { id: otherUserId });
  assert.deepEqual(loadRecentSearches(state.currentUser.id), []);
  addRecentSearch(state.currentUser.id, { id: 'other-track', title: 'Other', artist: 'Artist' });
  clearAuth();
  setAuth(hash, { id: userId });

  assert.equal(loadRecentSearches(state.currentUser.id)[0].count, 2);
  assert.deepEqual(removeRecentSearch(state.currentUser.id, 'track'), []);
  assert.equal(loadRecentSearches(otherUserId)[0].id, 'other-track');
  assert.ok([...localStorage.keys()].every(key => !key.includes(hash) && !key.includes(otherHash)));
});

test('shared logout clears credential DOM copies before showing the sign-in form', () => {
  localStorage.clear();
  setAuth(hash, { id: userId });
  const elements = {
    'signin-hash': { value: hash },
    'user-auth-hash': { textContent: hash },
    'app-main': { classList: { remove() {} } },
  };
  globalThis.document = { getElementById: id => elements[id] ?? null };
  const overlay = { style: {} };

  handleLogout(overlay, { style: {} }, { style: {} }, { classList: { add() {} } });

  assert.equal(elements['signin-hash'].value, '');
  assert.equal(elements['user-auth-hash'].textContent, '');
  assert.equal(overlay.style.display, 'flex');
  assert.equal(localStorage.getItem('openfy_auth'), null);
  delete globalThis.document;
});
