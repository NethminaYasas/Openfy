<div align="center">

![Openfy Logo](./client/images/logo_white.png)

# Openfy

*Your music. Your rules. No subscriptions. No surveillance.*

---

## 🎯 Our Mission

Openfy is a response to the growing trend of music streaming monopolies that charge premium subscriptions while collecting excessive user data. We believe:

- **Music ownership matters** – You should own the music you pay for
- **Privacy is a right** – No tracking, no profiling, no data sales
- **Subscription fatigue is real** – Pay once, own forever (infrastructure costs excluded)
- **Community over corporations** – Built by music lovers, not shareholders

We're building a decentralized alternative that puts you in control of your music library, without monthly fees or algorithmic manipulation.

---

## ✨ Features

- **Spotify-inspired UI** – Familiar, intuitive interface you already know
- **Self-hosted music library** – Store and stream your personal collection
- **Link downloads** – Pull music from supported sources (via [SpotiFLAC](https://github.com/AB1908/SpotiFLAC))
- **Metadata extraction** – Automatic scanning of artist, album, artwork, and more
- **HTTP range streaming** – Smooth playback with seeking support
- **Play counts & insights** – See what you listen to most
- **User playlists** – Create and share custom playlists
- **"Liked Songs"** – Quick access to your favorites
- **Multi-user support** – Each user gets their own library and playlists
- **Docker-ready** – Deploy in minutes with `docker-compose`

---

## 🏗️ Architecture

```
Openfy/
├── client/           # Static web UI (HTML, CSS, Vanilla JS)
├── server/           # FastAPI backend
│   ├── app/
│   │   ├── main.py   # API routes & app entry
│   │   ├── models.py # SQLAlchemy ORM models
│   │   ├── schemas.py# Pydantic request/response schemas
│   │   ├── db.py     # Database session management
│   │   └── services/ # Business logic
│   │       ├── library.py   # Metadata scanning
│   │       ├── storage.py   # File handling
│   │       └── spotiflac.py # External downloader integration
├── docker-compose.yml
├── Dockerfile
└── API.md            # Full API reference
```

**Tech Stack**

- **Backend:** FastAPI, SQLAlchemy 2.0, Pydantic v2, SQLite (PostgreSQL compatible)
- **Frontend:** Vanilla JavaScript, HTML5 Canvas, Font Awesome
- **Audio:** Mutagen for metadata, HTTP range requests for streaming
- **Deployment:** Docker, Docker Compose

---

## 🚀 Quick Start

### Docker (Recommended)

```bash
docker compose up --build
```

Open `http://localhost:8000/`.

### Local Development

```bash
cd server
pip install -r requirements.txt
uvicorn app.main:app --reload
```

---

## 📚 API Reference

See **[API.md](./API.md)** for complete endpoint documentation.

Key endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/tracks` | List tracks (newest first) |
| `GET` | `/tracks/{id}/stream` | Stream audio file |
| `POST` | `/tracks/upload` | Upload local audio file |
| `GET` | `/tracks/most-played` | Most played tracks |
| `GET` | `/search?q=...` | Search library |
| `POST` | `/playlists` | Create playlist |
| `POST` | `/downloads` | Queue download from URL |
| `POST` | `/auth/signup` | Create user account |
| `POST` | `/auth/signin` | Authenticate |

---

## 🎵 Getting Started

1. **Create an account** – Sign up from the login screen; save your auth hash
2. **Upload music** – Use the "Upload" tab to add local files or paste a Spotify/YouTube link
3. **Browse & play** – Your library appears on the home page; click any track to play
4. **Organize** – Create playlists, like tracks, and build your perfect collection

### Upload Methods

- **Local files:** Use the file uploader in the UI (coming soon) or call `POST /tracks/upload`
- **From links:** Paste a Spotify/YouTube URL in the upload box to download via SpotiFLAC

---

## 🔐 Authentication

Openfy uses a simple auth-hash system:

1. Sign up → receive an `auth_hash`
2. Include it in requests via `X-Auth-Hash` header
3. The hash identifies your playlists and liked songs

No passwords to forget. Store your hash safely.

---

## 🛡️ Philosophy

### Why Openfy Exists

The music industry has consolidated into a handful of corporations that:

- Charge **$10–$20/month** for access to music you don't own
- **Track your listening habits** to sell targeted ads
- **Pay artists fractions of a cent** per stream
- **Lock you into ecosystems** with DRM and proprietary formats

Openfy flips the script:

- You **own your music files** outright
- **Zero telemetry** – your listening habits stay private
- **Pay artists directly** by buying their albums/merch
- **No lock-in** – your library is just files in a folder

---

## 🤝 Contributing

We welcome contributors who share our vision. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

Areas where you can help:

- Frontend enhancements (responsive design, new features)
- Backend improvements (scalability, additional download sources)
- Documentation & translations
- Testing & bug reports
- Packaging for different platforms

---

## 📄 License

Openfy is licensed under the **MIT License** – see [LICENSE](./LICENSE).

This means you can:
- Use it personally or commercially
- Modify and distribute
- Sublicense

We only ask that you respect the spirit of open source: share improvements, attribute appropriately, and keep music free.

---

## 🙏 Acknowledgments

- **SpotiFLAC** – Download tool integration
- **FastAPI** – Modern Python web framework
- **Mutagen** – Audio metadata library
- **Font Awesome** – Icon set
- The open-source community for building tools that empower users

---

## 📫 Contact & Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/Openfy/issues)
- **Discussions:** [GitHub Discussions](https://github.com/yourusername/Openfy/discussions)
- **Email:** support@openfy.example (replace with actual)

---

<div align="center">

**Built with ❤️ by music lovers, for music lovers.**

*Resist monopolies. Reclaim your music.*

</div>