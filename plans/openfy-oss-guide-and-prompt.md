# Professional Open Source Project: Best Practices & Openfy Fix Prompt

---

## Part 1: How to Organize a Professional Open Source Project

### Ideal Repository Structure

```
my-project/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml          # lint, test, build on every PR
│       └── release.yml     # publish on tag push
│
├── docs/                   # extended documentation
│   ├── ARCHITECTURE.md
│   ├── CONTRIBUTING.md
│   └── DEPLOYMENT.md
│
├── client/                 # frontend source
│   ├── src/
│   │   ├── modules/        # ES module files
│   │   ├── styles/
│   │   └── index.html
│   └── public/
│
├── server/                 # backend source
│   ├── app/
│   │   ├── api/            # route handlers
│   │   ├── models/         # DB models
│   │   ├── schemas/        # Pydantic schemas
│   │   ├── services/       # business logic
│   │   └── main.py
│   ├── tests/
│   │   ├── unit/
│   │   └── integration/
│   ├── Dockerfile
│   └── requirements.txt
│
├── scripts/                # dev/admin helper scripts
│   └── generate_hash.py
│
├── .dockerignore
├── .editorconfig           # consistent editor settings for contributors
├── .gitignore
├── .env.example            # template, never .env itself
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── SECURITY.md             # vulnerability disclosure process
└── docker-compose.yml
```

---

### Root-Level Files Every Professional OSS Repo Needs

| File | Purpose |
|---|---|
| `README.md` | First impression — what it is, how to run it, screenshots |
| `CONTRIBUTING.md` | How to submit PRs, coding style, branch conventions |
| `CHANGELOG.md` | Version history in [Keep a Changelog](https://keepachangelog.com) format |
| `CODE_OF_CONDUCT.md` | Community standards (use Contributor Covenant) |
| `SECURITY.md` | How to report vulnerabilities **privately** (not via public issues) |
| `LICENSE` | Machine-readable license file |
| `.env.example` | All env vars documented with safe placeholder values |

---

### Key Best Practices

**Repository hygiene**
- Never commit `.env` files or secrets — use `.env.example` with placeholder values and document every variable
- Pin dependency versions in `requirements.txt` / `package-lock.json` for reproducible builds
- Tag releases with semantic versioning (`v1.0.0`) and maintain a `CHANGELOG.md`
- Keep `main` protected — require PRs and passing CI before merging

**Code organization**
- Separate concerns: routes → services → models (never put business logic in route handlers)
- One file = one responsibility; avoid monolithic files over ~400 lines
- Keep tests adjacent to or mirroring source structure (`tests/unit/`, `tests/integration/`)
- Use type hints (Python) or JSDoc (JS) consistently

**CI/CD (GitHub Actions)**
- Run linting (`ruff`), security scanning (`bandit`, `pip-audit`), and tests on every push/PR
- Build and push Docker image to GHCR on tag push
- Add a `codecov` badge in README once coverage reporting is set up

**Docker best practices**
- Use multi-stage builds to keep images small
- Run as a non-root user inside the container
- Never bake secrets into the image — always inject via environment variables
- Pin the base image tag (`python:3.12-slim`, not `python:latest`)

**Security posture**
- Add a `SECURITY.md` with a private disclosure email or GitHub private advisory link
- Use GitHub's Dependabot or `pip-audit` in CI for dependency CVE scanning
- Validate and sanitize all user input at the boundary (schemas layer)

**Documentation**
- Keep `README.md` as the "5-minute" entry point — Quick Start first, details later
- Put deeper content (architecture decisions, API reference, deployment guides) in `docs/`
- Screenshots and demo GIFs dramatically increase contributor interest

---

## Part 2: Openfy-Specific Issues Identified

From reviewing the repo, the following issues stand out:

### Critical / High Priority
1. **Hardcoded admin hash in `docker-compose.yml`** — `OPENFY_ADMIN_HASH` is committed in plaintext, anyone who clones the repo has a working credential
2. **License mismatch** — `README.md` says MIT, but `LICENSE` file is GPL-3.0
3. **No `SECURITY.md`** — vulnerability disclosure process is missing; `SECURITY_AUDIT.md` is an internal log, not a disclosure policy for contributors
4. **No `.env.example`** — new users don't know what env vars are needed without reading the README carefully
5. **Circular FK (`tracks ↔ users`)** — noted in `SECURITY_AUDIT.md` as an open issue causing SQLAlchemy warnings
6. **Auth model (`auth_hash`) has no session expiry** — noted as open high risk in security audit

### Medium Priority
7. **`SECURITY_AUDIT.md` contains local filesystem paths** (`(project root)`) — leaks developer environment details publicly
8. **In-memory rate limiting** — won't survive restarts or scale across multiple workers
9. **Missing GitHub Actions CI** — no automated lint/test/build pipeline visible
10. **Missing `CONTRIBUTING.md`** — no guidance for external contributors
11. **`data/` folder committed** — runtime data directory tracked in git (should be gitignored)
12. **No `CHANGELOG.md`** — 345 commits with no structured release history

### Low Priority
13. **`repo_images/` in root** — screenshots clutter the root; better in `docs/` or a `screenshots/` subfolder
14. **README architecture section** mentions React+Vite but codebase description says Vanilla JS — inconsistency suggesting a partial migration
15. **No `CODE_OF_CONDUCT.md`**

---

## Part 3: Claude Code Prompt — Openfy Comprehensive Fix

Copy and paste this prompt into a Claude Code session with the Openfy repo open:

---

```
You are working on the Openfy open-source music streaming project at the root of this repository. 
The tech stack is: FastAPI (Python 3.12+) backend in server/, Vanilla JS (ES modules) frontend 
in client/, SQLite via SQLAlchemy, Docker Compose deployment.

I need you to fix a series of issues across the entire project. Work through them 
systematically, one category at a time, and commit each category as a separate git commit 
with a descriptive message.

---

## CATEGORY 1 — Critical Security Fixes

### 1a. Remove hardcoded admin credentials from docker-compose.yml
- Remove OPENFY_ADMIN_HASH and OPENFY_ADMIN_USERNAME from docker-compose.yml
- Replace them with references to a .env file: use `env_file: - .env` in the service definition
- Create `.env.example` in the repo root with all required variables and safe placeholder values:

  OPENFY_ENV=dev
  OPENFY_ADMIN_USERNAME=admin
  OPENFY_ADMIN_HASH=<run: python scripts/generate_hash.py yourpassword>
  OPENFY_ALLOWED_ORIGINS=http://localhost:8000
  OPENFY_MAX_UPLOAD_SIZE_MB=200
  OPENFY_DATABASE_URL=sqlite:///./data/openfy.db
  OPENFY_DATA_DIR=./data
  OPENFY_MUSIC_DIR=./data/music
  OPENFY_DOWNLOADS_DIR=./data/downloads
  OPENFY_ARTWORK_DIR=./data/artwork

- Add .env to .gitignore if not already present
- Add a note in README.md under Configuration: "Copy `.env.example` to `.env` and fill in your values before starting"

### 1b. Fix the SQLAlchemy circular FK warning
- In server/app/models.py (or wherever the Users and Tracks models are defined), locate the 
  circular foreign key between tracks.user_hash → users.auth_hash and users.last_track_id → tracks.id
- Add use_alter=True and name="fk_users_last_track" to the users.last_track_id ForeignKey 
  so SQLAlchemy can determine a safe DROP order
- Verify with: python -m compileall server/app/

### 1c. Create SECURITY.md
Create a new file SECURITY.md in the repo root with this content (adapt as needed):

  # Security Policy

  ## Supported Versions
  Only the latest commit on `main` receives security fixes at this stage.

  ## Reporting a Vulnerability
  Please do NOT open a public GitHub issue for security vulnerabilities.

  Report vulnerabilities privately via GitHub Security Advisories:
  https://github.com/NethminaYasas/Openfy/security/advisories/new

  You can expect an initial response within 7 days.

  ## Known Limitations (by Design)
  - Artwork endpoints are unauthenticated by design to support browser <img> loading
  - Rate limiting is in-memory only; not suitable for multi-worker deployments
  - The auth_hash model has no session expiry; treat it as a long-lived token

---

## CATEGORY 2 — Repository Hygiene

### 2a. Fix the license mismatch
- README.md currently says "License: MIT" but the LICENSE file is GPL-3.0
- Update README.md to say "License: GPL-3.0" to match the actual LICENSE file
- Also update the license badge if one exists

### 2b. Redact personal filesystem path from SECURITY_AUDIT.md
- Find the line: **Path:** `(project root)`
- Replace it with: **Path:** `(repository root)`

### 2c. Add missing root-level community files

Create CONTRIBUTING.md with:
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

Create CODE_OF_CONDUCT.md using the standard Contributor Covenant v2.1 text 
(you can fetch it from https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md 
or write it out in full).

Create CHANGELOG.md with:
  # Changelog
  All notable changes to this project will be documented here.
  Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

  ## [Unreleased]
  ### Security
  - Removed user_hash from TrackOut schema to prevent credential exposure
  - Added SSRF hardening for remote artwork fetch endpoints
  - Added remote image fetch byte cap (8MB) and content-type validation
  - Hardened auth_hash input validation (strict hex format)

  ### Fixed
  - Artwork endpoint auth regression restored browser image loading compatibility

### 2d. Update .gitignore
Add these entries to .gitignore if not present:
  # Environment
  .env
  
  # Runtime data (Docker volume or local)
  data/
  
  # Python
  __pycache__/
  *.pyc
  .pytest_cache/
  .ruff_cache/
  
  # Editor
  .vscode/
  .idea/
  *.swp

---

## CATEGORY 3 — GitHub Actions CI Pipeline

Create .github/workflows/ci.yml:

  name: CI

  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]

  jobs:
    backend:
      name: Backend — Lint, Security, Test
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with:
            python-version: "3.12"
        - name: Install dependencies
          run: |
            cd server
            pip install -r requirements.txt
            pip install ruff bandit pip-audit pytest
        - name: Lint (ruff)
          run: ruff check server/
        - name: Security scan (bandit)
          run: bandit -r server/app/ -ll
        - name: Dependency audit (pip-audit)
          run: pip-audit -r server/requirements.txt
        - name: Tests (pytest)
          run: |
            cd server
            pytest --tb=short

    docker:
      name: Docker Build Check
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: Build Docker image
          run: docker build -f server/Dockerfile .

Create .github/ISSUE_TEMPLATE/bug_report.md:
  ---
  name: Bug Report
  about: Something isn't working
  labels: bug
  ---
  
  **Describe the bug**
  A clear description of what went wrong.
  
  **Steps to reproduce**
  1. Go to '...'
  2. Do '...'
  3. See error
  
  **Expected behavior**
  What you expected to happen.
  
  **Environment**
  - Openfy version / commit:
  - Deployment: Docker / Manual
  - Browser:
  - OS:
  
  **Logs**
  ```
  paste relevant logs here
  ```

Create .github/ISSUE_TEMPLATE/feature_request.md:
  ---
  name: Feature Request
  about: Suggest an idea
  labels: enhancement
  ---
  
  **Is this related to a problem?**
  Describe the problem this would solve.
  
  **Proposed solution**
  How would you want this to work?
  
  **Alternatives considered**
  Any other approaches you thought about?

---

## CATEGORY 4 — README Improvements

Update README.md with these changes:

### 4a. Fix license badge / footer — change MIT to GPL-3.0

### 4b. Add a Prerequisites section before Quick Start:
  ## Prerequisites
  - Docker and Docker Compose
  - For manual setup: Python 3.12+

### 4c. Add a section for generating the admin hash:
  ## Generating an Admin Hash
  ```bash
  python scripts/generate_hash.py yourpassword
  ```
  Copy the output hash into your `.env` as `OPENFY_ADMIN_HASH`.

  If `scripts/generate_hash.py` does not exist, create it:
  ```python
  #!/usr/bin/env python3
  import hashlib, sys
  if len(sys.argv) != 2:
      print("Usage: python generate_hash.py <password>")
      sys.exit(1)
  print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
  ```

### 4d. Fix the Architecture section
  The README says "Vanilla JS with ES modules" in Architecture but the Tech Stack section 
  is accurate. Remove any stale references to React/Vite if the client is vanilla JS, 
  or clarify if a React migration is underway.

### 4e. Move screenshots reference
  Add a note: "See the `docs/screenshots/` directory for more screenshots."
  Move repo_images/ → docs/screenshots/ and update all image paths in README.md accordingly.
  
  Old path pattern: ![Home Page](repo_images/home_page.png)
  New path pattern: ![Home Page](docs/screenshots/home_page.png)

---

## CATEGORY 5 — Project Structure Cleanup

### 5a. Move docs into docs/ folder
Move API.md and SECURITY_AUDIT.md into a new docs/ directory:
  docs/
    API.md
    SECURITY_AUDIT.md
    screenshots/   (moved from repo_images/)

Update any internal links that referenced these files.

### 5b. Create a helper scripts/ directory
Create scripts/ directory and add scripts/generate_hash.py as described in 4c above.
Add a README note that scripts/ contains developer/admin utilities.

---

## VERIFICATION

After all changes, run these checks:
1. python -m compileall server/app/             → must pass with no errors
2. ruff check server/                            → must pass (fix any issues found)
3. docker compose build                          → must succeed
4. Confirm .env is in .gitignore and NOT tracked: git ls-files .env → should return nothing
5. Confirm no personal paths remain: grep -r "nethmina" . --include="*.md" → should be empty

Then commit each category separately:
  git commit -m "security: remove hardcoded admin hash, add .env.example"
  git commit -m "fix: resolve SQLAlchemy circular FK warning with use_alter"
  git commit -m "docs: add SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, CHANGELOG.md"
  git commit -m "ci: add GitHub Actions CI pipeline with lint, security, and test jobs"
  git commit -m "chore: fix license mismatch (MIT→GPL-3.0 in README)"
  git commit -m "chore: move screenshots to docs/, add scripts/generate_hash.py"
  git commit -m "docs: update README with prerequisites, hash generation, fixed arch section"
```

---

*Guide and prompt prepared for Openfy — May 2026*
