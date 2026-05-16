# Contributing to Openfy

Thanks for your interest! Here's how to get started.

## Development Setup
```bash
git clone https://github.com/NethminaYasas/Openfy.git
cd Openfy
cp .env.example .env   # fill in your values
docker compose up --build
```

## Backend (Python/FastAPI)
- All source is in `server/app/`
- Run tests: `cd server && pytest`
- Lint: `ruff check server/`
- Security: `bandit -r server/app/`

## Frontend (Vanilla JS)
- All source is in `client/`
- No build step required — ES modules served directly

## Submitting a PR
1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes with clear commit messages
3. Open a PR against `main` with a description of what and why

## Code Style
- Python: follow PEP 8, use type hints, run `ruff` before committing
- JavaScript: use ES modules, no globals, keep functions small
