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

// Initialize gradient manager
let gradientManager = null;

export function initGradient() {
  if (!gradientManager) {
    gradientManager = new GradientManager();
    gradientManager.init();
  }
  return gradientManager;
}

export function destroyGradient() {
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
        if (window.gradientManager?._hasActiveTrack()) {
          window.gradientManager._emitTrackChangedEvent();
        }
      }, 100);
    }
  });
} else {
  if (document.getElementById('app-main')?.classList.contains('home-page')) {
    initGradient();
    // Check if there's an active track and emit track changed event
    setTimeout(() => {
      if (window.gradientManager?._hasActiveTrack()) {
        window.gradientManager._emitTrackChangedEvent();
      }
    }, 100);
  }
}