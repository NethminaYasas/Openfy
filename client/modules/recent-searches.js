function getStorageKey(userId) {
  return userId ? `openfy_recent_searches_${userId}` : 'openfy_recent_searches';
}

const MAX_RECENT = 5;

export function loadRecentSearches(userId) {
  try {
    const data = localStorage.getItem(getStorageKey(userId));
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function addRecentSearch(userId, track) {
  const recent = loadRecentSearches(userId);
  const existingIndex = recent.findIndex(item => item.id === track.id);

  if (existingIndex >= 0) {
    recent[existingIndex].count += 1;
    recent[existingIndex].lastSearched = Date.now();
    recent[existingIndex].title = track.title;
    recent[existingIndex].artist = track.artist;
    const [item] = recent.splice(existingIndex, 1);
    recent.unshift(item);
  } else {
    recent.unshift({
      id: track.id,
      title: track.title,
      artist: track.artist,
      count: 1,
      lastSearched: Date.now()
    });
    if (recent.length > MAX_RECENT) {
      recent.pop();
    }
  }

  saveRecentSearches(userId, recent);
}

export function saveRecentSearches(userId, recent) {
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(recent));
  } catch (e) {
    console.error('Failed to save recent searches:', e);
  }
}

export function removeRecentSearch(userId, trackId) {
  const recent = loadRecentSearches(userId);
  const filtered = recent.filter(item => item.id !== trackId);
  saveRecentSearches(userId, filtered);
  return filtered;
}