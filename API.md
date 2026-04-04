# Openfy Server API

Base URL (local): `http://localhost:8000`

All responses are JSON unless otherwise noted.

## Health

### `GET /health`
Returns server status.

Response:
```json
{ "status": "ok" }
```

## Library

### `POST /library/scan`
Scan the default music directory or a custom path.

Query params:
- `path` (optional): Absolute or relative path to scan.

Response:
```json
{ "scanned": 12, "new": 4 }
```

## Tracks

### `GET /tracks`
List tracks ordered by newest.

Query params:
- `limit` (default 50, max 200)
- `offset` (default 0)

Response: array of Track objects.

### `GET /tracks/{track_id}`
Get track metadata by id.

### `GET /tracks/{track_id}/stream`
Stream an audio file. Supports HTTP Range for partial reads. Increments `play_count`.

### `GET /tracks/most-played`
List most played tracks.

Query params:
- `limit` (default 12, max 100)

### `POST /tracks/upload`
Upload a local audio file. The server stores it in the music directory and indexes it.

Multipart form:
- `file`: audio file

## Artists

### `GET /artists`
List all artists ordered by name.

## Albums

### `GET /albums`
List all albums ordered by title.

## Search

### `GET /search?q=...`
Search by track title, artist name, or album title.

Query params:
- `q` (required)
- `limit` (default 50, max 200)

## Playlists

### `POST /playlists`
Create a playlist.

Body:
```json
{ "name": "My Playlist", "description": "optional" }
```

### `GET /playlists`
List playlists.

### `GET /playlists/{playlist_id}`
Get a playlist.

### `GET /playlists/{playlist_id}/tracks`
List tracks in a playlist.

### `POST /playlists/{playlist_id}/tracks?track_id=...`
Add a track to a playlist.

### `DELETE /playlists/{playlist_id}/tracks/{track_id}`
Remove a track from a playlist.

## Downloads (Legacy)

The download endpoints exist but the current UI uses **uploads** only. If you enable downloaders,
these endpoints may be used by clients.

### `POST /downloads`
Queue a download job.

Body:
```json
{ "query": "https://open.spotify.com/track/...", "source": "auto" }
```

### `GET /downloads`
List download jobs.

### `GET /downloads/{job_id}`
Get a single download job.

### `GET /events/downloads`
Server-sent events stream of download job updates.
