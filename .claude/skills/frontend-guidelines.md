---
name: frontend-guidelines
description: Frontend development patterns for Openfy web player - modals, styling conventions, and JS structure
triggers:
  - "frontend"
  - "modal"
  - "css"
  - "javascript"
  - "ui"
  - "user interface"
  - "styling"
---

# Openfy Frontend Guidelines

## Modal Pattern

Openfy uses custom modals with **blurred backdrop**. Never use `alert()` or `confirm()`.

### Modal HTML Structure

```html
<div class="modal-overlay" id="modal-id" style="display:none;">
    <div class="modal">
        <div class="modal-header">
            <h2><i class="fa-solid fa-icon"></i> Title</h2>
        </div>
        <div class="modal-content">Content</div>
        <div class="modal-footer">
            <button class="badge" id="close-btn">Close</button>
        </div>
    </div>
</div>
```

### Modal CSS Essentials

```css
.modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background-color: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}
.modal {
    background-color: #282828;
    border-radius: 12px;
    width: 90%;
    max-width: 500px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
```

### Modal JavaScript Pattern

```javascript
const modal = document.getElementById("modal-id");
const closeBtn = document.getElementById("close-btn");

function showModal() { modal.style.display = "flex"; }
function hideModal() { modal.style.display = "none"; }

closeBtn.addEventListener("click", hideModal);
modal.addEventListener("click", e => { if (e.target === modal) hideModal(); });
```

## Color Palette

- Background: #000
- Surface: #121212
- Card: #232323
- Card Hover: #2b2b2b
- Border: #282828, #3e3e3e
- Text Primary: #fff
- Text Secondary: #b3b3b3
- Accent: #1db954
- Error: #e74c3c

## Typography

- Font: Montserrat
- Body: 1rem (16px)
- Headings: 1.25rem, 2rem, etc.
- Small: 0.875rem, 0.75rem

## Layout

- Top bar: 60px fixed
- Bottom player: 90px fixed
- Main content: calc(100vh - 150px)
- Sidebar width: 340px
- Border radius: 0.5rem
- Gaps: 0.5rem, 1rem, 1.5rem

## Components

### Buttons
```css
.badge {
    background: #fff;
    border-radius: 100px;
    padding: 0.25rem 1rem;
    font-weight: 700;
    height: 2rem;
    color: black;
    cursor: pointer;
}
```

### Cards
```css
.card {
    background: #232323;
    border-radius: 0.5rem;
    padding: 0.5rem;
    margin: 0.5rem;
}
.card:hover { background: #2b2b2b; }
```

### Inputs
```css
.search-bar {
    display: flex;
    align-items: center;
    background: #242424;
    border-radius: 999px;
    height: 48px;
    padding: 0 1rem;
}
.search-bar input {
    background: transparent;
    border: none;
    color: #fff;
    width: 100%;
    outline: none;
}
```

## Interactive Buttons with Async State

For buttons that trigger async actions (like, follow, add), use a three‑state pattern with CSS‑drawn icons to avoid Font Awesome dependency.

**CSS:**
```css
.player-like-btn {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: transparent;
    border: 2px solid #727272;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    margin-left: 0.75rem;
    flex-shrink: 0;
    position: relative;
}
.player-like-btn:hover {
    border-color: #fff; color: #fff;
}
.player-like-btn:disabled {
    cursor: not-allowed; opacity: 0.5; transform: none;
}
.player-like-btn.liked {
    border-color: #1db954; color: #1db954;
}
.player-like-btn::before,
.player-like-btn::after {
    content: '';
    position: absolute;
    background-color: currentColor;
    transition: background-color 0.2s ease;
}
.player-like-btn::before { width: 2px; height: 10px; } /* vertical */
.player-like-btn::after  { width: 10px; height: 2px; } /* horizontal */
.player-like-btn.liked::before,
.player-like-btn.liked::after {
    background-color: #1db954;
}
.player-like-btn.adding::before,
.player-like-btn.adding::after {
    animation: pulse 0.4s ease;
}
@keyframes pulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.2); }
    100% { transform: scale(1); }
}
```

**HTML:**
```html
<button class="player-like-btn" id="np-like-btn"
        aria-label="Add to Liked Songs" title="Add to Liked Songs">
</button>
```

**JavaScript handler:**
```javascript
const btn = document.getElementById("np-like-btn");
btn.addEventListener("click", async function(event) {
    event.preventDefault();
    if (!currentTrackId || !authHash) return;

    const wasLiked = btn.classList.contains("liked");
    btn.disabled = true;
    btn.classList.add("adding");

    try {
        await api("/liked/" + currentTrackId, { method: "POST" });
        btn.classList.remove("adding");
        if (wasLiked) {
            btn.classList.remove("liked");
            btn.setAttribute("aria-label", "Add to Liked Songs");
            btn.setAttribute("title", "Add to Liked Songs");
        } else {
            btn.classList.add("liked");
            btn.setAttribute("aria-label", "Added to Liked Songs");
            btn.setAttribute("title", "Added to Liked Songs");
        }
    } catch (err) {
        btn.classList.remove("adding");
        btn.disabled = false;
        alert("Failed: " + err.message);
    }
});
```

**Show/hide per player state:**
```javascript
// Init: hide
npLikeBtn.classList.add("hidden");

// In playTrack(): show and reset
npLikeBtn.classList.remove("hidden", "liked", "adding");
npLikeBtn.disabled = false;
npLikeBtn.innerHTML = "";
```

### CSS-Drawn Icons

Use `::before`/`::after` pseudo‑elements for simple icons. Advantages: no font dependency, easy color/animation control.

**Plus icon pattern:**
```css
.icon-btn {
    position: relative;
    width: 28px; height: 28px;
}
.icon-btn::before { /* vertical */ width: 2px; height: 10px; }
.icon-btn::after  { /* horizontal */ width: 10px; height: 2px; }
.icon-btn::before,
.icon-btn::after {
    content: '';
    position: absolute;
    background-color: currentColor; /* inherits text color */
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
}
```

## JavaScript API Helper

```javascript
const apiBase = localStorage.getItem("openfy_api") || "";
let authHash = localStorage.getItem("openfy_auth") || "";

function withBase(path) { return apiBase ? apiBase + path : path; }
function apiHeaders() { const h = {}; if (authHash) h["x-auth-hash"] = authHash; return h; }

async function api(url, opts = {}) {
    const headers = Object.assign({}, apiHeaders(), opts.headers || {});
    if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
    }
    const res = await fetch(withBase(url), Object.assign({}, opts, { headers }));
    if (!res.ok) throw new Error(await res.text() || ("HTTP " + res.status));
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
}
```

## References

- Modal example: index.html lines 298-329 (profile-modal)
- Modal CSS: styles.css lines 1659+
- Like button: index.html lines 250-252 (HTML), 727-746 (JS), styles.css lines 184-237 (CSS)
- API helper: index.html lines 353-362

## Testing Checklist

- [ ] Modal displays with backdrop blur
- [ ] Close button works
- [ ] Outside click closes
- [ ] Escape key closes
- [ ] No console errors
- [ ] Mobile responsive (< 768px)
- [ ] Uses correct color palette
- [ ] Montserrat font loaded
- [ ] Like button hidden when no track playing
- [ ] Like button toggles correctly (add/remove)

## Pitfalls

- NEVER use alert() or confirm()
- Always include backdrop-filter: blur(4px)
- Modals need z-index: 1000+
- Use 4-space indentation
- Double quotes for HTML, single for JS strings
- For CSS icons, ensure `position: relative` on button and center pseudo‑elements with `top: 50%; left: 50%; transform: translate(-50%, -50%)`
