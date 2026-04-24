# Sidebar Minimize Feature Design

**Date:** 2026-04-24
**Feature:** Sidebar minimize/maximize toggle for the music player

## Overview

Add a minimize button to collapse the sidebar to show only playlist cover images, hiding text labels and icons.

## Structure

- Add `sidebar-minimized` class to the `.sidebar` element when minimized
- Minimize button (the arrow icon) toggles this class
- Button icon rotates/changes to indicate minimized state

## Minimized State Behavior

| Element | Maximized | Minimized |
|---------|-----------|-----------|
| "Your Library" text | Visible | Hidden |
| "+" icon | Visible | Hidden |
| Upload tab text | Visible | Hidden |
| Playlist names | Visible | Hidden |
| Playlist covers | Visible | Visible |

## CSS Changes

1. **Sidebar width transition:**
   ```css
   .sidebar {
       transition: width 0.2s ease;
   }
   ```

2. **Minimized state width:**
   ```css
   .sidebar.sidebar-minimized {
       width: 80px; /* enough for covers + left margin */
   }
   ```

3. **Hide text and icons when minimized:**
   ```css
   .sidebar.sidebar-minimized .lib-option a,
   .sidebar.sidebar-minimized .icons,
   .sidebar.sidebar-minimized .nav-option a {
       display: none;
   }
   ```

4. **Hide playlist names:**
   ```css
   .sidebar.sidebar-minimized .lib-item-name {
       display: none;
   }
   ```

5. **Playlist covers stay in position** - use CSS grid with fixed positioning so items don't shift during transition

## JavaScript

- Click handler on minimize button toggles `sidebar-minimized` class
- Button icon updates (arrow points right when minimized)

## Files to Modify

- `client/index.html` - Update button to use `<i>` with FontAwesome for easier icon swap
- `client/styles.css` - Add minimize styles
- `client/index.html` (JS section) - Add toggle handler