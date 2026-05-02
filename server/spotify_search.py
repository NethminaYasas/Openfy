#!/usr/bin/env python3
"""
Spotify track search using web search to find Spotify URLs.
Can be used as a module or CLI script.
"""

import sys
import re
import json
import time
import random
import requests


# Choose search engine: "brave" (more results) or "duckduckgo" (more reliable)
SEARCH_ENGINE = "brave"


def search_spotify(query: str, limit: int = 10) -> list[dict]:
    """Search for tracks on Spotify using web search."""
    results = []

    if SEARCH_ENGINE == "brave":
        search_url = f"https://search.brave.com/search?q={query}+site%3Aopen.spotify.com%2Ftrack"
    else:
        search_url = f"https://duckduckgo.com/html/?q={query}+site%3Aopen.spotify.com%2Ftrack&s=25"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        response = requests.get(search_url, headers=headers, timeout=15)
        response.raise_for_status()

        pattern = r'open\.spotify\.com/track/([a-zA-Z0-9]+)'
        matches = re.findall(pattern, response.text)

        # Remove duplicates
        seen = set()
        track_ids = []
        for match in matches:
            if match not in seen:
                seen.add(match)
                track_ids.append(match)

        # Fetch track details for each ID
        for track_id in track_ids[:limit]:
            # Add small delay to avoid rate limits
            time.sleep(0.3 + random.random() * 0.5)

            info = get_track_info(track_id)
            if info:
                results.append(info)
            else:
                results.append({
                    "track_name": query,
                    "artist_name": "Unknown",
                    "album_name": "Unknown",
                    "spotify_url": f"https://open.spotify.com/track/{track_id}",
                    "duration": "0:00",
                    "cover_art": None,
                })

    except Exception as e:
        print(f"Search error: {e}", file=sys.stderr)

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