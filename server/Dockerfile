FROM python:3.11-slim AS dependencies

# Git is needed only for the SpotiFLAC dependency and its update check.
# Prefer binary wheels for native dependencies on both runner architectures.
ENV PIP_PREFER_BINARY=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && python -m venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /build
COPY server/requirements.txt /build/requirements.txt
COPY scripts/check_spotiflac_update.sh /build/check_spotiflac_update.sh
RUN pip install --no-cache-dir --prefer-binary -r requirements.txt \
  && bash /build/check_spotiflac_update.sh \
  && find /opt/venv -name '__pycache__' -type d -exec rm -rf {} + \
  && find /opt/venv -name '*.pyc' -delete

FROM python:3.11-slim

# Only runtime OS packages and installed Python files enter the final image.
# Keep dependency layers above release metadata and application source so
# changing a release tag or source file can reuse them.
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

COPY --from=dependencies /opt/venv /opt/venv
COPY server/requirements.txt /app/requirements.txt
ENV PATH="/opt/venv/bin:${PATH}"

# Release metadata, injected by the release workflow (--build-arg).
# Defaults keep local `docker build` / `docker compose up --build` working.
ARG OPENFY_VERSION=dev
ARG OPENFY_REVISION=unknown
ARG OPENFY_CREATED=unknown

LABEL org.opencontainers.image.title="Openfy" \
      org.opencontainers.image.description="Self-hosted music streaming platform" \
      org.opencontainers.image.source="https://github.com/NethminaYasas/Openfy" \
      org.opencontainers.image.url="https://github.com/NethminaYasas/Openfy" \
      org.opencontainers.image.version="${OPENFY_VERSION}" \
      org.opencontainers.image.revision="${OPENFY_REVISION}" \
      org.opencontainers.image.created="${OPENFY_CREATED}" \
      org.opencontainers.image.licenses="GPL-3.0-only"

COPY server/app /app/app
COPY server/spotify_search.py /app/spotify_search.py
COPY client /app/client
COPY server/.env.example /app/.env

# Copy SpotifyScraper for artist image fetching
COPY server/spotify_scraper /opt/venv/lib/python3.11/site-packages/spotify_scraper

ENV OPENFY_ENV=prod
ENV PYTHONDONTWRITEBYTECODE=1
ENV OPENFY_DATA_DIR=/data
ENV OPENFY_MUSIC_DIR=/data/music
ENV OPENFY_DOWNLOADS_DIR=/data/downloads
ENV OPENFY_ARTWORK_DIR=/data/artwork
ENV OPENFY_DATABASE_URL=sqlite:////data/openfy.db

VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
