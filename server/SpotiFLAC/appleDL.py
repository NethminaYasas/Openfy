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
from typing import Callable
from urllib.parse import quote

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
        """Extract track metadata from a Spotify URL using Spotify's oEmbed API (no auth needed)."""
        try:
            import urllib.parse
            url = f"https://open.spotify.com/oembed?format=json&url={urllib.parse.quote(spotify_url)}"
            resp = self.session.get(url, timeout=10)
            data = resp.json()
            
            title = data.get("title", "Unknown").strip()
            cover_url = data.get("thumbnail_url", "")
            
            # Title from oEmbed is typically just the song name
            # We need artist info too - try parsing "Artist - Song" format
            artist = ""
            album = ""
            
            # Also get description for additional info
            # Try fetching the embed page for more metadata
            parsed = urllib.parse.urlparse(spotify_url)
            path_parts = [p for p in parsed.path.split("/") if p]
            if len(path_parts) >= 2 and path_parts[0] == "track":
                track_id = path_parts[1]
                embed_url = f"https://open.spotify.com/embed/track/{track_id}"
                try:
                    embed_resp = self.session.get(embed_url, timeout=10, allow_redirects=True)
                    # Look for metadata in the embed HTML
                    import re
                    
                    # Try to find artist and album from the page
                    artist_match = re.search(r'"name":"([^"]+)"', embed_resp.text)
                    if artist_match:
                        # The first "name" could be artist - try to find more context
                        name_matches = re.findall(r'"name":"([^"]+)"', embed_resp.text)
                        if len(name_matches) >= 2:
                            # Usually: artist_name, track_name, album_name
                            artist = name_matches[0]
                            if len(name_matches) > 2:
                                album = name_matches[2]
                except Exception:
                    pass
            
            # If we still don't have artist, try Songlink to get full metadata
            if not artist:
                try:
                    songlink_url = f"https://api.song.link/v1-alpha.1/links?url={urllib.parse.quote(spotify_url)}&userCountry=US"
                    songlink_resp = self.session.get(songlink_url, timeout=10)
                    songlink_data = songlink_resp.json()
                    entities = songlink_data.get("entitiesByUniqueId", {})
                    for uid, entity in entities.items():
                        if entity.get("apiProvider") == "spotify":
                            artists = entity.get("artistsByRole", {})
                            if artists:
                                for role, artists_list in artists.items():
                                    if artists_list:
                                        artist = ", ".join([a.get("name", "") for a in artists_list if a.get("name")])
                                        break
                            if not album:
                                album_links = entity.get("album", {})
                                if album_links:
                                    album = album_links.get("name", "")
                            break
                except Exception:
                    pass
            
            return {
                "name": title,
                "artist": artist or "Unknown Artist",
                "album": album,
                "album_artist": artist,
                "track_number": 1,
                "total_tracks": 1,
                "disc_number": 1,
                "release_date": "",
                "duration_ms": 0,
                "cover_url": cover_url,
                "genre": "",
                "explicit": False,
            }
        except Exception as e:
            print(f"[!] Spotify metadata extraction error: {e}")
        
        return None
    
    @staticmethod
    def parse_url_type(url: str) -> str:
        """Determine if URL is from Apple Music or Spotify."""
        if "music.apple.com" in url:
            return "apple"
        elif "open.spotify.com" in url or "play.spotify.com" in url:
            return "spotify"
        return "unknown"

    def __init__(self, timeout: float = 120.0):
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
        try:
            from ytmusicapi import YTMusic
            yt = YTMusic()
            
            # Search YouTube Music for songs only
            results = yt.search(f"{track_name} {artist_name}", filter="songs", limit=5)
            
            if not results:
                # Try with less specific search
                results = yt.search(f"{track_name} {artist_name}", limit=5)
            
            # Pick the best match by checking artist name
            for result in results:
                result_artists = ", ".join(
                    a.get("name", "") for a in result.get("artists", [])
                )
                # Check if artist name matches
                if artist_name.lower().split()[0] in result_artists.lower():
                    video_id = result.get("videoId")
                    duration = result.get("duration", "")
                    print(f"✓ Found on YouTube Music: {result.get('title')} - {result_artists} ({duration})")
                    if video_id:
                        return f"https://music.youtube.com/watch?v={video_id}"
            
            # If no good artist match, use the first result
            if results:
                video_id = results[0].get("videoId")
                print(f"✓ Found on YouTube Music: {results[0].get('title')} ({results[0].get('duration', '')})")
                if video_id:
                    return f"https://music.youtube.com/watch?v={video_id}"
        except ImportError:
            print("[!] ytmusicapi not available, falling back to search")
        except Exception as e:
            print(f"[!] YouTube Music search error: {e}")
        
        # Fallback: Regular search
        return self._search_youtube_fallback(track_name, artist_name)

    def _search_youtube_fallback(self, track_name: str, artist_name: str) -> str:
        """Fallback YouTube search if ytmusicapi fails."""
        try:
            search_query = quote(f"{track_name} {artist_name} audio")
            search_url = f"https://music.youtube.com/search?q={search_query}"
            resp = self.session.get(search_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
            }, timeout=15)
            
            match = re.search(r'"videoId":"([a-zA-Z0-9_-]{11})"', resp.text)
            if match:
                video_id = match.group(1)
                print(f"✓ Found via YouTube Music search: {video_id}")
                return f"https://music.youtube.com/watch?v={video_id}"
        except Exception as e:
            print(f"[!] YouTube fallback error: {e}")

        raise Exception(f"Could not find YouTube URL for: {track_name} - {artist_name}")

    def _request_spotube_dl(self, video_id: str) -> str | None:
        """Get download URL from SpotubeDL."""
        for engine in ["v1", "v3", "v2"]:
            api_url = f"https://spotubedl.com/api/download/{video_id}?engine={engine}&format=mp3&quality=320"
            try:
                print(f"Fetching from SpotubeDL (Engine: {engine})...")
                resp = self.session.get(api_url, timeout=15)
                if resp.status_code == 200:
                    data = resp.json()
                    download_url = data.get("url")
                    if download_url:
                        if download_url.startswith("/"):
                            download_url = "https://spotubedl.com" + download_url
                        return download_url
            except Exception:
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
            print("Trying Cobalt API (Fallback)...")
            resp = self.session.post(api_url, json=payload, headers=headers, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") in ["tunnel", "redirect"] and data.get("url"):
                    return data["url"]
        except Exception:
            pass
        return None

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

        track_info = self._extract_spotify_metadata(spotify_url)
        if not track_info or track_info.get("name") in ("Track", "Unknown"):
            raise Exception(f"Could not extract metadata from Spotify URL: {spotify_url}")

        print(f"✓ Found: {track_info['name']} - {track_info['artist']}")

        return self.download_by_info(track_info, output_dir)

    def download_by_info(self, track_info: dict, output_dir: str, **kwargs) -> str:
        """Download using pre-extracted track info (for use by other services)."""
        os.makedirs(output_dir, exist_ok=True)

        # Get YouTube URL
        yt_url = self._get_youtube_url(track_info["name"], track_info["artist"])
        video_id = self._extract_video_id(yt_url)
        if not video_id:
            raise Exception("Could not extract YouTube video ID")

        safe_title = sanitize_filename(track_info["name"])
        safe_artist = sanitize_filename(track_info["artist"].split(",")[0])
        expected_filename = f"{safe_artist} - {safe_title}.mp3"
        expected_path = os.path.join(output_dir, expected_filename)

        if os.path.exists(expected_path) and os.path.getsize(expected_path) > 0:
            return expected_path

        print("Downloading track from YouTube...")
        download_url = self._request_spotube_dl(video_id)
        if not download_url:
            download_url = self._request_cobalt(video_id)
        if not download_url:
            raise Exception("All YouTube download APIs failed")

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
