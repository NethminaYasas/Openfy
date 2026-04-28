import { withBase } from './state.js';
import { setAuthenticatedImage } from './api.js';

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return "00:00";
  var mins = Math.floor(seconds / 60);
  var secs = Math.round(seconds % 60).toString().padStart(2, "0");
  if (secs === "60") {
    secs = "00";
    mins += 1;
  }
  return mins + ":" + secs;
}

export function getArtistDisplay(track) {
  if (track.artists && track.artists.length > 0) {
    return track.artists.map(function(a) { return a.name; }).join(", ");
  }
  return (track.artist && track.artist.name) ? track.artist.name : "Unknown";
}

export function formatTotalDuration(tracks) {
  if (!tracks || tracks.length === 0) return '0 songs';
  var totalSeconds = 0;
  tracks.forEach(function(pt) {
    if (pt.track && pt.track.duration) {
      totalSeconds += pt.track.duration;
    }
  });
  var totalMinutes = Math.floor(totalSeconds / 60);
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  if (hours === 0) {
    return tracks.length + ' songs, ' + minutes + ' min';
  }
  return tracks.length + ' songs, ' + hours + ' hr ' + minutes + ' min';
}

export function formatDateAdded(dateStr) {
  if (!dateStr) return '—';
  var date = new Date(dateStr);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
}

export function seededColor(seed) {
  var hash = 0;
  for (var i = 0; i < seed.length; i++) { hash = seed.charCodeAt(i) + ((hash << 5) - hash); }
  var hue = Math.abs(hash) % 360;
  return "hsl(" + hue + ", 70%, 50%)";
}

export function rgbToHsl(r, g, b) {
  r /= 255, g /= 255, b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h, s, l = (max + min) / 2;
  if (max == min) {
    h = s = 0;
  } else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s, l: l };
}

export function hslToRgb(h, s, l) {
  h /= 360;
  var r, g, b;
  if (s == 0) {
    r = g = b = l;
  } else {
    var hue2rgb = function(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), l: l };
}

export function rgbToHex(rgb) {
  var match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!match) return '#535353';
  var r = parseInt(match[1]).toString(16).padStart(2, '0');
  var g = parseInt(match[2]).toString(16).padStart(2, '0');
  var b = parseInt(match[3]).toString(16).padStart(2, '0');
  return '#' + r + g + b;
}

export function extractVibrantColors(imageUrl) {
  return new Promise(function(resolve) {
    var img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = function() {
      try {
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        var size = 50;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;

        var colorBucket = [];
        for (var i = 0; i < data.length; i += 16) {
          if (data[i + 3] > 200) {
            var r = data[i], g = data[i+1], b = data[i+2];
            var hsl = rgbToHsl(r, g, b);
            var weight = hsl.s * (1 - Math.abs(hsl.l - 0.5) * 2);
            colorBucket.push({ r, g, b, h: hsl.h, s: hsl.s, l: hsl.l, weight: weight });
          }
        }

        if (colorBucket.length === 0) {
          resolve(['#282828', '#121212']);
          return;
        }
      } catch (e) {
        resolve(['#282828', '#121212']);
        return;
      }

      colorBucket.sort((a, b) => b.weight - a.weight);

      var color1 = colorBucket[0];
      var color2 = null;

      for (var i = 1; i < colorBucket.length; i++) {
        var c = colorBucket[i];
        var hueDiff = Math.abs(c.h - color1.h);
        if (hueDiff > 2 && hueDiff < 40) {
          color2 = c;
          break;
        }
      }

      if (!color2) color2 = colorBucket[Math.min(5, colorBucket.length - 1)];

      var pairs = [color1, color2].map(c => {
        var h = c.h, s = c.s, l = c.l;
        var targetL = Math.min(Math.max(l, 0.15), 0.25);
        var targetS = Math.min(s, 0.4);
        return hslToRgb(h, targetS, targetL);
      }).sort((a, b) => b.l - a.l);

      resolve([
        `rgb(${pairs[0].r}, ${pairs[0].g}, ${pairs[0].b})`,
        `rgb(${pairs[1].r}, ${pairs[1].g}, ${pairs[1].b})`
      ]);
    };
    img.onerror = () => resolve(['#282828', '#121212']);
    img.src = imageUrl;
  });
}

export function drawCanvas(canvas, title, artist) {
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

export function clearCanvas(canvas) {
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function createArtCanvas(title, artist) {
  var canvas = document.createElement("canvas");
  canvas.className = "art-canvas";
  canvas.width = 180;
  canvas.height = 180;
  drawCanvas(canvas, title, artist);
  return canvas;
}

export function createPlaylistIconSvg() {
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

export function extractDominantColorFromImage(img) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const scale = 0.1;
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
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

export function queueArtworkUrl(track) {
  return withBase("/tracks/" + track.id + "/artwork?v=" + encodeURIComponent(track.updated_at || ""));
}

export function positionRemovalMenu(menu, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  const container = anchorBtn.parentElement;
  const containerRect = container.getBoundingClientRect();
  menu.style.position = 'absolute';
  const GAP_ABOVE = 8;
  menu.style.bottom = (containerRect.height + GAP_ABOVE) + 'px';
  menu.style.right = '0';
  menu.style.left = 'auto';
  menu.style.top = 'auto';
}

export function hideRemovalMenuIfVisible() {
  hideRemovalMenu();
}

let removalMenuEl = null;
export function setRemovalMenuElement(el) {
  removalMenuEl = el;
}

function hideRemovalMenu() {
  if (removalMenuEl) removalMenuEl.classList.remove("visible");
}

export function buildPlaylistCover(tracks, playlist) {
  var mosaic = document.getElementById('playlist-mosaic');
  if (!mosaic) return;
  mosaic.innerHTML = '';

  if (playlist && playlist.is_liked) {
    var item = document.createElement('div');
    item.className = 'playlist-mosaic-item';
    item.style.gridColumn = '1 / -1';
    item.style.gridRow = '1 / -1';
    item.style.background = 'linear-gradient(135deg, #450af5, #c4efd9)';
    item.innerHTML = '<i class="fa-solid fa-heart" style="font-size: 4rem; color: #ffffff;"></i>';
    mosaic.appendChild(item);
    return;
  }

  if (!tracks || tracks.length === 0) {
    var item = document.createElement('div');
    item.className = 'playlist-mosaic-item';
    item.style.gridColumn = '1 / -1';
    item.style.gridRow = '1 / -1';
    item.innerHTML = '<i class="fa-solid fa-music"></i>';
    mosaic.appendChild(item);
    return;
  }

  var wrapper = document.createElement('div');
  wrapper.className = 'playlist-mosaic-item';
  wrapper.style.gridColumn = '1 / -1';
  wrapper.style.gridRow = '1 / -1';

  var coverImg = document.createElement('img');
  coverImg.style.width = '100%';
  coverImg.style.height = '100%';
  coverImg.style.objectFit = 'cover';
  coverImg.onerror = function() {
    buildMosaicFallback(tracks, playlist);
  };
  wrapper.appendChild(coverImg);
  mosaic.appendChild(wrapper);
  setAuthenticatedImage(
    coverImg,
    "/playlists/" + playlist.id + "/cover?v=" + Date.now(),
    function() { buildMosaicFallback(tracks, playlist); }
  );
}

export function buildMosaicFallback(tracks, playlist) {
  var mosaic = document.getElementById('playlist-mosaic');
  if (!mosaic) return;
  mosaic.innerHTML = '';

  if (playlist && playlist.is_liked) {
    var item = document.createElement('div');
    item.className = 'playlist-mosaic-item';
    item.style.gridColumn = '1 / -1';
    item.style.gridRow = '1 / -1';
    item.style.background = 'linear-gradient(135deg, #450af5, #c4efd9)';
    item.innerHTML = '<i class="fa-solid fa-heart" style="font-size: 4rem; color: #ffffff;"></i>';
    mosaic.appendChild(item);
    return;
  }

  if (!tracks || tracks.length === 0) {
    var item = document.createElement('div');
    item.className = 'playlist-mosaic-item';
    item.style.gridColumn = '1 / -1';
    item.style.gridRow = '1 / -1';
    item.innerHTML = '<i class="fa-solid fa-music"></i>';
    mosaic.appendChild(item);
    return;
  }

  if (tracks.length === 1) {
    var item = document.createElement('div');
    item.className = 'playlist-mosaic-item';
    item.style.gridColumn = '1 / -1';
    item.style.gridRow = '1 / -1';
    var img = document.createElement('img');
    img.src = withBase('/tracks/' + tracks[0].track.id + '/artwork?v=' + (tracks[0].track.updated_at || Date.now()));
    img.onerror = function() { this.parentElement.innerHTML = '<i class="fa-solid fa-music"></i>'; };
    item.appendChild(img);
    mosaic.appendChild(item);
    return;
  }

  if (tracks.length === 2) {
    for (var i = 0; i < 4; i++) {
      var item = document.createElement('div');
      item.className = 'playlist-mosaic-item';
      var artIndex = i < 2 ? 0 : 1;
      var img = document.createElement('img');
      img.src = withBase('/tracks/' + tracks[artIndex].track.id + '/artwork?v=' + (tracks[artIndex].track.updated_at || Date.now()));
      img.onerror = function() { this.style.display = 'none'; };
      item.appendChild(img);
      mosaic.appendChild(item);
    }
    return;
  }

  if (tracks.length === 3) {
    for (var i = 0; i < 3; i++) {
      var item = document.createElement('div');
      item.className = 'playlist-mosaic-item';
      var img = document.createElement('img');
      img.src = withBase('/tracks/' + tracks[i].track.id + '/artwork?v=' + (tracks[i].track.updated_at || Date.now()));
      img.onerror = function() { this.style.display = 'none'; };
      item.appendChild(img);
      mosaic.appendChild(item);
    }
    var placeholder = document.createElement('div');
    placeholder.className = 'playlist-mosaic-item';
    placeholder.style.background = '#282828';
    mosaic.appendChild(placeholder);
    return;
  }

  for (var i = 0; i < 4; i++) {
    var item = document.createElement('div');
    item.className = 'playlist-mosaic-item';
    var img = document.createElement('img');
    img.src = withBase('/tracks/' + tracks[i].track.id + '/artwork?v=' + (tracks[i].track.updated_at || Date.now()));
    img.onerror = function() { this.style.display = 'none'; };
    item.appendChild(img);
    mosaic.appendChild(item);
  }
}