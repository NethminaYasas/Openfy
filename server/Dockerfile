FROM python:3.11-slim

WORKDIR /app

COPY server/requirements.txt /app/requirements.txt
COPY scripts/check_spotiflac_update.sh /tmp/check_spotiflac_update.sh

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ffmpeg \
  && pip install --no-cache-dir -r requirements.txt \
  && bash /tmp/check_spotiflac_update.sh \
  && rm /tmp/check_spotiflac_update.sh \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY server/app /app/app
COPY server/spotify_search.py /app/spotify_search.py
COPY client /app/client
COPY server/.env.example /app/.env

# Copy SpotifyScraper for artist image fetching
COPY server/spotify_scraper /usr/local/lib/python3.11/site-packages/spotify_scraper

ENV OPENFY_ENV=prod
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
