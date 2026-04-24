---
name: Queue Sliding Window
description: Queue displays max 6 tracks with sliding window; total capacity 20 tracks; smooth entry animations for new queue items
type: project
---

# Queue Sliding Window Design

**Date:** 2026-04-24  
**Component:** Frontend queue UI (`client/script.js`, `client/styles.css`)

## Problem

The queue currently stores only 7 tracks total (current + 6 ahead) due to a hard-coded `QUEUE_LOOKAHEAD = 6` slice at line 622:

```js
currentQueue = arr.slice(idx, idx + 1 + QUEUE_LOOKAHEAD);
```

When a track finishes and the next track begins, only the 6-track window is available — no ability to queue more than 6 tracks ahead of time.

## Goal

Support a queue capacity of **up to 20 tracks** while the UI always shows:
- **Collapsed state:** 1 upcoming track
- **Expanded state:** up to 6 upcoming tracks

As the current track advances, newly visible tracks should slide in smoothly from the bottom.

---

## Design

### 1. Data Structure Changes

| Constant | Before | After |
|----------|--------|-------|
| `QUEUE_LOOKAHEAD` | `6` (slice length) | **Removed** |
| `MAX_QUEUE_CAPACITY` | N/A | `20` (new) |

`currentQueue` becomes a regular array storing all queued tracks (up to 20). No more slicing to a fixed lookahead count.

### 2. Queue Trimming Logic

**When adding a track** (`currentQueue.push()` — contexts: context menu "Add to Queue", playlist play, etc.):

```js
function enforceQueueCapacity() {
  if (currentQueue.length <= MAX_QUEUE_CAPACITY) return;

  const excess = currentQueue.length - MAX_QUEUE_CAPACITY;
  // Remove from the front (before currently playing track) first
  const removableBefore = Math.min(excess, currentIndex);
  currentQueue.splice(0, removableBefore);
  currentIndex -= removableBefore;

  // If still over capacity, remove queued tracks AFTER current
  const remainingExcess = currentQueue.length - MAX_QUEUE_CAPACITY;
  if (remainingExcess > 0) {
    currentQueue.splice(currentIndex + 1, remainingExcess);
  }
}
```

This is invoked immediately after any `push()` to the queue. It preserves the current track and trims older queued tracks first.

**When starting playback from a list** (`setQueueFromList`):

```js
// Old:
currentQueue = arr.slice(idx, idx + 1 + QUEUE_LOOKAHEAD);

// New:
currentQueue = arr.slice(idx, idx + MAX_QUEUE_CAPACITY);
```

### 3. Rendering — `renderNowPlayingQueue()`

Replace the current slice-based rendering with an index-window approach:

```js
function renderNowPlayingQueue() {
  if (!npNextPanel || !npQueueNext) return;

  npQueueNext.innerHTML = "";  // Clear existing items

  if (!currentQueue || !currentQueue.length || currentIndex < 0) {
    // Show "Play something to build a queue."
    return;
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex >= currentQueue.length) {
    // Show "End of queue."
    return;
  }

  // Determine visible count based on panel state
  const visibleCount = showFullQueue ? 6 : 1;
  const windowStart = nextIndex;
  const windowEnd = Math.min(
    nextIndex + visibleCount,
    currentQueue.length,
    nextIndex + MAX_QUEUE_CAPACITY
  );

  // Render items with enter animation
  for (let i = windowStart; i < windowEnd; i++) {
    const track = currentQueue[i];
    const item = buildQueueItem(track, i, {
      isCurrent: false,
      badgeText: ""
    });
    item.classList.add("queue-enter"); // Triggers CSS entry animation
    npQueueNext.appendChild(item);
  }

  // Clean up animation class after it runs
  setTimeout(() => {
    npQueueNext.querySelectorAll(".queue-enter").forEach(el => {
      el.classList.remove("queue-enter");
    });
  }, 300);
}
```

**Key change:** `windowEnd` uses `MAX_QUEUE_CAPACITY` indirectly — `currentQueue` already contains up to 20 tracks, and the window simply shows up to 6 of them starting at `nextIndex`.

### 4. Smooth Entry Animation

**CSS additions** (`styles.css`):

```css
@keyframes queueSlideUp {
  from {
    transform: translateY(16px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.np-queue-item.queue-enter {
  animation: queueSlideUp 0.25s ease-out forwards;
}
```

Each rendered queue item gets the `.queue-enter` class, which runs a one-time `slideUp` animation. The class is removed after 300ms to avoid affecting subsequent renders.

### 5. Edge Cases Handled

- **Current track is near end:** `windowEnd` caps at `currentQueue.length`; fewer (or zero) items render naturally
- **Track removed via `reorderQueue` or other operations:** No special handling — window logic always uses `currentIndex` as anchor
- **Shuffle:** Unchanged — operates on `currentQueue` as before
- **Drag-and-drop reorder:** Unchanged — uses visual-to-index mapping that respects `currentIndex` offset
- **Expanding from 1→6 items mid-playback:** All newly visible items get the enter animation
- **Queue shrink:** Clear → `npQueueNext.innerHTML = ""` clears all old items; window renders fresh

---

## File Changes

| File | Changes |
|------|---------|
| `client/script.js` | - Remove `QUEUE_LOOKAHEAD` constant<br>- Add `MAX_QUEUE_CAPACITY = 20` constant<br>- Update `setQueueFromList` slice to use `MAX_QUEUE_CAPACITY`<br>- Add `enforceQueueCapacity()` call after `currentQueue.push()`<br>- Replace `renderNowPlayingQueue` window logic with index-based range<br>- Add animation class application & cleanup |
| `client/styles.css` | - Add `@keyframes queueSlideUp`<br>- Add `.np-queue-item.queue-enter` rules |

---

## Self-Review Checklist

- [x] No placeholders — all logic concrete
- [x] Internal consistency: `MAX_QUEUE_CAPACITY = 20` used consistently
- [x] Scope: focused on single component (queue rendering + capacity)
- [x] Ambiguity resolved: animation timing (0.25s), visible counts (1/6), capacity (20) explicitly defined
- [x] Edge cases documented: end-of-queue, capacity trimming, drag/drop after trim
- [x] No unrelated refactoring — only changes directly serving the goal

---
