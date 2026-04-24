# Queue Sliding Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase queue capacity to 20 tracks with a sliding window UI showing 1 track when collapsed and 6 tracks when expanded, with smooth slide-up animations for new queue items.

**Architecture:** Replace the hard-coded `QUEUE_LOOKAHEAD` slice approach with a full `currentQueue` array storing up to 20 tracks. `renderNowPlayingQueue` computes a visible window based on `currentIndex` and `showFullQueue` state. Add `enforceQueueCapacity()` to trim when pushing beyond 20. CSS animation `.queue-enter` creates the slide-up effect.

**Tech Stack:** Vanilla JavaScript (ES6+), CSS animations, FastAPI backend (unchanged)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `client/script.js` | Queue management logic, rendering, capacity enforcement |
| `client/styles.css` | Animation keyframes and `.queue-enter` styling |

---

## Task 1: Add MAX_QUEUE_CAPACITY Constant and Remove QUEUE_LOOKAHEAD

**Files:**
- Modify: `client/script.js:452-454`

**Changes:**
1. Remove the line: `const QUEUE_LOOKAHEAD = 6; // store current + next 6`
2. Add: `const MAX_QUEUE_CAPACITY = 20; // maximum total tracks in queue`

The constant should be placed at the same location (around line 453) where `QUEUE_LOOKAHEAD` was declared.

**Step-by-step:**

- [ ] **Step 1:** Read `client/script.js` around lines 450-460 to confirm current constant declaration

- [ ] **Step 2:** Replace the `QUEUE_LOOKAHEAD` line with `MAX_QUEUE_CAPACITY`

```js
// Before:
const QUEUE_LOOKAHEAD = 6; // store current + next 6

// After:
const MAX_QUEUE_CAPACITY = 20; // maximum total tracks in queue
```

- [ ] **Step 3:** Verify no other references to `QUEUE_LOOKAIGHT` exist in the file (grep confirm)

- [ ] **Step 4:** Commit

```bash
git add client/script.js
git commit -m "feat(queue): increase capacity to 20 tracks via MAX_QUEUE_CAPACITY"
```

---

## Task 2: Update `setQueueFromList` to Use Full Capacity Slice

**Files:**
- Modify: `client/script.js:600-627` (`setQueueFromList` function)

**Current code (line 622):**
```js
currentQueue = arr.slice(idx, idx + 1 + QUEUE_LOOKAHEAD);
```

**Change to:**
```js
currentQueue = arr.slice(idx, idx + MAX_QUEUE_CAPACITY);
```

This keeps up to 20 tracks starting from `idx` (the current index position in the source array).

**Step-by-step:**

- [ ] **Step 1:** Read the `setQueueFromList` function (lines 600-627)

- [ ] **Step 2:** Replace line 622 with the new slice call

- [ ] **Step 3:** Commit

```bash
git add client/script.js
git commit -m "feat(queue): setQueueFromList slices up to MAX_QUEUE_CAPACITY tracks"
```

---

## Task 3: Create `enforceQueueCapacity` Helper

**Files:**
- Modify: `client/script.js` — add helper function near other queue utilities (after line 656, after `reorderQueue`)

**Implementation:**

```js
function enforceQueueCapacity() {
  if (currentQueue.length <= MAX_QUEUE_CAPACITY) return;

  const excess = currentQueue.length - MAX_QUEUE_CAPACITY;

  // Remove from the front (before currently playing track) first
  const removableBefore = Math.min(excess, currentIndex);
  if (removableBefore > 0) {
    currentQueue.splice(0, removableBefore);
    currentIndex -= removableBefore;
  }

  // If still over capacity, remove queued tracks AFTER current
  const remainingExcess = currentQueue.length - MAX_QUEUE_CAPACITY;
  if (remainingExcess > 0) {
    currentQueue.splice(currentIndex + 1, remainingExcess);
  }
}
```

**Step-by-step:**

- [ ] **Step 1:** Read the area after `reorderQueue` (around line 656-670) to find insertion point

- [ ] **Step 2:** Insert the `enforceQueueCapacity` function

- [ ] **Step 3:** Run a quick console test in browser after implementation (manual verification)

- [ ] **Step 4:** Commit

```bash
git add client/script.js
git commit -m "feat(queue): add enforceQueueCapacity to trim queue at 20 tracks"
```

---

## Task 4: Hook Capacity Enforcement Into Queue Add Operations

**Files:**
- Modify: `client/script.js:3781` (the "Add to Queue" context menu handler)

**Current code:**
```js
currentQueue.push(track);
queueOriginal = null;
renderNowPlayingQueue();
```

**Change to:**
```js
currentQueue.push(track);
enforceQueueCapacity();
queueOriginal = null;
renderNowPlayingQueue();
```

Also check for any other `currentQueue.push()` calls and apply the same pattern.

**Step-by-step:**

- [ ] **Step 1:** Search for all `currentQueue.push` occurrences

```bash
grep -n "currentQueue\.push" /home/nethmina/Documents/GITHUB/Openfy/client/script.js
```

- [ ] **Step 2:** At each location, insert `enforceQueueCapacity();` immediately after the push

- [ ] **Step 3:** Commit

```bash
git add client/script.js
git commit -m "feat(queue): enforce capacity after every queue push"
```

---

## Task 5: Rewrite `renderNowPlayingQueue` with Sliding Window Logic

**Files:**
- Modify: `client/script.js:2034-2076` (entire `renderNowPlayingQueue` function)

**Old behavior:** Renders all tracks from `nextIndex` onward (or just next track if collapsed)

**New behavior:** Renders a sliding window of `visibleCount` tracks starting from `nextIndex`, capped by queue length.

**Full replacement code:**

```js
function renderNowPlayingQueue() {
  if (!npNextPanel || !npQueueNext) return;

  npQueueNext.innerHTML = "";
  npNextPanel.style.display = "";

  if (!currentQueue || !currentQueue.length || currentIndex < 0) {
    const empty = document.createElement("div");
    empty.className = "np-queue-empty";
    empty.textContent = "Play something to build a queue.";
    npQueueNext.appendChild(empty);
    return;
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex >= currentQueue.length) {
    const empty = document.createElement("div");
    empty.className = "np-queue-empty";
    empty.textContent = "End of queue.";
    npQueueNext.appendChild(empty);
    return;
  }

  // Determine visible count: 1 when collapsed, 6 when expanded
  const visibleCount = showFullQueue ? 6 : 1;
  const windowStart = nextIndex;
  const windowEnd = Math.min(
    nextIndex + visibleCount,
    currentQueue.length
  );

  // Render tracks in the window with enter animation
  for (let i = windowStart; i < windowEnd; i++) {
    const track = currentQueue[i];
    const item = buildQueueItem(track, i, {
      isCurrent: false,
      badgeText: ""
    });
    item.classList.add("queue-enter");
    npQueueNext.appendChild(item);
  }

  // Remove animation class after it completes
  setTimeout(() => {
    if (npQueueNext) {
      npQueueNext.querySelectorAll(".queue-enter").forEach(el => {
        el.classList.remove("queue-enter");
      });
    }
  }, 300);
}
```

**Step-by-step:**

- [ ] **Step 1:** Read current `renderNowPlayingQueue` implementation fully (lines 2034-2076)

- [ ] **Step 2:** Replace entire function body with new implementation above

- [ ] **Step 3:** Verify the existing empty-state logic is preserved (two early returns)

- [ ] **Step 4:** Commit

```bash
git add client/script.js
git commit -m "feat(queue): sliding window render (1 collapsed / 6 expanded)"
```

---

## Task 6: Add CSS Animation for Queue Item Entry

**Files:**
- Modify: `client/styles.css` — add at an appropriate location (near other queue styles, around line 405-420)

**Add the following CSS:**

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

**Placement:** Insert right after `.np-queue-empty` block (after line 404) and before `.np-queue-item` block.

**Step-by-step:**

- [ ] **Step 1:** Read `client/styles.css` around lines 400-410 to find insertion point

- [ ] **Step 2:** Insert the `@keyframes queueSlideUp` and `.np-queue-item.queue-enter` rules

- [ ] **Step 3:** Commit

```bash
git add client/styles.css
git commit -m "style(queue): add slide-up animation for new queue items"
```

---

## Task 7: Update Drag-and-Drop Index Calculation (if needed)

**Files:**
- Modify: `client/script.js:2025-2031` (drop handler inside `renderNowPlayingQueue` scope)

The drag-and-drop logic already calculates `toIndex` as:
```js
const nextIndex = currentIndex + 1;
const toIndex = nextIndex + newVisualIndex;
```

Since `newVisualIndex` comes from DOM order (items in visible window), this calculation remains correct — the visual index maps directly to the absolute queue index offset by `nextIndex`.

**No code change needed** — verify correctness by reading the drop handler context.

**Step-by-step:**

- [ ] **Step 1:** Read the drop handler at lines 2016-2032

- [ ] **Step 2:** Confirm `toIndex = nextIndex + newVisualIndex` correctly computes target position

- [ ] **Step 3:** Commit (no code change, but document verification)

```bash
git add client/script.js
git commit -m "chore(queue): confirm drag-drop index mapping remains valid"
```

---

## Task 8: Manual Testing Checklist

**Files:** N/A (manual QA)

**Test plan:**

1. **Basic queue building**
   - Start playing a playlist with 10+ tracks
   - Verify queue shows current track + 6 ahead (expanded) or 1 ahead (collapsed)
   - Wait for track to end, verify next track plays and queue slides up with animation

2. **Capacity test (20 tracks)**
   - Queue 20 tracks from "Add to Queue" or play a 20+ track playlist
   - Verify all 20 are stored (can navigate through all with next/prev)
   - Add 1 more (21st) — verify oldest pre-current track is dropped, current index stays correct

3. **Animation test**
   - Expand/collapse queue, advance track, watch new items enter with smooth slide-up
   - Verify animation triggers on each window shift

4. **Edge cases**
   - Last track: queue shows "End of queue."
   - Single track playlist: appropriate empty/end messages
   - Drag reorder: items reorder correctly, capacity still enforced

**Step-by-step:**

- [ ] **Step 1:** Start dev server: `cd server && uvicorn app.main:app --reload` (or `docker compose up --build`)

- [ ] **Step 2:** Open http://localhost:8000, log in

- [ ] **Step 3:** Execute each test item above, observe behavior

- [ ] **Step 4:** If any test fails, create a bug task and address before proceeding

---

## Task 9: Final Code Review & Cleanup

**Files:**
- Review: `client/script.js`, `client/styles.css`

**Checklist:**
- No remaining references to `QUEUE_LOOKAHEAD`
- `MAX_QUEUE_CAPACITY` used consistently
- Animation timeout (300ms) matches CSS duration (0.25s) with buffer
- No console errors in browser devtools
- `npQueueNext` null check in `setTimeout` callback to avoid errors after panel removal

**Step-by-step:**

- [ ] **Step 1:** Grep for `QUEUE_LOOKAHEAD` to ensure complete removal

```bash
grep -n "QUEUE_LOOKAHEAD" /home/nethmina/Documents/GITHUB/Openfy/client/script.js
```

- [ ] **Step 2:** Verify all `currentQueue.push` locations call `enforceQueueCapacity()`

- [ ] **Step 3:** Final commit

```bash
git add client/script.js client/styles.css
git commit -m "feat(queue): sliding window with 20-track capacity and animations"
```

---

## Rollback Plan

If issues arise, individual commits can be reverted in reverse order (Task 9 → Task 1). The changes are isolated to queue rendering and capacity logic; no backend modifications were made.

---
