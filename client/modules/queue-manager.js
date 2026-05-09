/**
 * queue-manager.js
 * =================
 * The SINGLE authoritative source of truth for the playback queue.
 *
 * RULES — enforced here so the bug can never come back:
 *   1. Nobody outside this module writes to state.currentQueue or
 *      state.currentIndex directly.  All mutations go through the
 *      exported functions below.
 *   2. Every mutation is followed by a single renderNowPlayingQueue()
 *      call (via _commit) and a debounced server/localStorage save.
 *   3. The server save captures a snapshot at call-time so that even
 *      if the queue changes again before the 400 ms debounce fires,
 *      the correct (latest) data is sent.
 *   4. A monotonic version counter drops stale in-flight saves so a
 *      slow network response can never overwrite a newer queue state.
 */

import { state } from './state.js';
import { saveQueueToServerWithData } from './api.js';

// ─── internal helpers ──────────────────────────────────────────────────────

const QUEUE_KEY   = 'openfy_queue';
const INDEX_KEY   = 'openfy_queue_index';
const MAX_CAP     = 20;

let _version      = 0;   // monotonic; stale async saves are dropped
let _saveTimer    = null; // debounce handle

/** Write queue + index into the module-owned state fields (plain arrays). */
function _set(arr, index) {
  // Always store a plain, non-proxied array.
  state._queue        = Array.isArray(arr) ? arr.slice() : [];
  state.currentIndex  = (Number.isInteger(index) && index >= 0)
                          ? Math.min(index, state._queue.length - 1)
                          : -1;
}

/** Persist to localStorage immediately, then debounce server save. */
function _save() {
  // ① localStorage — synchronous, instant
  try {
    localStorage.setItem(QUEUE_KEY,  JSON.stringify(state._queue.map(t => t.id)));
    localStorage.setItem(INDEX_KEY,  String(state.currentIndex));
  } catch (_) { /* storage full — ignore */ }

  // ② Server — debounced 400 ms; snapshot taken NOW so the right data
  //    is sent even if another mutation happens before the timer fires.
  _version++;
  const capturedVersion = _version;
  const capturedIds     = state._queue.map(t => t.id);
  const capturedIndex   = state.currentIndex;

  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    // Drop if a newer mutation superseded us
    if (capturedVersion !== _version) return;
    if (!state.authHash) return;
    try {
      await saveQueueToServerWithData(capturedIds, capturedIndex);
    } catch (err) {
      console.error('[QueueManager] server save failed:', err);
    }
  }, 400);
}

/** Registered synchronously from audio-player to avoid circular async import. */
let _renderFn = null;
export function setRenderCallback(fn) { _renderFn = fn; }

/** Trigger UI re-render synchronously. */
function _render() {
  if (_renderFn) _renderFn();
}

/** Apply a mutation, save, and re-render. */
function _commit(arr, index) {
  _set(arr, index);
  _save();
  _render();
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Replace the entire queue with a new list of tracks.
 * This is the entry-point for every "play this list" action.
 *
 * @param {Array}  list        - Array of track objects.
 * @param {number} startIndex  - Which track to mark as current.
 */
export function queueSetList(list, startIndex = 0) {
  const arr = (Array.isArray(list) ? list : []).slice(0, MAX_CAP);
  const idx = arr.length ? Math.max(0, Math.min(startIndex | 0, arr.length - 1)) : -1;
  state.queueOriginal = null;
  _commit(arr, idx);
}

/**
 * Reorder the queue by moving the item at fromIndex to toIndex.
 * Both indices are queue-array positions (NOT DOM positions).
 * The currently-playing track's currentIndex is updated accordingly.
 *
 * @param {number} fromIndex  - Current position of the item.
 * @param {number} toIndex    - Desired position after insertion
 *                              (based on the pre-removal array).
 */
export function queueReorder(fromIndex, toIndex) {
  const q = state._queue.slice(); // plain copy

  if (fromIndex < 0 || fromIndex >= q.length) return;
  if (toIndex   < 0 || toIndex   >  q.length) return;
  if (fromIndex === toIndex) return;

  const moving   = q[fromIndex];
  const prevCur  = state.currentIndex;

  // Remove first, then insert at adjusted position.
  q.splice(fromIndex, 1);
  const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
  q.splice(insertAt, 0, moving);

  // Keep currentIndex pointing at the same track.
  let newCur = prevCur;
  if (prevCur >= 0 && prevCur < q.length) {
    if      (fromIndex === prevCur)                               newCur = insertAt;
    else if (fromIndex < prevCur  && insertAt >= prevCur)        newCur = prevCur - 1;
    else if (fromIndex > prevCur  && insertAt <= prevCur)        newCur = prevCur + 1;
  }

  state.queueOriginal = null;
  _commit(q, newCur);
}

/**
 * Insert a track at position insertAt (defaults to right after current).
 * Trims the queue to MAX_CAP if needed.
 *
 * @param {Object} track
 * @param {number} [insertAt]
 */
export function queueInsert(track, insertAt) {
  const q   = state._queue.slice();
  const pos = (insertAt !== undefined)
                ? Math.max(0, Math.min(insertAt, q.length))
                : state.currentIndex + 1;
  q.splice(pos, 0, track);

  // Trim overflow from the tail
  if (q.length > MAX_CAP) q.length = MAX_CAP;

  state.queueOriginal = null;
  _commit(q, state.currentIndex);
}

/**
 * Remove the track at position removeIndex.
 * The currently-playing track cannot be removed.
 *
 * @param {number} removeIndex
 */
export function queueRemove(removeIndex) {
  if (removeIndex === state.currentIndex) return; // never remove current
  const q = state._queue.slice();
  if (removeIndex < 0 || removeIndex >= q.length) return;

  q.splice(removeIndex, 1);
  const newCur = removeIndex < state.currentIndex
                   ? state.currentIndex - 1
                   : state.currentIndex;

  state.queueOriginal = null;
  _commit(q, newCur);
}

/**
 * Shuffle the tracks that follow the current track.
 * Saves the original order in state.queueOriginal so it can be restored.
 */
export function queueShuffle() {
  if (!state.shuffle) return;
  const q = state._queue.slice();
  if (q.length < 2 || state.currentIndex < 0) return;

  if (!state.queueOriginal) state.queueOriginal = q.slice();

  const start  = state.currentIndex + 1;
  const suffix = q.splice(start);
  for (let i = suffix.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [suffix[i], suffix[j]] = [suffix[j], suffix[i]];
  }
  _commit([...q, ...suffix], state.currentIndex);
}

/**
 * Restore the pre-shuffle order stored in state.queueOriginal.
 */
export function queueUnshuffle() {
  if (!state.queueOriginal) return;
  const activeId = state.currentTrackId;
  const q = state.queueOriginal.slice();
  state.queueOriginal = null;

  let idx = state.currentIndex;
  if (activeId) {
    const found = q.findIndex(t => t && t.id == activeId);
    if (found !== -1) idx = found;
  }
  _commit(q, idx);
}

/**
 * Trim the queue so it never exceeds MAX_CAP entries.
 * Removes old tracks before the current index first, then trims the tail.
 */
export function queueEnforceCap() {
  if (state._queue.length <= MAX_CAP) return;
  const q       = state._queue.slice();
  let   cur     = state.currentIndex;
  const excess  = q.length - MAX_CAP;
  const canTrim = Math.min(excess, cur);
  if (canTrim > 0) { q.splice(0, canTrim); cur -= canTrim; }
  if (q.length > MAX_CAP) q.splice(cur + 1, q.length - MAX_CAP);
  _commit(q, cur);
}

/**
 * Advance currentIndex (does NOT re-render or save — the caller handles that
 * by calling playTrack which triggers renderNowPlayingQueue).
 * Returns the new index, or -1 if advance is not possible.
 *
 * @param {number} index  - Absolute queue index to jump to.
 */
export function queueJumpTo(index) {
  if (index < 0 || index >= state._queue.length) return -1;
  state.currentIndex = index;
  // Save index immediately (no debounce needed for just an index change)
  try {
    localStorage.setItem(INDEX_KEY, String(index));
  } catch (_) { /* ignore */ }
  return index;
}

/**
 * Save the current queue and index to localStorage + server.
 * Use this when the queue content hasn't changed but the index has
 * (e.g. after a user manually clicks a queue item).
 */
export function queueSave() {
  _save();
}

/** Clear the queue entirely. */
export function queueClear() {
  state.queueOriginal = null;
  _commit([], -1);
}

/** Read-only helpers. */
export function queueGet()          { return state._queue; }
export function queueLength()       { return state._queue.length; }
export function queueCurrentIndex() { return state.currentIndex; }
export function queueCurrentTrack() { return state._queue[state.currentIndex] || null; }
export const   QUEUE_MAX_CAP        = MAX_CAP;
