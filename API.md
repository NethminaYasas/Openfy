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
- `400 Bad Request`: Invalid request parameters
- `401 Unauthorized`: Authentication required or invalid
- `403 Forbidden`: Insufficient permissions
- `404 Not Found`: Resource not found
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

## Library Management

### `POST /library/scan`

Scan the music directory for new tracks and update the library.

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

**Response:**
```json
{
  "tracks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Track Title",
      "artist": {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "name": "Artist Name"
      },
      "album": {
        "id": "550e8400-e29b-41d4-a716-446655440002",
        "title": "Album Title",
        "year": 2023
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
      "created_at": "2023-01-01T00:00:00Z",
      "updated_at": "2023-01-01T00:00:00Z"
    }
  ]
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
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Artist Name"
  },
  "album": {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "title": "Album Title",
    "year": 2023,
    "artwork_path": "/data/artwork/album.jpg"
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
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### `GET /tracks/{track_id}/stream`

Stream an audio file. Supports HTTP Range requests for seeking and partial content.

**Headers:**
- `Range` (optional): Specify byte range (e.g., `bytes=0-1024`)

**Response:**
- `200 OK` with audio content
- `206 Partial Content` when using Range header
- `Content-Range` header indicates the byte range served
- `Accept-Ranges: bytes` header indicates byte-range support

### `GET /tracks/{track_id}/artwork`

Get album artwork for a track.

**Query Parameters:**
- `v` (optional): Version parameter to bypass caching

**Response:**
- Image data with appropriate Content-Type header

### `GET /tracks/most-played`

Get the most played tracks.

**Query Parameters:**
- `limit` (integer, optional): Maximum number of tracks to return (default: 12, max: 100)

**Response:**
```json
{
  "tracks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Track Title",
      "artist": {
        "name": "Artist Name"
      },
      "play_count": 25
    }
  ]
}
```

### `POST /tracks/upload`

Upload an audio file to the library.

**Request:**
Multipart form data:
- `file`: Audio file to upload

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Uploaded Track",
  "artist": {
    "name": "Artist Name"
  },
  "file_path": "/data/music/track.mp3"
}
```

## Artists

### `GET /artists`

List all artists in the library, ordered by name.

**Query Parameters:**
- `limit` (integer, optional): Maximum number of artists to return (default: 50, max: 200)
- `offset` (integer, optional): Number of artists to skip for pagination

**Response:**
```json
{
  "artists": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Artist Name",
      "track_count": 10,
      "album_count": 2,
      "created_at": "2023-01-01T00:00:00Z"
    }
  ]
}
```

### `GET /artists/{artist_id}`

Get detailed information about a specific artist.

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "name": "Artist Name",
  "tracks": [...],
  "albums": [...],
  "created_at": "2023-01-01T00:00:00Z"
}
```

## Albums

### `GET /albums`

List all albums in the library, ordered by title.

**Query Parameters:**
- `limit` (integer, optional): Maximum number of albums to return (default: 50, max: 200)
- `offset` (integer, optional): Number of albums to skip for pagination

**Response:**
```json
{
  "albums": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "title": "Album Title",
      "artist": {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "name": "Artist Name"
      },
      "year": 2023,
      "track_count": 12,
      "duration": 2540.5,
      "artwork_path": "/data/artwork/album.jpg",
      "created_at": "2023-01-01T00:00:00Z"
    }
  ]
}
```

## Search

### `GET /search`

Search the library by track title, artist name, or album title.

**Query Parameters:**
- `q` (required, string): Search query
- `limit` (integer, optional): Maximum number of results (default: 50, max: 200)

**Response:**
```json
{
  "results": {
    "tracks": [...],
    "artists": [...],
    "albums": [...]
  }
}
```

## Playlists

### `POST /playlists`

Create a new playlist.

**Request Body:**
```json
{
  "name": "Playlist Name",
  "description": "Optional playlist description"
}
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "name": "Playlist Name",
  "description": "Optional playlist description",
  "track_count": 0,
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### `GET /playlists`

List all playlists for the authenticated user.

**Response:**
```json
{
  "playlists": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440003",
      "name": "Playlist Name",
      "description": "Description",
      "track_count": 5,
      "created_at": "2023-01-01T00:00:00Z",
      "updated_at": "2023-01-01T00:00:00Z"
    }
  ]
}
```

### `GET /playlists/{playlist_id}`

Get playlist details.

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "name": "Playlist Name",
  "description": "Description",
  "tracks": [...],
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### `GET /playlists/{playlist_id}/tracks`

Get tracks in a playlist.

**Query Parameters:**
- `limit` (integer, optional): Maximum number of tracks to return
- `offset` (integer, optional): Number of tracks to skip

**Response:**
```json
{
  "tracks": [...]
}
```

### `POST /playlists/{playlist_id}/tracks`

Add a track to a playlist.

**Query Parameters:**
- `track_id` (required): ID of the track to add

**Response:**
```json
{
  "message": "Track added to playlist"
}
```

### `DELETE /playlists/{playlist_id}/tracks`

Remove a track from a playlist.

**Query Parameters:**
- `track_id` (required): ID of the track to remove

**Response:**
```json
{
  "message": "Track removed from playlist"
}
```

### `DELETE /playlists/{playlist_id}`

Delete a playlist.

**Response:**
```json
{
  "message": "Playlist deleted"
}
```

## User Management

### `POST /auth/signup`

Create a new user account.

**Request Body:**
```json
{
  "username": "new_user"
}
```

**Response:**
```json
{
  "auth_hash": "generated_auth_hash",
  "username": "new_user",
  "created_at": "2023-01-01T00:00:00Z"
}
```

### `POST /auth/signin`

Authenticate a user.

**Request Body:**
```json
{
  "auth_hash": "user_auth_hash"
}
```

**Response:**
```json
{
  "message": "Authentication successful"
}
```

## Download Queue (Legacy)

Note: The download endpoints are available but the current UI focuses on uploads. These may be used by external clients.

### `POST /downloads`

Queue a download job.

**Request Body:**
```json
{
  "query": "https://open.spotify.com/track/...",
  "source": "auto"
}
```

**Response:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440004",
  "status": "queued"
}
```

### `GET /downloads`

List download jobs.

**Response:**
```json
{
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440004",
      "query": "https://open.spotify.com/track/...",
      "status": "completed",
      "progress": 100,
      "created_at": "2023-01-01T00:00:00Z",
      "completed_at": "2023-01-01T00:01:00Z"
    }
  ]
}
```

### `GET /downloads/{job_id}`

Get download job status.

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "query": "https://open.spotify.com/track/...",
  "status": "completed",
  "progress": 100,
  "created_at": "2023-01-01T00:00:00Z",
  "completed_at": "2023-01-01T00:01:00Z",
  "track_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### `GET /events/downloads`

Server-sent events stream for download job updates.

**Response:**
Event stream with updates:
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440004",
  "status": "progress",
  "progress": 50
}
```

## Admin Endpoints

Admin endpoints require elevated permissions and are restricted to admin users.

### `GET /admin/users`

List all users.

**Response:**
```json
{
  "users": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440005",
      "username": "admin",
      "created_at": "2023-01-01T00:00:00Z",
      "is_admin": true
    }
  ]
}
```

### `POST /admin/users`

Create a new user (admin only).

**Request Body:**
```json
{
  "username": "new_user",
  "is_admin": false
}
```

### `DELETE /admin/users/{user_id}`

Delete a user (admin only).

**Response:**
```json
{
  "message": "User deleted"
}
```

### `GET /admin/tracks`

Get all tracks in the system (admin only).

**Query Parameters:**
- `limit` (integer, optional): Maximum number of tracks
- `offset` (integer, optional): Number of tracks to skip

### `DELETE /admin/tracks/{track_id}`

Delete a track (admin only).

**Response:**
```json
{
  "message": "Track deleted"
}
```

## Rate Limiting

Currently, no rate limiting is implemented. However, please be considerate of server resources when making requests.

## Version History

- **v1.0.0**: Initial release with core functionality
- **v1.1.0**: Added playlist management
- **v1.2.0**: Added search functionality
- **v1.3.0**: Added admin interface

## Changelog

See the [CHANGELOG.md](./CHANGELOG.md) file for detailed release notes.