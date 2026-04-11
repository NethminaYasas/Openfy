# Openfy

A self-hosted music streaming platform that puts you in control of your music library.

## Overview

Openfy is a modern, web-based music player and management system designed for music enthusiasts who value ownership and privacy. It provides a Spotify-like experience without the subscriptions, tracking, or vendor lock-in. Built with modern web technologies, Openfy allows you to upload, organize, and stream your personal music collection from any device.

## Key Features

- **Web-based Interface**: Access your music library from any web browser
- **Local Music Management**: Upload local audio files or download from Spotify/Apple Music links
- **Metadata Extraction**: Automatic artist, album, and artwork detection using Mutagen
- **High-Quality Streaming**: HTTP Range requests for efficient audio playback
- **User Management**: Multi-user support with separate libraries and authentication
- **Playlist Support**: Create and manage custom playlists
- **Play Statistics**: Track play counts and identify your most-played songs
- **Admin Interface**: Built-in administrative controls for user and track management
- **Responsive Design**: Optimized for both desktop and mobile devices
- **Docker Support**: Easy deployment with Docker Compose

## Technical Architecture

### Frontend
- **Client**: Vanilla HTML, CSS, and JavaScript (no framework dependencies)
- **UI Framework**: Custom CSS with Font Awesome icons
- **Audio Engine**: HTML5 Audio API with custom controls
- **Authentication**: Client-side auth hash management

### Backend
- **Framework**: FastAPI (Python 3.8+)
- **ORM**: SQLAlchemy 2.0 with SQLite
- **Authentication**: Token-based auth system
- **Audio Processing**: Mutagen for metadata extraction
- **Download Service**: SpotiFLAC integration for external track downloads

### Data Storage
- **Database**: SQLite for user and track metadata
- **File Storage**: Organized directory structure for audio files and artwork
- **Caching**: In-memory caching for frequently accessed data

## Installation

### Prerequisites
- Python 3.8 or higher
- Docker and Docker Compose (optional)

### Quick Install with Docker

1. Clone the repository:
```bash
git clone https://github.com/yourusername/Openfy.git
cd Openfy
```

2. Start the application:
```bash
docker compose up --build
```

3. Access the web interface at `http://localhost:8000`

### Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/Openfy.git
cd Openfy
```

2. Install Python dependencies:
```bash
cd server
pip install -r requirements.txt
```

3. Configure environment variables (optional):
```bash
cp .env.example .env
# Edit .env with your settings
```

4. Start the development server:
```bash
uvicorn app.main:app --reload
```

5. Access the web interface at `http://localhost:8000`

## Configuration

### Environment Variables

Create a `.env` file in the `server` directory:

```env
# CORS settings
OPENFY_ALLOWED_ORIGINS=*

# Admin configuration
OPENFY_ADMIN_USERNAME=admin
OPENFY_ADMIN_HASH=your_secure_hash_here

# API configuration
OPENFY_API_BASE_URL=
```

### Data Persistence

The application creates several directories for data storage:
- `data/music/`: Stores uploaded and downloaded audio files
- `data/artwork/`: Stores album artwork images
- `data/openfy.db`: SQLite database file

## Usage Guide

### First-time Setup

1. **Create an Account**: Sign up through the web interface
2. **Save Your Auth Hash**: The auth hash is stored in localStorage for future sessions
3. **Upload Music**: 
   - Use the Upload tab to add local audio files
   - Paste Spotify or Apple Music links for automatic downloads
4. **Explore Your Library**: Browse tracks, create playlists, and start playing

### Navigation

- **Home Page**: Recently added tracks and quick access to features
- **Library**: Search and filter all available music
- **Uploads**: View and manage personally uploaded tracks
- **Playlists**: Create and organize custom collections
- **Admin**: Manage users and tracks (admin only)

### Audio Controls

- **Play/Pause**: Use the spacebar or the play button
- **Progress Bar**: Click to seek to any position in the track
- **Volume Control**: Use the slider to adjust playback volume
- **Navigation**: Use previous/next buttons to change tracks

### Administrative Functions

Admin users can:
- Manage user accounts (create, modify, delete)
- View and manage the entire track library
- Monitor system usage and statistics
- Configure system settings

## API Documentation

The API provides RESTful endpoints for all functionality. Authentication is handled via the `x-auth-hash` header.

### Authentication

```bash
# Sign up
curl -X POST "http://localhost:8000/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"username": "john_doe"}'

# Sign in
curl -X POST "http://localhost:8000/auth/signin" \
  -H "Content-Type: application/json" \
  -d '{"auth_hash": "your_hash_here"}'
```

### Track Management

```bash
# List tracks
curl -X GET "http://localhost:8000/tracks?limit=50&offset=0" \
  -H "x-auth-hash: your_hash_here"

# Upload track
curl -X POST "http://localhost:8000/tracks/upload" \
  -H "x-auth-hash: your_hash_here" \
  -F "file=@/path/to/track.mp3"

# Stream track
curl -X GET "http://localhost:8000/tracks/{track_id}/stream" \
  -H "Range: bytes=0-1024"
```

### Playlist Management

```bash
# Create playlist
curl -X POST "http://localhost:8000/playlists" \
  -H "Content-Type: application/json" \
  -H "x-auth-hash: your_hash_here" \
  -d '{"name": "My Playlist", "description": "Description optional"}'

# Add track to playlist
curl -X POST "http://localhost:8000/playlists/{playlist_id}/tracks?track_id={track_id}" \
  -H "x-auth-hash: your_hash_here"
```

### Search

```bash
# Search library
curl -X GET "http://localhost:8000/search?q=artist_name&limit=20" \
  -H "x-admin-hash: your_hash_here"
```

For complete API documentation, see [API.md](./API.md).

## Development

### Project Structure

```
Openfy/
├── client/                    # Frontend application
│   ├── index.html           # Main application entry point
│   ├── styles.css           # Application styles
│   ├── script.js            # Client-side JavaScript
│   └── images/              # Static assets
├── server/                  # Backend application
│   ├── app/                # Application core
│   │   ├── main.py         # FastAPI application and routes
│   │   ├── models.py       # SQLAlchemy models
│   │   ├── schemas.py      # Pydantic schemas
│   │   ├── services/       # Business logic
│   │   │   ├── library.py  # Music library management
│   │   │   ├── spotiflac.py # Download service
│   │   │   └── storage.py  # File system utilities
│   │   └── db.py           # Database connection
│   ├── requirements.txt    # Python dependencies
│   └── Dockerfile         # Container definition
├── data/                   # Runtime data directory
│   ├── music/             # Audio files
│   └── artwork/           # Album artwork
└── docker-compose.yml      # Container orchestration
```

### Running Tests

Currently, no test suite is implemented. The application can be tested manually using the web interface or API endpoints.

### Adding Features

1. **Backend Features**: Add endpoints in `server/app/main.py`
2. **Models**: Define data models in `server/app/models.py`
3. **Frontend Features**: Extend `client/script.js` and `client/styles.css`
4. **Services**: Implement business logic in `server/app/services/`

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow the existing code style and structure
- Add appropriate comments for complex logic
- Test your changes thoroughly
- Update documentation for new features

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Support

- Report bugs: [GitHub Issues](https://github.com/yourusername/Openfy/issues)
- Feature requests: [GitHub Discussions](https://github.com/yourusername/Openfy/discussions)
- Documentation: [Wiki](https://github.com/yourusername/Openfy/wiki)

## Acknowledgments

- FastAPI team for the excellent web framework
- SQLAlchemy team for the powerful ORM
- SpotiFLAC for the music download integration
- Font Awesome for the icon library

---

Built with ❤️ by music lovers, for music lovers.