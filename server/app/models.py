import uuid
from datetime import datetime

from sqlalchemy import (
    String,
    Integer,
    DateTime,
    ForeignKey,
    Text,
    UniqueConstraint,
    Float,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Artist(Base):
    __tablename__ = "artists"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    albums = relationship("Album", back_populates="artist")
    tracks = relationship("Track", back_populates="artist")


class Album(Base):
    __tablename__ = "albums"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(255), index=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    artwork_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    artist_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("artists.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    artist = relationship("Artist", back_populates="albums")
    tracks = relationship("Track", back_populates="album")

    __table_args__ = (
        UniqueConstraint("title", "artist_id", name="uq_album_title_artist"),
    )


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(255), index=True)
    file_path: Mapped[str] = mapped_column(String(512), unique=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bitrate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sample_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    channels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    track_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    disc_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    play_count: Mapped[int] = mapped_column(Integer, default=0)
    user_hash: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.auth_hash"), index=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    artist_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("artists.id"))
    album_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("albums.id"))

    artist = relationship("Artist", back_populates="tracks")
    album = relationship("Album", back_populates="tracks")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    auth_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    playlists = relationship(
        "Playlist", back_populates="user", cascade="all, delete-orphan"
    )


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_hash: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.auth_hash"), index=True
    )
    is_liked: Mapped[bool] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="playlists")
    tracks = relationship(
        "PlaylistTrack", back_populates="playlist", cascade="all, delete-orphan"
    )


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"

    playlist_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("playlists.id"), primary_key=True
    )
    track_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("tracks.id"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)

    playlist = relationship("Playlist", back_populates="tracks")
    track = relationship("Track")


class DownloadJob(Base):
    __tablename__ = "download_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    source: Mapped[str] = mapped_column(String(120))
    query: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    output_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    log: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
