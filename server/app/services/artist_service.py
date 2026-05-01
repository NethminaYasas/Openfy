"""
Artist service for fetching artist images from Spotify using SpotifyScraper library.
"""
import sys
from pathlib import Path
import logging
import requests

logger = logging.getLogger(__name__)

# Check multiple possible locations for SpotifyScraper
# Local development: GITHUB folder (parent of Openfy)
# Docker: site-packages
_spotify_scraper_added = False


def _ensure_spotify_scraper_import() -> bool:
    """Ensure SpotifyScraper is importable. Returns True if successful."""
    global _spotify_scraper_added
    if _spotify_scraper_added:
        return True

    # First, try importing directly (works in Docker where it's in site-packages)
    try:
        import spotify_scraper
        _spotify_scraper_added = True
        logger.info("SpotifyScraper found in site-packages")
        return True
    except ImportError:
        pass

    # Try local development path (parent of Openfy)
    possible_paths = [
        Path(__file__).resolve().parents[3].parent / "SpotifyScraper",  # /home/nethmina/Documents/GITHUB/SpotifyScraper
        Path(__file__).resolve().parents[2] / "SpotifyScraper",  # Same level as server folder
    ]

    for src in possible_paths:
        if src.exists():
            src_str = str(src / "src")
            if src_str not in sys.path:
                sys.path.insert(0, src_str)
            try:
                import spotify_scraper
                _spotify_scraper_added = True
                logger.info(f"SpotifyScraper imported from: {src}")
                return True
            except ImportError:
                continue

    logger.warning("SpotifyScraper not found in any location")
    return False

# Session for HTTP requests
_session = requests.Session()
_session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
})


def get_artist_from_spotify_url(spotify_url: str) -> dict | None:
    """
    Fetch artist info from Spotify URL (track or artist).

    Args:
        spotify_url: Spotify track or artist URL

    Returns:
        Dict with artist info or None if failed
    """
    if not spotify_url:
        return None

    if not _ensure_spotify_scraper_import():
        logger.error("SpotifyScraper not available")
        return None

    try:
        from spotify_scraper import SpotifyClient

        client = SpotifyClient()
        logger.info(f"Fetching artist info from: {spotify_url}")

        # Check if it's a track URL - need to get artist info differently
        if "/track/" in spotify_url:
            # Get track info first to extract artist ID
            track_info = client.get_track_info(spotify_url)
            if not track_info:
                logger.warning("Could not get track info")
                return None

            # Get artist ID from track
            artists = track_info.get("artists", [])
            if not artists:
                logger.warning("No artists in track info")
                return None

            artist_id = artists[0].get("id")
            if not artist_id:
                logger.warning("No artist ID in track")
                return None

            # Construct artist URL and get artist info
            artist_url = f"https://open.spotify.com/artist/{artist_id}"
            logger.info(f"Got artist ID: {artist_id}, fetching from: {artist_url}")
            artist_data = client.get_artist_info(artist_url)
        else:
            # It's already an artist URL
            artist_data = client.get_artist_info(spotify_url)

        if artist_data:
            logger.info(f"Got artist data: {artist_data.get('name')}")
            # Extract the largest image
            images = artist_data.get("images", [])
            if images:
                sorted_images = sorted(images, key=lambda x: x.get("width", 0), reverse=True)
                artist_data["largest_image"] = sorted_images[0].get("url") if sorted_images else None
        else:
            logger.warning("No artist data returned")

        return artist_data
    except Exception as e:
        logger.error(f"Failed to get artist from Spotify: {e}")
        import traceback
        traceback.print_exc()
        return None


# Legacy function for compatibility
def get_artist_info_from_spotify(spotify_url: str) -> dict | None:
    """Get artist info from Spotify URL."""
    return get_artist_from_spotify_url(spotify_url)


def get_artist_image_from_spotify(spotify_url: str) -> str | None:
    """Get artist image URL from Spotify URL."""
    result = get_artist_from_spotify_url(spotify_url)
    if result:
        return result.get("largest_image")
    return None


def download_artist_image(artist_url: str, output_path: str) -> str | None:
    """
    Download artist image from Spotify artist URL.

    Args:
        artist_url: Spotify artist URL (e.g., https://open.spotify.com/artist/<id>)
        output_path: Path to save the image file

    Returns:
        Path to saved image file, or None if failed
    """
    if not artist_url or not output_path:
        return None

    if not _ensure_spotify_scraper_import():
        logger.error("SpotifyScraper not available")
        return None

    try:
        from spotify_scraper import SpotifyClient

        client = SpotifyClient()
        logger.info(f"Downloading artist image from: {artist_url}")

        # Get artist info (works with artist URLs)
        artist_info = client.get_artist_info(artist_url)

        if not artist_info:
            logger.warning("No artist info returned")
            return None

        # Get images list - first item is usually largest
        images = artist_info.get("images", [])
        if not images:
            logger.warning("No images in artist info")
            return None

        # Get the first (largest) image URL
        image_url = images[0].get("url")
        if not image_url:
            logger.warning("No image URL found")
            return None

        # Infer file extension from URL
        if ".jpg" in image_url.lower() or ".jpeg" in image_url.lower():
            ext = ".jpg"
        elif ".png" in image_url.lower():
            ext = ".png"
        elif ".webp" in image_url.lower():
            ext = ".webp"
        else:
            ext = ".jpg"  # Default

        # Ensure output path has the extension
        from pathlib import Path
        output = Path(output_path)
        if output.suffix.lower() not in ['.jpg', '.jpeg', '.png', '.webp']:
            output = output.with_suffix(ext)

        # Download and save
        response = _session.get(image_url, timeout=30)
        response.raise_for_status()

        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, "wb") as f:
            f.write(response.content)

        logger.info(f"Downloaded artist image to: {output}")
        return str(output)

    except Exception as e:
        logger.error(f"Failed to download artist image: {e}")
        import traceback
        traceback.print_exc()
        return None