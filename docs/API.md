# Openfy API Documentation

Base URL: `http://localhost:8000`

All API responses are JSON-encoded unless otherwise specified. Authentication is handled via the `x-auth-hash` header for user-specific endpoints.

## Authentication

Most endpoints require authentication using an auth hash. The auth hash is obtained during signup and should be included in all requests:

```http
x-auth-hash: your_auth_hash_here
```

## Error Responses

All endpoints return appropriate HTTP status codes and error messages:

- `200 OK`: Successful request
- `201 Created`: Resource successfully created
- `204 No Content`: Resource exists but no content to return
- `206 Partial Content`: Partial content (range requests)
- `400 Bad Request`: Invalid request parameters
- `401 Unauthorized`: Authentication required or invalid
- `403 Forbidden`: Insufficient permissions
- `404 Not Found`: Resource not found
- `409 Conflict`: Duplicate resource or conflict
- `413 Payload Too Large`: Upload exceeds size limit
- `416 Range Not Satisfiable`: Invalid byte range
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

Error responses include a message:

```json
{
  "detail": "Error message describing the issue"
}
```

## Health Check

### `GET /health`

Check if the server is running and healthy.

**Response:**
```json
{
  "status": "ok"
}
```

## Frontend (SPA)

### `GET /`

Serve the main application HTML (desktop or mobile based on User-Agent).

### `GET /{path:path}`

Catch-all route — serves `index.html` for all non-API paths to enable client-side SPA routing.

## Track Updates

### `GET /tracks/updates`

Get track update status since a given timestamp (polling mechanism).

**Query Parameters:**
- `since` (integer, required): Unix timestamp in milliseconds to check for updates since

**Response:**
```json
{
  "has_updates": true,
  "timestamp": 1700000000000
}
```

## Library Management

### `POST /library/scan`

Scan the music directory for new tracks and update the library. (Admin only)

**Query Parameters:**
- `path` (optional, string): Absolute or relative path to scan. Defaults to the configured music directory.

**Response:**
```json
{
  "scanned": 12,
  "new": 4,
  "updated": 2
}
```

## Tracks

### `GET /tracks`

List all tracks in the library, ordered by creation date (newest first).

**Query Parameters:**
- `limit` (integer, optional): Maximum number of tracks to return (default: 50, max: 200)
- `offset` (integer, optional): Number of tracks to skip for pagination (default: 0)
- `user_hash` (string, optional): Filter tracks by user (admin only or own tracks)
- `random` (integer, optional): Set to `1` for random ordering

**Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Track Title",
    "artist": {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Artist Name"
    },
    "artists": [
      {"id": "...", "name": "Artist Name", "image_url": null}
    ],
    "album": {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "title": "Album Title",
      "year": 2023,
      "artwork_path": "/data/artwork/album.jpg",
      "created_at": "2023-01-01T00:00:00Z"
    },
    "duration": 180.5,
    "file_size": 3145728,
    "mime_type": "audio/mpeg",
    "bitrate": 320,
    "sample_rate": 44100,
    "channels": 2,
    "track_no": 1,
    "disc_no": 1,
    "play_count": 5,
    "user_hash": "abc123...",
    "created_at": "2023-01-01T00:00:00Z",
    "updated_at": "2023-01-01T00:00:00Z"
  }
]
```

### `GET /tracks/batch`

Get multiple tracks by IDs in the order requested.

**Query Parameters:**
- `ids` (required, string): Comma-separated track IDs

**Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Track Title",
    ...
  }
]
```

### `GET /tracks/most-played`

Get the most played tracks of all time.

**Query Parameters:**
- `limit` (integer, optional): Maximum number of tracks to return (default: 10, max: 100)

**Response:**
```json
[
  {
    "id": "...",
    "title": "Track Title",
    "artist": {"name": "Artist Name"},
    "play_count": 25,
    ...
  }
]
```

### `GET /tracks/refresh-30day-counts`

Refresh play counts for the last 30 days. (Admin only)

**Response:**
```json
{
  "status": "success",
  "message": "30-day play counts refreshed"
}
```

### `GET /tracks/{track_id}`

Get detailed information about a specific track.

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Track Title",
  "artist": {
    "id": "...",
    "name": "Artist Name"
  },
  "artists": [...],
  "album": {
    "id": "...",
    "title": "Album Title",
    "year": 2023,
    "artwork_path": "/data/artwork/album.jpg",
    "image_url": "https://...",
    "created_at": "2023-01-01T00:00:00Z"
  },
  "duration": 180.5,
  "file_size": 3145728,
  "mime_type": "audio/mpeg",
  "bitrate": 320,
  "sample_rate": 44100,
  "channels": 2,
  "track_no": 1,
  "disc_no": 1,
  "play_count": 5,
  "user_hash": "...",
  "universal_track_id": "...",
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### `GET /tracks/{track_id}/stream`

Stream an audio file. Supports HTTP Range requests for seeking and partial content. Increments play count and logs a TrackPlay entry on full (non-range) requests.

**Headers:**
- `Range` (optional): Specify byte range (e.g., `bytes=0-1024`)
- `x-auth-hash` (optional): Auth header, OR use `token` query parameter

**Query Parameters:**
- `token` (optional): Time-limited stream token (alternative to auth header)

**Response:**
- `200 OK` with audio content
- `206 Partial Content` when using Range header

### `GET /tracks/{track_id}/stream-token`

Issue a time-limited stream token (120 seconds) for sharing playback without exposing auth credentials.

**Response:**
```json
{
  "token": "base64url_encoded_token",
  "expires_in": 120
}
```

### `GET /tracks/{track_id}/artwork`

Get album artwork for a track.

**Response:**
- Image data with appropriate Content-Type header, or `404` if not found.

### `GET /tracks/{track_id}/playlists`

List all regular (non-Liked Songs) playlists owned by the user that contain the given track.

**Response:**
```json
[
  {
    "id": "...",
    "name": "My Playlist",
    ...
  }
]
```

### `GET /tracks/by-spotify-id/{spotify_id}`

Look up a track by its Spotify track ID.

**Query Parameters:**
- `album_source_id` (optional, string): Album source ID to link the track to an album

**Response:** Single TrackOut object.

### `GET /tracks/by-universal/{universal_track_id}`

Look up a track by its universal track ID (SHA-256 hash of file content).

**Response:** Single TrackOut object.

### `POST /tracks/upload`

Upload an audio file to the library. Requires manual uploads to be enabled (admin setting).

**Request:** Multipart form data:
- `file`: Audio file to upload (mp3/flac/wav/m4a/ogg/opus)

**Response:** Single TrackOut object.

### `POST /tracks/fix-missing-albums`

Fix tracks that don't have albums by creating placeholder albums for them. (Admin only)

**Response:**
```json
{
  "status": "fixed",
  "tracks_fixed": 5
}
```

## Liked Songs

### `POST /liked/{track_id}`

Toggle the "liked" status of a track for the authenticated user.

**Response:**
```json
{
  "status": "liked"
}
```

### `GET /liked/{track_id}`

Check if a track is liked by the authenticated user.

**Response:**
```json
{
  "liked": true
}
```

## Artists

### `GET /artists`

List all artists in the library, ordered by name.

**Response:**
```json
[
  {
    "id": "...",
    "name": "Artist Name",
    "image_url": "https://...",
    "spotify_url": "https://open.spotify.com/artist/...",
    "created_at": "2023-01-01T00:00:00Z",
    "tracks": [],
    "albums": []
  }
]
```

### `GET /artists/{artist_id}`

Get detailed information about a specific artist, including combined primary and featured tracks, and valid albums (more than 1 track or has source_id).

**Response:**
```json
{
  "id": "...",
  "name": "Artist Name",
  "image_url": "https://...",
  "spotify_url": "...",
  "tracks": [...],
  "albums": [...],
  "created_at": "2023-01-01T00:00:00Z"
}
```

### `GET /artists/{artist_id}/refresh-image`

Trigger a background task to refresh the artist's image from Spotify.

**Response:**
```json
{
  "status": "triggered"
}
```

### `GET /artists/{artist_id}/refresh-albums`

Refresh all album images for an artist synchronously.

**Response:**
```json
{
  "status": "refreshed",
  "albums_updated": 3
}
```

### `POST /artists/{artist_id}/fetch-spotify-image`

Fetch artist image from Spotify and update the artist record. (Admin only)

**Response:**
```json
{
  "image_url": "https://...",
  "spotify_url": "https://open.spotify.com/artist/...",
  "name": "Artist Name"
}
```

## Albums

### `GET /albums`

List all albums in the library, ordered by title.

**Response:**
```json
[
  {
    "id": "...",
    "title": "Album Title",
    "year": 2023,
    "artist_id": "...",
    "artwork_path": "/data/artwork/album.jpg",
    "created_at": "2023-01-01T00:00:00Z"
  }
]
```

### `GET /albums/{album_id}`

Get an album with its tracks in a format compatible with the playlist view. Includes follow status.

**Response:**
```json
{
  "id": "...",
  "name": "Album Title",
  "description": "Album by Artist Name",
  "type": "album",
  "is_public": true,
  "is_followed": false,
  "is_owner": false,
  "is_liked": false,
  "shuffle": false,
  "pinned": false,
  "owner_name": "Artist Name",
  "image_url": "https://...",
  "tracks": [
    {
      "position": 0,
      "track": {
        "id": "...",
        "title": "Track Title",
        "duration": 180.5,
        "artist": {"id": "...", "name": "Artist Name", "image_url": null},
        "artists": [...],
        "album": {"id": "...", "title": "Album Title", "artwork_path": "...", "image_url": "..."}
      }
    }
  ],
  "track_count": 12,
  "user": {"id": "...", "name": "Artist Name", "avatar_path": null}
}
```

### `GET /albums/{album_id}/artwork`

Get album artwork. Proxies and caches external image URLs locally.

**Response:** Image data or `204 No Content`.

### `POST /albums/{album_id}/follow`

Follow an album (adds to user's library).

**Response:**
```json
{
  "success": true
}
```

### `PUT /albums/{album_id}/follow`

Update album follow settings (shuffle, pinned).

**Request Body:**
```json
{
  "shuffle": true,
  "pinned": true
}
```

**Response:**
```json
{
  "success": true
}
```

### `DELETE /albums/{album_id}/follow`

Unfollow an album.

**Response:**
```json
{
  "success": true
}
```

## Search

### `GET /search`

Search the library by track title, artist name, or album title.

**Query Parameters:**
- `q` (required, string): Search query (1-255 characters)
- `limit` (integer, optional): Maximum number of results (default: 50, max: 200)

**Response:**
```json
[
  {
    "id": "...",
    "title": "Track Title",
    "artist": {"name": "Artist Name"},
    "album": {"title": "Album Title"},
    ...
  }
]
```

### `GET /spotify-search`

Search Spotify for tracks using web scraping.

**Query Parameters:**
- `q` (required, string): Search query
- `limit` (integer, optional): Maximum number of results (default: 10, max: 20)

**Response:** Array of Spotify track results.

## Playlists

### `POST /playlists`

Create a new playlist. Auto-appends `#2`, `#3`, etc. on name collision.

**Request Body:**
```json
{
  "name": "Playlist Name",
  "description": "Optional description",
  "type": "playlist",
  "owner_name": null
}
```

**Response:**
```json
{
  "id": "...",
  "name": "Playlist Name",
  "description": "Optional description",
  "is_liked": false,
  "pinned": false,
  "shuffle": false,
  "is_public": false,
  "type": "playlist",
  "owner_name": null,
  "user": {"id": "...", "name": "username", "avatar_path": null},
  "created_at": "2023-01-01T00:00:00Z",
  "track_count": 0
}
```

### `GET /playlists`

List all playlists for the authenticated user, including followed playlists and followed albums.

**Response:**
```json
[
  {
    "id": "...",
    "name": "Playlist Name",
    "description": "Description",
    "is_liked": false,
    "pinned": false,
    "shuffle": false,
    "is_public": false,
    "type": "playlist",
    "owner_name": null,
    "is_owner": true,
    "is_followed": false,
    "track_count": 5,
    "created_at": "2023-01-01T00:00:00Z",
    "user": {"id": "...", "name": "username", "avatar_path": null}
  }
]
```

### `GET /playlists/{playlist_id}`

Get playlist details. Public playlists accessible without auth; private playlists return limited data to non-owners.

**Response (owner/admin):**
```json
{
  "id": "...",
  "name": "Playlist Name",
  "description": "Description",
  "is_liked": false,
  "pinned": false,
  "shuffle": false,
  "is_public": false,
  "type": "playlist",
  "owner_name": null,
  "is_owner": true,
  "is_followed": true,
  "track_count": 5,
  "tracks": [
    {
      "track": {...},
      "position": 0
    }
  ],
  "created_at": "2023-01-01T00:00:00Z",
  "user": {"id": "...", "name": "username"}
}
```

**Response (non-owner, private):**
```json
{
  "id": "...",
  "name": "Playlist Name",
  "description": "Description",
  "is_liked": false,
  "pinned": false,
  "shuffle": false,
  "is_public": false,
  "created_at": "2023-01-01T00:00:00Z",
  "user": null,
  "access_denied": true,
  "is_followed": false,
  "is_owner": false,
  "track_count": 0
}
```

### `PUT /playlists/{playlist_id}`

Update playlist metadata (name, pinned, shuffle, visibility, image_url).

**Request Body:**
```json
{
  "name": "New Name",
  "pinned": true,
  "shuffle": false,
  "is_public": true,
  "image_url": "https://...",
  "type": "playlist",
  "owner_name": null
}
```

**Response:** Updated PlaylistOut object.

### `DELETE /playlists/{playlist_id}`

Delete a playlist (owner only, even admins cannot delete other users' playlists).

**Response:**
```json
{
  "status": "deleted"
}
```

### `POST /playlists/{playlist_id}/follow`

Follow a public playlist.

**Response:**
```json
{
  "success": true
}
```

### `DELETE /playlists/{playlist_id}/follow`

Unfollow a playlist. For owned albums, this deletes the album playlist record.

**Response:**
```json
{
  "success": true
}
```

### `GET /playlists/{playlist_id}/cover`

Return a cached 500x500 JPEG collage of the playlist's first 4 tracks. Proxies external image_url if set. Public playlists accessible without auth.

**Response:** JPEG image data.

### `GET /playlists/{playlist_id}/tracks`

Get tracks in a playlist.

**Response:**
```json
[
  {
    "track": {
      "id": "...",
      "title": "Track Title",
      "artist": {"name": "Artist Name"},
      "artists": [...],
      "album": {...},
      "duration": 180.5,
      ...
    },
    "position": 0
  }
]
```

### `POST /playlists/{playlist_id}/tracks`

Add a track to a playlist.

**Query Parameters:**
- `track_id` (required, string): ID of the track to add

**Response:** Single PlaylistTrackOut object.

### `DELETE /playlists/{playlist_id}/tracks/{track_id}`

Remove a track from a playlist. Idempotent.

**Response:**
```json
{
  "status": "removed",
  "playlist_id": "...",
  "track_id": "...",
  "was_present": true
}
```

### `POST /playlists/import`

Import a Spotify playlist or album by URL. Fetches metadata and returns normalized track list for the frontend to process.

**Request Body:**
```json
{
  "url": "https://open.spotify.com/playlist/... or https://open.spotify.com/album/..."
}
```

**Response:**
```json
{
  "playlist_id": "spotify_playlist_id",
  "name": "Playlist Name",
  "owner": "owner_name",
  "image_url": "https://...",
  "tracks": [
    {
      "name": "Track Name",
      "artists": ["Artist 1"],
      "duration_ms": 180000,
      "spotify_url": "https://open.spotify.com/track/...",
      "artist_url": "https://open.spotify.com/artist/..."
    }
  ],
  "type": "playlist",
  "internal_album_id": null
}
```

## User State

### `GET /auth/me`

Get the currently authenticated user's profile.

**Response:**
```json
{
  "id": "...",
  "name": "username",
  "is_admin": false,
  "upload_enabled": true,
  "library_minimized": false,
  "shuffle": false,
  "repeat_state": "off",
  "avatar_path": null,
  "created_at": "2023-01-01T00:00:00Z"
}
```

### `GET /user/last-track`

Get the user's last played track.

**Response:** Single TrackOut object or `null`.

### `PUT /user/last-track`

Update the user's last played track.

**Query Parameters:**
- `track_id` (required, string): Track ID to set as last played

**Response:**
```json
{
  "status": "updated",
  "track_id": "..."
}
```

### `GET /user/queue`

Get the user's saved queue state.

**Response:**
```json
{
  "queue": ["track_id_1", "track_id_2"],
  "current_index": 0
}
```

### `PUT /user/queue`

Save the user's current queue state.

**Request Body:**
```json
{
  "track_ids": ["track_id_1", "track_id_2"],
  "current_index": 0
}
```

**Response:**
```json
{
  "status": "updated"
}
```

### `GET /user/player-state`

Get the user's saved player state (shuffle, repeat).

**Response:**
```json
{
  "shuffle": false,
  "repeat_state": "off"
}
```

### `PUT /user/player-state`

Update the user's saved player state.

**Request Body:**
```json
{
  "shuffle": true,
  "repeat_state": "loop-once"
}
```

**Response:**
```json
{
  "status": "updated"
}
```

### `GET /user/library-state`

Get the user's library sidebar state (minimized/expanded).

**Response:**
```json
{
  "library_minimized": false
}
```

### `PUT /user/library-state`

Update the user's library sidebar state.

**Request Body:**
```json
{
  "library_minimized": true
}
```

**Response:**
```json
{
  "status": "updated",
  "library_minimized": true
}
```

### `PUT /user/upload-preference`

Update whether the user can upload tracks.

**Request Body:**
```json
{
  "upload_enabled": true
}
```

**Response:**
```json
{
  "status": "updated",
  "upload_enabled": true
}
```

### `POST /users/upload-avatar`

Upload a profile picture for the authenticated user (max 5MB, formats: jpg/png/gif/webp).

**Request:** Multipart form data:
- `file`: Image file

**Response:** UserOutPublic object.

### `GET /users/{user_id}/avatar`

Serve a user's avatar image.

**Response:** Image data.

### `DELETE /users/avatar`

Delete the authenticated user's avatar.

**Response:**
```json
{
  "status": "deleted"
}
```

## Authentication

### `POST /auth/signup`

Create a new user account. Rate limited (10 requests per 5 minutes per IP).

**Request Body:**
```json
{
  "name": "new_user"
}
```

**Response:**
```json
{
  "id": "...",
  "name": "new_user",
  "auth_hash": "generated_auth_hash",
  "is_admin": false,
  "upload_enabled": true,
  "library_minimized": false,
  "shuffle": false,
  "repeat_state": "off",
  "avatar_path": null,
  "created_at": "2023-01-01T00:00:00Z"
}
```

### `POST /auth/signin`

Authenticate a user. Rate limited (15 requests per 5 minutes per IP).

**Request Body:**
```json
{
  "auth_hash": "user_auth_hash"
}
```

**Response:** UserOut object (includes auth_hash).

## Downloads

### `POST /downloads`

Queue a download job (SpotiFLAC).

**Request Body:**
```json
{
  "query": "https://open.spotify.com/track/...",
  "source": "auto",
  "artist_url": "https://open.spotify.com/artist/...",
  "album_source_id": "spotify:album_id"
}
```

**Response:**
```json
{
  "id": "job_id",
  "source": "auto",
  "query": "https://open.spotify.com/track/...",
  "status": "queued",
  "track_id": null,
  "output_path": null,
  "log": null,
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### `GET /downloads/{job_id}`

Get download job status.

**Response:**
```json
{
  "id": "job_id",
  "source": "auto",
  "query": "https://open.spotify.com/track/...",
  "status": "completed",
  "track_id": "resolved_track_id",
  "output_path": "/data/music/track.mp3",
  "log": "...",
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### `GET /events/downloads`

Server-sent events stream for download job updates.

**Response:**
Event stream with updates:
```json
{
  "job_id": "...",
  "status": "progress",
  "progress": 50
}
```

## System Settings

### `GET /system/settings`

Get public system settings (manual audio upload enabled, playlist import enabled).

**Response:**
```json
{
  "manual_audio_upload_enabled": true,
  "playlist_import_enabled": true
}
```

## Admin Endpoints

All admin endpoints require elevated permissions (`x-auth-hash` must belong to an admin user).

### `GET /admin/stats`

Get server statistics.

**Response:**
```json
{
  "total_users": 10,
  "online_users": 3,
  "total_storage_bytes": 1073741824
}
```

### `GET /admin/settings`

Get system-wide settings.

**Response:**
```json
{
  "manual_audio_upload_enabled": true,
  "playlist_import_enabled": true,
  "timezone": "UTC"
}
```

### `PUT /admin/settings`

Update system-wide settings.

**Request Body:**
```json
{
  "manual_audio_upload_enabled": false,
  "playlist_import_enabled": true,
  "timezone": "America/New_York"
}
```

### `GET /admin/users`

List all users with their uploaded track counts.

**Query Parameters:**
- `q` (optional, string): Search by username

**Response:**
```json
[
  {
    "id": "...",
    "name": "admin",
    "is_admin": true,
    "upload_enabled": true,
    "created_at": "2023-01-01T00:00:00Z",
    "uploaded_tracks_count": 5
  }
]
```

### `DELETE /admin/users/{user_id}`

Delete a user and their data (cannot delete self). User tracks are unlinked but files remain on disk.

**Response:**
```json
{
  "status": "deleted",
  "user": "username"
}
```

### `GET /admin/tracks`

Get all tracks in the system with user info.

**Query Parameters:**
- `q` (optional, string): Search by track title, artist, or album name

**Response:**
```json
[
  {
    "id": "...",
    "universal_track_id": "...",
    "title": "Track Title",
    "artist_name": "Artist Name",
    "user_name": "username",
    "duration": 180.5,
    "play_count": 5
  }
]
```

### `DELETE /admin/tracks/{track_id}`

Delete a track from database and disk.

**Response:**
```json
{
  "status": "deleted",
  "track": "Track Title"
}
```

### `GET /admin/albums`

List all albums with track counts (only albums with more than 1 track).

**Query Parameters:**
- `q` (optional, string): Search by album title

**Response:**
```json
[
  {
    "id": "...",
    "title": "Album Title",
    "artist_name": "Artist Name",
    "track_count": 12,
    "created_at": "2023-01-01T00:00:00Z"
  }
]
```

### `DELETE /admin/albums/{album_id}`

Delete an album but keep its tracks (tracks are unlinked from the album).

**Response:**
```json
{
  "status": "deleted"
}
```

## Rate Limiting

Rate limiting is implemented for auth endpoints:
- **Signup**: 10 requests per 5 minutes per IP
- **Signin**: 15 requests per 5 minutes per IP

## Version History

- **v1.0.0**: Initial release with core functionality
- **v1.1.0**: Added playlist management
- **v1.2.0**: Added search functionality
- **v1.3.0**: Added admin interface
- **v1.4.0**: Added Spotify playlist import, album management, artist pages, user avatars, player state persistence, stream tokens, mobile UI
