# Context

## What this repo is
Openfy is an open-source, Spotify-inspired music system.
It includes a static web UI and a FastAPI server that stores and streams audio files.

## Current State
- UI is static HTML/CSS/JS served from `server/static/`.
- Server uses SQLite for metadata.
- Music files live in `data/music` (in container: `/data/music`).
- Uploads are the primary ingestion path.
- Most-played is calculated from stream requests.

## Key Commands
Docker:
```bash
docker compose up --build
```

Local server:
```bash
cd server
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Main Endpoints
- `POST /tracks/upload` - upload a local audio file
- `GET /tracks` - list tracks
- `GET /tracks/{id}/stream` - stream a track (range supported)
- `GET /tracks/most-played` - most played
- `GET /search?q=` - search library

## Files to Know
- `server/app/main.py` - API routes and startup
- `server/app/models.py` - database models
- `server/app/services/library.py` - metadata scanning
- `client/index.html` - UI
- `client/styles.css` - UI styling
