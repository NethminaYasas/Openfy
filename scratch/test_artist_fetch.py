import sys
import os
from pathlib import Path

# Add server to path
sys.path.insert(0, str(Path("/home/nethmina/Documents/GITHUB/Openfy/server").resolve()))

from app.services.artist_service import get_artist_info_from_spotify

# Test with a known Spotify track URL
test_url = "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6" # Bohemian Rhapsody
print(f"Testing with URL: {test_url}")

info = get_artist_info_from_spotify(test_url)
if info:
    print(f"Name: {info.get('name')}")
    print(f"Images: {info.get('images')}")
    if info.get('images'):
        print(f"Largest image: {info.get('images')[0].get('url')}")
else:
    print("Failed to get info")
