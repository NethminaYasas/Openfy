FROM python:3.11-slim

WORKDIR /app

COPY server/requirements.txt /app/requirements.txt
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ffmpeg \
  && pip install --no-cache-dir -r requirements.txt \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY server/app /app/app
COPY client /app/client
COPY server/.env.example /app/.env

# Copy Apple Music downloader into the installed SpotiFLAC package
COPY server/SpotiFLAC /usr/local/lib/python3.11/site-packages/SpotiFLAC

ENV OPENFY_ENV=prod
ENV OPENFY_DATA_DIR=/data
ENV OPENFY_MUSIC_DIR=/data/music
ENV OPENFY_DOWNLOADS_DIR=/data/downloads
ENV OPENFY_ARTWORK_DIR=/data/artwork
ENV OPENFY_DATABASE_URL=sqlite:////data/openfy.db

VOLUME ["/data"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
