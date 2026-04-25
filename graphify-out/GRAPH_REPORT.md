# Graph Report - .  (2026-04-25)

## Corpus Check
- 63 files · ~67,796 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 373 nodes · 1105 edges · 21 communities detected
- Extraction: 61% EXTRACTED · 39% INFERRED · 0% AMBIGUOUS · INFERRED: 434 edges (avg confidence: 0.56)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Data Models & Schemas|Data Models & Schemas]]
- [[_COMMUNITY_API Endpoints|API Endpoints]]
- [[_COMMUNITY_Apple Music Downloader|Apple Music Downloader]]
- [[_COMMUNITY_DOM Utilities|DOM Utilities]]
- [[_COMMUNITY_Music Library Services|Music Library Services]]
- [[_COMMUNITY_API Client Functions|API Client Functions]]
- [[_COMMUNITY_Playback Engine|Playback Engine]]
- [[_COMMUNITY_Gradient Manager|Gradient Manager]]
- [[_COMMUNITY_Playlist UI|Playlist UI]]
- [[_COMMUNITY_Playlist Actions|Playlist Actions]]
- [[_COMMUNITY_UI Gradient System|UI Gradient System]]
- [[_COMMUNITY_API Documents|API Documents]]
- [[_COMMUNITY_Authentication|Authentication]]
- [[_COMMUNITY_App Init|App Init]]
- [[_COMMUNITY_App Config|App Config]]
- [[_COMMUNITY_FastAPI App|FastAPI App]]
- [[_COMMUNITY_Health Check|Health Check]]
- [[_COMMUNITY_Audio Streaming|Audio Streaming]]
- [[_COMMUNITY_Playlist Icon|Playlist Icon]]
- [[_COMMUNITY_Queue Icon|Queue Icon]]
- [[_COMMUNITY_Upload Icon|Upload Icon]]

## God Nodes (most connected - your core abstractions)
1. `Track` - 48 edges
2. `Playlist` - 44 edges
3. `PlaylistTrack` - 40 edges
4. `Base` - 38 edges
5. `User` - 36 edges
6. `api()` - 24 edges
7. `Update the global track update timestamp` - 24 edges
8. `Simple in-memory rate limiter.     Limits requests based on client IP address.` - 24 edges
9. `Delete cached collage for given playlist if it exists.` - 24 edges
10. `Get track updates since a given timestamp` - 24 edges

## Surprising Connections (you probably didn't know these)
- `GradientManager Class` --uses_for_ui--> `Track`  [EXTRACTED]
  client/script.js → server/app/models.py
- `_download_with_yt_music()` --calls--> `parse_url_type()`  [INFERRED]
  server/app/services/spotiflac.py → server/SpotiFLAC/appleDL.py
- `Play Icon` --visualizes--> `GradientManager Class`  [INFERRED]
  client/images/play_musicbar.png → client/script.js
- `Home Icon` --part_of--> `UI Gradient System`  [INFERRED]
  client/images/home.svg → client/script.js
- `_get_or_create_artist()` --calls--> `Artist`  [INFERRED]
  server/app/services/library.py → server/app/models.py

## Hyperedges (group relationships)
- **Core Backend System** — main_fastapi_app, system_authentication, system_music_library, system_playlist_management, system_download_queue [EXTRACTED 0.90]
- **Data Persistence Layer** — models_artist, models_album, models_track, models_user, models_playlist, models_playlisttrack, models_downloadjob [EXTRACTED 1.00]
- **Music Processing Pipeline** — library_scan_paths, library_upsert_track, library_extract_artwork, system_music_library [EXTRACTED 0.90]
- **Download Processing Pipeline** — spotiflac_queue_download, spotiflac_run_download, spotiflac_download_yt_music, system_download_queue [EXTRACTED 0.90]

## Communities

### Community 0 - "Data Models & Schemas"
Cohesion: 0.11
Nodes (88): Base, BaseModel, Base, DeclarativeBase, Parse raw artist metadata (string or list) into a clean list of artist names., Get or create primary artist from artist name., Clear old artist associations and insert new ones with position order., Create a new Track instance from metadata (without adding to session). (+80 more)

### Community 1 - "API Endpoints"
Cohesion: 0.08
Nodes (47): SafeSession, add_track_to_playlist(), auth_me(), create_download(), create_playlist(), delete_playlist(), _delete_playlist_collage(), delete_track() (+39 more)

### Community 2 - "Apple Music Downloader"
Cohesion: 0.07
Nodes (23): AppleMusicDownloader, parse_url_type(), Apple Music downloader module for SpotiFLAC. Uses the free iTunes lookup API to, Embed metadata and cover art into MP3 file., Extract track/album info from an Apple Music URL., Get track metadata from the free iTunes lookup API., Get all tracks in an album from the iTunes API., Find YouTube Music URL for a track using ytmusicapi.         Searches YouTube Mu (+15 more)

### Community 3 - "DOM Utilities"
Cohesion: 0.08
Nodes (21): buildRemovalMenu(), filterSubmenuItems(), formatDuration(), getInsertBeforeElement(), hideRemovalMenu(), indexOfTrackId(), loadPlaylistSubmenuItems(), loadTrackPlaylists() (+13 more)

### Community 4 - "Music Library Services"
Cohesion: 0.11
Nodes (32): BaseSettings, _associate_track_artists(), _build_track_from_metadata(), _extract_artwork(), _get_or_create_album(), _get_or_create_artist(), _get_primary_artist(), _normalize() (+24 more)

### Community 5 - "API Client Functions"
Cohesion: 0.13
Nodes (25): api(), apiHeaders(), checkForTrackUpdates(), downloadFromLink(), hideHashModal(), isTrackInAnyRegularPlaylist(), loadLastTrackPaused(), loadMostPlayed() (+17 more)

### Community 6 - "Playback Engine"
Cohesion: 0.2
Nodes (24): buildQueueItem(), buildTrackCard(), checkIfLiked(), clearCanvas(), createArtCanvas(), drawCanvas(), emitTrackChanged(), getArtistDisplay() (+16 more)

### Community 7 - "Gradient Manager"
Cohesion: 0.15
Nodes (3): destroyGradient(), GradientManager, initGradient()

### Community 8 - "Playlist UI"
Cohesion: 0.2
Nodes (10): addTrackToPlaylist(), applyPendingChanges(), createPlaylistIconSvg(), escapeHtml(), hideAddToPlaylistModal(), hideContextMenu(), loadPlaylists(), renderLibrary() (+2 more)

### Community 9 - "Playlist Actions"
Cohesion: 0.24
Nodes (10): buildAddToPlaylistItems(), filterAddToPlaylistItems(), handleAddToPlaylistToggle(), handleLikedSongsToggle(), handleNewPlaylistClick(), loadPlaylistsInternal(), positionAddToPlaylistModal(), setsDiffer() (+2 more)

### Community 10 - "UI Gradient System"
Cohesion: 0.5
Nodes (4): GradientManager Class, Home Icon, Play Icon, UI Gradient System

### Community 11 - "API Documents"
Cohesion: 0.5
Nodes (4): x-auth-hash Authentication, POST /library/scan, GET /tracks/{track_id}, GET /tracks

### Community 12 - "Authentication"
Cohesion: 0.67
Nodes (3): Authentication Endpoints, rate_limit(), Authentication System

### Community 13 - "App Init"
Cohesion: 1.0
Nodes (0): 

### Community 14 - "App Config"
Cohesion: 1.0
Nodes (1): Determine if URL is from Apple Music or Spotify.

### Community 15 - "FastAPI App"
Cohesion: 1.0
Nodes (1): FastAPI Application

### Community 16 - "Health Check"
Cohesion: 1.0
Nodes (1): GET /health

### Community 17 - "Audio Streaming"
Cohesion: 1.0
Nodes (1): GET /tracks/{track_id}/stream

### Community 18 - "Playlist Icon"
Cohesion: 1.0
Nodes (1): Playlist Icon

### Community 19 - "Queue Icon"
Cohesion: 1.0
Nodes (1): Queue Icon

### Community 20 - "Upload Icon"
Cohesion: 1.0
Nodes (1): Upload Icon

## Knowledge Gaps
- **40 isolated node(s):** `Config`, `Track schema with file_path — ONLY for admin responses`, `User schema with auth_hash — ONLY for signup/signin responses`, `User schema without auth_hash — for /auth/me and all other user responses`, `Delete a playlist (owner only, admins cannot delete others' playlists)` (+35 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `App Init`** (1 nodes): `__init__.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `App Config`** (1 nodes): `Determine if URL is from Apple Music or Spotify.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `FastAPI App`** (1 nodes): `FastAPI Application`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Health Check`** (1 nodes): `GET /health`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Audio Streaming`** (1 nodes): `GET /tracks/{track_id}/stream`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Playlist Icon`** (1 nodes): `Playlist Icon`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Queue Icon`** (1 nodes): `Queue Icon`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Upload Icon`** (1 nodes): `Upload Icon`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppleMusicDownloader` connect `Apple Music Downloader` to `Music Library Services`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `Track` connect `Data Models & Schemas` to `UI Gradient System`, `Music Library Services`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `search()` connect `API Endpoints` to `Apple Music Downloader`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Are the 41 inferred relationships involving `Track` (e.g. with `Base` and `Update the global track update timestamp`) actually correct?**
  _`Track` has 41 INFERRED edges - model-reasoned connections that need verification._
- **Are the 40 inferred relationships involving `Playlist` (e.g. with `Base` and `Update the global track update timestamp`) actually correct?**
  _`Playlist` has 40 INFERRED edges - model-reasoned connections that need verification._
- **Are the 37 inferred relationships involving `PlaylistTrack` (e.g. with `Base` and `Update the global track update timestamp`) actually correct?**
  _`PlaylistTrack` has 37 INFERRED edges - model-reasoned connections that need verification._
- **Are the 36 inferred relationships involving `Base` (e.g. with `Artist` and `Album`) actually correct?**
  _`Base` has 36 INFERRED edges - model-reasoned connections that need verification._