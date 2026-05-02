#!/usr/bin/env python3
"""
Spotify track search with 30-day cache.
"""

import sys
import re
import json
import os
import time
import requests
from datetime import datetime, timedelta


# Cache file location
CACHE_DIR = "/app/data"
CACHE_FILE = os.path.join(CACHE_DIR, "search_cache.json")
CACHE_DAYS = 30


def load_cache():
    """Load search cache from file."""
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        with open(CACHE_FILE, 'r') as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(cache):
    """Save search cache to file."""
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(CACHE_FILE, 'w') as f:
            json.dump(cache, f)
    except Exception as e:
        print(f"Cache save error: {e}", file=sys.stderr)


def get_cached_results(query):
    """Get cached results for a query if not expired."""
    cache = load_cache()
    query_lower = query.lower().strip()

    if query_lower in cache:
        cached = cache[query_lower]
        cached_time = cached.get('timestamp', 0)
        # Check if less than CACHE_DAYS old
        if time.time() - cached_time < CACHE_DAYS * 24 * 3600:
            return cached.get('results', [])
        else:
            # Remove expired entry
            del cache[query_lower]
            save_cache(cache)

    return None


def save_cached_results(query, results):
    """Save results to cache."""
    cache = load_cache()
    query_lower = query.lower().strip()
    cache[query_lower] = {
        'timestamp': time.time(),
        'results': results
    }
    save_cache(cache)


def search_spotify(query: str, limit: int = 10) -> list[dict]:
    """Search for tracks on Spotify with caching."""

    # Check cache first
    cached = get_cached_results(query)
    if cached:
        print(f"Returning cached results for: {query}", file=sys.stderr)
        return cached[:limit]

    results = []

    # Get more results from each source to interleave
    itunes_limit = limit * 2
    yt_limit = limit * 2

    # Try iTunes Search API - free, reliable, no rate limits
    itunes_results = []
    try:
        url = f"https://itunes.apple.com/search?term={requests.utils.quote(query)}&media=music&limit={itunes_limit}"
        resp = requests.get(url, timeout=5)

        if resp.status_code == 200:
            data = resp.json()
            items = data.get('results', [])

            for item in items:
                track_id = item.get('trackId')
                if track_id:
                    itunes_results.append({
                        "track_name": item.get('trackName', query),
                        "artist_name": item.get('artistName', 'Unknown'),
                        "album_name": item.get('collectionName', ''),
                        "source": "Apple Music",
                        "spotify_url": item.get('trackViewUrl', ''),
                        "duration": "",
                        "cover_art": item.get('artworkUrl100', '').replace('100x100', '600x600'),
                    })

    except Exception as e:
        print(f"iTunes search failed: {e}", file=sys.stderr)

    # Try YouTube Music search
    yt_results = []
    try:
        yt_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        yt_url = f"https://www.youtube.com/results?search_query={requests.utils.quote(query)}+song"
        yt_resp = requests.get(yt_url, headers=yt_headers, timeout=5)

        if yt_resp.status_code == 200:
            yt_pattern = r'\"videoId\":\"([a-zA-Z0-9_-]+)\"'
            yt_matches = re.findall(yt_pattern, yt_resp.text)
            seen_videos = set()
            for video_id in yt_matches[:yt_limit]:
                if video_id not in seen_videos:
                    seen_videos.add(video_id)
                    yt_results.append({
                        "track_name": query.title(),
                        "artist_name": "YouTube Music",
                        "album_name": "",
                        "source": "YouTube Music",
                        "spotify_url": f"https://music.youtube.com/watch?v={video_id}",
                        "duration": "",
                        "cover_art": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                    })

    except Exception as e:
        print(f"YouTube search failed: {e}", file=sys.stderr)

    # Interleave results from both sources
    itunes_idx = 0
    yt_idx = 0
    while len(results) < limit and (itunes_idx < len(itunes_results) or yt_idx < len(yt_results)):
        if itunes_idx < len(itunes_results):
            results.append(itunes_results[itunes_idx])
            itunes_idx += 1
        if yt_idx < len(yt_results) and len(results) < limit:
            results.append(yt_results[yt_idx])
            yt_idx += 1

    if results:
        # Save to cache
        save_cached_results(query, results)

    return results


def get_track_info(track_id: str) -> dict | None:
    """Get track information from Spotify embed page."""
    try:
        embed_url = f"https://open.spotify.com/embed/track/{track_id}"
        resp = requests.get(embed_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://open.spotify.com/",
        }, timeout=5)

        if resp.status_code != 200:
            return None

        text = resp.text

        # Extract data from __NEXT_DATA__ script tag
        next_data_match = re.search(r'<script id="__NEXT_DATA__" type="application/json">([^<]+)</script>', text)
        if not next_data_match:
            return None

        data = json.loads(next_data_match.group(1))

        # Navigate through the JSON structure
        props = data.get("props", {})
        page_props = props.get("pageProps", {})
        state = page_props.get("state", {})
        data_obj = state.get("data", {})

        # Get entity data
        entity = data_obj.get("entity", {})

        # Extract track name
        track_name = entity.get("name", "Unknown")

        # Extract artists
        artists_data = entity.get("artists", [])
        if not artists_data:
            artists_data = data_obj.get("artists", [])
        artist_names = [a.get("name", "Unknown") for a in artists_data]
        artist_name = ", ".join(artist_names) if artist_names else "Unknown"

        # Extract album name
        album_data = entity.get("album", {})
        if not album_data:
            album_data = data_obj.get("albumOfTrack", {})
        album_name = album_data.get("name", "Unknown") if album_data else "Unknown"

        # Extract cover art from album images
        cover_art = None
        if album_data:
            images = album_data.get("images", [])
            if images:
                # Get largest image
                sorted_images = sorted(images, key=lambda x: x.get("width", 0), reverse=True)
                cover_art = sorted_images[0].get("url") if sorted_images else None
        if not cover_art:
            # Try alternate path
            cover_data = data_obj.get("albumOfTrack", {})
            if cover_data:
                images = cover_data.get("images", [])
                if images:
                    sorted_images = sorted(images, key=lambda x: x.get("width", 0), reverse=True)
                    cover_art = sorted_images[0].get("url") if sorted_images else None
        if not cover_art:
            # Try new visualIdentity path
            visual = entity.get("visualIdentity", {})
            images = visual.get("image", [])
            if images:
                # Get largest image
                sorted_images = sorted(images, key=lambda x: x.get("maxWidth", 0), reverse=True)
                cover_art = sorted_images[0].get("url") if sorted_images else None

        # Extract duration
        duration_ms = entity.get("duration", 0) or entity.get("durationMs", 0)
        if duration_ms:
            minutes = duration_ms // 60000
            seconds = (duration_ms % 60000) // 1000
            duration = f"{minutes}:{seconds:02d}"
        else:
            duration = "0:00"

        return {
            "track_name": track_name,
            "artist_name": artist_name,
            "album_name": album_name,
            "spotify_url": f"https://open.spotify.com/track/{track_id}",
            "duration": duration,
            "cover_art": cover_art,
        }

    except Exception as e:
        print(f"Error getting track info: {e}", file=sys.stderr)
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python spotify_search.py <track_name> [limit]")
        print(f"Search engine: {SEARCH_ENGINE}")
        sys.exit(1)

    query = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    print(f"Searching for: {query} (limit: {limit})")
    results = search_spotify(query, limit)

    if not results:
        print("No results found.")
        sys.exit(1)

    print(f"\nSearch results for '{query}':\n")
    for i, track in enumerate(results, 1):
        print(f"{i}. {track['track_name']}")
        print(f"   Artist: {track['artist_name']}")
        print(f"   Album: {track['album_name']}")
        print(f"   Duration: {track['duration']}")
        print(f"   URL: {track['spotify_url']}")
        print(f"   Cover: {track.get('cover_art', 'N/A')}")
        print()


if __name__ == "__main__":
    main()