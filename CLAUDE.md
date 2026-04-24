# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Docker Development
```bash
docker compose up --build
```
Then visit http://localhost:8000

To rebuild after code changes:
```bash
docker compose up --build -d
```

### Manual Server Development
```bash
cd server
pip install -r requirements.txt
uvicorn app.main:app --reload
```
The API will be available at http://localhost:8000

### Running Tests
Currently no test suite is configured. Manual testing can be done via the API endpoints or frontend interface.

To test a specific API endpoint manually:
```bash
curl -X GET "http://localhost:8000/health"
```

### Database Migrations
Database schema is initialized automatically on startup. For manual migrations, modify the models in `server/app/models.py` and the startup scripts in `server/app/main.py`.

### Git Workflow
When working with the repository, if you encounter divergent branches:
```bash
# To merge remote changes with local changes
git pull --no-rebase origin main

# To rebase local changes onto remote
git pull --rebase origin main

# To fast-forward only (if no local changes)
git pull --ff-only origin main
```

## Code Architecture

### Overall Structure
- **client/**: Frontend web interface (HTML, CSS, JavaScript)
- **server/**: Backend API (FastAPI with Python)
- **data/**: Persistent storage (SQLite database, music files, downloads, artwork)

### Backend Architecture (server/)
- **app/main.py**: FastAPI application setup and route definitions
- **app/models.py**: SQLAlchemy ORM models (Track, Artist, Album, Playlist, User, etc.)
- **app/schemas.py**: Pydantic models for request/response validation
- **app/settings.py**: Configuration management
- **app/db.py**: Database connection and session management
- **app/services/**: Business logic
  - **library.py**: Music file scanning and metadata extraction
  - **spotiflac.py**: Download job queuing (using SpotiFLAC module)
  - **storage.py**: Directory management utilities

### Frontend Architecture (client/)
- **index.html**: Main application structure
- **styles.css**: Styling for the interface
- **images/**: Static assets (logos, icons)
- **JavaScript**: Embedded in index.html for client-side logic
  - API communication with auth hash authentication
  - Music player controls and playlist management
  - User authentication flow (signup/signin)
  - Admin interface for user/track management

### Key Features
1. **Authentication**: Auth hash stored in localStorage, sent via `x-auth-hash` header
2. **Music Library**: Tracks can be uploaded via files or links (Spotify/Apple Music via SpotiFLAC)
3. **Playlists**: User-created playlists plus special "Liked Songs" playlist
4. **Admin Endpoints**: Protected routes for managing users and tracks
5. **Streaming**: HTTP Range support for efficient audio streaming
6. **Metadata**: Automatic extraction of artist, album, and artwork from audio files

### Important Files
- **API.md**: Complete API endpoint reference
- **server/.env.example**: Environment configuration template
- **server/requirements.txt**: Python dependencies

## Claude Behavior

- **Never auto-commit or auto-push**: Do not create git commits or push to remotes unless explicitly instructed by the user. Await explicit confirmation before any git write operations.