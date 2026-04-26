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
    Table,
    Column,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


# Association table for many-to-many Track-Artist relationship
track_artist = Table(
    "track_artist",
    Base.metadata,
    Column(
        "track_id",
        String(36),
        ForeignKey("tracks.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "artist_id",
        String(36),
        ForeignKey("artists.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "position", Integer, nullable=False, default=0
    ),  # Order of artists for a track
)


class Artist(Base):
    __tablename__ = "artists"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    albums = relationship("Album", back_populates="artist")
    tracks = relationship(
        "Track", back_populates="artist"
    )  # primary artist via artist_id
    many_tracks = relationship(
        "Track", secondary=track_artist, back_populates="artists"
    )  # full many-to-many


class Album(Base):
    __tablename__ = "albums"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    artwork_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    artist_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("artists.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    artist = relationship("Artist", back_populates="albums")
    tracks = relationship("Track", back_populates="album")

    # Unique constraint removed to allow albums with same title when artist is unspecified


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
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
    source_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)  # Spotify/Apple Music track ID
    universal_track_id: Mapped[str | None] = mapped_column(
        String(64), index=True, nullable=True
    )

    artist = relationship(
        "Artist", back_populates="tracks"
    )  # primary artist via artist_id
    artists = relationship(
        "Artist",
        secondary=track_artist,
        back_populates="many_tracks",
        order_by="track_artist.c.position",
    )  # full many-to-many with ordering
    album = relationship("Album", back_populates="tracks")
    plays = relationship(
        "TrackPlay", back_populates="track", cascade="all, delete-orphan"
    )
    playlist_tracks = relationship(
        "PlaylistTrack", back_populates="track", cascade="all, delete-orphan"
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    auth_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    is_admin: Mapped[bool] = mapped_column(Integer, default=0)
    upload_enabled: Mapped[bool] = mapped_column(Integer, default=1)
    last_track_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("tracks.id"), nullable=True
    )
    library_minimized: Mapped[bool] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    playlists = relationship(
        "Playlist", back_populates="user", cascade="all, delete-orphan"
    )
    last_track = relationship("Track", foreign_keys=[last_track_id])


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_hash: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.auth_hash"), index=True
    )
    is_liked: Mapped[bool] = mapped_column(Integer, default=0)
    pinned: Mapped[bool] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_hash", "name", name="uq_user_playlist_name"),
    )

    user = relationship("User", back_populates="playlists")
    tracks = relationship(
        "PlaylistTrack", back_populates="playlist", cascade="all, delete-orphan"
    )


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"

    playlist_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("playlists.id", ondelete="CASCADE"), primary_key=True
    )
    track_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)

    playlist = relationship("Playlist", back_populates="tracks")
    track = relationship("Track", back_populates="playlist_tracks")


class TrackPlay(Base):
    __tablename__ = "track_plays"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    track_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("tracks.id", ondelete="CASCADE"), index=True
    )
    played_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )
    user_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    track = relationship("Track", back_populates="plays")


class DownloadJob(Base):
    __tablename__ = "download_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    source: Mapped[str] = mapped_column(String(120))
    query: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    output_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    log: Mapped[str | None] = mapped_column(Text, nullable=True)
    embed_lyrics: Mapped[str | None] = mapped_column(Text, nullable=True, server_default="")  # Legacy field, kept for schema compatibility
    lyrics: Mapped[str | None] = mapped_column(Text, nullable=True, server_default="")  # Legacy field
    artist: Mapped[str | None] = mapped_column(String(255), nullable=True, server_default="")  # Legacy field
    album: Mapped[str | None] = mapped_column(String(255), nullable=True, server_default="")  # Legacy field
    title: Mapped[str | None] = mapped_column(String(255), nullable=True, server_default="")  # Legacy field
    duration: Mapped[int | None] = mapped_column(Integer, nullable=True, server_default="0")  # Legacy field
    user_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
