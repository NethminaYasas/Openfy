# Spotify URL Download Safeguards

This document outlines the comprehensive safeguards implemented to prevent downloading wrong songs from Spotify URLs.

## Problem
Previously, when users pasted Spotify URLs, the system would sometimes download the wrong song if:
- The exact track wasn't found on YouTube Music
- The search fell back to the first result
- Artist name matching wasn't robust enough

## Safeguards Implemented

### 1. **Multi-Strategy Search**
The system now tries multiple search strategies in order:
1. Full query (track name + artist name)
2. Track name only
3. Reversed (artist name + track name)
4. Primary artist only

### 2. **Scoring System**
Each result is scored based on:
- Title matches (weighted higher)
- Artist matches (various weights)
- Individual artist word matches
- Minimum threshold of 10 points to avoid wrong songs

### 3. **YouTube Video Verification**
Before downloading, the system:
- Fetches YouTube video metadata
- Compares with expected track and artist
- Requires score ≥ 20 for verification pass
- Falls back to alternative searches if verification fails

### 4. **Metadata Validation**
- Validates extracted metadata before proceeding
- Checks for invalid/missing track names and artists
- Implements retry logic with exponential backoff

### 5. **Safety Checks**
- Verifies downloaded filename contains track name
- Warns about low-confidence matches
- Fails fast rather than guessing when verification fails

### 6. **Error Handling**
- Comprehensive retry mechanism for network failures
- Clear error messages for debugging
- Graceful fallbacks when primary methods fail

### 7. **Configuration System**
Centralized configuration for:
- Score thresholds
- Search strategies
- Safety checks
- Logging levels

## Configuration

Key settings in `config.py`:
```python
SCORE_THRESHOLDS = {
    "minimum_confident_match": 10,  # Minimum score to accept
    "high_confidence_match": 30,    # High confidence threshold
    "perfect_match": 50,            # Perfect match score
}

SAFETY_CHECKS = {
    "verify_youtube_metadata": True,    # Verify YouTube video
    "check_filename_match": True,       # Check filename
    "minimum_score_threshold": True,    # Enforce minimum score
    "allow_low_confidence_fallback": False,  # Don't allow low-score matches
}
```

## Behavior

### Success Case
1. Extract metadata from Spotify URL
2. Search YouTube Music with multiple strategies
3. Find high-confidence match (score ≥ 30)
4. Verify video metadata matches expected track
5. Download and embed metadata

### Failure Case
1. Extract metadata from Spotify URL
2. Search YouTube Music
3. No match meets minimum score threshold
4. Try alternative search strategies
5. If still no match, fail with clear error
6. Never download a low-confidence match

## Benefits

1. **Prevents Wrong Downloads**: The system fails rather than guesses
2. **Better Accuracy**: Multiple search strategies increase success rate
3. **Transparency**: Clear logging shows what the system is doing
4. **Configurable**: Can be tuned for different use cases
5. **Robust**: Handles network failures and edge cases

## Future Improvements

1. **Cache Search Results**: Avoid repeated searches for same track
2. **User Feedback**: Allow users to confirm correct match
3. **Machine Learning**: Improve scoring based on user choices
4. **Multiple Sources**: Try other platforms if YouTube fails

## Testing

The safeguards have been tested with:
- The original problematic URL: `https://open.spotify.com/track/56t6dqgJ02yHuHSzWitfFp?si=5eee9a90204d4510`
- Various other Spotify URLs
- Edge cases with common artist names

The system now correctly identifies and downloads the right song or fails with a clear error message.