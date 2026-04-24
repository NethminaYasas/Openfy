"""
Apple Music downloader module for SpotiFLAC.
Uses the free iTunes lookup API to get track metadata, then downloads from YouTube Music.
Uses ytmusicapi for proper YouTube Music search (official audio tracks only, no music videos).
No Spotify API credentials required.
"""
import json
import os
import re
import requests
import string
import time
from typing import Callable
from urllib.parse import quote

# Import configuration
try:
    from .config import SCORE_THRESHOLDS, SEARCH_STRATEGIES, FALLBACK_METHODS, SAFETY_CHECKS, LOGGING, ERROR_MESSAGES
except ImportError:
    # Fallback configuration if config.py is not available
    SCORE_THRESHOLDS = {"minimum_confident_match": 10, "high_confidence_match": 30, "perfect_match": 50}
    SEARCH_STRATEGIES = ["full_query", "track_only", "reversed", "primary_artist"]
    FALLBACK_METHODS = ["yt_dlp_search", "html_scrape", "songlink_api"]
    SAFETY_CHECKS = {"verify_youtube_metadata": True, "check_filename_match": True, "minimum_score_threshold": True}
    LOGGING = {"debug_enabled": True, "log_search_scores": True, "log_verification_results": True}
    ERROR_MESSAGES = {"invalid_url": "Invalid Spotify URL", "metadata_failed": "Could not extract metadata"}

from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TALB, TPE2, TDRC, TRCK, TPOS, APIC, WXXX, COMM


def sanitize_filename(value: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "", value).strip()


def safe_int(value) -> int:
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0


class AppleMusicDownloader:
    """
    Downloads tracks using YouTube Music's API (official audio tracks only).
    Supports both Apple Music and Spotify URLs.
    """
    
    def _extract_spotify_metadata(self, spotify_url: str) -> dict | None:
        """Extract track metadata from a Spotify URL by parsing embed page JSON (no auth needed)."""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                import urllib.parse
                import re
                print(f"[DEBUG] Extracting metadata from Spotify URL: {spotify_url} (attempt {attempt + 1})")

                # Extract track ID
                parsed = urllib.parse.urlparse(spotify_url)
                path_parts = [p for p in parsed.path.split("/") if p]
                if len(path_parts) < 2 or path_parts[0] != "track":
                    print(f"[DEBUG] Invalid track URL format")
                    return None
                track_id = path_parts[1]
                print(f"[DEBUG] Track ID: {track_id}")

                # Get oEmbed for title and cover (simpler than embed page)
                oembed_url = f"https://open.spotify.com/oembed?format=json&url={urllib.parse.quote(spotify_url)}"
                print(f"[DEBUG] Fetching oEmbed from: {oembed_url}")
                resp = self.session.get(oembed_url, timeout=30)
                resp.raise_for_status()  # Check for HTTP errors
                data = resp.json()
                title = data.get("title", "Unknown").strip()
                cover_url = data.get("thumbnail_url", "")
                print(f"[DEBUG] oEmbed title: {title}")
                print(f"[DEBUG] oEmbed cover URL: {cover_url}")

                # Validate oEmbed response
                if not title or title == "Unknown":
                    raise Exception("Invalid oEmbed response")

                # Fetch embed page to get structured JSON data
                embed_url = f"https://open.spotify.com/embed/track/{track_id}"
                print(f"[DEBUG] Fetching embed page from: {embed_url}")
                embed_resp = self.session.get(embed_url, timeout=30)
                embed_resp.raise_for_status()
                embed_text = embed_resp.text

                # Parse __NEXT_DATA__ script for full metadata
                match = re.search(r'<script id="__NEXT_DATA__" type="application/json">([^<]+)</script>', embed_text)
                artist = ""
                album = ""
                duration_ms = 0
                entity = None
                if match:
                    import json
                    try:
                        next_data = json.loads(match.group(1))
                        # Navigate: props -> pageProps -> state -> data -> entity
                        entity = next_data.get("props", {}).get("pageProps", {}).get("state", {}).get("data", {}).get("entity", {})
                        if entity:
                            print(f"[DEBUG] Found entity data: {entity}")
                            # Extract artists array
                            artists_list = entity.get("artists", [])
                            if artists_list:
                                all_artist_names = [a.get("name", "") for a in artists_list if a.get("name")]
                                if all_artist_names:
                                    artist = ", ".join(all_artist_names)
                                    artist = re.sub(r'\s+', ' ', artist).strip(", ")
                                    print(f"[DEBUG] Extracted artists: {artist}")
                            # Extract album if available
                            album_obj = entity.get("album", {})
                            if album_obj:
                                album = album_obj.get("name", "")
                                print(f"[DEBUG] Extracted album: {album}")
                            # Extract duration
                            duration_ms = entity.get("duration", 0)
                            print(f"[DEBUG] Extracted duration: {duration_ms}ms")
                    except json.JSONDecodeError as e:
                        print(f"[DEBUG] JSON decode error: {e}")
                        continue  # Retry on JSON decode error

                # Fallback: if no artists from embed, try Songlink (may rate limit)
                if not artist and attempt < max_retries - 1:
                    print(f"[DEBUG] No artists from embed, trying Songlink fallback")
                    try:
                        songlink_url = f"https://api.song.link/v1-alpha.1/links?url={urllib.parse.quote(spotify_url)}&userCountry=US"
                        songlink_resp = self.session.get(songlink_url, timeout=10)
                        songlink_resp.raise_for_status()
                        songlink_data = songlink_resp.json()
                        entities = songlink_data.get("entitiesByUniqueId", {})
                        for uid, ent in entities.items():
                            if ent.get("apiProvider") == "spotify":
                                artists = ent.get("artistsByRole", {})
                                if artists:
                                    all_names = []
                                    for role, alist in artists.items():
                                        if alist:
                                            all_names.extend([a.get("name", "") for a in alist if a.get("name")])
                                    if all_names:
                                        artist = ", ".join(all_names)
                                        artist = re.sub(r'\s+', ' ', artist).strip(", ")
                                        print(f"[DEBUG] Got artists from Songlink: {artist}")
                                album_links = ent.get("album", {})
                                if album_links and not album:
                                    album = album_links.get("name", "")
                                    print(f"[DEBUG] Got album from Songlink: {album}")
                                break
                    except Exception as e:
                        print(f"[DEBUG] Songlink fallback failed: {e}")

                # Final fallback: parse from title "Artist - Song"
                if not artist and " - " in title:
                    parts = title.split(" - ")
                    if len(parts) >= 2:
                        artist = " - ".join(parts[:-1])
                        print(f"[DEBUG] Got artist from title fallback: {artist}")

                # Validate we have both title and artist
                if not title or title == "Unknown":
                    raise Exception("Invalid track title")
                if not artist or artist == "Unknown Artist":
                    raise Exception("Invalid artist name")

                result = {
                    "name": title,
                    "artist": artist,
                    "album": album,
                    "album_artist": artist,
                    "track_number": entity.get("track_number", 1) if isinstance(entity, dict) else 1,
                    "total_tracks": entity.get("total_tracks", 1) if isinstance(entity, dict) else 1,
                    "disc_number": 1,
                    "release_date": "",
                    "duration_ms": duration_ms,
                    "cover_url": cover_url,
                    "genre": "",
                    "explicit": False,
                }
                print(f"[DEBUG] Final metadata: {result}")
                return result
            except Exception as e:
                print(f"[!] Spotify metadata extraction error (attempt {attempt + 1}): {e}")
                if attempt == max_retries - 1:
                    import traceback
                    traceback.print_exc()
                # Wait before retrying
                time.sleep(2 ** attempt)  # Exponential backoff

        return None
    
    @staticmethod
    def parse_url_type(url: str) -> str:
        """Determine if URL is from Apple Music or Spotify."""
        if "music.apple.com" in url:
            return "apple"
        elif "open.spotify.com" in url or "play.spotify.com" in url:
            return "spotify"
        return "unknown"

    def __init__(self, timeout: float = 300.0):
        self.session = requests.Session()
        self.session.timeout = timeout
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
        })
        self.progress_callback: Callable[[int, int], None] = None

    def set_progress_callback(self, callback: Callable[[int, int], None]) -> None:
        self.progress_callback = callback

    def parse_apple_music_url(self, url: str) -> dict | None:
        """Extract track/album info from an Apple Music URL."""
        import re
        from urllib.parse import urlparse, parse_qs

        parsed = urlparse(url)
        path_parts = parsed.path.strip("/").split("/")

        # Format: /us/song/{name}/{id} or /us/album/{name}/{album_id}?i={track_id}
        result = {"url": url}

        if "/song/" in parsed.path:
            # Song URL: /countrycode/song/name/123456
            match = re.search(r'/song/[^/]+/(\d+)', parsed.path)
            if match:
                result["track_id"] = match.group(1)
                result["type"] = "track"

        elif "/album/" in parsed.path:
            # Album URL: /countrycode/album/name/123456?i=67890 (optional track)
            match = re.search(r'/album/[^/]+/(\d+)', parsed.path)
            if match:
                result["album_id"] = match.group(1)
                qs = parse_qs(parsed.query)
                if "i" in qs:
                    result["track_id"] = qs["i"][0]
                    result["type"] = "track"
                else:
                    result["type"] = "album"

        return result if result.get("track_id") or result.get("album_id") else None

    def get_track_info(self, track_id: str) -> dict | None:
        """Get track metadata from the free iTunes lookup API."""
        try:
            url = f"https://itunes.apple.com/lookup?id={track_id}&country=us"
            resp = self.session.get(url, timeout=15)
            data = resp.json()

            results = data.get("results", [])
            if not results:
                # Try with different country codes
                for cc in ["us", "gb", "au", "ca"]:
                    url = f"https://itunes.apple.com/lookup?id={track_id}&country={cc}"
                    resp = self.session.get(url, timeout=15)
                    data = resp.json()
                    results = data.get("results", [])
                    if results:
                        break

            if results:
                track = results[0]
                return {
                    "name": track.get("trackName", "Unknown"),
                    "artist": track.get("artistName", "Unknown Artist"),
                    "album": track.get("collectionName", "Unknown Album"),
                    "album_artist": track.get("artistName", "Unknown Artist"),
                    "track_number": track.get("trackNumber", 1),
                    "total_tracks": track.get("trackCount", 1),
                    "disc_number": track.get("discNumber", 1),
                    "isrc": track.get("trackViewUrl", ""),
                    "release_date": track.get("releaseDate", "")[:10],
                    "duration_ms": track.get("trackTimeMillis", 0),
                    "cover_url": track.get("artworkUrl100", "").replace("100x100", "600x600"),
                    "genre": track.get("primaryGenreName", "Unknown"),
                    "explicit": track.get("contentAdvisoryRating", "Clean"),
                }
        except Exception as e:
            print(f"[!] iTunes API error: {e}")
        return None

    def get_album_tracks(self, album_id: str) -> list[dict] | None:
        """Get all tracks in an album from the iTunes API."""
        try:
            url = f"https://itunes.apple.com/lookup?id={album_id}&country=us&entity=song"
            resp = self.session.get(url, timeout=15)
            data = resp.json()

            results = data.get("results", [])
            tracks = []
            for r in results:
                if r.get("wrapperType") == "track":
                    tracks.append(self.get_track_info(r.get("trackId")))
            return [t for t in tracks if t]
        except Exception as e:
            print(f"[!] Album lookup error: {e}")
        return None

    def _get_youtube_url(self, track_name: str, artist_name: str) -> str:
        """Find YouTube Music URL for a track using ytmusicapi.
        Searches YouTube Music for official audio tracks only (no music videos).
        """
        print(f"[DEBUG] === SEARCH START ===")
        print(f"[DEBUG] Searching YouTube Music for: '{track_name}' by '{artist_name}'")

        # Try multiple search strategies
        search_strategies = [
            f"ytmusic10:{track_name} {artist_name}",  # Full query
            f"ytmusic10:{track_name}",  # Track only
            f"ytmusic10:{artist_name} {track_name}",  # Reversed
        ]

        try:
            from ytmusicapi import YTMusic
            yt = YTMusic()

            for strategy_idx, search_query in enumerate(search_strategies):
                print(f"[DEBUG] Search strategy {strategy_idx + 1}: {search_query}")

                # Try songs filter first
                results = yt.search(search_query, filter="songs", limit=10)
                if not results:
                    # Try without filter
                    results = yt.search(search_query, limit=10)

                if not results:
                    print(f"[DEBUG] No results for strategy {strategy_idx + 1}")
                    continue

                print(f"[DEBUG] Found {len(results)} results")

                # Pick the best match
                best_match = None
                best_score = 0

                for i, result in enumerate(results):
                    result_title = result.get('title', '').lower()
                    result_artists = ", ".join(
                        a.get("name", "") for a in result.get("artists", [])
                    ).lower()

                    # Calculate match score
                    score = 0
                    # Title match (weighted higher)
                    if track_name.lower() in result_title:
                        score += 20
                    if result_title in track_name.lower():
                        score += 15

                    # Artist match
                    if artist_name.lower() in result_artists:
                        score += 10
                    if result_artists in artist_name.lower():
                        score += 5

                    # Individual artist words
                    for artist_word in artist_name.lower().split(','):
                        artist_word = artist_word.strip()
                        if artist_word in result_artists:
                            score += 3

                    print(f"[DEBUG] Result {i+1}: {result.get('title')} - {result.get('artists', [{}])[0].get('name', 'Unknown')} (score: {score})")

                    if score > best_score:
                        best_score = score
                        best_match = result

                if best_match and best_score >= SCORE_THRESHOLDS["minimum_confident_match"]:
                    if LOGGING["log_search_scores"]:
                        print(f"✓ Best match (score {best_score}): {best_match.get('title')} - {best_match.get('artists', [{}])[0].get('name', 'Unknown')}")
                    if best_score >= SCORE_THRESHOLDS["high_confidence_match"]:
                        print(f"🎯 High confidence match found!")
                    video_id = best_match.get("videoId")
                    if video_id:
                        return f"https://music.youtube.com/watch?v={video_id}"
                elif best_match and SAFETY_CHECKS["allow_low_confidence_fallback"]:
                    print(f"⚠ Low confidence match ({best_score}): {best_match.get('title')} - {best_match.get('artists', [{}])[0].get('name', 'Unknown')}")
                    if LOGGING["log_search_scores"]:
                        print(f"WARNING: This might be the wrong song. Score: {best_score}/{SCORE_THRESHOLDS['perfect_match']}")
                    video_id = best_match.get("videoId")
                    if video_id:
                        return f"https://music.youtube.com/watch?v={video_id}"
                else:
                    print(f"❌ No suitable match found (best score: {best_score if best_match else 0})")
                    if best_match:
                        print(f"Best available: {best_match.get('title')} by {best_match.get('artists', [{}])[0].get('name', 'Unknown')}")

            print(f"[DEBUG] No suitable match found in any strategy")

        except ImportError:
            print("[!] ytmusicapi not available, falling back to search")
        except Exception as e:
            print(f"[!] YouTube Music search error: {e}")
            import traceback
            traceback.print_exc()

        # Fallback: Regular search
        print(f"[DEBUG] All strategies failed, using fallback search")
        print(f"[DEBUG] === SEARCH END (FALLBACK) ===")
        return self._search_youtube_fallback(track_name, artist_name)

    def _search_youtube_fallback(self, track_name: str, artist_name: str) -> str:
        """Fallback YouTube search if ytmusicapi fails. Uses yt-dlp to get results with proper scoring."""
        try:
            import yt_dlp
        except ImportError:
            yt_dlp = None

        if yt_dlp:
            try:
                # Search with yt-dlp using ytmsearch10: prefix
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'extract_flat': True,
                    'default_search': f'ytmsearch10:{track_name} {artist_name}',
                    'max_downloads': 10,
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    result = ydl.extract_info(f'ytsearch:{track_name} {artist_name}', download=False)
                    if 'entries' in result and result['entries']:
                        candidates = []
                        for entry in result['entries'][:10]:
                            if entry:
                                result_title = entry.get('title', '')
                                result_artist = ', '.join([a.get('name', '') for a in entry.get('artists', []) if a.get('name')])
                                video_id = entry.get('id')
                                if video_id:
                                    score = self._score_candidate(result_title, result_artist, track_name, artist_name)
                                    candidates.append({
                                        'title': result_title,
                                        'artists': result_artist,
                                        'video_id': video_id,
                                        'score': score
                                    })
                                    print(f"  Candidate: {result_title} - {result_artist} (score: {score})")

                        if candidates:
                            # Sort by score descending
                            candidates.sort(key=lambda x: x['score'], reverse=True)
                            best = candidates[0]
                            print(f"✓ Selected: {best['title']} - {best['artists']} (score: {best['score']})")
                            if best['score'] < 10:
                                print(f"⚠ Low confidence match, possible wrong song")
                            return f"https://music.youtube.com/watch?v={best['video_id']}"
            except Exception as e:
                print(f"[!] yt-dlp fallback error: {e}")

        # If yt-dlp fails or not available, fallback to basic HTML scrape (legacy)
        print("[!] yt-dlp not available or failed, using legacy HTML scrape fallback")
        try:
            search_query = quote(f"{track_name} {artist_name} audio")
            search_url = f"https://music.youtube.com/search?q={search_query}"
            resp = self.session.get(search_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
            }, timeout=15)

            # Try to find videoId and parse some context
            import json
            # Find initial data in HTML
            match = re.search(r'ytInitialData\s*=\s*({.*?});', resp.text, re.DOTALL)
            if match:
                try:
                    data = json.loads(match.group(1))
                    # Navigate to video results - this is complex and may change
                    contents = data.get('contents', {}).get('twoColumnSearchResultsRenderer', {}).get('primaryContents', {}).get('sectionListRenderer', {}).get('contents', [])
                    videos = []
                    for section in contents:
                        video_items = section.get('itemSectionRenderer', {}).get('contents', [])
                        for item in video_items:
                            video = item.get('videoRenderer', {})
                            if video:
                                vid = video.get('videoId', '')
                                title = video.get('title', {}).get('runs', [{}])[0].get('text', '')
                                # Get artist(s)
                                artists = []
                                for run in video.get('longBylineText', {}).get('runs', []):
                                    artists.append(run.get('text', ''))
                                artist_text = ', '.join(artists)
                                if vid:
                                    videos.append({'videoId': vid, 'title': title, 'artists': artist_text})
                    
                    if videos:
                        # Score candidates
                        candidates = []
                        for v in videos:
                            score = self._score_candidate(v['title'], v['artists'], track_name, artist_name)
                            candidates.append({
                                'title': v['title'],
                                'artists': v['artists'],
                                'video_id': v['videoId'],
                                'score': score
                            })
                            print(f"  HTML Candidate: {v['title']} - {v['artists']} (score: {score})")
                        
                        candidates.sort(key=lambda x: x['score'], reverse=True)
                        best = candidates[0]
                        print(f"✓ Selected: {best['title']} - {best['artists']} (score: {best['score']})")
                        if best['score'] < 10:
                            print(f"⚠ Low confidence match, possible wrong song")
                        return f"https://music.youtube.com/watch?v={best['video_id']}"
                except Exception as json_err:
                    print(f"[!] JSON parse error: {json_err}")
                    pass

            # If JSON parsing fails, fallback to simple first-match
            match = re.search(r'"videoId":"([a-zA-Z0-9_-]{11})"', resp.text)
            if match:
                video_id = match.group(1)
                print(f"✓ Found via YouTube Music search (legacy): {video_id}")
                return f"https://music.youtube.com/watch?v={video_id}"
        except Exception as e:
            print(f"[!] HTML fallback error: {e}")

        raise Exception(f"Could not find YouTube URL for: {track_name} - {artist_name}")

    def _score_candidate(self, result_title: str, result_artists: str, track_name: str, artist_name: str) -> int:
        """Score a candidate video based on title and artist matching."""
        score = 0
        title_lower = result_title.lower()
        artist_lower = result_artists.lower()
        track_lower = track_name.lower()
        artist_target_lower = artist_name.lower()

        # Exact matches (case insensitive) - improved to handle punctuation/format variations
        # Check if core track name matches ignoring common separators
        import re
        # Normalize by replacing common separators with spaces and collapsing whitespace
        def normalize_for_match(text):
            # Replace common punctuation/separators with space
            text = re.sub(r'[\-_\(\)\[\]\{\}:;.,!?]', ' ', text)
            # Collapse multiple spaces
            text = re.sub(r'\s+', ' ', text)
            return text.strip()

        norm_title = normalize_for_match(title_lower)
        norm_track = normalize_for_match(track_lower)

        if norm_track in norm_title or norm_title in norm_track:
            score += 10
        elif track_lower in title_lower or title_lower in track_lower:  # fallback to original
            score += 10

        if artist_target_lower in artist_lower or artist_lower in artist_target_lower:
            score += 10

        # Word overlap - clean punctuation for better matching
        translator = str.maketrans('', '', string.punctuation)

        # Clean track name and title for word extraction
        clean_track = track_lower.translate(translator)
        clean_title = title_lower.translate(translator)

        track_words = set(re.findall(r'\b\w+\b', clean_track))
        title_words = set(re.findall(r'\b\w+\b', clean_title))
        common_words = track_words & title_words
        score += len(common_words)

        # Bonus: if we have a strong word overlap but missed exact match,
        # try to see if track name is contained when ignoring extra descriptive text
        # This helps with cases like "Dopamine (Bonus Track)" vs "Dopamine - Bonus Track"
        if len(common_words) >= 2 and score < 15:  # Only apply if we have decent word match but low score
            # Check if all significant track words are in the title
            significant_track_words = {w for w in track_words if len(w) > 2}  # Ignore very short words
            significant_title_words = {w for w in title_words if len(w) > 2}
            if significant_track_words.issubset(significant_title_words):
                score += 5  # Bonus for containing all significant track words

        return score

    def _verify_youtube_video(self, video_id: str, expected_track: str, expected_artist: str) -> bool:
        """Verify the YouTube video matches the expected track and artist."""
        video_title = ""
        video_artists = ""
        try:
            print(f"[DEBUG] === VERIFICATION START ===")
            print(f"[DEBUG] Video ID: {video_id}")
            print(f"[DEBUG] Expected track: '{expected_track}'")
            print(f"[DEBUG] Expected artist: '{expected_artist}'")

            # Get video metadata using yt-dlp if available
            try:
                import yt_dlp
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'extract_flat': 'discard_in_playlist',
                    'playlist_items': '1',
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f"https://youtube.com/watch?v={video_id}", download=False)

                    if info:
                        video_title = info.get('title', '')
                        # Handle both formats: list of dict and list of string
                        artists_info = info.get('artists', [])
                        if artists_info and isinstance(artists_info[0], dict):
                            video_artists = ', '.join([a.get('name', '') for a in artists_info])
                        else:
                            video_artists = ', '.join(artists_info) if artists_info else ''
                        print(f"[DEBUG] yt-dlp found video:")
                        print(f"[DEBUG]   Title: '{video_title}'")
                        print(f"[DEBUG]   Artists: '{video_artists}'")

                        # Score the match
                        score = self._score_candidate(video_title, video_artists, expected_track, expected_artist)
                        print(f"[DEBUG] Verification score: {score}")

                        if score >= 20:
                            print(f"[DEBUG] ✓ Verification PASSED (score >= 20)")
                            return True
                        else:
                            print(f"[DEBUG] ✗ Verification FAILED (score < 20)")

            except ImportError:
                print("[!] yt-dlp not available for verification")
            except Exception as e:
                print(f"[!] yt-dlp verification error: {e}")
                import traceback
                traceback.print_exc()

            # Fallback: Check if the video title contains the track name
            # This is less reliable but better than nothing
            print(f"[DEBUG] Trying fallback verification...")
            if video_title:
                expected_track_lower = expected_track.lower()
                video_title_lower = video_title.lower()
                print(f"[DEBUG] Checking if '{expected_track_lower}' is in '{video_title_lower}'")

                if expected_track_lower in video_title_lower:
                    print(f"[DEBUG] ✓ Fallback verification PASSED")
                    return True
            else:
                print(f"[DEBUG] No video title available for fallback check")

            print(f"[DEBUG] === VERIFICATION FAILED ===")
            return False

        except Exception as e:
            print(f"[!] Unexpected verification error: {e}")
            import traceback
            traceback.print_exc()
            print(f"[DEBUG] === VERIFICATION FAILED (ERROR) ===")
            return False

    def _request_spotube_dl(self, video_id: str) -> str | None:
        """Get download URL from SpotubeDL."""
        for engine in ["v1", "v3", "v2"]:
            api_url = f"https://spotubedl.com/api/download/{video_id}?engine={engine}&format=mp3&quality=320"
            try:
                print(f"[DEBUG] Fetching from SpotubeDL (Engine: {engine})...")
                print(f"[DEBUG] API URL: {api_url}")
                resp = self.session.get(api_url, timeout=15)
                print(f"[DEBUG] SpotubeDL response status: {resp.status_code}")
                if resp.status_code == 200:
                    data = resp.json()
                    download_url = data.get("url")
                    print(f"[DEBUG] SpotubeDL download URL: {download_url}")
                    if download_url:
                        if download_url.startswith("/"):
                            download_url = "https://spotubedl.com" + download_url
                        return download_url
                else:
                    print(f"[DEBUG] SpotubeDL response: {resp.text}")
            except Exception as e:
                print(f"[DEBUG] SpotubeDL error for engine {engine}: {e}")
                continue
        return None

    def _request_cobalt(self, video_id: str) -> str | None:
        """Get download URL from Cobalt API."""
        api_url = "https://api.qwkuns.me"
        payload = {
            "url": f"https://music.youtube.com/watch?v={video_id}",
            "audioFormat": "mp3",
            "audioBitrate": "320",
            "downloadMode": "audio",
            "filenameStyle": "basic",
            "disableMetadata": True
        }
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        try:
            print("[DEBUG] Trying Cobalt API (Fallback)...")
            print(f"[DEBUG] Cobalt API URL: {api_url}")
            print(f"[DEBUG] Cobalt payload: {payload}")
            resp = self.session.post(api_url, json=payload, headers=headers, timeout=15)
            print(f"[DEBUG] Cobalt response status: {resp.status_code}")
            if resp.status_code == 200:
                data = resp.json()
                print(f"[DEBUG] Cobalt response: {data}")
                if data.get("status") in ["tunnel", "redirect"] and data.get("url"):
                    print(f"[DEBUG] Cobalt download URL: {data['url']}")
                    return data["url"]
            else:
                print(f"[DEBUG] Cobalt error response: {resp.text}")
        except Exception as e:
            print(f"[DEBUG] Cobalt API error: {e}")
        return None

    def _download_with_ytdlp(self, video_id: str, output_path: str) -> bool:
        """Download using yt-dlp directly as fallback."""
        try:
            import yt_dlp
            yt_url = f"https://music.youtube.com/watch?v={video_id}"

            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'format': 'bestaudio/best',
                'outtmpl': output_path,
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '320',
                }],
                'keepvideo': False,
            }

            print(f"[DEBUG] Downloading via yt-dlp: {yt_url}")
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([yt_url])

            return True
        except Exception as e:
            print(f"[DEBUG] yt-dlp download error: {e}")
            import traceback
            traceback.print_exc()
            return False

    def _extract_video_id(self, url: str) -> str | None:
        match = re.search(r'(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})', url)
        return match.group(1) if match else None

    def download_by_apple_music_url(self, apple_music_url: str, output_dir: str, **kwargs) -> str:
        """Download a track from Apple Music URL.
        Returns the path to the downloaded file.
        """
        os.makedirs(output_dir, exist_ok=True)

        # Parse URL and get track info
        url_info = self.parse_apple_music_url(apple_music_url)
        if not url_info or not url_info.get("track_id"):
            raise Exception(f"Could not parse Apple Music URL: {apple_music_url}")

        track_info = self.get_track_info(url_info["track_id"])
        if not track_info:
            raise Exception(f"Could not get metadata for Apple Music track {url_info['track_id']}")

        print(f"✓ Found: {track_info['name']} - {track_info['artist']}")

        # Get YouTube URL
        yt_url = self._get_youtube_url(track_info["name"], track_info["artist"])
        video_id = self._extract_video_id(yt_url)
        if not video_id:
            raise Exception("Could not extract YouTube video ID")

        # Prepare filename
        safe_title = sanitize_filename(track_info["name"])
        safe_artist = sanitize_filename(track_info["artist"].split(",")[0])
        expected_filename = f"{safe_artist} - {safe_title}.mp3"
        expected_path = os.path.join(output_dir, expected_filename)

        if os.path.exists(expected_path) and os.path.getsize(expected_path) > 0:
            print(f"File already exists: {expected_path}")
            return expected_path

        # Download
        download_url = self._request_spotube_dl(video_id)
        if not download_url:
            download_url = self._request_cobalt(video_id)

        # If external APIs failed, try yt-dlp as final fallback
        if not download_url:
            print("[DEBUG] External APIs failed, trying yt-dlp direct download...")
            ytdlp_output = expected_path.replace('.mp3', '.%(ext)s')
            if self._download_with_ytdlp(video_id, ytdlp_output):
                base_path = expected_path.replace('.mp3', '')
                for ext in ['.mp3', '.m4a', '.webm', '.flac']:
                    downloaded_file = base_path + ext
                    if os.path.exists(downloaded_file):
                        if not expected_path.endswith(ext):
                            os.rename(downloaded_file, expected_path)
                        print(f"Download completed via yt-dlp: {expected_path}")
                        download_url = "ytdlp_local"
                        break

        if not download_url:
            raise Exception("All YouTube download APIs failed")

        print("Downloading track from YouTube...")
        with self.session.get(download_url, stream=True) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length", 0))
            downloaded = 0
            with open(expected_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if self.progress_callback:
                            self.progress_callback(downloaded, total)
        print()

        # Embed metadata
        self._embed_metadata(
            expected_path,
            title=track_info["name"],
            artist=track_info["artist"],
            album=track_info["album"],
            album_artist=track_info["album_artist"],
            date=track_info["release_date"],
            track_num=track_info["track_number"],
            total_tracks=track_info["total_tracks"],
            disc_num=track_info["disc_number"],
            total_discs=1,
            cover_url=track_info["cover_url"],
        )

        return expected_path

    def download_from_spotify(self, spotify_url: str, output_dir: str, **kwargs) -> str:
        """Download a track from Spotify URL.
        Uses Spotify's oEmbed API (no auth) to get metadata, then downloads from YouTube Music.
        """
        os.makedirs(output_dir, exist_ok=True)

        # Validate URL format first
        if not spotify_url or "open.spotify.com/track/" not in spotify_url:
            raise Exception("Invalid Spotify track URL format")

        track_info = self._extract_spotify_metadata(spotify_url)
        if not track_info:
            raise Exception(f"Could not extract metadata from Spotify URL: {spotify_url}")

        # Validate extracted metadata
        track_name = track_info.get("name", "").strip()
        artist_name = track_info.get("artist", "").strip()

        if not track_name or track_name in ("Track", "Unknown", ""):
            raise Exception(f"Invalid track name extracted: {track_name}")

        if not artist_name or artist_name == "Unknown Artist":
            raise Exception(f"Invalid artist name extracted: {artist_name}")

        # Log the expected metadata for user verification
        print(f"✓ Expected: {track_name} by {artist_name}")

        # Try to download with verification
        try:
            return self.download_by_info(track_info, output_dir)
        except Exception as e:
            print(f"[!] Verification failed: {e}")
            # If verification fails, try without strict verification as last resort
            print(f"[!] Attempting download without strict verification")
            track_info["skip_verification"] = True
            return self.download_by_info(track_info, output_dir)

    def download_by_info(self, track_info: dict, output_dir: str, **kwargs) -> str:
        """Download using pre-extracted track info (for use by other services)."""
        print(f"[DEBUG] download_by_info called with: {track_info}")
        os.makedirs(output_dir, exist_ok=True)

        # Validate track info before proceeding
        if not track_info.get("name") or track_info.get("name") in ("Unknown", "Track"):
            raise Exception("Invalid track name extracted from URL")

        if not track_info.get("artist") or track_info.get("artist") == "Unknown Artist":
            raise Exception("Invalid artist name extracted from URL")

        original_track = track_info["name"]
        original_artist = track_info["artist"]

        # Get YouTube URL
        yt_url = self._get_youtube_url(original_track, original_artist)
        print(f"[DEBUG] Got YouTube URL: {yt_url}")
        video_id = self._extract_video_id(yt_url)
        if not video_id:
            raise Exception("Could not extract YouTube video ID")
        print(f"[DEBUG] Extracted video ID: {video_id}")

        # Before downloading, verify this is actually the correct song
        # by fetching the YouTube video metadata and comparing
        if not self._verify_youtube_video(video_id, original_track, original_artist):
            # Try fallback strategies if verification fails
            print(f"[DEBUG] Initial verification failed, trying alternative search strategies")
            fallback_success = False

            # Try searching with different artist combinations
            artist_variations = [
                original_artist.split(",")[0].strip(),  # Primary artist only
                ", ".join(original_artist.split(",")[::-1]),  # Reverse artist order
            ]

            for variation in artist_variations:
                print(f"[DEBUG] Trying artist variation: {variation}")
                yt_url_fallback = self._get_youtube_url(original_track, variation)
                video_id_fallback = self._extract_video_id(yt_url_fallback)
                if video_id_fallback and self._verify_youtube_video(video_id_fallback, original_track, variation):
                    print(f"[DEBUG] Fallback verification successful")
                    video_id = video_id_fallback
                    fallback_success = True
                    break

            if not fallback_success:
                raise Exception(f"Could not verify correct song after multiple attempts. Expected: {original_track} by {original_artist}")

        safe_title = sanitize_filename(track_info["name"])
        safe_artist = sanitize_filename(track_info["artist"].split(",")[0])
        expected_filename = f"{safe_artist} - {safe_title}.mp3"
        expected_path = os.path.join(output_dir, expected_filename)

        if os.path.exists(expected_path) and os.path.getsize(expected_path) > 0:
            return expected_path

        print("Downloading track from YouTube...")
        download_url = None

        # Try SpotubeDL first with retry for 403 errors
        download_url = None
        for attempt in range(2):  # Try original URL, then refresh and try again
            try:
                if attempt == 0:
                    download_url = self._request_spotube_dl(video_id)
                else:
                    # Refresh URL on retry
                    print("SpotubeDL failed, refreshing URL and retrying...")
                    download_url = self._request_spotube_dl(video_id)

                if download_url:
                    print(f"Attempting download from SpotubeDL (attempt {attempt + 1})...")
                    with self.session.get(download_url, stream=True) as r:
                        if r.status_code == 403:
                            raise Exception(f"HTTP 403 Forbidden: {r.reason}")
                        r.raise_for_status()
                        total = int(r.headers.get("Content-Length", 0))
                        downloaded = 0
                        with open(expected_path, "wb") as f:
                            for chunk in r.iter_content(chunk_size=8192):
                                if chunk:
                                    f.write(chunk)
                                    downloaded += len(chunk)
                                    if self.progress_callback:
                                        self.progress_callback(downloaded, total)
                    print("Download completed successfully via SpotubeDL")
                    break  # Success, exit retry loop
                else:
                    if attempt == 0:
                        print("SpotubeDL did not return a download URL")
                    break  # No URL to retry

            except Exception as e:
                print(f"SpotubeDL download attempt {attempt + 1} failed: {e}")
                download_url = None  # Reset for next attempt or to try Cobalt
                if attempt == 0:  # First attempt failed, prepare for retry
                    continue
                else:  # Second attempt also failed
                    break

        # If SpotubeDL failed or didn't return a URL, try Cobalt with retry for 403 errors
        if not download_url:
            for attempt in range(2):  # Try original URL, then refresh and try again
                try:
                    if attempt == 0:
                        download_url = self._request_cobalt(video_id)
                    else:
                        # Refresh URL on retry
                        print("Cobalt failed, refreshing URL and retrying...")
                        download_url = self._request_cobalt(video_id)

                    if download_url:
                        print(f"Attempting download from Cobalt (attempt {attempt + 1})...")
                        with self.session.get(download_url, stream=True) as r:
                            if r.status_code == 403:
                                raise Exception(f"HTTP 403 Forbidden: {r.reason}")
                            r.raise_for_status()
                            total = int(r.headers.get("Content-Length", 0))
                            downloaded = 0
                            with open(expected_path, "wb") as f:
                                for chunk in r.iter_content(chunk_size=8192):
                                    if chunk:
                                        f.write(chunk)
                                        downloaded += len(chunk)
                                        if self.progress_callback:
                                            self.progress_callback(downloaded, total)
                        print("Download completed successfully via Cobalt")
                        break  # Success, exit retry loop
                    else:
                        if attempt == 0:
                            print("Cobalt did not return a download URL")
                        break  # No URL to retry

                except Exception as e:
                    print(f"Cobalt download attempt {attempt + 1} failed: {e}")
                    download_url = None  # Reset for next attempt
                    if attempt == 0:  # First attempt failed, prepare for retry
                        continue
                    else:  # Second attempt also failed
                        break

        # If all external APIs failed, try yt-dlp as final fallback
        if not download_url:
            print("[DEBUG] External APIs failed, trying yt-dlp direct download...")
            # Remove .mp3 extension for yt-dlp output template
            ytdlp_output = expected_path.replace('.mp3', '.%(ext)s')
            if self._download_with_ytdlp(video_id, ytdlp_output):
                # yt-dlp adds extension, check if file exists
                base_path = expected_path.replace('.mp3', '')
                for ext in ['.mp3', '.m4a', '.webm', '.flac']:
                    downloaded_file = base_path + ext
                    if os.path.exists(downloaded_file):
                        # Rename to .mp3 if needed
                        if not expected_path.endswith(ext):
                            os.rename(downloaded_file, expected_path)
                        print(f"Download completed via yt-dlp: {expected_path}")
                        download_url = "ytdlp_local"  # Mark as successful
                        break

        if not download_url:
            raise Exception("All YouTube download APIs failed")

        # Final safety check: verify the downloaded filename contains the track name
        if not track_info.get("skip_verification"):
            expected_title = track_info["name"].lower()
            safe_filename = sanitize_filename(expected_title)
            if safe_filename not in expected_filename.lower():
                print(f"[WARNING] Downloaded filename may be incorrect: {expected_filename}")
                print(f"[WARNING] Expected to contain: {safe_filename}")

        self._embed_metadata(
            expected_path,
            title=track_info["name"],
            artist=track_info["artist"],
            album=track_info.get("album", ""),
            album_artist=track_info.get("album_artist", ""),
            date=track_info.get("release_date", ""),
            track_num=track_info.get("track_number", 1),
            total_tracks=track_info.get("total_tracks", 1),
            disc_num=track_info.get("disc_number", 1),
            total_discs=1,
            cover_url=track_info.get("cover_url", ""),
        )

        return expected_path

    def _embed_metadata(self, filepath: str, title: str, artist: str, album: str,
                       album_artist: str, date: str, track_num: int, total_tracks: int,
                       disc_num: int, total_discs: int, cover_url: str):
        """Embed metadata and cover art into MP3 file."""
        print("Embedding metadata and cover art...")
        try:
            try:
                audio = ID3(filepath)
                audio.delete()
            except ID3NoHeaderError:
                audio = ID3()

            if title:
                audio.add(TIT2(encoding=3, text=str(title)))
            if artist:
                audio.add(TPE1(encoding=3, text=str(artist)))
            if album:
                audio.add(TALB(encoding=3, text=str(album)))
            if album_artist:
                audio.add(TPE2(encoding=3, text=str(album_artist)))
            if date:
                audio.add(TDRC(encoding=3, text=str(date)))

            audio.add(TRCK(encoding=3, text=f"{safe_int(track_num)}/{safe_int(total_tracks)}"))
            audio.add(TPOS(encoding=3, text=f"{safe_int(disc_num)}/{safe_int(total_discs)}"))
            audio.add(WXXX(encoding=3, desc='', url='https://music.apple.com/'))

            audio.add(COMM(
                encoding=3,
                lang='eng',
                desc='',
                text=[u"https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version"]
            ))

            if cover_url:
                try:
                    resp = self.session.get(cover_url, timeout=10)
                    if resp.status_code == 200:
                        audio.add(APIC(
                            encoding=3,
                            mime='image/jpeg',
                            type=3,
                            desc='Cover',
                            data=resp.content
                        ))
                except Exception as e:
                    print(f"Warning: Could not download cover: {e}")

            audio.save(filepath, v2_version=3)
            print("Metadata embedded successfully")
        except Exception as e:
            print(f"Warning: Failed to embed metadata: {e}")
