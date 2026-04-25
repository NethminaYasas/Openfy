        // Gradient Manager for Openfy
        // Handles the top gradient effect that changes based on track artwork

        class GradientManager {
          constructor({
            primaryId = 'home-gradient',
            secondaryId = 'home-gradient-2',
            fadeMs = 6000,
            fadeInMs = 300,
            gradientOpacity = 0.25
          } = {}) {
            this.primaryDiv = document.getElementById(primaryId);
            this.secondaryDiv = document.getElementById(secondaryId);
            this.fadeMs = fadeMs;
            this.fadeInMs = fadeInMs;
            this.gradientOpacity = gradientOpacity;
            this.current = null;   // {primary, secondary}
            this.next = null;
            this.rafId = null;
            this.fadeTimeout = null;
            this.isHome = false;
            this.isActive = false;
            this.currentTrackInfo = null; // Store current track info

            // Bind event handlers
            this.onTrackChange = this.onTrackChange.bind(this);
            this.onPageNav = this.onPageNav.bind(this);
          }

          /* ---------- Public API ---------- */
          init() {
            if (!this.primaryDiv || !this.secondaryDiv) {
              console.warn('GradientManager: missing gradient elements');
              return;
            }

            document.addEventListener('trackChanged', this.onTrackChange);
            document.addEventListener('pageNavigated', this.onPageNav);

            // Check if we're on the home page
            this.isHome = document.getElementById('app-main')?.classList.contains('home-page') || false;
            if (this.isHome) {
              this.show();
              // Check if there's an active track and emit track changed event
              setTimeout(() => {
                if (this._hasActiveTrack()) {
                  this._emitTrackChangedEvent();
                }
              }, 100);
            }
          }

          destroy() {
            document.removeEventListener('trackChanged', this.onTrackChange);
            document.removeEventListener('pageNavigated', this.onPageNav);
            this._cancelRaf();
            this._clearFadeTimeout();
            this.isActive = false;
          }

          /* ---------- Event Handlers ---------- */
          async onTrackChange(ev) {
            const { artworkUrl, title, artist } = ev.detail;
            // Store current track info
            this.currentTrackInfo = { artworkUrl, title, artist };

            if (!this.isHome || !this.isActive) return;

            const colors = await this._resolveColors(artworkUrl, title, artist);
            this._queueTransition(colors);
          }

          onPageNav(ev) {
            const { pageId } = ev.detail;
            const wasHome = this.isHome;
            this.isHome = pageId === 'home';

            if (this.isHome) {
              this.show();
              // If we just navigated to home page and there's a track playing,
              // emit a trackChanged event to update gradient colors
              if (!wasHome && this._hasActiveTrack()) {
                this._emitTrackChangedEvent();
              }
            } else {
              this.hide();
            }
          }

          /* ---------- Core Logic ---------- */
          async _resolveColors(artworkUrl, title, artist) {
            try {
              if (artworkUrl) {
                return await this._extractColorsFromImage(artworkUrl);
              }
            } catch (error) {
              console.warn('Failed to extract colors from image, using fallback:', error);
            }

            // Fallback to seeded colors
            return this._generateSeededColors(title, artist);
          }

          async _extractColorsFromImage(imageUrl) {
            return new Promise((resolve, reject) => {
              const img = new Image();
              img.crossOrigin = 'Anonymous';

              img.onload = () => {
                try {
                  const canvas = document.createElement('canvas');
                  const ctx = canvas.getContext('2d');

                  // Scale down for faster processing
                  const scale = 0.1;
                  canvas.width = img.width * scale;
                  canvas.height = img.height * scale;

                  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                  // Sample from center area
                  const centerX = Math.floor(canvas.width / 2);
                  const centerY = Math.floor(canvas.height / 2);
                  const size = Math.min(canvas.width, canvas.height) * 0.3;

                  let r = 0, g = 0, b = 0;
                  let count = 0;

                  for (let x = centerX - size/2; x < centerX + size/2; x++) {
                    for (let y = centerY - size/2; y < centerY + size/2; y++) {
                      const pixel = ctx.getImageData(x, y, 1, 1).data;
                      r += pixel[0];
                      g += pixel[1];
                      b += pixel[2];
                      count++;
                    }
                  }

                  if (count > 0) {
                    const avgR = Math.round(r / count);
                    const avgG = Math.round(g / count);
                    const avgB = Math.round(b / count);

                    // Create gradient from color to transparent black
                    const primary = `rgb(${avgR}, ${avgG}, ${avgB})`;
                    const secondary = 'rgba(0, 0, 0, 0)';

                    resolve({ primary, secondary });
                  } else {
                    throw new Error('No pixels sampled');
                  }
                } catch (error) {
                  reject(error);
                }
              };

              img.onerror = () => reject(new Error('Failed to load image'));
              img.src = imageUrl;
            });
          }

          _generateSeededColors(title, artist) {
            const label = ((title || "") + " " + (artist || "")).trim() || "Openfy";
            let hash = 0;
            for (let i = 0; i < label.length; i++) {
              hash = label.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash) % 360;
            const primary = `hsl(${hue}, 70%, 40%)`;
            const secondary = 'rgba(0, 0, 0, 0)';

            return { primary, secondary };
          }

          _queueTransition(colors) {
            this.next = colors;
            if (!this.rafId && this.isActive) {
              this._crossfade();
            }
            // Side gradients remain constant - no need to update
          }

          _crossfade() {
            if (!this.next || !this.isActive) return;

            const from = this.primaryDiv;
            const to = this.secondaryDiv;

            // Apply colors to the hidden div
            to.style.setProperty('--gradient-start', this.next.primary);
            to.style.setProperty('--gradient-end', this.next.secondary);
            to.style.opacity = '0';

            // Force reflow
            void to.offsetWidth;

            const start = performance.now();
            const duration = this.fadeInMs;

            const step = (now) => {
              const elapsed = now - start;
              const progress = Math.min(elapsed / duration, 1);

              // Easing function for smoother transition
              const eased = this._easeOutCubic(progress);
              to.style.opacity = (eased * this.gradientOpacity).toString();
              from.style.opacity = ((1 - eased) * this.gradientOpacity).toString();

              if (progress < 1) {
                this.rafId = requestAnimationFrame(step);
              } else {
                // Swap references
                [this.primaryDiv, this.secondaryDiv] = [this.secondaryDiv, this.primaryDiv];
                this.current = this.next;
                this.next = null;
                this._cancelRaf();
                this._resetFadeTimer();
              }
            };

            this.rafId = requestAnimationFrame(step);
          }

          _easeOutCubic(t) {
            return 1 - Math.pow(1 - t, 3);
          }

          /* ---------- Track State Helpers ---------- */
          _hasActiveTrack() {
            // Check if audio player exists and has a source (track is loaded)
            const audioPlayer = document.getElementById('audio-player');
            return audioPlayer && audioPlayer.src && audioPlayer.src !== window.location.href;
          }

          _emitTrackChangedEvent() {
            // Use stored track info if available
            if (this.currentTrackInfo && this.currentTrackInfo.title) {
              const { artworkUrl, title, artist } = this.currentTrackInfo;

              // Emit event with stored info
              const event = new CustomEvent('trackChanged', {
                detail: {
                  artworkUrl: artworkUrl,
                  title: title,
                  artist: artist
                }
              });
              document.dispatchEvent(event);
            }
          }

          _getArtworkUrl() {
            // Try to get artwork URL from the current track
            // This is a simplified approach - in a real implementation, you might want to
            // store the current track's artwork URL when it's loaded
            return null;
          }

          _getArtworkUrlFromCanvas(canvas) {
            // If canvas has visible image, try to get artwork URL
            // This is a simplified approach - in a real implementation, you might want to
            // store the current track's artwork URL in a variable when it's loaded
            return null; // For now, we'll fall back to seeded colors
          }

          /* ---------- Visibility & Timers ---------- */
          show() {
            if (!this.isHome) return;

            this.isActive = true;
            this.primaryDiv.classList.remove('hidden');
            this.secondaryDiv.classList.remove('hidden');

            // Set initial opacity if no current gradient
            if (!this.current) {
              this.primaryDiv.style.opacity = this.gradientOpacity.toString();
              this.secondaryDiv.style.opacity = '0';
            } else {
              // If we have a current gradient, ensure proper opacity
              this.primaryDiv.style.opacity = this.gradientOpacity.toString();
              this.secondaryDiv.style.opacity = '0';
            }

            // Don't auto-fade out anymore
            this._clearFadeTimeout();
          }

          hide() {
            this.isActive = false;
            this._clearFadeTimeout();
            this.primaryDiv.classList.add('hidden');
            this.secondaryDiv.classList.add('hidden');
            this.primaryDiv.style.opacity = '0';
            this.secondaryDiv.style.opacity = '0';
          }

          _clearFadeTimeout() {
            if (this.fadeTimeout) {
              clearTimeout(this.fadeTimeout);
              this.fadeTimeout = null;
            }
          }

          _cancelRaf() {
            if (this.rafId) {
              cancelAnimationFrame(this.rafId);
              this.rafId = null;
            }
          }
        }

        // Gradient manager instance
        let gradientManager = null;

        // Helper to emit track change event for gradient updates
        function emitTrackChanged(track) {
            if (!gradientManager) return;
            const event = new CustomEvent('trackChanged', {
                detail: {
                    artworkUrl: withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || "")),
                    title: track.title,
                    artist: getArtistDisplay(track)
                }
            });
            document.dispatchEvent(event);
        }

        function initGradient() {
          if (!gradientManager) {
            gradientManager = new GradientManager();
            gradientManager.init();
          }
          return gradientManager;
        }

        function destroyGradient() {
          if (gradientManager) {
            gradientManager.destroy();
            gradientManager = null;
          }
        }

        // Auto-initialize if on home page
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            if (document.getElementById('app-main')?.classList.contains('home-page')) {
              initGradient();
              // Check if there's an active track and emit track changed event
              setTimeout(() => {
                if (gradientManager?._hasActiveTrack()) {
                  gradientManager._emitTrackChangedEvent();
                }
              }, 100);
            }
          });
        } else {
          if (document.getElementById('app-main')?.classList.contains('home-page')) {
            initGradient();
            // Check if there's an active track and emit track changed event
            setTimeout(() => {
              if (gradientManager?._hasActiveTrack()) {
                gradientManager._emitTrackChangedEvent();
              }
            }, 100);
          }
        }

        const apiBase = localStorage.getItem("openfy_api") || "";
        let authHash = localStorage.getItem("openfy_auth") || "";
        let currentUser = null;
        let isAdmin = false;
        let currentPlaylistId = null;
        let userPlaylists = [];

        const tracksGrid = document.getElementById("tracks-grid");
        const mostPlayedGrid = document.getElementById("most-played-grid");
        const uploadsGrid = document.getElementById("uploads-grid");
        const searchInput = document.getElementById("search-input");
        const searchDropdown = document.getElementById("search-dropdown");
        const audioPlayer = document.getElementById("audio-player");
        const nowTitle = document.getElementById("now-title");
        const nowArtist = document.getElementById("now-artist");
        const nowCover = document.getElementById("now-cover");
        const npPlaceholder = document.getElementById("np-placeholder");
        const npTrack = document.getElementById("np-track");
        const npTitle = document.getElementById("np-title");
        const npArtist = document.getElementById("np-artist");
        const npCover = document.getElementById("np-cover");
        const npImg = document.getElementById("np-img");
        const npNextPanel = document.getElementById("np-next-panel");
        const npQueueNext = document.getElementById("np-queue-next");
        const npLikeBtn = document.getElementById("np-like-btn");
        const queueHeader = document.getElementById("queue-header");
        const queueToggle = document.getElementById("queue-toggle");
        let showFullQueue = false; // tracks whether to show full queue (true) or just next track (false)
        let collapseTimeout = null; // tracks pending collapse render timeout
        npLikeBtn.classList.add("hidden");
        // Custom progress bar elements
        const progressContainer = document.getElementById("progress-container");
        const progressTrack = document.getElementById("progress-track");
        const progressFill = document.getElementById("progress-fill");
        const currTime = document.getElementById("curr-time");
        const totTime = document.getElementById("tot-time");
        const libBox = document.getElementById("lib-box");
        const userIcon = document.getElementById("user-icon");
        const userDropdown = document.getElementById("user-dropdown");
        const dropdownUsername = document.getElementById("dropdown-username");
        const userMenu = document.getElementById("user-menu");
        const authOverlay = document.getElementById("auth-overlay");
        const appMain = document.getElementById("app-main");
        const topBar = document.getElementById("top-bar");
        const topBarHome = document.getElementById("top-bar-home");

        const pages = { home: document.getElementById("page-home"), library: document.getElementById("page-library"), playlist: document.getElementById("page-playlist"), admin: document.getElementById("page-admin") };
        const btnPlay = document.getElementById("btn-play");
        const btnPrev = document.getElementById("btn-prev");
        const btnNext = document.getElementById("btn-next");
        const btnRepeat = document.getElementById("btn-repeat");

        let repeatState = "off";
        let repeatCount = 0;
        let shuffle = false;
        let queueOriginal = null; // Snapshot of the unshuffled order (for current queue) when shuffle is enabled

        let currentQueue = [];
        let currentIndex = -1;
        let currentTrackId = null;
        let lastRenderedIndices = []; // Track which queue indices were last rendered (for animation)
        let dragSourceIndex = null; // Track index being dragged
        let draggedElement = null; // DOM element being dragged
        let lastInsertBeforeEl = null; // For FLIP animation during reordering
        let currentContextPlaylist = null; // { id, name, is_liked, pinned }
        let currentContextTrack = null; // track object for track context menu
        let pendingActionPlaylistId = null; // stored ID for rename/delete modals
        let lastTrackUpdate = 0;
        let updateCheckInterval = null;
        let existingLibraryTracks = new Set(); // Track existing track IDs for library
        let existingMostPlayedTracks = new Set(); // Track existing track IDs for most played
        let lastSearchResults = [];
        let searchDebounceTimer = null;
        let tracksInitTimeout = null;
        let uploadsInitTimeout = null;
        let mostPlayedInitTimeout = null;
        let activeDownloadPoll = null; // Current download poll interval
        let trackIdsInRegularPlaylists = new Set(); // Track IDs in any non-Liked playlist
        let likedTrackIds = new Set(); // Track IDs in Liked Songs
        let trackPlaylistRemovalMenu = null; // DOM reference to removal menu
        let currentTrackPlaylistsCache = []; // Playlists containing current track
        let scrollPositions = {}; // Global tracker for scroll positions: { 'track-row-0': 0, 'uploads-row-0': 0 }

        function withBase(path) { return apiBase ? apiBase + path : path; }
        function apiHeaders() { const h = {}; if (authHash) h["x-auth-hash"] = authHash; return h; }

        const MAX_QUEUE_CAPACITY = 20; // maximum total tracks in queue

        // Escape HTML to prevent XSS when inserting playlist names into DOM
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Media Session API integration for OS/browser media overlays
        function updateMediaSession(track) {
            if (!('mediaSession' in navigator)) return;

            const artworkUrl = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
            const artistName = (track.artists && track.artists.length > 0 && track.artists[0].name) ||
                               (track.artist && track.artist.name) || "Unknown";
            const albumTitle = track.album?.title || "";

            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.title || "",
                    artist: artistName,
                    album: albumTitle,
                    artwork: [
                        {
                            src: artworkUrl,
                            sizes: '512x512',
                            type: 'image/jpeg'
                        }
                    ]
                });
            } catch (e) {
                // Silently ignore - Media Session is best-effort
                console.warn('MediaSession metadata error:', e.message);
            }
        }

        // Create default playlist icon SVG (music note)
        function createPlaylistIconSvg() {
            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.className = "lib-item-icon";
            svg.setAttribute("viewBox", "292 128 156 156");
            svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            svg.setAttribute("role", "img");
            svg.setAttribute("aria-label", "Playlist");
            svg.setAttribute("width", "20");
            svg.setAttribute("height", "20");
            var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
            title.textContent = "Playlist icon";
            var desc = document.createElementNS("http://www.w3.org/2000/svg", "desc");
            desc.textContent = "A music note/playlist icon";
            var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
            g.setAttribute("transform", "translate(297, 133) scale(6.667)");
            var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("fill", "currentColor");
            path.setAttribute("d", "M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5z");
            g.appendChild(path);
            svg.appendChild(title);
            svg.appendChild(desc);
            svg.appendChild(g);
            return svg;
        }

        // Position the removal menu anchored to the like button (right-aligned, entirely above container)
        function positionRemovalMenu(menu, anchorBtn) {
            const rect = anchorBtn.getBoundingClientRect();
            const container = anchorBtn.parentElement;
            const containerRect = container.getBoundingClientRect();

            menu.style.position = 'absolute';
            // Position menu completely above the now playing bar: bottom = container height + gap
            const GAP_ABOVE = 8;
            menu.style.bottom = (containerRect.height + GAP_ABOVE) + 'px';
            // Right-align menu's right edge with container's right edge (button is near right)
            menu.style.right = '0';
            menu.style.left = 'auto';
            menu.style.top = 'auto';
        }

        // Hide removal menu if visible, and clear cache
        function hideRemovalMenuIfVisible() {
            hideRemovalMenu();
        }

        async function api(url, opts) {
            opts = opts || {};
            const headers = Object.assign({}, apiHeaders(), opts.headers || {});
            if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
            console.log("API request:", url, "Headers:", headers);
            const res = await fetch(withBase(url), Object.assign({}, opts, { headers: headers }));
            console.log("API response status:", res.status);
            if (!res.ok) {
                const text = await res.text();
                console.log("API error body:", text);
                throw new Error(text || ("HTTP " + res.status));
            }
            const ct = res.headers.get("content-type") || "";
            if (ct.includes("application/json")) return res.json();
            return res.text();
        }

        function setActivePage(pageId) {
            Object.values(pages).forEach(function(p) { p.classList.remove("active"); });
            var target = pages[pageId] || pages.home;
            target.classList.add("active");
            document.querySelectorAll(".nav-link").forEach(function(link) { link.classList.toggle("active", link.dataset.page === pageId); });
            if (pageId === "library" && authHash) {
                loadUserUploads();
            }
            // Add/remove home-page class on main container for styling
            document.getElementById('app-main').classList.toggle('home-page', pageId === 'home');

            // Notify gradient manager about page navigation
            if (gradientManager) {
                const event = new CustomEvent('pageNavigated', {
                    detail: { pageId }
                });
                document.dispatchEvent(event);
            }
        }

        function formatDuration(seconds) {
            if (!seconds || Number.isNaN(seconds)) return "00:00";
            var mins = Math.floor(seconds / 60);
            var secs = Math.round(seconds % 60).toString().padStart(2, "0");
            // Handle rounding up to next minute
            if (secs === "60") {
                secs = "00";
                mins += 1;
            }
            return mins + ":" + secs;
        }

        function getArtistDisplay(track) {
            if (track.artists && track.artists.length > 0) {
                return track.artists.map(function(a) { return a.name; }).join(", ");
            }
            return (track.artist && track.artist.name) ? track.artist.name : "Unknown";
        }

        function seededColor(seed) {
            var hash = 0;
            for (var i = 0; i < seed.length; i++) { hash = seed.charCodeAt(i) + ((hash << 5) - hash); }
            var hue = Math.abs(hash) % 360;
            return "hsl(" + hue + ", 70%, 50%)";
        }

        function setQueueFromList(list, startIndex) {
            // Auto‑expand queue on first playback after page load
            if (currentTrackId === null && !showFullQueue) {
                showFullQueue = true;
                if (npNextPanel) npNextPanel.classList.add('expanded');
                const h3 = queueHeader && queueHeader.querySelector('h3');
                if (h3) h3.textContent = 'QUEUE';
                if (queueToggle) {
                    // Icon transition handled via CSS .expanded class
                }
            }

            const arr = Array.isArray(list) ? list : [];
            if (!arr.length) {
                currentQueue = [];
                currentIndex = -1;
                queueOriginal = null;
                renderNowPlayingQueue();
                return;
            }

            const idx = Math.max(0, Math.min((startIndex | 0), arr.length - 1));
            currentQueue = arr.slice(idx, idx + MAX_QUEUE_CAPACITY);
            currentIndex = 0;
            queueOriginal = null;
            shuffleQueueOnce();
            renderNowPlayingQueue();
        }

        // Reorder queue: move track at fromIndex to toIndex (inserts before target)
        function reorderQueue(fromIndex, toIndex) {
            if (!Array.isArray(currentQueue) || fromIndex < 0 || fromIndex >= currentQueue.length) return;
            // `toIndex` is allowed to equal `currentQueue.length` so a track can be
            // dropped at the end of the queue.
            if (toIndex < 0 || toIndex > currentQueue.length) return;
            if (fromIndex === toIndex) return;

            // When moving an item forward in the array, removal shifts the target
            // index left by one. Adjusting here keeps the underlying queue order in
            // sync with the visual drop position.
            const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;

            // Remove from old position, then insert at the adjusted position.
            const [track] = currentQueue.splice(fromIndex, 1);
            currentQueue.splice(insertAt, 0, track);

            // Update currentIndex if needed
            if (currentTrackId) {
                const idx = indexOfTrackId(currentQueue, currentTrackId);
                if (idx !== -1) currentIndex = idx;
                else currentIndex = -1; // track not found, reset
            } else {
                currentIndex = -1;
            }

            // Clear shuffle state since manual reorder overrides it
            queueOriginal = null;

            // Re-render queue panel
            renderNowPlayingQueue();
        }

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

        function extractDominantColorFromImage(img) {
            // Create a canvas to sample the image
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Scale down the image for faster processing
            const scale = 0.1;
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;

            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // Get image data
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            // Simple color sampling - take average of center region
            const centerX = Math.floor(canvas.width / 2);
            const centerY = Math.floor(canvas.height / 2);
            const sampleSize = Math.min(10, Math.floor(canvas.width / 4));

            let rSum = 0, gSum = 0, bSum = 0;
            let count = 0;

            for (let y = centerY - sampleSize; y <= centerY + sampleSize; y++) {
                for (let x = centerX - sampleSize; x <= centerX + sampleSize; x++) {
                    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
                        const i = (y * canvas.width + x) * 4;
                        rSum += data[i];
                        gSum += data[i + 1];
                        bSum += data[i + 2];
                        count++;
                    }
                }
            }

            const r = Math.round(rSum / count);
            const g = Math.round(gSum / count);
            const b = Math.round(bSum / count);

            return `rgb(${r}, ${g}, ${b})`;
        }

        
        
        function drawCanvas(canvas, title, artist) {
            var ctx = canvas.getContext("2d");
            var label = ((title || "") + " " + (artist || "")).trim() || "Openfy";
            var colorA = seededColor(label);
            var colorB = seededColor(label.split(" ").reverse().join(" "));
            var gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, colorA);
            gradient.addColorStop(1, colorB);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#fff";
            ctx.font = Math.floor(canvas.width / 5) + "px Montserrat, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            var initials = label.split(" ").filter(Boolean).slice(0, 2).map(function(w) { return w[0].toUpperCase(); }).join("");
            ctx.fillText(initials || "OF", canvas.width / 2, canvas.height / 2);
        }

        function clearCanvas(canvas) { var ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height); }

        
        function createArtCanvas(title, artist) {
            var canvas = document.createElement("canvas");
            canvas.className = "art-canvas";
            canvas.width = 180;
            canvas.height = 180;
            drawCanvas(canvas, title, artist);
            return canvas;
        }

        function buildTrackCard(track, list, index) {
            var card = document.createElement("div");
            card.className = "card";

            // Create artwork container
            var artContainer = document.createElement("div");
            artContainer.className = "artwork-container";

            var art = createArtCanvas(track.title, getArtistDisplay(track));
            var img = document.createElement("img");
            img.className = "card-img";
            img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
            img.alt = track.title;
            img.style.display = "none";

            img.addEventListener("load", function() {
                art.style.display = "none";
                img.style.display = "block";
            });
            img.addEventListener("error", function() {
                img.style.display = "none";
                art.style.display = "block";
            });

            artContainer.appendChild(art);
            artContainer.appendChild(img);
            card.appendChild(artContainer);

            var title = document.createElement("p");
            title.className = "card-title";
            title.textContent = track.title;
            var info = document.createElement("p");
            info.className = "card-info";
            info.textContent = getArtistDisplay(track);
            card.appendChild(title);
            card.appendChild(info);

            card.addEventListener("click", function() {
                setQueueFromList(list, index);
                if (currentQueue.length) playTrack(currentQueue[0]);
            });

            // Right-click context menu for track
            card.addEventListener("contextmenu", function(e) {
                e.preventDefault();
                showTrackContextMenu(e, track);
            });

            return card;
        }

        
                function renderTracks(tracks) {
            const container = document.getElementById('tracks-grid');
            if (!container) return;

            container.innerHTML = '';

            if (!tracks.length) {
                const emptyCard = document.createElement('div');
                emptyCard.className = 'card';
                emptyCard.innerHTML = '<p class="card-title">No tracks yet</p><p class="card-info">Download a track to start</p>';
                container.appendChild(emptyCard);
                updateTrackRowScrollButtons();
                return;
            }

            // Create multiple rows with max 8 tracks per row
            const maxTracksPerRow = 8;
            const rows = [];
            for (let i = 0; i < tracks.length; i += maxTracksPerRow) {
                const rowTracks = tracks.slice(i, i + maxTracksPerRow);
                rows.push(rowTracks);
            }

            // Create track row wrapper for each row
            rows.forEach((rowTracks, rowIndex) => {
                const rowWrapper = document.createElement('div');
                rowWrapper.className = 'track-row-wrapper';
                rowWrapper.style.marginTop = rowIndex === 0 ? '1.5rem' : '1rem';

                // Create previous button
                const prevBtn = document.createElement('button');
                prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
                prevBtn.id = `track-row-prev-${rowIndex}`;
                prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

                // Create container for the row
                const rowContainer = document.createElement('div');
                rowContainer.className = 'track-row-container';

                // Create the track row
                const trackRow = document.createElement('div');
                trackRow.className = 'track-row';
                trackRow.id = `tracks-grid-${rowIndex}`;

                // Add tracks to the row with animation for new tracks
                const baseIndex = rowIndex * maxTracksPerRow;
                rowTracks.forEach(function(track, idx) {
                    const globalIndex = baseIndex + idx;
                    const card = buildTrackCard(track, tracks, globalIndex);
                    card.classList.add('track-row-card');

                    // Check if this is a new track
                    if (!existingLibraryTracks.has(track.id)) {
                        card.classList.add('new-track');
                        // Add animation delay for sequential effect
                        card.style.animationDelay = `${idx * 0.1}s`;
                        // Add to existing tracks
                        existingLibraryTracks.add(track.id);
                    }

                    trackRow.appendChild(card);
                });

                // Create next button
                const nextBtn = document.createElement('button');
                nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
                nextBtn.id = `track-row-next-${rowIndex}`;
                nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

                // Assemble the wrapper
                rowWrapper.appendChild(prevBtn);
                rowWrapper.appendChild(rowContainer);
                rowWrapper.appendChild(nextBtn);
                container.appendChild(rowWrapper);

                // Add track row to container
                rowContainer.appendChild(trackRow);
            });

            // Initialize track row scrolling for each row
            if (tracksInitTimeout) clearTimeout(tracksInitTimeout);
            tracksInitTimeout = setTimeout(() => {
                rows.forEach((_, rowIndex) => {
                    const prevBtn = document.getElementById(`track-row-prev-${rowIndex}`);
                    const nextBtn = document.getElementById(`track-row-next-${rowIndex}`);
                    // Skip if elements were removed (DOM replaced by new render)
                    if (!prevBtn || !nextBtn || !prevBtn.isConnected || !nextBtn.isConnected) return;
                    const trackRow = document.getElementById(`tracks-grid-${rowIndex}`);
                    const rowContainer = prevBtn.nextElementSibling;

                    if (trackRow && rowContainer && rowContainer.isConnected && trackRow.isConnected) {
                        // Use global scroll position tracker
                        const rowKey = `track-row-${rowIndex}`;
                        if (!(rowKey in scrollPositions)) {
                            scrollPositions[rowKey] = 0;
                        }

                        // Compute card width dynamically
                        const sampleCard = trackRow.querySelector('.track-row-card');
                        const computedGap = parseFloat(getComputedStyle(trackRow).gap) || 16;
                        const cardWidth = (sampleCard ? sampleCard.offsetWidth : 160) + computedGap;

                        // Button visibility variables
                        let showPrevBtn = false;
                        let showNextBtn = false;

                        // Initialize previous button click
                        prevBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            scrollPositions[rowKey] = Math.max(0, scrollPositions[rowKey] - cardWidth * 2);
                            trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;
                            updateButtonStates();
                        });

                        // Initialize next button click
                        nextBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            scrollPositions[rowKey] = Math.min(maxScroll, scrollPositions[rowKey] + cardWidth * 2);
                            trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;
                            updateButtonStates();
                        });

                        // Get the wrapper element
                        const wrapper = prevBtn.parentElement;

                        // Show buttons when hovering over the track row wrapper
                        wrapper.addEventListener('mouseenter', () => {
                            showPrevBtn = true;
                            showNextBtn = true;
                            updateProximityVisibility();
                        });

                        // Hide buttons when mouse leaves the wrapper
                        wrapper.addEventListener('mouseleave', () => {
                            showPrevBtn = false;
                            showNextBtn = false;
                            updateProximityVisibility();
                        });

                        function updateProximityVisibility() {
                            prevBtn.classList.toggle('visible', showPrevBtn);
                            nextBtn.classList.toggle('visible', showNextBtn);

                            // Add specific classes for animations
                            prevBtn.classList.toggle('prev-visible', showPrevBtn);
                            nextBtn.classList.toggle('next-visible', showNextBtn);

                            // Debug logging
                            if (showPrevBtn || showNextBtn) {
                                console.log('Buttons visibility:', { showPrevBtn, showNextBtn });
                            }
                        }

                        function updateButtonStates() {
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            const isAtStart = scrollPositions[rowKey] <= 0;
                            const isAtEnd = scrollPositions[rowKey] >= maxScroll;

                            // Only hide buttons if there's no content to scroll
                            if (maxScroll <= 0) {
                                prevBtn.classList.add('hidden');
                                nextBtn.classList.add('hidden');
                            } else {
                                prevBtn.classList.toggle('hidden', isAtStart);
                                nextBtn.classList.toggle('hidden', isAtEnd);
                            }

                            // Update proximity visibility
                            updateProximityVisibility();
                        }

                        // Make track row transformable
                        trackRow.style.transition = 'transform 0.3s ease-out';
                        trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;

                        // Initial button state update
                        updateButtonStates();
                    }
                });
            }, 100);
        }

        function renderUploads(tracks) {
            const container = document.getElementById('uploads-grid');
            if (!container) return;

            container.innerHTML = '';

            if (!tracks.length) {
                const emptyCard = document.createElement('div');
                emptyCard.className = 'card';
                emptyCard.innerHTML = '<p class="card-title">No uploads yet</p><p class="card-info">Upload a track to see it here</p>';
                container.appendChild(emptyCard);
                return;
            }

            // Create multiple rows with max 8 tracks per row
            const maxTracksPerRow = 8;
            const rows = [];
            for (let i = 0; i < tracks.length; i += maxTracksPerRow) {
                const rowTracks = tracks.slice(i, i + maxTracksPerRow);
                rows.push(rowTracks);
            }

            // Create track row wrapper for each row
            rows.forEach((rowTracks, rowIndex) => {
                const rowWrapper = document.createElement('div');
                rowWrapper.className = 'track-row-wrapper';
                rowWrapper.style.marginTop = rowIndex === 0 ? '1.5rem' : '1rem';

                // Create previous button
                const prevBtn = document.createElement('button');
                prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
                prevBtn.id = `uploads-row-prev-${rowIndex}`;
                prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

                // Create container for the row
                const rowContainer = document.createElement('div');
                rowContainer.className = 'track-row-container';

                // Create the track row
                const trackRow = document.createElement('div');
                trackRow.className = 'track-row';
                trackRow.id = `uploads-grid-${rowIndex}`;

                // Add tracks to the row with animation for new tracks
                const baseIndex = rowIndex * maxTracksPerRow;
                rowTracks.forEach(function(track, idx) {
                    const globalIndex = baseIndex + idx;
                    const card = buildTrackCard(track, tracks, globalIndex);
                    card.classList.add('track-row-card');

                    // Check if this is a new track
                    if (!existingLibraryTracks.has(track.id)) {
                        card.classList.add('new-track');
                        // Add animation delay for sequential effect
                        card.style.animationDelay = `${idx * 0.1}s`;
                        // Add to existing tracks
                        existingLibraryTracks.add(track.id);
                    }

                    trackRow.appendChild(card);
                });

                // Create next button
                const nextBtn = document.createElement('button');
                nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
                nextBtn.id = `uploads-row-next-${rowIndex}`;
                nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

                // Assemble the wrapper
                rowWrapper.appendChild(prevBtn);
                rowWrapper.appendChild(rowContainer);
                rowWrapper.appendChild(nextBtn);
                container.appendChild(rowWrapper);

                // Add track row to container
                rowContainer.appendChild(trackRow);
            });

            // Initialize track row scrolling for each row
            if (uploadsInitTimeout) clearTimeout(uploadsInitTimeout);
            uploadsInitTimeout = setTimeout(() => {
                rows.forEach((_, rowIndex) => {
                    const prevBtn = document.getElementById(`uploads-row-prev-${rowIndex}`);
                    const nextBtn = document.getElementById(`uploads-row-next-${rowIndex}`);
                    if (!prevBtn || !nextBtn || !prevBtn.isConnected || !nextBtn.isConnected) return;
                    const trackRow = document.getElementById(`uploads-grid-${rowIndex}`);
                    const rowContainer = prevBtn.nextElementSibling;

                    if (trackRow && rowContainer && rowContainer.isConnected && trackRow.isConnected) {
                        // Use global scroll position tracker
                        const rowKey = `uploads-row-${rowIndex}`;
                        if (!(rowKey in scrollPositions)) {
                            scrollPositions[rowKey] = 0;
                        }

                        // Compute card width dynamically
                        const sampleCard = trackRow.querySelector('.track-row-card');
                        const computedGap = parseFloat(getComputedStyle(trackRow).gap) || 16;
                        const cardWidth = (sampleCard ? sampleCard.offsetWidth : 160) + computedGap;

                        // Button visibility variables
                        let showPrevBtn = false;
                        let showNextBtn = false;

                        // Initialize previous button click
                        prevBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            scrollPositions[rowKey] = Math.max(0, scrollPositions[rowKey] - cardWidth * 2);
                            trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;
                            updateButtonStates();
                        });

                        // Initialize next button click
                        nextBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            scrollPositions[rowKey] = Math.min(maxScroll, scrollPositions[rowKey] + cardWidth * 2);
                            trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;
                            updateButtonStates();
                        });

                        // Get the wrapper element
                        const wrapper = prevBtn.parentElement;

                        // Show buttons when hovering over the track row wrapper
                        wrapper.addEventListener('mouseenter', () => {
                            showPrevBtn = true;
                            showNextBtn = true;
                            updateProximityVisibility();
                        });

                        // Hide buttons when mouse leaves the wrapper
                        wrapper.addEventListener('mouseleave', () => {
                            showPrevBtn = false;
                            showNextBtn = false;
                            updateProximityVisibility();
                        });

                        function updateProximityVisibility() {
                            prevBtn.classList.toggle('visible', showPrevBtn);
                            nextBtn.classList.toggle('visible', showNextBtn);

                            // Add specific classes for animations
                            prevBtn.classList.toggle('prev-visible', showPrevBtn);
                            nextBtn.classList.toggle('next-visible', showNextBtn);

                            // Debug logging
                            if (showPrevBtn || showNextBtn) {
                                console.log('Buttons visibility:', { showPrevBtn, showNextBtn });
                            }
                        }

                        function updateButtonStates() {
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            const isAtStart = scrollPositions[rowKey] <= 0;
                            const isAtEnd = scrollPositions[rowKey] >= maxScroll;

                            // Only hide buttons if there's no content to scroll
                            if (maxScroll <= 0) {
                                prevBtn.classList.add('hidden');
                                nextBtn.classList.add('hidden');
                            } else {
                                prevBtn.classList.toggle('hidden', isAtStart);
                                nextBtn.classList.toggle('hidden', isAtEnd);
                            }

                            // Update proximity visibility
                            updateProximityVisibility();
                        }

                        // Make track row transformable
                        trackRow.style.transition = 'transform 0.3s ease-out';
                        trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;

                        // Initial button state update
                        updateButtonStates();
                    }
                });
            }, 100);
        }

        function renderMostPlayed(tracks) {
            const container = document.getElementById('most-played-grid');
            if (!container) return;

            container.innerHTML = '';

            if (!tracks.length) {
                const emptyCard = document.createElement('div');
                emptyCard.className = 'card';
                emptyCard.innerHTML = '<p class="card-title">No most played tracks yet</p><p class="card-info">Play some tracks to see them here</p>';
                container.appendChild(emptyCard);
                updateTrackRowScrollButtons();
                return;
            }

            // Create multiple rows with max 9 tracks per row
            const maxTracksPerRow = 9;
            const rows = [];
            for (let i = 0; i < tracks.length; i += maxTracksPerRow) {
                const rowTracks = tracks.slice(i, i + maxTracksPerRow);
                rows.push(rowTracks);
            }

            // Create track row wrapper for each row
            rows.forEach((rowTracks, rowIndex) => {
                const rowWrapper = document.createElement('div');
                rowWrapper.className = 'track-row-wrapper';
                rowWrapper.style.marginTop = rowIndex === 0 ? '1.5rem' : '1rem';

                // Create previous button
                const prevBtn = document.createElement('button');
                prevBtn.className = 'track-row-scroll-btn track-row-scroll-btn-prev';
                prevBtn.id = `most-played-row-prev-${rowIndex}`;
                prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';

                // Create container for the row
                const rowContainer = document.createElement('div');
                rowContainer.className = 'track-row-container';

                // Create the track row
                const trackRow = document.createElement('div');
                trackRow.className = 'track-row';
                trackRow.id = `most-played-grid-${rowIndex}`;

                // Add tracks to the row with animation for new tracks
                const baseIndex = rowIndex * maxTracksPerRow;
                rowTracks.forEach(function(track, idx) {
                    const globalIndex = baseIndex + idx;
                    const card = buildTrackCard(track, tracks, globalIndex);
                    card.classList.add('track-row-card');

                    // Check if this is a new track
                    if (!existingMostPlayedTracks.has(track.id)) {
                        card.classList.add('new-track');
                        // Add animation delay for sequential effect
                        card.style.animationDelay = `${idx * 0.1}s`;
                        // Add to existing tracks
                        existingMostPlayedTracks.add(track.id);
                    }

                    trackRow.appendChild(card);
                });

                // Create next button
                const nextBtn = document.createElement('button');
                nextBtn.className = 'track-row-scroll-btn track-row-scroll-btn-next';
                nextBtn.id = `most-played-row-next-${rowIndex}`;
                nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

                // Assemble the wrapper
                rowWrapper.appendChild(prevBtn);
                rowWrapper.appendChild(rowContainer);
                rowWrapper.appendChild(nextBtn);
                container.appendChild(rowWrapper);

                // Add track row to container
                rowContainer.appendChild(trackRow);
            });

            // Initialize track row scrolling for each row
            if (mostPlayedInitTimeout) clearTimeout(mostPlayedInitTimeout);
            mostPlayedInitTimeout = setTimeout(() => {
                rows.forEach((_, rowIndex) => {
                    const prevBtn = document.getElementById(`most-played-row-prev-${rowIndex}`);
                    const nextBtn = document.getElementById(`most-played-row-next-${rowIndex}`);
                    if (!prevBtn || !nextBtn || !prevBtn.isConnected || !nextBtn.isConnected) return;
                    const trackRow = document.getElementById(`most-played-grid-${rowIndex}`);
                    const rowContainer = prevBtn.nextElementSibling;

                    if (trackRow && rowContainer && rowContainer.isConnected && trackRow.isConnected) {
                        // Use global scroll position tracker
                        const rowKey = `most-played-row-${rowIndex}`;
                        if (!(rowKey in scrollPositions)) {
                            scrollPositions[rowKey] = 0;
                        }

                        // Compute card width dynamically
                        const sampleCard = trackRow.querySelector('.track-row-card');
                        const computedGap = parseFloat(getComputedStyle(trackRow).gap) || 16;
                        const cardWidth = (sampleCard ? sampleCard.offsetWidth : 160) + computedGap;

                        // Button visibility variables
                        let showPrevBtn = false;
                        let showNextBtn = false;

                        // Initialize previous button click
                        prevBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            scrollPositions[rowKey] = Math.max(0, scrollPositions[rowKey] - cardWidth * 2);
                            trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;
                            updateButtonStates();
                        });

                        // Initialize next button click
                        nextBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            scrollPositions[rowKey] = Math.min(maxScroll, scrollPositions[rowKey] + cardWidth * 2);
                            trackRow.style.transform = `translateX(-${scrollPositions[rowKey]}px)`;
                            updateButtonStates();
                        });

                        // Get the wrapper element
                        const wrapper = prevBtn.parentElement;

                        // Show buttons when hovering over the track row wrapper
                        wrapper.addEventListener('mouseenter', () => {
                            showPrevBtn = true;
                            showNextBtn = true;
                            updateProximityVisibility();
                        });

                        // Hide buttons when mouse leaves the wrapper
                        wrapper.addEventListener('mouseleave', () => {
                            showPrevBtn = false;
                            showNextBtn = false;
                            updateProximityVisibility();
                        });

                        function updateProximityVisibility() {
                            prevBtn.classList.toggle('visible', showPrevBtn);
                            nextBtn.classList.toggle('visible', showNextBtn);

                            // Add specific classes for animations
                            prevBtn.classList.toggle('prev-visible', showPrevBtn);
                            nextBtn.classList.toggle('next-visible', showNextBtn);

                            // Debug log
                            if (showPrevBtn || showNextBtn) {
                                console.log('Buttons visibility:', { showPrevBtn, showNextBtn });
                            }
                        }

                        function updateButtonStates() {
                            const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                            const isAtStart = scrollPositions[rowKey] <= 0;
                            const isAtEnd = scrollPositions[rowKey] >= maxScroll;

                            // Only hide buttons if there's no content to scroll
                            if (maxScroll <= 0) {
                                prevBtn.classList.add('hidden');
                                nextBtn.classList.add('hidden');
                            } else {
                                prevBtn.classList.toggle('hidden', isAtStart);
                                nextBtn.classList.toggle('hidden', isAtEnd);
                            }

                            // Update proximity visibility
                            updateProximityVisibility();
                        }

                        // Make track row transformable
                        trackRow.style.transition = 'transform 0.3s ease-out';
                        trackRow.style.transform = 'translateX(0)';
                        currentPosition = 0;

                        // Initial button state update
                        updateButtonStates();
                    }
                });
            }, 100);
        }

        async function loadTracks() {
            try { var data = await api("/tracks?limit=24"); renderTracks(Array.isArray(data) ? data : []); } catch (err) { console.error(err); }
        }

        async function loadUserUploads() {
            if (!authHash) {
                uploadsGrid.innerHTML = '<div class="card"><p class="card-title">Not logged in</p><p class="card-info">Log in to view your uploads</p></div>';
                return;
            }
            try {
                // All users (including admin) should only see their own uploads in the upload page
                var url = "/tracks?limit=24&user_hash=" + encodeURIComponent(authHash);
                var data = await api(url);
                renderUploads(Array.isArray(data) ? data : []);
            } catch (err) { console.error(err); }
        }

        async function loadMostPlayed() {
            try {
                var data = await api("/tracks/most-played?limit=9");
                renderMostPlayed(Array.isArray(data) ? data : []);
            } catch (err) { console.error(err); }
        }

        async function loadLastTrackPaused() {
            if (!authHash) return;
            try {
                var data = await api("/user/last-track");
                if (data && data.id) {
                    // Reset current player state before loading last track
                    audioPlayer.pause();
                    audioPlayer.src = "";
                    btnPlay.classList.remove("playing");
                    progressContainer.classList.remove("active");
                    loadTrackPaused(data);
                }
            } catch (err) { console.error("Failed to load last track:", err); }
        }

        async function downloadFromLink() {
            // Check if upload is enabled for current user (admins can always upload)
            if (!currentUser || (!currentUser.is_admin && !currentUser.upload_enabled)) {
                alert("Uploads are disabled for your account.");
                return;
            }
            var url = document.getElementById("download-url").value.trim();
            var progressDiv = document.getElementById("download-progress");
            var statusText = document.getElementById("download-status-text");
            var progressBar = document.getElementById("download-progress-bar");
            if (!url) { statusText.textContent = "Paste a link first."; progressDiv.style.display = "block"; return; }
            if (!url.startsWith("http")) { statusText.textContent = "Paste a valid https:// link."; progressDiv.style.display = "block"; return; }
            
            progressDiv.style.display = "block";
            statusText.textContent = "Queuing download…";
            progressBar.style.width = "0%";
            
            try {
                var jobData = await api("/downloads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: url, source: "spotiflac" }) });
                pollJobStatus(jobData.id);
            } catch (err) { console.error(err); statusText.textContent = "Download failed. " + (err.message || ""); progressBar.style.width = "100%"; progressBar.classList.add("progress-error"); }
        }

        function pollJobStatus(jobId) {
            var progressDiv = document.getElementById("download-progress");
            var statusText = document.getElementById("download-status-text");
            var progressBar = document.getElementById("download-progress-bar");
            progressDiv.style.display = "block";

            // Clear any existing poll to prevent overlaps
            if (activeDownloadPoll) {
                clearInterval(activeDownloadPoll);
                activeDownloadPoll = null;
            }

            var poll = setInterval(function() {
                api("/downloads/" + jobId).then(function(job) {
                    if (job.status === "completed") {
                        clearInterval(poll);
                        activeDownloadPoll = null;
                        statusText.textContent = "Download completed.";
                        progressBar.classList.remove("progress-indeterminate", "progress-error");
                        progressBar.style.width = "100%";
                        progressBar.classList.add("progress-complete");
                        loadTracks(); loadMostPlayed(); loadUserUploads();
                        document.getElementById("download-url").value = "";
                        setTimeout(function() { 
                            progressDiv.style.display = "none"; 
                            progressBar.classList.remove("progress-complete");
                            progressBar.style.width = "0%";
                        }, 3000);
                    } else if (job.status === "failed") {
                        clearInterval(poll);
                        activeDownloadPoll = null;
                        statusText.textContent = "Download failed.";
                        progressBar.classList.remove("progress-indeterminate");
                        progressBar.style.width = "100%";
                        progressBar.classList.add("progress-error");
                        setTimeout(function() { progressBar.classList.remove("progress-error"); }, 500);
                        var errorDetail = document.getElementById("download-error-detail");
                        if (!errorDetail) {
                            var detailP = document.createElement("p");
                            detailP.id = "download-error-detail";
                            detailP.style.cssText = "color: #b3b3b3; font-size: 0.75rem; margin-top: 0.5rem; white-space: pre-wrap; max-height: 100px; overflow-y: auto;";
                            progressDiv.appendChild(detailP);
                            errorDetail = detailP;
                        }
                        errorDetail.style.display = "block";
                        errorDetail.textContent = job.log || "Unknown error.";
                    } else {
                        var log = job.log || "";
                        var lines = log.split("\n").filter(function(l) { return l.trim(); });
                        var trackName = "";
                        var progressPercent = 0;
                        
                        for (var i = lines.length - 1; i >= 0; i--) {
                            var line = lines[i];
                            if (line.includes("Found:")) {
                                trackName = line.split("Found:")[1].trim();
                            }
                            if (line.includes("Downloaded:")) {
                                var mb = line.split("Downloaded:")[1].split(" MB |")[0];
                                progressPercent = Math.min(85, (parseFloat(mb) / 8) * 100);
                            } else if (line.includes("Metadata embedded")) {
                                progressPercent = Math.max(progressPercent, 92);
                            } else if (line.includes("Download complete:")) {
                                progressPercent = Math.max(progressPercent, 95);
                            } else if (line.includes("Scan complete")) {
                                progressPercent = Math.max(progressPercent, 98);
                            } else if (line.includes("Starting")) {
                                progressPercent = Math.max(progressPercent, 5);
                            }
                        }
                        
                        if (trackName) {
                            statusText.textContent = "Downloading: " + trackName;
                        } else {
                            var lastLine = lines[lines.length - 1] || (job.status + "...");
                            if (lastLine.length > 60) lastLine = lastLine.substring(0, 60) + "...";
                            statusText.textContent = lastLine;
                        }
                        
                        if (progressPercent > 0) {
                            progressBar.classList.remove("progress-indeterminate");
                            progressBar.style.width = progressPercent + "%";
                        } else {
                            progressBar.classList.add("progress-indeterminate");
                        }
                    }
                }).catch(function(err) { 
                    clearInterval(poll);
                    activeDownloadPoll = null;
                    statusText.textContent = "Poll error: " + err.message; 
                    progressBar.classList.remove("progress-indeterminate");
                    progressBar.classList.add("progress-error");
                });
            }, 2000);
            
            activeDownloadPoll = poll;
        }

        async function runSearch() {
            var query = searchInput.value.trim();
            if (!query) {
                hideSearchDropdown();
                return;
            }

            try {
                const q = query;
                var data = await api("/search?q=" + encodeURIComponent(q) + "&limit=12");
                if (searchInput.value.trim() !== q) return; // ignore stale responses
                lastSearchResults = Array.isArray(data) ? data : [];
                renderSearchDropdown(lastSearchResults);
            } catch (err) {
                console.error(err);
                renderSearchDropdown([]);
            }
        }

        function hideSearchDropdown() {
            if (!searchDropdown) return;
            searchDropdown.style.display = "none";
            searchDropdown.innerHTML = "";
        }

        function renderSearchDropdown(results) {
            if (!searchDropdown) return;
            const items = Array.isArray(results) ? results : [];
            searchDropdown.innerHTML = "";
            searchDropdown.style.display = "block";

            const inner = document.createElement("div");
            inner.className = "search-dropdown-inner";

            if (!items.length) {
                const empty = document.createElement("div");
                empty.className = "search-dropdown-empty";
                empty.textContent = "No results.";
                inner.appendChild(empty);
                searchDropdown.appendChild(inner);
                return;
            }

            items.forEach(function(track, index) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "search-result";

                const artistText = getArtistDisplay(track) || "Unknown";
                const seed = ((track.title || "") + " " + artistText).trim() || "Openfy";

                const art = document.createElement("div");
                art.className = "search-result-art";
                art.style.setProperty("--sr-color", seededColor(seed));

                const img = document.createElement("img");
                img.alt = (track.title || "Track") + " artwork";
                img.loading = "lazy";
                img.decoding = "async";
                img.src = queueArtworkUrl(track);
                img.onerror = function() { img.remove(); };
                art.appendChild(img);

                const meta = document.createElement("div");
                meta.className = "search-result-meta";

                const titleEl = document.createElement("div");
                titleEl.className = "search-result-title";
                titleEl.textContent = track.title || "";

                const artistEl = document.createElement("div");
                artistEl.className = "search-result-artist";
                artistEl.textContent = artistText;

                meta.appendChild(titleEl);
                meta.appendChild(artistEl);

                btn.appendChild(art);
                btn.appendChild(meta);

                btn.addEventListener("click", function(ev) {
                    ev.preventDefault();
                    setQueueFromList(items, index);
                    if (currentQueue.length) playTrack(currentQueue[0]);
                    hideSearchDropdown();
                    searchInput.blur();
                });

                inner.appendChild(btn);
            });

            searchDropdown.appendChild(inner);
        }

        async function checkForTrackUpdates() {
            try {
                var response = await api("/tracks/updates?since=" + lastTrackUpdate);
                if (response.has_updates) {
                    console.log("New tracks detected, refreshing...");
                    lastTrackUpdate = response.timestamp;
                    loadTracks();
                    loadMostPlayed();

                    // If we're on the upload page, refresh uploads too
                    if (pages.library.classList.contains('active')) {
                        loadUserUploads();
                    }
                }
            } catch (err) {
                console.error("Error checking for updates:", err);
            }
        }

        function startUpdateChecker() {
            // Clear any existing interval
            if (updateCheckInterval) {
                clearInterval(updateCheckInterval);
            }

            // Check for updates every 5 seconds
            updateCheckInterval = setInterval(checkForTrackUpdates, 5000);
        }

        function stopUpdateChecker() {
            if (updateCheckInterval) {
                clearInterval(updateCheckInterval);
                updateCheckInterval = null;
            }
        }

        // Remove new-track class after animation completes
        document.addEventListener('animationend', function(e) {
            if (e.target.classList.contains('new-track')) {
                // Remove the class after animation
                setTimeout(() => {
                    e.target.classList.remove('new-track');
                    // Clear the animation delay property
                    e.target.style.animationDelay = '';
                }, 10);
            }
        });

        function playTrack(track) {
            console.log('Playing track:', track.title);
            currentTrackId = track.id;
            updateMediaSession(track);
            var streamUrl = "/tracks/" + track.id + "/stream";
            if (authHash) streamUrl += "?auth=" + encodeURIComponent(authHash);
            audioPlayer.src = withBase(streamUrl);
            audioPlayer.play().catch(function(err) { console.error(err); });
            nowTitle.textContent = track.title || "";
            nowArtist.textContent = getArtistDisplay(track) || "";
            // Set tab title: "Track Name - First Artist"
            var artistTitle = (track.artists && track.artists.length > 0 && track.artists[0].name) || (track.artist && track.artist.name) || "Unknown";
            document.title = (track.title || "Openfy") + " - " + artistTitle;
            clearCanvas(nowCover);
            nowCover.classList.remove("visible");

            // Emit trackChanged event for gradient manager
            emitTrackChanged(track);

            var img = new Image();
            img.onload = function() {
                var ctx = nowCover.getContext("2d");
                ctx.clearRect(0, 0, nowCover.width, nowCover.height);
                var size = Math.min(img.width, img.height);
                ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, nowCover.width, nowCover.height);
                nowCover.classList.add("visible");
            };
            img.onerror = function() {
                drawCanvas(nowCover, track.title, getArtistDisplay(track) || "");
                nowCover.classList.add("visible");
            };
            img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
            updateNowPlaying(track);
            renderNowPlayingQueue();
            // Show like button only if authenticated
            if (authHash) {
                npLikeBtn.classList.remove("hidden");
                npLikeBtn.classList.remove("liked", "adding");
                npLikeBtn.innerHTML = "";
                // Check if already liked
                checkIfLiked(track.id);
            } else {
                npLikeBtn.classList.add("hidden");
            }
            // Close any open removal menu when track changes
            hideRemovalMenuIfVisible();
        }

        function loadTrackPaused(track) {
            console.log('Loading track (paused):', track.title);
            currentTrackId = track.id;
            updateMediaSession(track);
            // Set track to current queue (single track)
            setQueueFromList([track], 0);
            // Set audio source so it's ready to play, but keep paused
            var streamUrl = "/tracks/" + track.id + "/stream";
            if (authHash) streamUrl += "?auth=" + encodeURIComponent(authHash);
            audioPlayer.src = withBase(streamUrl);
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            // Update UI
            nowTitle.textContent = track.title || "";
            nowArtist.textContent = getArtistDisplay(track) || "";
            clearCanvas(nowCover);
            nowCover.classList.remove("visible");

            // Emit trackChanged event for gradient manager
            emitTrackChanged(track);

            var img = new Image();
            img.onload = function() {
                var ctx = nowCover.getContext("2d");
                ctx.clearRect(0, 0, nowCover.width, nowCover.height);
                var size = Math.min(img.width, img.height);
                ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, nowCover.width, nowCover.height);
                nowCover.classList.add("visible");
            };
            img.onerror = function() {
                drawCanvas(nowCover, track.title, getArtistDisplay(track) || "");
                nowCover.classList.add("visible");
            };
            img.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
            updateNowPlaying(track);
            renderNowPlayingQueue();
            // Show like button only if authenticated
            if (authHash) {
                npLikeBtn.classList.remove("hidden");
                npLikeBtn.classList.remove("liked", "adding");
                npLikeBtn.innerHTML = "";
                checkIfLiked(track.id);
            } else {
                npLikeBtn.classList.add("hidden");
            }
            // Ensure play button shows paused state
            btnPlay.classList.remove("playing");
            progressContainer.classList.remove("active");
            // Close any open removal menu when track changes
            hideRemovalMenuIfVisible();
        }

        async function checkIfLiked(trackId) {
            if (!authHash) {
                npLikeBtn.classList.add("hidden");
                return;
            }
            try {
                const res = await api("/liked/" + trackId);
                if (res.liked) {
                    npLikeBtn.classList.add("liked");
                    npLikeBtn.innerHTML = '<i class="fa-solid fa-heart"></i>';
                    npLikeBtn.setAttribute("aria-label", "Remove from Liked Songs");
                    npLikeBtn.setAttribute("title", "Remove from Liked Songs");
                } else {
                    npLikeBtn.classList.remove("liked");
                    npLikeBtn.innerHTML = "";
                    npLikeBtn.setAttribute("aria-label", "Add to Liked Songs");
                    npLikeBtn.setAttribute("title", "Add to Liked Songs");
                }
            } catch (e) {
                console.error("checkIfLiked error:", e);
                npLikeBtn.classList.remove("liked");
                npLikeBtn.innerHTML = "";
            }
        }

        function updateNowPlaying(track) {
            npPlaceholder.style.display = "none";
            npTrack.style.display = "flex";
            npTitle.textContent = track.title || "";
            npArtist.textContent = getArtistDisplay(track) || "Unknown";
            clearCanvas(npCover);
            npCover.style.display = "none";
            npImg.style.display = "none";
            var npImgEl = new Image();
            npImgEl.onload = function() {
                npImg.src = npImgEl.src;
                npImg.style.display = "block";
                npCover.style.display = "none";
            };
            npImgEl.onerror = function() {
                drawCanvas(npCover, track.title, getArtistDisplay(track) || "");
                npCover.style.display = "block";
                npImg.style.display = "none";
            };
            npImgEl.src = withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));

            // Update like button state based on playlist membership
            syncLikeButtonState(track);
        }

        function queueArtworkUrl(track) {
            return withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
        }

        // Sync like button appearance to track's playlist membership
        function syncLikeButtonState(track) {
            npLikeBtn.disabled = false;
            npLikeBtn.classList.remove("liked", "adding", "in-playlist");

            if (likedTrackIds.has(track.id)) {
                npLikeBtn.classList.add("liked");
                npLikeBtn.innerHTML = '<i class="fa-solid fa-heart"></i>';
                npLikeBtn.setAttribute("aria-label", "Remove from Liked Songs");
                npLikeBtn.setAttribute("title", "Remove from Liked Songs");
            } else if (trackIdsInRegularPlaylists.has(track.id)) {
                npLikeBtn.classList.add("in-playlist");
                npLikeBtn.innerHTML = '';
                npLikeBtn.setAttribute("aria-label", "Added to playlist");
                npLikeBtn.setAttribute("title", "Added to playlist");
            } else {
                npLikeBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
                npLikeBtn.setAttribute("aria-label", "Add to Liked Songs");
                npLikeBtn.setAttribute("title", "Add to Liked Songs");
            }
        }

        function buildQueueItem(track, index, opts) {
            opts = opts || {};
            const btn = document.createElement("button");
            btn.type = "button";
            let className = "np-queue-item";
            if (opts.isNext) className += " next";
            if (opts.isCurrent) className += " current";
            btn.className = className;
            btn.draggable = !opts.isCurrent; // allow dragging for all tracks except current
            btn.dataset.index = index;
            btn.dataset.trackId = track && track.id != null ? String(track.id) : "";

            const artistText = getArtistDisplay(track) || "Unknown";
            const seed = ((track.title || "") + " " + artistText).trim() || "Openfy";

            const art = document.createElement("div");
            art.className = "np-queue-art";
            art.style.setProperty("--queue-color", seededColor(seed));

            const img = document.createElement("img");
            img.alt = (track.title || "Track") + " artwork";
            img.loading = "lazy";
            img.decoding = "async";
            img.src = queueArtworkUrl(track);
            img.onerror = function() { img.remove(); };
            art.appendChild(img);

            const meta = document.createElement("div");
            meta.className = "np-queue-meta";

            const titleEl = document.createElement("div");
            titleEl.className = "np-queue-title";
            titleEl.textContent = track.title || "";

            const artistEl = document.createElement("div");
            artistEl.className = "np-queue-artist";
            artistEl.textContent = artistText;

            meta.appendChild(titleEl);
            meta.appendChild(artistEl);

            const badge = document.createElement("div");
            badge.className = "np-queue-badge";
            badge.textContent = opts.badgeText || "";
            if (!badge.textContent) badge.style.display = "none";

            // Now Playing indicator for current track
            if (opts.isCurrent) {
                const nowPlayingBadge = document.createElement("span");
                nowPlayingBadge.className = "np-queue-now-playing";
                nowPlayingBadge.innerHTML = '<i class="fa-solid fa-music"></i> Now Playing';
                meta.appendChild(nowPlayingBadge);
            }

            // Click to play
            btn.appendChild(art);
            btn.appendChild(meta);
            btn.appendChild(badge);

            // Click to play
            btn.addEventListener("click", function(ev) {
                ev.preventDefault();
                if (!currentQueue || !currentQueue.length) return;
                if (index < 0 || index >= currentQueue.length) return;
                currentIndex = index;
                // Reset repeat state when manually selecting a track
                repeatState = "off";
                repeatCount = 0;
                btnRepeat.classList.remove("active", "loop-twice");
                playTrack(currentQueue[currentIndex]);
            });

            // Drag start
            btn.addEventListener("dragstart", function(ev) {
                if (opts.isCurrent) {
                    ev.preventDefault();
                    return;
                }
                dragSourceIndex = index;
                draggedElement = btn;
                btn.classList.add("dragging");
                if (ev.dataTransfer) {
                    ev.dataTransfer.setData("text/plain", index.toString());
                    ev.dataTransfer.effectAllowed = "move";
                }
                lastDragY = ev.clientY;
                lastInsertBeforeEl = null; // reset FLIP tracker
            });

            // Drag end - cleanup
            btn.addEventListener("dragend", function(ev) {
                btn.classList.remove("dragging");
                // Cleanup any inline styles from FLIP animation
                document.querySelectorAll('.np-queue-item').forEach(el => {
                    el.style.transform = '';
                    el.style.transition = '';
                });
                document.querySelectorAll(".np-queue-item.drag-over").forEach(function(el) {
                    el.classList.remove("drag-over");
                });
                dragSourceIndex = null;
                draggedElement = null;
                lastDragY = null;
                lastInsertBeforeEl = null;
            });

            // Track mouse movement during drag
            btn.addEventListener("drag", function(ev) {
                lastDragY = ev.clientY;
            });

            return btn;
         }

         // Get the element before which the dragged item should be inserted
        function getInsertBeforeElement(container) {
            const items = Array.from(container.querySelectorAll(".np-queue-item:not(.dragging)"));
            const dragY = lastDragY;
            if (dragY === null || items.length === 0) return null;

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const rect = item.getBoundingClientRect();
                const itemMidY = rect.top + rect.height / 2;
                if (dragY < itemMidY) {
                    return item;
                }
            }
            return null; // append at end
        }

        // Real-time reordering during dragover
        npQueueNext.addEventListener("dragover", function(ev) {
            ev.preventDefault();
            if (!draggedElement) return;
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
            lastDragY = ev.clientY;
            updateDragPosition();
        });

        function updateDragPosition() {
            if (!draggedElement || !npQueueNext.contains(draggedElement)) return;

            const insertBeforeEl = getInsertBeforeElement(npQueueNext);

            // Only act if the insertion target changed
            if (insertBeforeEl === lastInsertBeforeEl) return;

            // --- FLIP: capture "before" positions of siblings ---
            const siblings = Array.from(npQueueNext.querySelectorAll('.np-queue-item:not(.dragging)'));
            const beforeRects = new Map();
            siblings.forEach(el => beforeRects.set(el, el.getBoundingClientRect()));

            // Perform DOM reorder
            if (insertBeforeEl) {
                if (draggedElement.nextSibling !== insertBeforeEl) {
                    npQueueNext.insertBefore(draggedElement, insertBeforeEl);
                }
            } else {
                if (draggedElement.nextSibling !== null) {
                    npQueueNext.appendChild(draggedElement);
                }
            }

            // --- FLIP: animate siblings to their new positions ---
            siblings.forEach(el => {
                const before = beforeRects.get(el);
                const after = el.getBoundingClientRect();
                const deltaX = before.left - after.left;
                const deltaY = before.top - after.top;
                if (deltaX !== 0 || deltaY !== 0) {
                    // Hold element at old position
                    el.style.transition = 'none';
                    el.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                    // Force reflow to apply the transform
                    el.offsetHeight;
                    // Animate to natural new position
                    el.style.transition = 'transform 0.15s ease';
                    el.style.transform = '';
                }
            });

            // Update visual indicator
            document.querySelectorAll('.np-queue-item.drag-over').forEach(el => el.classList.remove('drag-over'));
            if (insertBeforeEl) {
                insertBeforeEl.classList.add('drag-over');
            }

            // Remember this insertion point for the next dragover
            lastInsertBeforeEl = insertBeforeEl;
        }

        // Reset on dragleave of container
        npQueueNext.addEventListener("dragleave", function(ev) {
            if (!npQueueNext.contains(ev.relatedTarget)) {
                document.querySelectorAll(".np-queue-item.drag-over").forEach(function(el) {
                    el.classList.remove("drag-over");
                });
            }
        });

        // Drop finalizes reorder
        npQueueNext.addEventListener("drop", function(ev) {
            ev.preventDefault();
            if (dragSourceIndex === null || !draggedElement) return;

            // Compute new index based on dragged element's position in DOM
            const allItems = Array.from(npQueueNext.querySelectorAll(".np-queue-item"));
            const newVisualIndex = allItems.indexOf(draggedElement);
            if (newVisualIndex === -1) return;

            // Visual index → absolute queue index
            const nextIndex = currentIndex + 1;
            const toIndex = nextIndex + newVisualIndex;

            if (toIndex === dragSourceIndex) return;

            reorderQueue(dragSourceIndex, toIndex);
        });

        function renderNowPlayingQueue() {
            if (!npNextPanel || !npQueueNext) return;

            npNextPanel.style.display = "";

            // Empty state
            if (!currentQueue || !currentQueue.length || currentIndex < 0) {
                npQueueNext.innerHTML = "";
                const empty = document.createElement("div");
                empty.className = "np-queue-empty";
                empty.textContent = "Play something to build a queue.";
                npQueueNext.appendChild(empty);
                lastRenderedIndices = [];
                return;
            }

            const nextIndex = currentIndex + 1;
            if (nextIndex >= currentQueue.length) {
                npQueueNext.innerHTML = "";
                const empty = document.createElement("div");
                empty.className = "np-queue-empty";
                empty.textContent = "End of queue.";
                npQueueNext.appendChild(empty);
                lastRenderedIndices = [];
                return;
            }

            const visibleCount = showFullQueue ? 6 : 1;
            const windowStart = nextIndex;
            const windowEnd = Math.min(nextIndex + visibleCount, currentQueue.length);
            const newIndices = [];
            for (let i = windowStart; i < windowEnd; i++) newIndices.push(i);

            const oldRectsByTrackId = new Map();
            npQueueNext.querySelectorAll('.np-queue-item').forEach(el => {
                const trackId = el.dataset.trackId;
                if (trackId) oldRectsByTrackId.set(trackId, el.getBoundingClientRect());
            });

            // Rebuild from the queue state directly so the visible list never
            // drifts away from `currentQueue` after a manual reorder.
            npQueueNext.innerHTML = "";
            const mountedItems = [];

            newIndices.forEach(idx => {
                const track = currentQueue[idx];
                const el = buildQueueItem(track, idx, { isCurrent: false, badgeText: "" });
                npQueueNext.appendChild(el);
                mountedItems.push(el);
            });

            // FLIP-style motion: existing tracks glide to new positions, new tracks
            // get a subtle entry motion so queue updates feel continuous.
            mountedItems.forEach(el => {
                const trackId = el.dataset.trackId;
                const oldRect = trackId ? oldRectsByTrackId.get(trackId) : null;
                const newRect = el.getBoundingClientRect();

                if (oldRect) {
                    const deltaX = oldRect.left - newRect.left;
                    const deltaY = oldRect.top - newRect.top;
                    if (deltaX !== 0 || deltaY !== 0) {
                        el.style.transition = 'none';
                        el.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                        el.offsetHeight;
                        el.style.transition = 'transform 0.24s ease';
                        el.style.transform = '';
                    }
                } else {
                    el.style.transition = 'none';
                    el.style.opacity = '0';
                    el.style.transform = 'translateY(10px)';
                    el.offsetHeight;
                    el.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
                    el.style.opacity = '';
                    el.style.transform = '';
                }
            });

            setTimeout(() => {
                if (!npQueueNext) return;
                npQueueNext.querySelectorAll('.np-queue-item').forEach(el => {
                    el.style.transition = '';
                    el.style.transform = '';
                    el.style.opacity = '';
                });
            }, 260);

            lastRenderedIndices = newIndices;
        }

        // Toggle full queue view on header click
        queueHeader.addEventListener("click", function(e) {
            e.preventDefault();
            const h3 = queueHeader.querySelector("h3");
            const collapseDelay = 280; // matches CSS transition duration (0.28s)

            if (showFullQueue) {
                // Collapse to "NEXT IN QUEUE"
                showFullQueue = false;
                h3.textContent = "NEXT IN QUEUE";
                // Icon transition handled via CSS .expanded class
                npNextPanel.classList.remove("expanded");

                if (collapseTimeout) {
                    clearTimeout(collapseTimeout);
                    collapseTimeout = null;
                }

                collapseTimeout = setTimeout(function() {
                    collapseTimeout = null;
                    renderNowPlayingQueue();
                }, collapseDelay);
            } else {
                // Expand to "QUEUE"
                showFullQueue = true;
                h3.textContent = "QUEUE";
                // Icon transition handled via CSS .expanded class
                npNextPanel.classList.add("expanded");
                if (collapseTimeout) {
                    clearTimeout(collapseTimeout);
                    collapseTimeout = null;
                }
                renderNowPlayingQueue();
            }
        });

        function indexOfTrackId(queue, trackId, startFrom) {
            if (!trackId || !Array.isArray(queue)) return -1;
            const startIdx = startFrom !== undefined ? startFrom : 0;
            for (let i = startIdx; i < queue.length; i++) {
                if (queue[i] && queue[i].id == trackId) return i;
            }
            return -1;
        }

        function shuffleQueueOnce() {
            // Shuffle only the upcoming part of the queue, keeping the current track fixed.
            if (!shuffle) return;
            if (!Array.isArray(currentQueue) || currentQueue.length < 2) return;
            if (currentIndex < 0) return;

            if (!queueOriginal) queueOriginal = currentQueue.slice();

            const start = currentIndex + 1;
            const suffix = currentQueue.slice(start);
            for (let i = suffix.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const tmp = suffix[i];
                suffix[i] = suffix[j];
                suffix[j] = tmp;
            }
            currentQueue = currentQueue.slice(0, start).concat(suffix);
        }

        function unshuffleQueue() {
            if (!queueOriginal) return;
            const activeTrackId = currentTrackId;
            currentQueue = queueOriginal.slice();
            queueOriginal = null;
            if (activeTrackId) {
                const idx = indexOfTrackId(currentQueue, activeTrackId);
                if (idx !== -1) currentIndex = idx;
            }
        }

        // Paint initial empty state for the queue panel.
        renderNowPlayingQueue();

        function togglePlay() {
            if (!audioPlayer.src || audioPlayer.src === window.location.href) {
                // If no source but we have a current track, start playback
                if (currentTrackId && currentQueue.length && currentIndex >= 0) {
                    playTrack(currentQueue[currentIndex]);
                    return;
                }
                return;
            }
            if (audioPlayer.paused) { audioPlayer.play().catch(function(err) { console.error(err); }); } else { audioPlayer.pause(); }
        }

        function playByIndex(index, fromRepeat) {
            if (!currentQueue.length) return;
            if (index < 0 || index >= currentQueue.length) return;
            currentIndex = index;
            if (!fromRepeat) {
                repeatState = "off";
                repeatCount = 0;
                btnRepeat.classList.remove("active", "loop-twice");
            }
            playTrack(currentQueue[currentIndex]);
        }

        audioPlayer.addEventListener("loadedmetadata", function() { totTime.textContent = formatDuration(audioPlayer.duration); });
        audioPlayer.addEventListener("play", function() {
            btnPlay.classList.add("playing");
            progressContainer.classList.add("active");
            // Update media session playback state
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
            // Update tab title when playback starts (including resume from pause)
            if (currentQueue.length && currentIndex >= 0 && currentIndex < currentQueue.length) {
                var track = currentQueue[currentIndex];
                var artistTitle = (track.artists && track.artists.length > 0 && track.artists[0].name) || (track.artist && track.artist.name) || "Unknown";
                document.title = (track.title || "Openfy") + " - " + artistTitle;
            }
        });
        audioPlayer.addEventListener("pause", function() {
            btnPlay.classList.remove("playing");
            progressContainer.classList.remove("active");
            // Update media session playback state
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
        });

        function updateProgressFill() {
            var pct = audioPlayer.duration ? (audioPlayer.currentTime / audioPlayer.duration) * 100 : 0;
            progressFill.style.width = pct + "%";
        }

        function smoothProgress() {
            if (!audioPlayer.paused && audioPlayer.duration) {
                currTime.textContent = formatDuration(audioPlayer.currentTime);
                updateProgressFill();
            }
            requestAnimationFrame(smoothProgress);
        }
        requestAnimationFrame(smoothProgress);

        // Media Session position state synchronization (throttled via timeupdate)
        let lastMediaSessionUpdate = 0;
        audioPlayer.addEventListener("timeupdate", function() {
            if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;

            const now = Date.now();
            if (now - lastMediaSessionUpdate < 100) return; // Throttle to ~10Hz
            lastMediaSessionUpdate = now;

            if (audioPlayer.duration) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: audioPlayer.duration,
                        playbackRate: audioPlayer.playbackRate,
                        position: audioPlayer.currentTime
                    });
                } catch (e) {
                    // Silently ignore
                }
            }
        });

        // Update position state when duration becomes available (some files report late)
        audioPlayer.addEventListener("durationchange", function() {
            if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
            if (audioPlayer.duration) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: audioPlayer.duration,
                        playbackRate: audioPlayer.playbackRate,
                        position: audioPlayer.currentTime
                    });
                } catch (e) {
                    // Silently ignore
                }
            }
        });

        audioPlayer.addEventListener("ended", function() {
            if (repeatState === "loop-once") {
                repeatState = "off";
                btnRepeat.classList.remove("active", "loop-twice");
                playTrack(currentQueue[currentIndex]);
            } else if (repeatState === "loop-twice") {
                if (repeatCount < 2) {
                    repeatCount++;
                    if (repeatCount >= 2) {
                        btnRepeat.classList.add("loop-twice");
                    }
                    playTrack(currentQueue[currentIndex]);
                } else {
                    repeatCount = 0;
                    btnRepeat.classList.remove("active", "loop-twice");
                    playByIndex(currentIndex + 1, false);
                }
            } else {
                // Check if there's a next track
                var nextIndex = (currentIndex + 1) % currentQueue.length;
                if (nextIndex === 0) {
                    // No next track - reset title
                    document.title = "Openfy - Web Player";
                } else {
                    playByIndex(currentIndex + 1, false);
                }
            }
        });

        
        // Custom progress bar interaction
        let isDragging = false;

        function seekFromEvent(e) {
            var rect = progressTrack.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
            if (audioPlayer.duration) {
                audioPlayer.currentTime = (pct / 100) * audioPlayer.duration;
                updateProgressFill();
                // Immediately notify Media Session of seek to keep OS overlay in sync
                if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
                    try {
                        navigator.mediaSession.setPositionState({
                            duration: audioPlayer.duration,
                            playbackRate: audioPlayer.playbackRate,
                            position: audioPlayer.currentTime
                        });
                    } catch (e) {
                        // Silently ignore
                    }
                }
            }
        }

        progressContainer.addEventListener("mousedown", function(e) {
            isDragging = true;
            progressContainer.classList.add("dragging");
            seekFromEvent(e);
        });

        progressContainer.addEventListener("touchstart", function(e) {
            isDragging = true;
            progressContainer.classList.add("dragging");
            seekFromEvent(e.touches[0]);
            e.preventDefault();
        }, { passive: false });

        document.addEventListener("mousemove", function(e) {
            if (isDragging) {
                seekFromEvent(e);
            }
        });

        document.addEventListener("touchmove", function(e) {
            if (isDragging) {
                seekFromEvent(e.touches[0]);
            }
        });

        document.addEventListener("mouseup", function() {
            if (isDragging) {
                isDragging = false;
                progressContainer.classList.remove("dragging");
            }
        });

        document.addEventListener("touchend", function() {
            if (isDragging) {
                isDragging = false;
                progressContainer.classList.remove("dragging");
            }
        });

        // Register Media Session API action handlers
        if ('mediaSession' in navigator) {
            // Play handler
            navigator.mediaSession.setActionHandler('play', function() {
                if (audioPlayer.paused && audioPlayer.src && audioPlayer.src !== window.location.href) {
                    audioPlayer.play().catch(function(err) { console.error(err); });
                }
            });

            // Pause handler
            navigator.mediaSession.setActionHandler('pause', function() {
                if (!audioPlayer.paused) {
                    audioPlayer.pause();
                }
            });

            // Previous track handler
            navigator.mediaSession.setActionHandler('previoustrack', function() {
                if (currentQueue.length && currentIndex > 0) {
                    playByIndex(currentIndex - 1, false);
                }
            });

            // Next track handler
            navigator.mediaSession.setActionHandler('nexttrack', function() {
                if (currentQueue.length && currentIndex < currentQueue.length - 1) {
                    playByIndex(currentIndex + 1, false);
                }
            });

            // Seek backward handler (-10 seconds)
            navigator.mediaSession.setActionHandler('seekbackward', function() {
                if (audioPlayer.duration) {
                    audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10);
                    // Immediately update position state for responsive OS UI
                    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
                        navigator.mediaSession.setPositionState({
                            duration: audioPlayer.duration,
                            playbackRate: audioPlayer.playbackRate,
                            position: audioPlayer.currentTime
                        });
                    }
                }
            });

            // Seek forward handler (+10 seconds)
            navigator.mediaSession.setActionHandler('seekforward', function() {
                if (audioPlayer.duration) {
                    audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 10);
                    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
                        navigator.mediaSession.setPositionState({
                            duration: audioPlayer.duration,
                            playbackRate: audioPlayer.playbackRate,
                            position: audioPlayer.currentTime
                        });
                    }
                }
            });
        }
        topBarHome.addEventListener("click", function(event) {
            event.preventDefault();
            setActivePage("home");
        });

        document.querySelectorAll(".nav-link").forEach(function(link) { link.addEventListener("click", function(event) { event.preventDefault(); setActivePage(link.dataset.page || "home"); }); });
        document.getElementById("back-to-home").addEventListener("click", function(event) { event.preventDefault(); setActivePage("home"); });
        document.getElementById("download-button").addEventListener("click", function(event) { event.preventDefault(); downloadFromLink(); });
        searchInput.addEventListener("input", function() {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(runSearch, 150);
        });
        searchInput.addEventListener("keydown", function(ev) {
            if (ev.key === "Escape") {
                hideSearchDropdown();
                searchInput.blur();
            }
        });
        btnPlay.addEventListener("click", function(event) { event.preventDefault(); togglePlay(); });
        btnPrev.addEventListener("click", function(event) { event.preventDefault(); if (audioPlayer.currentTime > 3) { audioPlayer.currentTime = 0; } else { playByIndex(currentIndex - 1); } });
        btnNext.addEventListener("click", function(event) { event.preventDefault(); playByIndex(currentIndex + 1); });

        document.addEventListener("click", function(ev) {
            if (!searchDropdown || searchDropdown.style.display === "none") return;
            const searchBar = ev.target && ev.target.closest ? ev.target.closest(".search-bar") : null;
            if (!searchBar) hideSearchDropdown();
        });

        var btnShuffle = document.getElementById("btn-shuffle");
        btnShuffle.addEventListener("click", function(event) {
            event.preventDefault();
            shuffle = !shuffle;
            btnShuffle.classList.toggle("active", shuffle);
            if (shuffle) {
                shuffleQueueOnce();
            } else {
                unshuffleQueue();
            }
            renderNowPlayingQueue();
        });

        btnRepeat.addEventListener("click", function(event) {
            event.preventDefault();
            if (repeatState === "off") {
                repeatState = "loop-once";
                repeatCount = 0;
                btnRepeat.classList.add("active");
                btnRepeat.classList.remove("loop-twice");
            } else if (repeatState === "loop-once") {
                repeatState = "loop-twice";
                repeatCount = 0;
            } else {
                repeatState = "off";
                repeatCount = 0;
                btnRepeat.classList.remove("active", "loop-twice");
            }
        });

        npLikeBtn.addEventListener("click", async function(event) {
            event.preventDefault();
            if (!currentTrackId) return;
            if (!authHash) {
                alert("Please log in to manage playlists.");
                return;
            }

            // Show Add to Playlist modal instead of old menu behavior
            event.stopPropagation();
            await showAddToPlaylistModal();
            npLikeBtn.disabled = false;
        });

        var volumeSlider = document.getElementById("volume-slider");
        var volumeIcon = document.getElementById("volume-icon");
        audioPlayer.volume = 1;
        volumeSlider.addEventListener("input", function() {
            audioPlayer.volume = volumeSlider.value / 100;
            volumeSlider.style.setProperty("--volume", volumeSlider.value + "%");
            volumeIcon.className = audioPlayer.volume === 0 ? "fa-solid fa-volume-xmark" : audioPlayer.volume < 0.5 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high";
        });
        volumeSlider.style.setProperty("--volume", "100%");
        volumeIcon.addEventListener("click", function() {
            if (audioPlayer.volume > 0) { audioPlayer.dataset.prevVolume = audioPlayer.volume; audioPlayer.volume = 0; volumeSlider.value = 0; volumeIcon.className = "fa-solid fa-volume-xmark"; }
            else { var prev = parseFloat(audioPlayer.dataset.prevVolume) || 1; audioPlayer.volume = prev; volumeSlider.value = Math.round(prev * 100); volumeIcon.className = prev < 0.5 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high"; }
        });

        // Build/refresh cache of track IDs present in regular playlists and liked songs
        async function updateRegularPlaylistTrackCache() {
            trackIdsInRegularPlaylists.clear();
            likedTrackIds.clear();

            const regularPlaylists = userPlaylists.filter(pl => !pl.is_liked);
            const likedPlaylist = userPlaylists.find(pl => pl.is_liked);

            const results = await Promise.all(
                regularPlaylists.map(async (pl) => {
                    try {
                        const tracks = await api("/playlists/" + pl.id + "/tracks");
                        return tracks.map(pt => pt.track.id);
                    } catch (e) {
                        console.error("Failed to load tracks for playlist:", pl.name, e);
                        return [];
                    }
                })
            );
            results.forEach(ids => { for (const id of ids) trackIdsInRegularPlaylists.add(id); });

            if (likedPlaylist) {
                try {
                    const tracks = await api("/playlists/" + likedPlaylist.id + "/tracks");
                    for (const pt of tracks) likedTrackIds.add(pt.track.id);
                } catch (e) {
                    console.error("Failed to load liked tracks", e);
                }
            }

            // Update player button if a track is currently playing
            if (currentTrackId) {
                const track = currentQueue[currentIndex];
                if (track) syncLikeButtonState(track);
            }
        }

        // Check if a track ID is in any regular playlist (uses cache, falls back to fetch if cache empty)
        async function isTrackInAnyRegularPlaylist(trackId) {
            if (trackIdsInRegularPlaylists.size > 0) {
                return trackIdsInRegularPlaylists.has(trackId);
            }
            // Fallback: check by scanning playlists (rare, for edge cases)
            const regularPlaylists = userPlaylists.filter(pl => !pl.is_liked);
            for (const pl of regularPlaylists) {
                try {
                    const tracks = await api("/playlists/" + pl.id + "/tracks");
                    if (tracks.some(pt => pt.track.id === trackId)) return true;
                } catch (e) { /* ignore */ }
            }
            return false;
        }

        async function loadPlaylists() {
            try {
                // Cache bust: add timestamp
                var url = "/playlists";
                if (apiBase) url = apiBase + url;
                url += (url.includes('?') ? '&' : '?') + '_=' + Date.now();
                userPlaylists = await api(url);
                await updateRegularPlaylistTrackCache();
                renderLibrary();
            } catch (err) {
                console.error(err);
            }
        }

        function renderLibrary() {
            libBox.innerHTML = "";
            // Ensure ordering: Liked Songs first, then pinned, then by date (newest first)
            userPlaylists.sort(function(a, b) {
                if (a.is_liked && !b.is_liked) return -1;
                if (!a.is_liked && b.is_liked) return 1;
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            });
            userPlaylists.forEach(function(pl) {
                var item = document.createElement("div");
                item.className = "lib-item";
                var bg = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";

                var cover = document.createElement("div");
                cover.className = "lib-item-cover";

                if (pl.is_liked) {
                    // Liked Songs: gradient + heart icon
                    cover.style.background = "linear-gradient(135deg,#450af5,#c4efd9)";
                    cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
                } else {
                    // Regular playlist: try loading collage thumbnail
                    cover.style.background = "transparent";
                    var img = document.createElement("img");
                    img.src = withBase("/playlists/" + pl.id + "/cover?v=" + Date.now());
                    img.alt = escapeHtml(pl.name || "Playlist");
                    img.style.width = "100%";
                    img.style.height = "100%";
                    img.style.objectFit = "cover";
                    img.onerror = function() {
                        img.style.display = "none";
                        // Fallback to default playlist icon
                        cover.style.background = "#282828";
                        cover.appendChild(createPlaylistIconSvg());
                    };
                    cover.appendChild(img);
                }

                var info = document.createElement("div");
                info.className = "lib-item-info";

                var nameEl = document.createElement("p");
                nameEl.className = "lib-item-name";
                nameEl.appendChild(document.createTextNode(pl.name || ""));

                var typeEl = document.createElement("p");
                typeEl.className = "lib-item-type";
                if (pl.pinned) {
                    var pinSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                    pinSvg.className = "library-pin-icon";
                    pinSvg.setAttribute("viewBox", "290 120 160 160");
                    pinSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
                    pinSvg.setAttribute("aria-hidden", "true");
                    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                    g.setAttribute("transform", "translate(290, 120) scale(10)");
                    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    path.setAttribute("d", "M8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
                    path.setAttribute("fill", "#1ed760");
                    g.appendChild(path);
                    pinSvg.appendChild(g);
                    typeEl.appendChild(pinSvg);
                    typeEl.appendChild(document.createTextNode(" "));
                }
                typeEl.appendChild(document.createTextNode("Playlist"));

                info.appendChild(nameEl);
                info.appendChild(typeEl);

                item.appendChild(cover);
                item.appendChild(info);
                item.addEventListener("click", function() { openPlaylist(pl.id); });
                // Right-click context menu
                item.addEventListener("contextmenu", function(e) {
                    e.preventDefault();
                    showContextMenu(e, pl);
                });
                libBox.appendChild(item);
            });
        }

        async function openPlaylist(playlistId) {
            currentPlaylistId = playlistId;
            try {
                var pl = await api("/playlists/" + playlistId);
                var tracks = await api("/playlists/" + playlistId + "/tracks");
                document.getElementById("playlist-name").textContent = pl.name;
                document.getElementById("playlist-type").textContent = pl.is_liked ? "Playlist" : "Playlist";
                document.getElementById("playlist-meta").textContent = tracks.length + " songs";
                var cover = document.getElementById("playlist-cover");

                if (pl.is_liked) {
                    // Liked Songs: gradient + heart
                    cover.style.background = "linear-gradient(135deg,#450af5,#c4efd9)";
                    cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
                } else {
                    // Regular playlist: try loading collage image
                    var img = document.createElement("img");
                    img.src = withBase("/playlists/" + playlistId + "/cover?v=" + Date.now());
                    img.style.width = "100%";
                    img.style.height = "100%";
                    img.style.objectFit = "cover";
                    img.onerror = function() {
                        // Collage not available (<4 tracks, no artwork, etc.)
                        cover.style.background = "#282828";
                        cover.innerHTML = '<svg class="playlist-cover-icon" viewBox="292 128 156 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Playlist"><title>Playlist icon</title><desc>A music note/playlist icon</desc><g transform="translate(297, 133) scale(6.667)"><path fill="currentColor" d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5z"/></g></svg>';
                    };
                    cover.style.background = "transparent";
                    cover.innerHTML = "";
                    cover.appendChild(img);
                }
                var container = document.getElementById("playlist-tracks");
                container.innerHTML = "";
                tracks.forEach(function(pt, i) {
                    var row = document.createElement("div");
                    row.className = "playlist-track-row";
                    var artSpan = document.createElement("span");
                    artSpan.className = "pt-art";
                    var artImg = document.createElement("img");
                    artImg.src = withBase("/tracks/" + pt.track.id + "/artwork?v=" + encodeURIComponent(pt.track.updated_at || ""));
                    artImg.alt = pt.track.title || "";
                    artImg.onerror = function() { artImg.style.display = "none"; artSpan.style.background = "#282828"; };
                    artSpan.appendChild(artImg);

                    var num = document.createElement("span");
                    num.className = "pt-num";
                    num.textContent = String(i + 1);

                    var title = document.createElement("span");
                    title.className = "pt-title";
                    title.textContent = pt.track.title || "";

                    var artist = document.createElement("span");
                    artist.className = "pt-artist";
                    artist.textContent = getArtistDisplay(pt.track) || "";

                    var duration = document.createElement("span");
                    duration.className = "pt-duration";
                    duration.textContent = formatDuration(pt.track.duration);

                    row.appendChild(num);
                    row.appendChild(artSpan);
                    row.appendChild(title);
                    row.appendChild(artist);
                    row.appendChild(duration);

                    title.addEventListener("click", function() {
                        setQueueFromList(tracks.map(function(t) { return t.track; }), i);
                        if (currentQueue.length) playTrack(currentQueue[0]);
                    });
                    title.style.cursor = "pointer";
                    container.appendChild(row);
                });
                setActivePage("playlist");
            } catch (err) { console.error(err); }
        }

        document.getElementById("new-playlist-btn").addEventListener("click", async function() {
            try { await api("/playlists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "My Playlist" }) }); loadPlaylists(); } catch (err) { alert("Failed: " + err.message); }
        });

        // Sidebar minimize/maximize toggle
        (function() {
            const sidebar = document.querySelector('.sidebar');
            const sidebarToggleBtn = document.querySelector('.sidebar-toggle-container');

            function updateLibraryUI(minimized) {
                if (sidebar) {
                    sidebar.classList.toggle('sidebar-minimized', minimized);
                }
                localStorage.setItem("library_minimized", minimized);
            }

            function loadLibraryState() {
                if (currentUser && typeof currentUser.library_minimized !== 'undefined') {
                    updateLibraryUI(currentUser.library_minimized);
                } else {
                    const saved = localStorage.getItem("library_minimized");
                    if (saved !== null) {
                        updateLibraryUI(saved !== "false");
                    } else {
                        updateLibraryUI(false); // default to expanded
                    }
                }
            }

            // Initial load
            loadLibraryState();

            if (sidebarToggleBtn) {
                sidebarToggleBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const currentlyMinimized = sidebar && sidebar.classList.contains('sidebar-minimized');
                    const newState = !currentlyMinimized;
                    updateLibraryUI(newState);
                    setTimeout(updateAllScrollButtonStates, 200);

                    if (authHash) {
                        api("/user/library-state", {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ library_minimized: newState })
                        }).then(() => {
                            if (currentUser) currentUser.library_minimized = newState;
                        }).catch(err => {
                            console.error("Failed to update library state:", err);
                            updateLibraryUI(!newState);
                        });
                    }
                });
            }

            window.refreshLibraryState = loadLibraryState;
        })();

        userIcon.addEventListener("click", function(event) {
            event.stopPropagation();
            console.log("User icon clicked, toggling dropdown");
            userDropdown.classList.toggle("visible");
            console.log("Dropdown visible:", userDropdown.classList.contains("visible"));
        });

        userDropdown.addEventListener("click", function(event) {
            event.stopPropagation();
        });

        document.addEventListener("click", function(event) {
            if (!userMenu.contains(event.target)) {
                userDropdown.classList.remove("visible");
            }
        });

        document.getElementById("profile-btn").addEventListener("click", function() {
            if (!currentUser) return;
            userDropdown.classList.remove("visible");
            showProfileModal();
        });

        document.getElementById("logout-btn").addEventListener("click", function() {
            localStorage.removeItem("openfy_auth");
            authHash = "";
            dropdownUsername.textContent = "";
            currentUser = null;
            isAdmin = false;
            npLikeBtn.classList.add("hidden");
            updateAdminButtonVisibility();

            // Stop the update checker
            stopUpdateChecker();

            // Reset tab title to default
            document.title = "Openfy - Web Player";

            authOverlay.style.display = "flex";
            userDropdown.classList.remove("visible");
            appMain.style.display = "none";
            // Remove home-page class when logging out (going to auth screen)
            document.getElementById('app-main').classList.remove('home-page');
            topBar.style.display = "none";
        });

        // Upload toggle functionality
        (function() {
            const uploadCheckbox = document.getElementById("upload-enabled");
            const sidebar = document.querySelector('.sidebar');

            // Function to update UI based on uploadEnabled state
            function updateUploadUI(enabled) {
                if (uploadCheckbox) {
                    uploadCheckbox.checked = enabled;
                }
                if (sidebar) {
                    sidebar.classList.toggle('upload-disabled', !enabled);
                }
                localStorage.setItem("upload_enabled", enabled);
            }

            // Load state from currentUser if available, else from localStorage
            function loadUploadState() {
                if (currentUser && typeof currentUser.upload_enabled !== 'undefined') {
                    updateUploadUI(currentUser.upload_enabled);
                } else {
                    const saved = localStorage.getItem("upload_enabled");
                    if (saved !== null) {
                        updateUploadUI(saved !== "false");
                    } else {
                        updateUploadUI(true); // default to enabled
                    }
                }
            }

            // Initial load
            loadUploadState();

            // Handle toggle change
            if (uploadCheckbox) {
                uploadCheckbox.addEventListener("change", async function() {
                    const enabled = this.checked;
                    updateUploadUI(enabled);
                    
                    // Sync with server if user is logged in
                    if (currentUser && authHash) {
                        try {
                            await api("/user/upload-preference", {
                                method: "PUT",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ upload_enabled: enabled })
                            });
                            // Update currentUser to reflect change
                            currentUser.upload_enabled = enabled;
                        } catch (err) {
                            console.error("Failed to update upload preference:", err);
                            // Revert on error
                            updateUploadUI(!enabled);
                        }
                    }
                });
            }

            // Expose function to refresh state when user data changes
            window.refreshUploadState = loadUploadState;
        })();

        document.getElementById("signup-btn").addEventListener("click", async function() {
            var name = document.getElementById("signup-name").value.trim();
            if (!name || !name.trim()) return;
            try {
                var user = await api("/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
                authHash = user.auth_hash;
                currentUser = user;
                isAdmin = user.is_admin || false;
                updateAdminButtonVisibility();
                localStorage.setItem("openfy_auth", authHash);
                
                // Show hash modal instead of directly showing app
                showHashModal(user.auth_hash);

                // Refresh upload toggle to reflect server-stored preference
                if (window.refreshUploadState) window.refreshUploadState();
                // Refresh library sidebar state
                if (window.refreshLibraryState) window.refreshLibraryState();
            } catch (err) { alert("Failed: " + err.message); }
        });

        document.getElementById("signin-btn").addEventListener("click", async function() {
            var hash = document.getElementById("signin-hash").value.trim();
            if (!hash) { document.getElementById("signin-status").textContent = "Enter your auth hash."; return; }
            try {
                var user = await api("/auth/signin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth_hash: hash }) });
                authHash = user.auth_hash;
                currentUser = user;
                isAdmin = user.is_admin || false;
                updateAdminButtonVisibility();
                localStorage.setItem("openfy_auth", authHash);
                authOverlay.style.display = "none";
                appMain.style.display = "flex";
                topBar.style.display = "flex";
                dropdownUsername.textContent = user.name;
                npLikeBtn.classList.add("hidden");
                loadTracks(); loadPlaylists(); loadUserUploads();
                loadLastTrackPaused();

                // Refresh upload toggle to reflect server-stored preference
                if (window.refreshUploadState) window.refreshUploadState();
                // Refresh library sidebar state
                if (window.refreshLibraryState) window.refreshLibraryState();

                // Start the update checker
                startUpdateChecker();
            } catch (err) { document.getElementById("signin-status").textContent = err.message; }
        });

        async function tryAutoLogin() {
            if (!authHash) { console.log("No auth hash stored"); return false; }
            try {
                var url = withBase("/auth/me");
                console.log("Auto-login fetching:", url, "with hash:", authHash);
                var res = await fetch(url, { headers: { "x-auth-hash": authHash } });
                console.log("Auto-login response status:", res.status);
                if (res.ok) {
                    var user = await res.json();
                    console.log("Auto-login user:", user);
                    if (user && user.name) {
                        currentUser = user;
                        isAdmin = user.is_admin || false;
                        updateAdminButtonVisibility();
                        authOverlay.style.display = "none";
                        appMain.style.display = "flex";
                        topBar.style.display = "flex";
                        dropdownUsername.textContent = user.name;
                        npLikeBtn.classList.add("hidden");
                        loadTracks(); loadPlaylists(); loadUserUploads();
                        loadLastTrackPaused();
                        // Set home-page class for successful auto-login (home page)
                        document.getElementById('app-main').classList.add('home-page');

                        // Refresh upload toggle to reflect server-stored preference
                        if (window.refreshUploadState) window.refreshUploadState();
                        // Refresh library sidebar state
                        if (window.refreshLibraryState) window.refreshLibraryState();

                        // Start the update checker
                        startUpdateChecker();

                        return true;
                    }
                } else {
                    var errText = await res.text();
                    console.log("Auto-login failed:", res.status, errText);
                }
            } catch (err) {
                console.error("Auto-login error:", err);
            }
            return false;
        }

        // Hash Modal functionality
        const hashModalOverlay = document.getElementById("hash-modal-overlay");
        const userAuthHash = document.getElementById("user-auth-hash");
        const copyHashBtn = document.getElementById("copy-hash-btn");
        const continueBtn = document.getElementById("continue-btn");

        function showHashModal(hash) {
            userAuthHash.textContent = hash;
            authOverlay.style.display = "none"; // Hide auth overlay
            hashModalOverlay.style.display = "flex";
        }

        function hideHashModal() {
            hashModalOverlay.style.display = "none";
            // After closing modal, show the main app
            authOverlay.style.display = "none";
            appMain.style.display = "flex";
            topBar.style.display = "flex";
            dropdownUsername.textContent = currentUser.name;
            loadTracks(); loadPlaylists(); loadUserUploads();
            loadLastTrackPaused();
            // Ensure home-page class is present when returning to main app (home page)
            document.getElementById('app-main').classList.add('home-page');

            // Refresh upload toggle to reflect server-stored preference
            if (window.refreshUploadState) window.refreshUploadState();
            // Refresh library sidebar state
            if (window.refreshLibraryState) window.refreshLibraryState();

            // Start the update checker
            startUpdateChecker();
        }

        function copyHashToClipboard() {
            const hash = userAuthHash.textContent;
            navigator.clipboard.writeText(hash).then(function() {
                const originalHTML = copyHashBtn.innerHTML;
                copyHashBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                copyHashBtn.classList.add("copied");
                setTimeout(function() {
                    copyHashBtn.innerHTML = originalHTML;
                    copyHashBtn.classList.remove("copied");
                }, 2000);
            }).catch(function(err) {
                alert("Failed to copy: " + err.message);
            });
        }

        copyHashBtn.addEventListener("click", copyHashToClipboard);
        continueBtn.addEventListener("click", hideHashModal);

        // Close modal on overlay click
        hashModalOverlay.addEventListener("click", function(event) {
            if (event.target === hashModalOverlay) {
                hideHashModal();
            }
        });

        // Profile Modal functionality
        const profileModalOverlay = document.getElementById("profile-modal-overlay");
        const profileUsername = document.getElementById("profile-username");
        const profileAuthHash = document.getElementById("profile-auth-hash");
        const profileMemberSince = document.getElementById("profile-member-since");
        const profileCopyHashBtn = document.getElementById("profile-copy-hash-btn");
        const profileCloseBtn = document.getElementById("profile-close-btn");

        function showProfileModal() {
            if (!currentUser) return;
            profileUsername.textContent = currentUser.name || "N/A";
            profileAuthHash.textContent = authHash || "N/A";
            // Format date to show only YYYY-MM-DD
            const createdAt = currentUser.created_at || "N/A";
            if (createdAt !== "N/A") {
                try {
                    const date = new Date(createdAt);
                    profileMemberSince.textContent = date.toISOString().split('T')[0];
                } catch (e) {
                    profileMemberSince.textContent = createdAt;
                }
            } else {
                profileMemberSince.textContent = "N/A";
            }
            profileModalOverlay.style.display = "flex";
        }

        function hideProfileModal() {
            profileModalOverlay.style.display = "none";
        }

        function copyProfileHashToClipboard() {
            const hash = profileAuthHash.textContent;
            navigator.clipboard.writeText(hash).then(function() {
                const originalHTML = profileCopyHashBtn.innerHTML;
                profileCopyHashBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                profileCopyHashBtn.classList.add("copied");
                setTimeout(function() {
                    profileCopyHashBtn.innerHTML = originalHTML;
                    profileCopyHashBtn.classList.remove("copied");
                }, 2000);
            }).catch(function(err) {
                alert("Failed to copy: " + err.message);
            });
        }

        profileCopyHashBtn.addEventListener("click", copyProfileHashToClipboard);
        profileCloseBtn.addEventListener("click", hideProfileModal);

        // Close modal on overlay click
        profileModalOverlay.addEventListener("click", function(event) {
            if (event.target === profileModalOverlay) {
                hideProfileModal();
            }
        });

        // Playlist context menu and modals
        const contextMenuOverlay = document.getElementById("context-menu-overlay");
        const contextMenu = document.getElementById("context-menu");
        const ctxPin = document.getElementById("ctx-pin");
        const ctxRename = document.getElementById("ctx-rename");
        const ctxRemove = document.getElementById("ctx-remove");
        const ctxTrackAddPlaylist = document.getElementById("ctx-track-add-playlist");
        const ctxPlaylistSubmenu = document.getElementById("ctx-playlist-submenu");
        const ctxSubmenuItems = document.getElementById("submenu-playlist-items");
        const ctxTrackAddQueue = document.getElementById("ctx-track-add-queue");
        const submenuSearchWrapper = document.getElementById("submenu-search-wrapper");
        const submenuSearchInput = document.getElementById("submenu-search-input");

        // Removal menu
        const npRemovalMenu = document.getElementById("np-playlist-removal-menu");
        const npRemovalItems = document.getElementById("np-playlist-removal-items");
        const npRemovalSearchWrapper = document.getElementById("np-removal-search-wrapper");
        const npRemovalSearchInput = document.getElementById("np-removal-search-input");

        const renameModalOverlay = document.getElementById("rename-modal-overlay");
        const renameInput = document.getElementById("rename-input");
        const renameCancelBtn = document.getElementById("rename-cancel-btn");
        const renameConfirmBtn = document.getElementById("rename-confirm-btn");

        const confirmModalOverlay = document.getElementById("confirm-modal-overlay");
        const confirmMessage = document.getElementById("confirm-message");
        const confirmCancelBtn = document.getElementById("confirm-cancel-btn");
        const confirmDeleteBtn = document.getElementById("confirm-delete-btn");

        // Add to Playlist Modal elements
        const addPlaylistModalOverlay = document.getElementById("add-playlist-modal-overlay");
        const addPlaylistModalWrapper = document.getElementById("add-playlist-modal-wrapper");
        const addPlaylistModal = document.querySelector(".add-playlist-modal"); // modal content box
        const addPlaylistNewRow = document.getElementById("add-playlist-new-row");
        const addPlaylistItems = document.getElementById("add-playlist-items");
        const addPlaylistSearchInput = document.getElementById("add-playlist-search-input");
        const addPlaylistCancelBtn = document.getElementById("add-playlist-cancel-btn");
        const addPlaylistConfirmBtn = document.getElementById("add-playlist-confirm-btn");

        // Debounce timer for modal search
        let addPlaylistSearchTimeout = null;
        // Cached playlists for the modal
        let allPlaylistsCache = [];
        // Original state when modal opened (server state)
        let modalOriginalInPlaylist = new Set(); // Set of playlist IDs + 'liked' for Liked Songs
        // Pending state (changes as user toggles)
        let modalPendingInPlaylist = new Set(); // Set of playlist IDs + 'liked'

        // Modal event listeners
        addPlaylistSearchInput.addEventListener("input", function() {
            clearTimeout(addPlaylistSearchTimeout);
            addPlaylistSearchTimeout = setTimeout(filterAddToPlaylistItems, 150);
        });

        addPlaylistCancelBtn.addEventListener("click", hideAddToPlaylistModal);
        addPlaylistNewRow.addEventListener("click", handleNewPlaylistClick);

        // Close when clicking overlay (outside modal)
        addPlaylistModalOverlay.addEventListener("click", function(e) {
            if (e.target === addPlaylistModalOverlay || e.target === addPlaylistModalWrapper) {
                hideAddToPlaylistModal();
            }
        });

        // Stop propagation on modal content clicks
        addPlaylistModal.addEventListener("click", function(e) {
            e.stopPropagation();
        });

        // Confirm button — apply all staged changes to server
        addPlaylistConfirmBtn.addEventListener("click", async function() {
            await applyPendingChanges();
        });

        // Show confirm button when changes are made
        function showConfirmButton() {
            // Compare pending vs original to determine if there are changes
            const hasChanges = setsDiffer(modalPendingInPlaylist, modalOriginalInPlaylist);
            addPlaylistConfirmBtn.style.display = hasChanges ? 'inline-block' : 'none';
        }

        // Helper: compare two Sets
        function setsDiffer(a, b) {
            if (a.size !== b.size) return true;
            for (const v of a) if (!b.has(v)) return true;
            for (const v of b) if (!a.has(v)) return true;
            return false;
        }

        // Reset confirm state (call when modal opens/closes)
        function resetConfirmState() {
            modalOriginalInPlaylist.clear();
            modalPendingInPlaylist.clear();
            addPlaylistConfirmBtn.style.display = 'none';
        }

        // Update like button UI to reflect current PENDING state
        function updateLikeButtonPreview() {
            const inLiked = modalPendingInPlaylist.has('liked');
            const regularCount = modalPendingInPlaylist.size - (inLiked ? 1 : 0);
            if (inLiked) {
                npLikeBtn.classList.remove('in-playlist', 'adding');
                npLikeBtn.classList.add('liked');
                npLikeBtn.innerHTML = '<i class="fa-solid fa-heart"></i>';
                npLikeBtn.setAttribute('aria-label', 'Remove from Liked Songs');
                npLikeBtn.setAttribute('title', 'Remove from Liked Songs');
            } else if (regularCount > 0) {
                npLikeBtn.classList.remove('liked', 'adding');
                npLikeBtn.classList.add('in-playlist');
                npLikeBtn.innerHTML = '';
                npLikeBtn.setAttribute('aria-label', 'Added to playlist');
                npLikeBtn.setAttribute('title', 'Added to playlist');
            } else {
                npLikeBtn.classList.remove('liked', 'in-playlist');
                npLikeBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
                npLikeBtn.setAttribute('aria-label', 'Add to Liked Songs');
                npLikeBtn.setAttribute('title', 'Add to Liked Songs');
            }
        }

        // Apply all staged changes to the server
        async function applyPendingChanges() {
            const toRemove = [...modalOriginalInPlaylist].filter(id => !modalPendingInPlaylist.has(id));
            const toAdd = [...modalPendingInPlaylist].filter(id => !modalOriginalInPlaylist.has(id));

            try {
                // Removals first
                for (const id of toRemove) {
                    if (id === 'liked') {
                        await api(`/liked/${currentTrackId}`, { method: "POST" });
                    } else {
                        await api(`/playlists/${id}/tracks/${currentTrackId}`, { method: "DELETE" });
                    }
                }
                // Additions
                for (const id of toAdd) {
                    if (id === 'liked') {
                        await api(`/liked/${currentTrackId}`, { method: "POST" });
                    } else {
                        const pl = allPlaylistsCache.find(p => p.id === id);
                        if (pl && pl._isNew) {
                            // Create playlist first
                            const newPl = await api("/playlists", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ name: pl.name })
                            });
                            // Replace placeholder in cache
                            const idx = allPlaylistsCache.findIndex(p => p.id === id);
                            if (idx !== -1) allPlaylistsCache[idx] = { ...newPl, _isNew: false };
                            // Add track to new playlist
                            await api(`/playlists/${newPl.id}/tracks?track_id=${currentTrackId}`, { method: "POST" });
                        } else {
                            await api(`/playlists/${id}/tracks?track_id=${currentTrackId}`, { method: "POST" });
                        }
                    }
                }
                // Refresh and close
                loadPlaylists();
                hideAddToPlaylistModal();
            } catch (err) {
                alert("Failed to save changes: " + err.message);
            }
        }

        // Search input for submenu - debounced handler
        submenuSearchInput.addEventListener("input", function() {
            clearTimeout(submenuSearchTimeout);
            submenuSearchTimeout = setTimeout(() => {
                filterSubmenuItems(this.value);
            }, 150);
        });

        // Search input for removal menu
        if (npRemovalSearchInput) {
            npRemovalSearchInput.addEventListener("input", function() {
                clearTimeout(submenuSearchTimeout);
                submenuSearchTimeout = setTimeout(() => {
                    filterRemovalMenuItems(this.value);
                }, 150);
            });
        }

        function showContextMenu(e, playlist) {
            currentContextPlaylist = playlist;
            currentContextTrack = null; // clear track context
            // Position menu near mouse
            const menuWidth = 180;
            const menuHeight = 110; // approx
            let x = e.clientX;
            let y = e.clientY;
            // Adjust if near edges
            if (x + menuWidth > window.innerWidth) x -= menuWidth;
            if (y + menuHeight > window.innerHeight) y -= menuHeight;
            contextMenu.style.left = x + "px";
            contextMenu.style.top = y + "px";

            // Update Pin menu item: icon and text
            const pinSpan = ctxPin.querySelector("span");
            pinSpan.textContent = playlist.pinned ? "Unpin" : "Pin";
            const pinIcon = ctxPin.querySelector("svg .pin-path");
            if (pinIcon) {
                if (playlist.pinned) {
                    // Filled pin (pinned.svg) - green
                    pinIcon.setAttribute("d", "M8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
                    pinIcon.setAttribute("fill", "#1ed760");
                } else {
                    // Outline pin (pin.svg) - gray
                    pinIcon.setAttribute("d", "M11.609 1.858a1.22 1.22 0 0 0-1.727 0L5.92 5.82l-2.867.768 6.359 6.359.768-2.867 3.962-3.963a1.22 1.22 0 0 0 0-1.726zM8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
                    pinIcon.setAttribute("fill", "#b3b3b3");
                }
            }

            // Disable only Rename and Remove for Liked Songs; Pin remains enabled
            if (playlist.is_liked) {
                ctxRename.classList.add("disabled");
                ctxRemove.classList.add("disabled");
                // Ensure Pin is enabled (remove disabled if present)
                ctxPin.classList.remove("disabled");
            } else {
                ctxRename.classList.remove("disabled");
                ctxRemove.classList.remove("disabled");
                ctxPin.classList.remove("disabled");
            }

            // Show playlist items, hide track-specific items
            ctxPin.style.display = '';
            ctxRename.style.display = '';
            ctxRemove.style.display = '';
            ctxTrackAddPlaylist.style.display = 'none';
            ctxTrackAddQueue.style.display = 'none';
            // Ensure submenu is hidden
            ctxPlaylistSubmenu.classList.remove('visible');
            ctxSubmenuItems.innerHTML = '';

            contextMenuOverlay.style.display = "block";
        }

        function hideContextMenu() {
            contextMenuOverlay.style.display = "none";
            ctxPlaylistSubmenu.classList.remove('visible');
            if (currentTimeout) {
                clearTimeout(currentTimeout);
                currentTimeout = null;
            }
            currentContextPlaylist = null;
            currentContextTrack = null;
        }

        function showTrackContextMenu(e, track) {
            // Close any existing context menu first
            hideContextMenu();

            currentContextTrack = track;
            currentContextPlaylist = null; // clear playlist context

            // Position menu near mouse
            const menuWidth = 180;
            const menuHeight = 110; // approx
            let x = e.clientX;
            let y = e.clientY;
            if (x + menuWidth > window.innerWidth) x -= menuWidth;
            if (y + menuHeight > window.innerHeight) y -= menuHeight;
            contextMenu.style.left = x + "px";
            contextMenu.style.top = y + "px";

            // Hide playlist items
            ctxPin.style.display = 'none';
            ctxRename.style.display = 'none';
            ctxRemove.style.display = 'none';
            // Show Add to Playlist and Add to Queue
            ctxTrackAddPlaylist.style.display = '';
            ctxTrackAddQueue.style.display = '';
            // Reorder: Add to Queue first
            contextMenu.insertBefore(ctxTrackAddQueue, ctxTrackAddPlaylist);
            // Reset submenu
            ctxPlaylistSubmenu.classList.remove('visible');
            ctxSubmenuItems.innerHTML = '';
            // Disable (gray out) if track already in unplayed portion of queue (including current)
            if (indexOfTrackId(currentQueue, track.id, currentIndex) !== -1) {
                ctxTrackAddQueue.classList.add('disabled');
            } else {
                ctxTrackAddQueue.classList.remove('disabled');
            }

            // Show the menu
            contextMenuOverlay.style.display = "block";
        }

        let currentTimeout = null;
        let lastPlaylistResults = []; // Store item elements for filtering
        let submenuSearchTimeout = null;

        // Show submenu and load playlists
        function showPlaylistSubmenu() {
            // Cancel any pending timeout
            if (currentTimeout) {
                clearTimeout(currentTimeout);
                currentTimeout = null;
            }
            // Position submenu next to parent item
            ctxPlaylistSubmenu.style.top = ctxTrackAddPlaylist.offsetTop + "px";
            // Show submenu
            ctxPlaylistSubmenu.classList.add('visible');
            // Show and clear search, reset all items visible
            submenuSearchWrapper.style.display = 'block';
            submenuSearchInput.value = '';
            submenuSearchInput.focus();
            // Reset any filtered items to visible
            const items = ctxSubmenuItems.querySelectorAll('.submenu-item');
            items.forEach(item => item.style.display = '');
            // Remove any empty message
            const emptyMsg = ctxSubmenuItems.querySelector('.submenu-search-empty');
            if (emptyMsg) emptyMsg.remove();
            // Load playlists if not already
            if (!ctxSubmenuItems.hasChildNodes()) {
                ctxSubmenuItems.innerHTML = '<div class="submenu-loading">Loading...</div>';
                loadPlaylistSubmenuItems();
            }
        }

        // Hide submenu with a small delay (allows moving mouse to submenu)
        function scheduleHideSubmenu() {
            currentTimeout = setTimeout(() => {
                ctxPlaylistSubmenu.classList.remove('visible');
                currentTimeout = null;
            }, 200);
        }

        // ========== Removal menu functions ==========

        // Toggle removal menu for current track (unlike from playlists)
        async function toggleRemovalMenu() {
            const menu = npRemovalMenu;
            if (!menu) return;

            const isVisible = menu.classList.contains("visible");

            if (isVisible) {
                // Toggle off
                hideRemovalMenu();
                return;
            }

            // Close other popovers
            hideContextMenu();

            // Fetch playlists containing the current track
            let playlists;
            try {
                playlists = await loadTrackPlaylists(currentTrackId);
            } catch (e) {
                console.error("Failed to load playlists for removal menu:", e);
                return;
            }

            if (playlists.length === 0) {
                // No playlists contain this track — shouldn't happen if tick shows
                return;
            }

            currentTrackPlaylistsCache = playlists;
            buildRemovalMenu(playlists);

            // Show search bar and clear any previous search
            if (npRemovalSearchWrapper) npRemovalSearchWrapper.style.display = 'block';
            if (npRemovalSearchInput) {
                npRemovalSearchInput.value = '';
                // Apply any current search filter (empty = show all)
                const items = npRemovalItems.querySelectorAll('.submenu-item');
                items.forEach(item => item.style.display = '');
            }

            positionRemovalMenu(menu, npLikeBtn);
            menu.classList.add("visible");
        }

        // Hide removal menu and clear cache
        function hideRemovalMenu() {
            if (npRemovalMenu) npRemovalMenu.classList.remove("visible");
            currentTrackPlaylistsCache = [];
            if (npRemovalSearchWrapper) npRemovalSearchWrapper.style.display = 'none';
            if (npRemovalSearchInput) npRemovalSearchInput.value = '';
        }

        // Fetch playlists that contain given track (regular playlists only)
        async function loadTrackPlaylists(trackId) {
            try {
                return await api("/tracks/" + trackId + "/playlists");
            } catch (e) {
                console.error("Failed to load track's playlists:", e);
                throw e;
            }
        }

        // Build menu DOM from playlists array
        function buildRemovalMenu(playlists) {
            const itemsContainer = document.getElementById("np-playlist-removal-items");
            if (!itemsContainer) return;
            itemsContainer.innerHTML = '';

            playlists.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'submenu-item';
                item.dataset.playlistId = pl.id;
                item.dataset.playlistName = pl.name.toLowerCase();

                const nameSpan = document.createElement('span');
                nameSpan.className = 'submenu-playlist-name';
                nameSpan.textContent = pl.name;
                item.appendChild(nameSpan);

                const xIcon = document.createElement('i');
                xIcon.className = 'fa-solid fa-xmark removal-icon';
                xIcon.setAttribute('aria-label', 'Remove from playlist');
                xIcon.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const confirmed = confirm(`Remove this track from "${pl.name}"?`);
                    if (confirmed) {
                        await removeFromPlaylist(pl.id);
                    }
                });
                item.appendChild(xIcon);

                itemsContainer.appendChild(item);
            });
        }

        // Execute removal from a specific playlist
        async function removeFromPlaylist(playlistId) {
            try {
                await api(`/playlists/${playlistId}/tracks/${currentTrackId}`, { method: "DELETE" });

                // Update cache: remove this playlist from currentTrackPlaylistsCache
                currentTrackPlaylistsCache = currentTrackPlaylistsCache.filter(pl => pl.id !== playlistId);

                // Update global trackIdsInRegularPlaylists
                if (currentTrackPlaylistsCache.length > 0) {
                    trackIdsInRegularPlaylists.add(currentTrackId);
                } else {
                    trackIdsInRegularPlaylists.delete(currentTrackId);
                }

                // Hide the menu
                const menu = document.getElementById("np-playlist-removal-menu");
                if (menu) menu.classList.remove("visible");

                // Update like button state based on new membership
                syncLikeButtonState({ id: currentTrackId });

            } catch (err) {
                const msg = err.message || "";
                if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("not authenticated")) {
                    // Session expired — logout
                    localStorage.removeItem("openfy_auth");
                    authHash = "";
                    npLikeBtn.classList.add("hidden");
                    // Reset tab title to default
                    document.title = "Openfy - Web Player";
                    alert("Session expired. Please log in again.");
                    authOverlay.style.display = "flex";
                    appMain.style.display = "none";
                    topBar.style.display = "none";
                } else if (msg.includes("404")) {
                    // Already removed — treat as success, sync state
                    console.warn("Track already removed, syncing state");
                    currentTrackPlaylistsCache = currentTrackPlaylistsCache.filter(pl => pl.id !== playlistId);
                    if (currentTrackPlaylistsCache.length === 0) {
                        trackIdsInRegularPlaylists.delete(currentTrackId);
                    }
                    syncLikeButtonState({ id: currentTrackId });
                    const menu = document.getElementById("np-playlist-removal-menu");
                    if (menu) menu.classList.remove("visible");
                } else {
                    alert("Failed to remove from playlist: " + msg);
                }
            }
        }

        // ========== End removal menu functions ==========

        // Populate submenu with user's playlists (names only, gray out if track already in playlist)
        async function loadPlaylistSubmenuItems() {
            if (!currentUser) {
                ctxSubmenuItems.innerHTML = '<div class="submenu-error">Not logged in</div>';
                return;
            }
            // Sort playlists the same way as the library: Liked first, then pinned, then newest
            const sortedPlaylists = [...userPlaylists].sort(function(a, b) {
                if (a.is_liked && !b.is_liked) return -1;
                if (!a.is_liked && b.is_liked) return 1;
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            });
            ctxSubmenuItems.innerHTML = '';
            if (sortedPlaylists.length === 0) {
                ctxSubmenuItems.innerHTML = '<div class="submenu-empty">No playlists yet.<br>Create one from the sidebar.</div>';
                lastPlaylistResults = [];
                return;
            }

            // Fetch tracks for all playlists concurrently to check membership
            const results = await Promise.all(
                sortedPlaylists.map(async (pl) => {
                    const trackIds = new Set();
                    try {
                        const tracks = await api("/playlists/" + pl.id + "/tracks");
                        for (const pt of tracks) trackIds.add(pt.track.id);
                    } catch (e) {
                        console.error("Failed to load tracks for playlist:", pl.name, e);
                    }
                    return { pl, trackIds };
                })
            );

            ctxSubmenuItems.innerHTML = '';
            lastPlaylistResults = [];

            // Build menu items (names only), disabling if track already in that playlist
            results.forEach(({ pl, trackIds }) => {
                const item = document.createElement('button');
                item.className = 'submenu-item';
                if (trackIds.has(currentContextTrack.id)) {
                    item.classList.add('disabled');
                    item.disabled = true;
                }

                const nameSpan = document.createElement('span');
                nameSpan.className = 'submenu-playlist-name';
                nameSpan.textContent = pl.name;
                // Store playlist name for search filtering
                item.dataset.playlistName = pl.name.toLowerCase();

                item.appendChild(nameSpan);

                item.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (pl.is_liked) {
                        alert("Liked Songs is managed automatically. Use the heart button on tracks to add/remove.");
                        return;
                    }
                    const confirmed = confirm(`Add this track to "${pl.name}"?`);
                    if (confirmed) {
                        addTrackToPlaylist(pl.id, currentContextTrack);
                    }
                });
                ctxSubmenuItems.appendChild(item);
                lastPlaylistResults.push(item);
            });

            // Apply any current search filter
            const currentSearch = submenuSearchInput.value.trim();
            if (currentSearch) {
                filterSubmenuItems(currentSearch);
            }
        }

        // Filter submenu items based on search query
        function filterSubmenuItems(query) {
            const normalizedQuery = query.toLowerCase().trim();
            const items = ctxSubmenuItems.querySelectorAll('.submenu-item');
            let visibleCount = 0;
            items.forEach(item => {
                const name = item.dataset.playlistName || '';
                if (name.includes(normalizedQuery)) {
                    item.style.display = '';
                    visibleCount++;
                } else {
                    item.style.display = 'none';
                }
            });

            // Show empty state if no matches
            const existingEmpty = ctxSubmenuItems.querySelector('.submenu-search-empty');
            if (visibleCount === 0 && !existingEmpty) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'submenu-search-empty';
                emptyMsg.textContent = 'No playlists match';
                emptyMsg.style.cssText = 'padding:0.6rem 1rem;color:#727272;font-size:0.85rem;text-align:center;';
                ctxSubmenuItems.appendChild(emptyMsg);
            } else if (existingEmpty) {
                existingEmpty.remove();
            }
        }

        // Filter removal menu items based on search query
        function filterRemovalMenuItems(query) {
            const normalizedQuery = query.toLowerCase().trim();
            const items = npRemovalItems.querySelectorAll('.submenu-item');
            let visibleCount = 0;
            items.forEach(item => {
                const name = item.dataset.playlistName || '';
                if (name.includes(normalizedQuery)) {
                    item.style.display = '';
                    visibleCount++;
                } else {
                    item.style.display = 'none';
                }
            });

            // Show empty state if no matches
            const existingEmpty = npRemovalItems.querySelector('.submenu-search-empty');
            if (visibleCount === 0 && !existingEmpty) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'submenu-search-empty';
                emptyMsg.textContent = 'No playlists match';
                emptyMsg.style.cssText = 'padding:0.6rem 1rem;color:#727272;font-size:0.85rem;text-align:center;';
                npRemovalItems.appendChild(emptyMsg);
            } else if (existingEmpty) {
                existingEmpty.remove();
            }
        }


        // Add current track to selected playlist
        async function addTrackToPlaylist(playlistId, track) {
            try {
                await api("/playlists/" + playlistId + "/tracks?track_id=" + track.id, { method: "POST" });
                // Update cache and UI immediately
                trackIdsInRegularPlaylists.add(track.id);
                if (currentTrackId === track.id) {
                    npLikeBtn.classList.remove("liked", "adding");
                    npLikeBtn.classList.add("in-playlist");
                    npLikeBtn.innerHTML = '';
                    npLikeBtn.setAttribute("aria-label", "Added to playlist");
                    npLikeBtn.setAttribute("title", "Added to playlist");
                }
                hideContextMenu();
                // Reload playlists to update counts, etc.
                loadPlaylists();
            } catch (err) {
                alert("Failed to add track to playlist: " + err.message);
            }
        }

        // Add to Playlist submenu hover handlers
        ctxTrackAddPlaylist.addEventListener("mouseenter", function() {
            // Show submenu immediately on hover
            showPlaylistSubmenu();
        });

        ctxTrackAddPlaylist.addEventListener("mouseleave", function() {
            // Schedule hide — allows mouse to move into submenu
            scheduleHideSubmenu();
        });

        ctxPlaylistSubmenu.addEventListener("mouseenter", function() {
            // Cancel hide when entering submenu
            if (currentTimeout) {
                clearTimeout(currentTimeout);
                currentTimeout = null;
            }
        });

        ctxPlaylistSubmenu.addEventListener("mouseleave", function() {
            // Hide submenu when mouse leaves
            scheduleHideSubmenu();
        });

        // Keep removal menu anchored to tick on window resize
        window.addEventListener("resize", function() {
            if (npRemovalMenu && npRemovalMenu.classList.contains("visible")) {
                positionRemovalMenu(npRemovalMenu, npLikeBtn);
            }
            if (addPlaylistModalOverlay && addPlaylistModalOverlay.style.display === "flex") {
                positionAddToPlaylistModal(npLikeBtn);
            }
            // Update scroll button visibility on resize
            updateAllScrollButtonStates();
        });

        // Also close removal menu when main context menu is closed
        const originalHideContextMenu = hideContextMenu;
        hideContextMenu = function() {
            ctxPlaylistSubmenu.classList.remove('visible');
            submenuSearchInput.value = '';
            submenuSearchWrapper.style.display = 'none';
            hideRemovalMenu();
            if (currentTimeout) {
                clearTimeout(currentTimeout);
                currentTimeout = null;
            }
            originalHideContextMenu();
        };


        // Context menu item clicks
        ctxPin.addEventListener("click", async function() {
            if (!currentContextPlaylist || currentContextPlaylist.is_liked) return;
            var targetId = currentContextPlaylist.id;
            var isPinned = currentContextPlaylist.pinned;
            hideContextMenu();
            try {
                await api("/playlists/" + targetId, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ pinned: !isPinned })
                });
                loadPlaylists();
            } catch (err) {
                alert("Failed to update pin: " + err.message);
            }
        });

        ctxRename.addEventListener("click", function() {
            if (!currentContextPlaylist || currentContextPlaylist.is_liked) return;
            pendingActionPlaylistId = currentContextPlaylist.id;
            var targetName = currentContextPlaylist.name;
            hideContextMenu();
            renameInput.value = targetName;
            renameModalOverlay.style.display = "flex";
            setTimeout(function() { renameInput.focus(); }, 100);
        });

        ctxRemove.addEventListener("click", function() {
            if (!currentContextPlaylist || currentContextPlaylist.is_liked) return;
            pendingActionPlaylistId = currentContextPlaylist.id;
            var targetName = currentContextPlaylist.name;
            hideContextMenu();
            confirmMessage.textContent = 'Delete playlist "' + targetName + '"?';
            confirmModalOverlay.style.display = "flex";
        });

        ctxTrackAddQueue.addEventListener("click", function() {
            // Ignore if disabled
            if (ctxTrackAddQueue.classList.contains('disabled')) return;
            if (!currentContextTrack) return;
            const track = currentContextTrack;
            // Double-check if already in unplayed portion of queue (including current)
            if (indexOfTrackId(currentQueue, track.id, currentIndex) !== -1) {
                hideContextMenu();
                return;
            }
            // Add track to end of queue
            currentQueue.push(track);
            enforceQueueCapacity();
            // Invalidate shuffle state since queue changed manually
            queueOriginal = null;
            renderNowPlayingQueue();
            hideContextMenu();
        });

        // Close context menu on overlay click
        contextMenuOverlay.addEventListener("click", function(e) {
            if (e.target === contextMenuOverlay) {
                hideContextMenu();
            }
        });

        // Rename modal handlers
        function hideRenameModal() {
            renameModalOverlay.style.display = "none";
        }

        renameCancelBtn.addEventListener("click", hideRenameModal);
        renameConfirmBtn.addEventListener("click", async function() {
            const newName = renameInput.value.trim();
            if (!newName || !pendingActionPlaylistId) {
                if (!newName) alert("Name cannot be empty.");
                return;
            }
            try {
                await api("/playlists/" + pendingActionPlaylistId, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: newName })
                });
                hideRenameModal();
                loadPlaylists();
            } catch (err) {
                alert("Failed to rename: " + err.message);
            } finally {
                pendingActionPlaylistId = null;
            }
        });

        // Confirm modal handlers
        function hideConfirmModal() {
            confirmModalOverlay.style.display = "none";
        }

        confirmCancelBtn.addEventListener("click", hideConfirmModal);
        confirmDeleteBtn.addEventListener("click", async function() {
            if (!pendingActionPlaylistId) return;
            try {
                await api("/playlists/" + pendingActionPlaylistId, { method: "DELETE" });
                hideConfirmModal();
                loadPlaylists();
            } catch (err) {
                alert("Failed to delete: " + err.message);
            } finally {
                pendingActionPlaylistId = null;
            }
        });

        // Add to Playlist Modal functions
        function hideAddToPlaylistModal() {
            addPlaylistModalOverlay.style.display = "none";
            addPlaylistSearchInput.value = '';
            allPlaylistsCache = [];
            // Reset confirm state (clears modalOriginalInPlaylist & modalPendingInPlaylist)
            resetConfirmState();
        }

        // Position the modal wrapper centered above the like button
        function positionAddToPlaylistModal(anchorBtn) {
            const rect = anchorBtn.getBoundingClientRect();
            const wrapper = addPlaylistModalWrapper;

            // Center horizontally: left edge = button center X - half modal width
            const centerX = rect.left + rect.width / 2;
            wrapper.style.left = (centerX - wrapper.offsetWidth / 2) + 'px';

            // Position bottom: modal bottom should be at (button top - GAP)
            // bottom CSS property = distance from viewport bottom to element's bottom
            const GAP = 8;
            wrapper.style.bottom = (window.innerHeight - rect.top + GAP) + 'px';
            wrapper.style.top = 'auto';
            wrapper.style.right = 'auto';
        }

        async function showAddToPlaylistModal() {
            // If modal already visible, do nothing
            if (addPlaylistModalOverlay.style.display === "flex") return;

            // Reset confirm state on fresh open
            resetConfirmState();

            // Close other popovers
            hideContextMenu();
            hideRemovalMenuIfVisible();

            // Position the modal above the like button
            positionAddToPlaylistModal(npLikeBtn);

            // Fetch all user playlists and which contain current track
            try {
                const playlists = await loadPlaylistsInternal();
                allPlaylistsCache = playlists;

                // Capture server state for this track
                modalOriginalInPlaylist.clear();
                modalPendingInPlaylist.clear();

                if (currentTrackId) {
                    try {
                        const trackPlaylists = await loadTrackPlaylists(currentTrackId);
                        for (const pl of trackPlaylists) {
                            modalOriginalInPlaylist.add(pl.id);
                            modalPendingInPlaylist.add(pl.id);
                        }
                    } catch (e) {
                        console.warn("Could not fetch track playlists:", e);
                    }
                }

                // Liked Songs
                if (likedTrackIds.has(currentTrackId)) {
                    modalOriginalInPlaylist.add('liked');
                    modalPendingInPlaylist.add('liked');
                }

                buildAddToPlaylistItems(playlists);
                showConfirmButton(); // show if any pending vs original diff
                addPlaylistModalOverlay.style.display = "flex";
                setTimeout(() => addPlaylistSearchInput.focus(), 100);
            } catch (err) {
                console.error("Failed to load playlists for modal:", err);
                alert("Failed to load playlists: " + err.message);
            }
        }

        // Internal loadPlaylists that returns the array (not DOM update)
        async function loadPlaylistsInternal() {
            // api() already throws on error and returns parsed JSON
            return await api("/playlists");
        }

        // Check if a playlist contains a specific track
        async function playlistContainsTrack(playlistId, trackId) {
            try {
                const tracks = await api(`/playlists/${playlistId}/tracks`);
                return tracks.some(t => t.id === trackId);
            } catch {
                return false;
            }
        }

        function buildAddToPlaylistItems(playlists, filter = '') {
            addPlaylistItems.innerHTML = '';

            const filterLower = filter.toLowerCase();

            // Build Liked Songs special item (always show, not searchable)
            const likedItem = document.createElement('div');
            likedItem.className = 'add-playlist-item';
            likedItem.dataset.playlistId = 'liked';
            if (!filterLower) { // Only show when not filtering, or could include in filter
                // Thumbnail for Liked Songs — match library's gradient heart styling
                const thumb = document.createElement('div');
                thumb.className = 'add-playlist-thumb';
                // Use same gradient as library Liked Songs cover
                thumb.style.background = 'linear-gradient(135deg,#450af5,#c4efd9)';
                const heart = document.createElement('i');
                heart.className = 'fa-solid fa-heart';
                // Library shows white heart on gradient; override default grey CSS
                heart.style.color = '#fff';
                thumb.appendChild(heart);
                likedItem.appendChild(thumb);

                // Name
                const name = document.createElement('span');
                name.className = 'add-playlist-name';
                name.textContent = 'Liked Songs';
                likedItem.appendChild(name);

                // Actions container
                const actions = document.createElement('div');
                actions.className = 'add-playlist-actions';

                // Checkbox — reflects PENDING state
                const checkbox = document.createElement('div');
                checkbox.className = 'add-playlist-checkbox';
                if (modalPendingInPlaylist.has('liked')) {
                    checkbox.classList.add('checked');
                }
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleLikedSongsToggle(checkbox);
                });
                actions.appendChild(checkbox);

                likedItem.appendChild(actions);
                if (!filterLower) {
                    addPlaylistItems.appendChild(likedItem);
                }
            }

            // Filter regular playlists
            const filtered = playlists.filter(pl => {
                if (pl.is_liked) return false; // Skip Liked Songs (handled separately)
                return pl.name.toLowerCase().includes(filterLower);
            });

            if (filtered.length === 0 && !filterLower) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'add-playlist-empty';
                emptyMsg.style.cssText = 'padding: 1rem; color: #727272; font-size: 0.875rem; text-align: center;';
                emptyMsg.textContent = 'No playlists yet';
                addPlaylistItems.appendChild(emptyMsg);
                return;
            }

            if (filtered.length === 0 && filterLower) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'add-playlist-empty';
                emptyMsg.style.cssText = 'padding: 1rem; color: #727272; font-size: 0.875rem; text-align: center;';
                emptyMsg.textContent = 'No playlists match your search';
                addPlaylistItems.appendChild(emptyMsg);
                return;
            }

            filtered.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'add-playlist-item';
                item.dataset.playlistId = pl.id;

                // Thumbnail
                const thumb = document.createElement('div');
                thumb.className = 'add-playlist-thumb';
                // Liked Songs: gradient + heart
                if (pl.is_liked) {
                    thumb.style.background = 'linear-gradient(135deg,#450af5,#c4efd9)';
                    const heart = document.createElement('i');
                    heart.className = 'fa-solid fa-heart';
                    heart.style.color = '#fff';
                    heart.style.fontSize = '1.25rem';
                    thumb.appendChild(heart);
                } else {
                    // Regular playlist: try loading collage thumbnail
                    const img = document.createElement('img');
                    img.src = withBase("/playlists/" + pl.id + "/cover?v=" + Date.now());
                    img.alt = escapeHtml(pl.name);
                    img.style.width = '100%';
                    img.style.height = '100%';
                    img.style.objectFit = 'cover';
                    img.onerror = function() {
                        img.style.display = 'none';
                        // Fallback to default playlist icon SVG
                        const fallback = createPlaylistIconSvg();
                        fallback.style.width = '20px';
                        fallback.style.height = '20px';
                        thumb.appendChild(fallback);
                    };
                    thumb.appendChild(img);
                }
                item.appendChild(thumb);

                // Name
                const name = document.createElement('span');
                name.className = 'add-playlist-name';
                name.textContent = pl.name;
                item.appendChild(name);

                // Actions container
                const actions = document.createElement('div');
                actions.className = 'add-playlist-actions';

                // Pin icon (inline SVG) - always visible if pinned, shown on hover otherwise
                const pinSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                pinSvg.className = 'add-playlist-pin';
                pinSvg.setAttribute("viewBox", "290 120 160 160");
                pinSvg.setAttribute("width", "14");
                pinSvg.setAttribute("height", "14");
                pinSvg.setAttribute("fill", pl.pinned ? "#1DB954" : "#b3b3b3");
                pinSvg.setAttribute("aria-hidden", "true");
                const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                g.setAttribute("transform", "translate(290, 120) scale(10)");
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                if (pl.pinned) {
                    // Filled pin (pinned) - green
                    path.setAttribute("d", "M8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
                } else {
                    // Outline pin (unpinned) - gray
                    path.setAttribute("d", "M11.609 1.858a1.22 1.22 0 0 0-1.727 0L5.92 5.82l-2.867.768 6.359 6.359.768-2.867 3.962-3.963a1.22 1.22 0 0 0 0-1.726zM8.822.797a2.72 2.72 0 0 1 3.847 0l2.534 2.533a2.72 2.72 0 0 1 0 3.848l-3.678 3.678-1.337 4.988-4.486-4.486L1.28 15.78a.75.75 0 0 1-1.06-1.06l4.422-4.422L.156 5.812l4.987-1.337z");
                }
                g.appendChild(path);
                pinSvg.appendChild(g);
                actions.appendChild(pinSvg);

                // Checkbox — reflects PENDING state
                const checkbox = document.createElement('div');
                checkbox.className = 'add-playlist-checkbox';
                if (modalPendingInPlaylist.has(pl.id)) {
                    checkbox.classList.add('checked');
                }
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleAddToPlaylistToggle(pl.id, checkbox);
                });
                actions.appendChild(checkbox);

                item.appendChild(actions);
                addPlaylistItems.appendChild(item);
            });
        }

        function filterAddToPlaylistItems() {
            buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
        }

        function handleAddToPlaylistToggle(playlistId, checkboxEl) {
            const currentlyChecked = checkboxEl.classList.contains('checked');
            const newChecked = !currentlyChecked;

            if (newChecked) {
                modalPendingInPlaylist.add(playlistId);
                checkboxEl.classList.add('checked');
            } else {
                modalPendingInPlaylist.delete(playlistId);
                checkboxEl.classList.remove('checked');
            }
            showConfirmButton();
        }

        function handleLikedSongsToggle(checkboxEl) {
            const currentlyChecked = checkboxEl.classList.contains('checked');

            if (currentlyChecked) {
                // Uncheck Liked — remove from pending (keep regular playlist pending state intact)
                modalPendingInPlaylist.delete('liked');
                checkboxEl.classList.remove('checked');
                // Rebuild all items to reflect regular checkboxes unchanged
                buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
            } else {
                // Check Liked — add liked but keep other pending adds (multi-select)
                modalPendingInPlaylist.add('liked');
                // Rebuild to reflect new liked state while preserving other selections
                buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
                checkboxEl.classList.add('checked');
            }

            showConfirmButton();
        }

        function handleNewPlaylistClick() {
            // Create a pending new playlist entry (temporary ID)
            const count = allPlaylistsCache.filter(p => !p.is_liked && !p._isNew).length;
            const newName = `My Playlist #${count + 1}`;
            const tempId = 'new-' + Date.now();

            // Add to cache as a placeholder (won't persist until Confirm)
            const placeholder = {
                id: tempId,
                name: newName,
                is_liked: false,
                pinned: false,
                _isNew: true  // marker
            };
            allPlaylistsCache.push(placeholder);

            // Mark this playlist as pending addition in the modal
            modalPendingInPlaylist.add(tempId);

            // Remove Liked from pending (new playlist implies not Liked)
            modalPendingInPlaylist.delete('liked');

            // Rebuild items to show new playlist with checked box
            buildAddToPlaylistItems(allPlaylistsCache, addPlaylistSearchInput.value);
            showConfirmButton();
        }

        // Close modals on overlay click and Escape key
        document.addEventListener("keydown", function(e) {
            if (e.key === "Escape") {
                hideContextMenu();
                hideRenameModal();
                hideConfirmModal();
                hideRemovalMenuIfVisible();
                hideAddToPlaylistModal();
            }
        });

        // Also close removal menu when clicking outside of it
        document.addEventListener("click", function(e) {
            const menu = document.getElementById("np-playlist-removal-menu");
            if (menu && menu.classList.contains("visible") &&
                !menu.contains(e.target) && !npLikeBtn.contains(e.target)) {
                hideRemovalMenuIfVisible();
            }
        });

        // Admin functionality
        const adminBtn = document.getElementById("admin-btn");
        
        // Show/hide admin button based on admin status
        function updateAdminButtonVisibility() {
            if (adminBtn) {
                adminBtn.style.display = isAdmin ? "flex" : "none";
            }
        }

        // Initialize admin button visibility on page load
        updateAdminButtonVisibility();

        // Admin button click handler
        adminBtn.addEventListener("click", function() {
            userDropdown.classList.remove("visible");
            // Reset admin views to dashboard
            if (adminDashboard) {
                adminDashboard.style.display = "block";
            }
            if (adminUsersView) {
                adminUsersView.style.display = "none";
            }
            if (adminLibraryView) {
                adminLibraryView.style.display = "none";
            }
            setActivePage("admin");
        });

        // Load users list with optional search query
        async function loadUsersList(searchQuery = "") {
            const container = document.getElementById("users-table-container");
            const tableBody = document.getElementById("users-table-body");
            if (!container || !tableBody) return;

            try {
                const url = searchQuery.trim() 
                    ? `/admin/users?q=${encodeURIComponent(searchQuery.trim())}`
                    : "/admin/users";
                const users = await api(url);
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
                    const isSelf = user.id === currentUser?.id;
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

                // Add delete event listeners
                tableBody.querySelectorAll(".btn-delete").forEach(btn => {
                    btn.addEventListener("click", async function() {
                        const userId = this.dataset.userId;
                        const confirmed = confirm("Are you sure you want to delete this user? Their playlists will be removed and tracks will become unowned. This cannot be undone.");
                        if (!confirmed) return;

                        this.disabled = true;
                        this.textContent = "Deleting...";

                        try {
                            await api(`/admin/users/${userId}`, { method: "DELETE" });
                            alert("User deleted successfully");
                            loadUsersList(searchQuery); // Refresh with current search
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

        // Load library tracks list
        async function loadTracksList(searchQuery = "") {
            const container = document.getElementById("library-table-container");
            const tableBody = document.getElementById("library-table-body");
            if (!container || !tableBody) return;

            try {
                const url = searchQuery.trim() 
                    ? `/admin/tracks?q=${encodeURIComponent(searchQuery.trim())}`
                    : "/admin/tracks";
                const tracks = await api(url);
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

                // Add delete event listeners
                tableBody.querySelectorAll(".btn-delete").forEach(btn => {
                    btn.addEventListener("click", async function() {
                        const trackId = this.dataset.trackId;
                        const confirmed = confirm("Are you sure you want to delete this track? This cannot be undone.");
                        if (!confirmed) return;

                        this.disabled = true;
                        this.textContent = "Deleting...";

                        try {
                            await api(`/admin/tracks/${trackId}`, { method: "DELETE" });
                            alert("Track deleted successfully");
                            loadTracksList(searchQuery);
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

        // Add event listeners for admin actions after DOM is fully loaded
        const viewUsersBtn = document.getElementById("view-users-btn");
        const adminDashboard = document.getElementById("admin-dashboard");
        const adminUsersView = document.getElementById("admin-users-view");
        const adminUsersBack = document.getElementById("admin-users-back");
        const adminBackHome = document.getElementById("admin-back-home");
        const usersSearchInput = document.getElementById("users-search-input");
        let searchTimeout = null;
        
        const viewLibraryBtn = document.getElementById("view-library-btn");
        const adminLibraryView = document.getElementById("admin-library-view");
        const adminLibraryBack = document.getElementById("admin-library-back");
        const librarySearchInput = document.getElementById("library-search-input");
        let librarySearchTimeout = null;
        
        viewUsersBtn?.addEventListener("click", function() {
            adminDashboard.style.display = "none";
            adminUsersView.style.display = "flex";
            loadUsersList();
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
                loadUsersList(query);
            }, 300);
        });
        
        viewLibraryBtn?.addEventListener("click", function() {
            adminDashboard.style.display = "none";
            adminLibraryView.style.display = "flex";
            loadTracksList();
        });
        
        adminLibraryBack?.addEventListener("click", function() {
            adminLibraryView.style.display = "none";
            adminDashboard.style.display = "block";
        });
        
        librarySearchInput?.addEventListener("input", function() {
            clearTimeout(librarySearchTimeout);
            const query = this.value.trim();
            librarySearchTimeout = setTimeout(() => {
                loadTracksList(query);
            }, 300);
        });

        clearCanvas(nowCover);

        // Initialize when DOM is ready
        // Keyboard event listener for space bar to play/pause
        document.addEventListener('keydown', function(event) {
            // Only handle space bar for play/pause
            if (event.code === 'Space' && event.target.tagName !== 'INPUT') {
                // Only play/pause if there's a track playing
                if (audioPlayer.src && audioPlayer.src !== window.location.href) {
                    togglePlay();
                }
                event.preventDefault();
            }
            // Arrow keys do nothing - prevent any default behavior
            if (event.code === 'ArrowLeft' || event.code === 'ArrowRight' ||
                event.code === 'ArrowUp' || event.code === 'ArrowDown') {
                event.preventDefault();
            }
        });

        function updateTrackRowScrollButtons() {
            // Update scroll button visibility for all track rows (library, uploads, most-played)
            // Called after window resize or sidebar toggle
            const updateForContainer = (containerSelector, idPrefix) => {
                const container = document.querySelector(containerSelector);
                if (!container) return;

                const wrappers = container.querySelectorAll('.track-row-wrapper');
                wrappers.forEach((wrapper, rowIndex) => {
                    const prevBtn = wrapper.querySelector(`#${idPrefix}-prev-${rowIndex}`);
                    const nextBtn = wrapper.querySelector(`#${idPrefix}-next-${rowIndex}`);
                    const rowContainer = wrapper.querySelector('.track-row-container');
                    const trackRow = wrapper.querySelector('.track-row');

                    if (!prevBtn || !nextBtn || !rowContainer || !trackRow) return;
                    if (!prevBtn.isConnected || !nextBtn.isConnected) return;

                    // Get or create the row key for global scroll position
                    const rowKey = `${idPrefix}-${rowIndex}`;
                    if (!(rowKey in scrollPositions)) {
                        scrollPositions[rowKey] = 0;
                    }

                    // Reset scroll position to 0 when layout changes
                    scrollPositions[rowKey] = 0;
                    trackRow.style.transform = 'translateX(0)';

                    const maxScroll = Math.max(0, trackRow.scrollWidth - rowContainer.clientWidth);
                    const isAtStart = true; // Always at start after reset
                    const isAtEnd = maxScroll <= 0;

                    // Remove all visibility classes first
                    prevBtn.classList.remove('hidden', 'visible', 'prev-visible', 'next-visible');
                    nextBtn.classList.remove('hidden', 'visible', 'prev-visible', 'next-visible');

                    if (maxScroll <= 0) {
                        // No scroll needed - hide both buttons
                        prevBtn.classList.add('hidden');
                        nextBtn.classList.add('hidden');
                    } else {
                        // Has scroll content
                        // Hide prev if at start
                        if (isAtStart) {
                            prevBtn.classList.add('hidden');
                        } else {
                            prevBtn.classList.add('visible', 'prev-visible');
                        }
                        // Hide next if at end
                        if (isAtEnd) {
                            nextBtn.classList.add('hidden');
                        } else {
                            nextBtn.classList.add('visible', 'next-visible');
                        }
                    }
                });
            };

            // Update all container types - library uses #tracks-grid, others use their IDs
            updateForContainer('#most-played-grid', 'most-played-row');
            updateForContainer('#uploads-grid', 'uploads-row');
            updateForContainer('#tracks-grid', 'track-row');
        }

        function updateAllScrollButtonStates() {
            // Delay to allow layout to settle
            setTimeout(() => {
                updateTrackRowScrollButtons();
            }, 150);
        }

        document.addEventListener('DOMContentLoaded', function() {
            // Initialization is now handled in render functions
        });


        // Initialize page state - this will properly set the home-page class
        setActivePage('home');
        (async function() {
            var ok = await tryAutoLogin();
            if (!ok) {
                authOverlay.style.display = "flex";
                appMain.style.display = "none";
            } else {
                loadTracks();
                loadMostPlayed();
                loadPlaylists();
                loadUserUploads();
            }
        })();
