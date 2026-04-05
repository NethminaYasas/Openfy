# Openfy

Your music. Your rules. No subscriptions. No surveillance.

## Why Openfy?

We built this because we're tired of renting music from big corporations. You pay monthly fees, they track your listening, and you don't own anything. Artists get pennies while streaming companies profit.

Openfy changes that:

- You own your music files
- No tracking, no ads, no monthly fees
- Your library stays private and under your control
- Support artists directly by buying their work

This is music as it should be.

## Features

- Clean, Spotify-like web interface
- Upload local files or download from links
- Automatic metadata scanning (artist, album, artwork)
- Smooth streaming with seek support
- Play counts and most-played tracking
- User playlists and liked songs
- Multi-user support
- Docker-ready deployment

## Getting Started

### Docker

```bash
docker compose up --build
```

Open http://localhost:8000

### Manual

```bash
cd server
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Quick API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tracks` | GET | List all tracks |
| `/tracks/{id}/stream` | GET | Play audio |
| `/tracks/upload` | POST | Upload file |
| `/search?q=` | GET | Search library |
| `/playlists` | GET/POST | Manage playlists |
| `/auth/signup` | POST | Create account |
| `/auth/signin` | POST | Login |

Full API docs: [API.md](./API.md)

## Using Openfy

1. Sign up and save your auth hash
2. Upload music via the Upload tab (files or links)
3. Browse and play from the home page
4. Create playlists and like tracks to organize

Your uploads appear in the Uploads tab; everything else lives in the main library.

## Philosophy

We believe music belongs to listeners and creators, not corporations. Openfy exists to:

- Give you control over your collection
- Protect your privacy
- Reduce reliance on subscription services
- Build community-run alternatives

No algorithms pushing what to listen to next. No surveillance. No lock-in.

## License

MIT. See [LICENSE](./LICENSE).

Built by music lovers, for music lovers.