# Sidebar Minimize Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimize/maximize toggle to the sidebar that collapses it to show only playlist cover images, hiding text labels and icons.

**Architecture:** CSS class-based toggle (`sidebar-minimized`) on the `.sidebar` element with smooth width transitions. JavaScript toggles the class and updates the button icon.

**Tech Stack:** Vanilla JavaScript, CSS transitions

---

## Files to Modify

- `client/styles.css` - Add minimize styles and transitions
- `client/script.js` - Add click handler for toggle button
- `client/images/library_minimize.svg` - Already exists, keep as is

---

## Task 1: Add CSS Styles for Sidebar Minimize

**Files:**
- Modify: `client/styles.css`

- [ ] **Step 1: Add sidebar width transition**

Find the `.sidebar` rule (around line 96) and add transition:

```css
.sidebar {
    background-color: #000;
    width: clamp(280px, 22vw, 340px);
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
    transition: width 0.2s ease;
}
```

- [ ] **Step 2: Add minimized sidebar width**

After the `.sidebar` rule, add:

```css
/* Minimized sidebar - show only playlist covers */
.sidebar.sidebar-minimized {
    width: 80px;
}
```

- [ ] **Step 3: Hide text and icons when minimized**

Add after `.sidebar.sidebar-minimized`:

```css
/* Hide text and icons in minimized state */
.sidebar.sidebar-minimized .lib-option a,
.sidebar.sidebar-minimized .icons,
.sidebar.sidebar-minimized .nav-option a {
    display: none;
}
```

- [ ] **Step 4: Hide playlist names when minimized**

Add after the above:

```css
/* Hide playlist names but keep covers visible */
.sidebar.sidebar-minimized .lib-item-name {
    display: none;
}
```

- [ ] **Step 5: Adjust lib-box layout for minimized state**

The lib-box should use a fixed grid so playlists don't shift. Find the lib-box related styles and ensure it has proper overflow handling:

```css
/* Lib box scrollable content */
.lib-box {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    -ms-overflow-style: none;
    scrollbar-width: none;
}

.lib-box::-webkit-scrollbar {
    display: none;
}
```

- [ ] **Step 6: Adjust sidebar-toggle-icon positioning for minimized state**

Update the `.sidebar-toggle-icon` to show when minimized:

```css
.sidebar-toggle-icon {
    width: 28px !important;
    height: 28px !important;
    left: 4px !important;
}

/* Show toggle icon even when minimized */
.sidebar.sidebar-minimized .sidebar-toggle-icon {
    opacity: 0.7 !important;
}
```

- [ ] **Step 7: Commit**

```bash
git add client/styles.css
git commit -m "feat: add sidebar minimize CSS styles"
```

---

## Task 2: Add JavaScript Toggle Handler

**Files:**
- Modify: `client/script.js`

- [ ] **Step 1: Add toggle handler function**

Find a good location near line 2712 (near the new-playlist-btn handler) and add:

```javascript
// Sidebar minimize/maximize toggle
const sidebarToggleBtn = document.querySelector('.sidebar-toggle-icon');
if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', function(e) {
        e.preventDefault();
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.classList.toggle('sidebar-minimized');
            // Update icon direction based on state
            if (sidebar.classList.contains('sidebar-minimized')) {
                // Icon already points left, could swap to right-pointing arrow if desired
            }
        }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add client/script.js
git commit -m "feat: add sidebar minimize toggle handler"
```

---

## Task 3: Test the Implementation

- [ ] **Step 1: Build and test**

```bash
docker compose up --build -d
```

- [ ] **Step 2: Verify behavior**

1. Open http://localhost:8000
2. Hover over "Your Library" to see the minimize icon
3. Click the icon - sidebar should collapse to ~80px width
4. Text labels and "+" icon should be hidden
5. Playlist covers should remain visible
6. Click again - sidebar should expand back

---

## Verification Checklist

- [ ] Sidebar width transitions smoothly (0.2s)
- [ ] "Your Library" text hidden when minimized
- [ ] "+" icon hidden when minimized
- [ ] Upload tab text hidden when minimized
- [ ] Playlist names hidden when minimized
- [ ] Playlist covers stay in same position during transition
- [ ] Toggle icon still visible and clickable when minimized
- [ ] Clicking toggle expands sidebar back