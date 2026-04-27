from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict


class ArtistBase(BaseModel):
    name: str


class ArtistOut(ArtistBase):
    id: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AlbumBase(BaseModel):
    title: str
    year: int | None = None
    artist_id: str | None = None


class AlbumOut(AlbumBase):
    id: str
    artwork_path: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TrackBase(BaseModel):
    title: str
    artist_id: str | None = None
    album_id: str | None = None


class TrackOut(TrackBase):
    id: str
    universal_track_id: str | None = None
    file_size: int | None = None
    duration: float | None = None
    mime_type: str | None = None
    bitrate: int | None = None
    sample_rate: int | None = None
    channels: int | None = None
    track_no: int | None = None
    disc_no: int | None = None
    play_count: int = 0
    user_hash: str | None = None
    created_at: datetime
    updated_at: datetime

    artist: ArtistOut | None = None  # primary artist via artist_id
    artists: List[ArtistOut] = Field(default_factory=list)  # full many-to-many list
    album: AlbumOut | None = None

    model_config = ConfigDict(from_attributes=True)


class TrackOutAdmin(TrackOut):
    """Track schema with file_path — ONLY for admin responses"""

    file_path: str


class PlaylistCreate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None


class PlaylistUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    pinned: bool | None = None
    shuffle: bool | None = None


class PlaylistOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    is_liked: bool = False
    pinned: bool = False
    shuffle: bool = False
    created_at: datetime
    user: Optional['UserOutPublic'] = None

    model_config = ConfigDict(from_attributes=True)


class UserSignup(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class UserSignin(BaseModel):
    auth_hash: str = Field(..., min_length=64, max_length=64)


class UserUploadPreferenceUpdate(BaseModel):
    upload_enabled: bool


class UserLibraryStateUpdate(BaseModel):
    library_minimized: bool


class UserPlayerStateUpdate(BaseModel):
    shuffle: bool | None = None
    repeat_state: str | None = None


class UserQueueUpdate(BaseModel):
    track_ids: list[str] = Field(default_factory=list)
    current_index: int = 0


class SystemSettingsUpdate(BaseModel):
    manual_audio_upload_enabled: bool | None = None
    timezone: str | None = None


class SystemSettingsOut(BaseModel):
    manual_audio_upload_enabled: bool
    timezone: str = "UTC"


class UserOut(BaseModel):
    """User schema with auth_hash — ONLY for signup/signin responses"""

    id: str
    name: str
    auth_hash: str
    is_admin: bool = False
    upload_enabled: bool = True
    library_minimized: bool = False
    shuffle: bool = False
    repeat_state: str = "off"
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UserOutPublic(BaseModel):
    """User schema without auth_hash — for /auth/me and all other user responses"""

    id: str
    name: str
    is_admin: bool = False
    upload_enabled: bool = True
    library_minimized: bool = False
    shuffle: bool = False
    repeat_state: str = "off"
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PlaylistTrackOut(BaseModel):
    track: TrackOut
    position: int

    model_config = ConfigDict(from_attributes=True)


class DownloadRequest(BaseModel):
    query: str = Field(..., min_length=1)
    source: str | None = "auto"


class DownloadJobOut(BaseModel):
    id: str
    source: str
    query: str
    status: str
    output_path: str | None = None
    log: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
