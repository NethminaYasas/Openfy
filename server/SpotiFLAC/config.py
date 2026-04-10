"""
Configuration for SpotiFLAC download behavior
"""

# Scoring thresholds for YouTube search results
SCORE_THRESHOLDS = {
    "minimum_confident_match": 10,  # Minimum score to accept a match
    "high_confidence_match": 30,    # Score considered high confidence
    "perfect_match": 50,            # Score for a perfect match
}

# Search strategies to try in order
SEARCH_STRATEGIES = [
    "full_query",      # Track name + Artist name
    "track_only",      # Track name only
    "reversed",        # Artist name + Track name
    "primary_artist",  # Track name + Primary artist only
]

# Fallback options when primary methods fail
FALLBACK_METHODS = [
    "yt_dlp_search",
    "html_scrape",
    "songlink_api",
]

# Retry configuration
RETRY_CONFIG = {
    "max_attempts": 3,
    "initial_delay": 1,      # seconds
    "backoff_factor": 2,     # exponential backoff
    "max_timeout": 300,      # seconds
}

# Safety checks
SAFETY_CHECKS = {
    "verify_youtube_metadata": True,    # Verify YouTube video matches expected track
    "check_filename_match": True,       # Check downloaded filename contains track name
    "minimum_score_threshold": True,    # Enforce minimum score threshold
    "allow_low_confidence_fallback": False,  # Allow fallback to low-score matches
}

# Logging configuration
LOGGING = {
    "debug_enabled": True,
    "log_search_scores": True,
    "log_verification_results": True,
    "log_fallback_attempts": True,
}

# API endpoints for external services
EXTERNAL_APIS = {
    "songlink": "https://api.song.link/v1-alpha.1/links",
    "oembed": "https://open.spotify.com/oembed",
    "embed": "https://open.spotify.com/embed",
}

# Error messages
ERROR_MESSAGES = {
    "invalid_url": "Invalid Spotify URL format",
    "metadata_failed": "Could not extract metadata from Spotify URL",
    "no_youtube_match": "No matching YouTube video found",
    "verification_failed": "Could not verify the correct song",
    "download_failed": "Download failed after multiple attempts",
    "low_confidence_warning": "Low confidence match - this might be the wrong song",
}