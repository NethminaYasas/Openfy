# Openfy

Openfy is an open-source music system with a Spotify-inspired web UI and a local-file server.
The server stores audio files, indexes metadata, and exposes a clean REST API for clients.

## Features
- Spotify-inspired web UI
- Upload local audio files into your library
- Metadata scanning and library search
- HTTP range streaming endpoint
- Most-played tracking
- Docker-ready setup

## Project Structure
- `client/` - Web UI (static)
- `server/` - FastAPI server
- `server/static/` - Static UI served by the server
- `API.md` - Server API reference

## Quick Start (Docker)
```bash
docker compose up --build
```
Open `http://localhost:8000/`.

## Local Development
```bash
cd server
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Uploading Music
Use the **Uploads** tab in the UI or call:
```
POST /tracks/upload
```
with a multipart `file` field.

## Notes
- The current UI uses uploads only (downloads are optional/legacy).
- Static UI files are served from `server/static/`.

## License
See `LICENSE`.
