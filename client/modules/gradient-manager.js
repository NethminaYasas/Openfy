import { state, withBase } from './state.js';
import { getArtistDisplay, extractVibrantColors, hslToRgb } from './utils.js';

let gradientManagerInstance = null;

class GradientManager {
  constructor({
    primaryId = 'home-gradient',
    secondaryId = 'home-gradient-2',
    fadeInMs = 300,
    gradientOpacity = 0.25
  } = {}) {
    this.primaryDiv = document.getElementById(primaryId);
    this.secondaryDiv = document.getElementById(secondaryId);
    this.fadeInMs = fadeInMs;
    this.gradientOpacity = gradientOpacity;
    this.current = null;
    this.next = null;
    this.rafId = null;
    this.isHome = false;
    this.isActive = false;
    this.currentTrackInfo = null;

    this.onTrackChange = this.onTrackChange.bind(this);
    this.onPageNav = this.onPageNav.bind(this);
  }

  init() {
    if (!this.primaryDiv || !this.secondaryDiv) {
      console.warn('GradientManager: missing gradient elements');
      return;
    }

    document.addEventListener('trackChanged', this.onTrackChange);
    document.addEventListener('pageNavigated', this.onPageNav);

    this.isHome = document.getElementById('app-main')?.classList.contains('home-page') || false;
    if (this.isHome) {
      this.show();
      if (window.__lastTrackForGradient) {
        const track = window.__lastTrackForGradient;
        const event = new CustomEvent('trackChanged', {
          detail: {
            artworkUrl: withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || "")),
            title: track.title,
            artist: getArtistDisplay(track)
          }
        });
        document.dispatchEvent(event);
      }
    }
  }

  destroy() {
    document.removeEventListener('trackChanged', this.onTrackChange);
    document.removeEventListener('pageNavigated', this.onPageNav);
    this._cancelRaf();
    this.isActive = false;
  }

  async onTrackChange(ev) {
    const { artworkUrl, title, artist } = ev.detail;
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
      if (!wasHome && this._hasActiveTrack()) {
        this._emitTrackChangedEvent();
      }
    } else {
      this.hide();
    }
  }

  async _resolveColors(artworkUrl, title, artist) {
    try {
      if (artworkUrl) {
        return await this._extractColorsFromImage(artworkUrl);
      }
    } catch (error) {
      console.warn('Failed to extract colors from image, using fallback:', error);
    }
    return this._generateSeededColors(title, artist);
  }

  async _extractColorsFromImage(imageUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = async () => {
        try {
          const colors = await extractVibrantColors(imageUrl);
          resolve({ primary: colors[0], secondary: colors[1] });
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
    const colors = [
      hslToRgb(hue, 0.4, 0.25),
      hslToRgb((hue + 20) % 360, 0.3, 0.15)
    ];
    return { 
      primary: `rgb(${colors[0].r}, ${colors[0].g}, ${colors[0].b})`, 
      secondary: `rgb(${colors[1].r}, ${colors[1].g}, ${colors[1].b})` 
    };
  }

  _queueTransition(colors) {
    this.next = colors;
    if (!this.rafId && this.isActive) {
      this._crossfade();
    }
  }

  _crossfade() {
    if (!this.next || !this.isActive) return;
    const from = this.primaryDiv;
    const to = this.secondaryDiv;
    to.style.setProperty('--gradient-start', this.next.primary);
    to.style.setProperty('--gradient-mid', this.next.secondary);
    to.style.opacity = '0';
    void to.offsetWidth;
    const start = performance.now();
    const duration = this.fadeInMs;
    const step = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = this._easeOutCubic(progress);
      to.style.opacity = (eased * this.gradientOpacity).toString();
      from.style.opacity = ((1 - eased) * this.gradientOpacity).toString();
      if (progress < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        [this.primaryDiv, this.secondaryDiv] = [this.secondaryDiv, this.primaryDiv];
        this.current = this.next;
        this.next = null;
        this._cancelRaf();
      }
    };
    this.rafId = requestAnimationFrame(step);
  }

  _easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  _hasActiveTrack() {
    const audioPlayer = document.getElementById('audio-player');
    return audioPlayer && audioPlayer.src && audioPlayer.src !== window.location.href;
  }

  _emitTrackChangedEvent() {
    const track = this.currentTrackInfo || window.__lastTrackForGradient;
    if (track && track.title) {
      const { artworkUrl, title, artist } = track;
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

  show() {
    if (!this.isHome) return;
    this.isActive = true;
    this.primaryDiv.classList.remove('hidden');
    this.secondaryDiv.classList.remove('hidden');
    if (!this.current) {
      this.primaryDiv.style.opacity = this.gradientOpacity.toString();
      this.secondaryDiv.style.opacity = '0';
    } else {
      this.primaryDiv.style.opacity = this.gradientOpacity.toString();
      this.secondaryDiv.style.opacity = '0';
    }
  }

  hide() {
    this.isActive = false;
    this.primaryDiv.classList.add('hidden');
    this.secondaryDiv.classList.add('hidden');
    this.primaryDiv.style.opacity = '0';
    this.secondaryDiv.style.opacity = '0';
  }

  _cancelRaf() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

export function initGradient() {
  if (!gradientManagerInstance) {
    gradientManagerInstance = new GradientManager();
    gradientManagerInstance.init();
  }
  return gradientManagerInstance;
}

export function destroyGradient() {
  if (gradientManagerInstance) {
    gradientManagerInstance.destroy();
    gradientManagerInstance = null;
  }
}

export function emitTrackChanged(track) {
  window.__lastTrackForGradient = track;
  const event = new CustomEvent('trackChanged', {
    detail: {
      artworkUrl: withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || "")),
      title: track.title,
      artist: getArtistDisplay(track)
    }
  });
  document.dispatchEvent(event);
}

export function getGradientManager() {
  return gradientManagerInstance;
}