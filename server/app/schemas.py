from datetime import datetime
from pydantic import BaseModel, Field


class ArtistBase(BaseModel):
    name: str


class ArtistOut(ArtistBase):
    id: str
    created_at: datetime

    class Config:
        from_attributes = True


class AlbumBase(BaseModel):
    title: str
    year: int | None = None
    artist_id: str | None = None


class AlbumOut(AlbumBase):
    id: str
    artwork_path: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class TrackBase(BaseModel):
    title: str
    artist_id: str | None = None
    album_id: str | None = None


class TrackOut(TrackBase):
    id: str
    file_path: str
    file_size: int | None = None
    duration: float | None = None
    mime_type: str | None = None
    bitrate: int | None = None
    sample_rate: int | None = None
    channels: int | None = None
    track_no: int | None = None
    disc_no: int | None = None
    play_count: int = 0
    created_at: datetime
    updated_at: datetime

    artist: ArtistOut | None = None
    album: AlbumOut | None = None

    class Config:
        from_attributes = True


class PlaylistCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None


class PlaylistOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class PlaylistTrackOut(BaseModel):
    track: TrackOut
    position: int

    class Config:
        from_attributes = True


class DownloadRequest(BaseModel):
    query: str = Field(..., min_length=1)
    source: str = "auto"


class DownloadJobOut(BaseModel):
    id: str
    source: str
    query: str
    status: str
    output_path: str | None = None
    log: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
