from datetime import datetime
from typing import List, Optional, TYPE_CHECKING
from pydantic import BaseModel, Field, ConfigDict

if TYPE_CHECKING:
    from .schemas import AlbumOut, TrackForArtist


class ArtistBase(BaseModel):
    name: str
    image_url: str | None = None
    spotify_url: str | None = None


class ArtistForTrack(BaseModel):
    """Shallow artist info for embedding in TrackOut - no circular refs"""
    id: str
    name: str
    image_url: str | None = None

    model_config = ConfigDict(from_attributes=True)


class AlbumForTrack(BaseModel):
    """Shallow album info for embedding in TrackForArtist"""
    id: str
    title: str
    artwork_path: str | None = None
    image_url: str | None = None

    model_config = ConfigDict(from_attributes=True)


class TrackForArtist(BaseModel):
    """Track info for embedding in ArtistOut - includes artist/artists for display"""
    id: str
    title: str
    artist_id: str | None = None
    album_id: str | None = None
    duration: float | None = None
    play_count: int = 0
    play_count_30_days: int = 0
    created_at: datetime
    album: AlbumForTrack | None = None
    artist: ArtistForTrack | None = None
    artists: List[ArtistForTrack] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class ArtistOut(ArtistBase):
    id: str
    created_at: datetime
    tracks: List["TrackForArtist"] = Field(default_factory=list)
    albums: List["AlbumOut"] = Field(default_factory=list)

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

    artist: ArtistForTrack | None = None  # primary artist via artist_id
    artists: List[ArtistForTrack] = Field(default_factory=list)  # full many-to-many list
    album: AlbumOut | None = None

    model_config = ConfigDict(from_attributes=True)


class TrackOutAdmin(TrackOut):
    """Track schema with file_path — ONLY for admin responses"""

    file_path: str


class PlaylistCreate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    type: str | None = "playlist"
    owner_name: str | None = None


class PlaylistUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    pinned: bool | None = None
    shuffle: bool | None = None
    is_public: bool | None = None
    image_url: str | None = None
    type: str | None = None
    owner_name: str | None = None


class PlaylistOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    is_liked: bool = False
    pinned: bool = False
    shuffle: bool = False
    is_public: bool = False
    created_at: datetime
    user: Optional['UserOutPublic'] = None
    is_followed: bool = False
    is_owner: bool = False
    track_count: int = 0
    type: str = "playlist"
    owner_name: Optional[str] = None

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
    playlist_import_enabled: bool | None = None
    timezone: str | None = None


class SystemSettingsOut(BaseModel):
    manual_audio_upload_enabled: bool
    playlist_import_enabled: bool
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
    avatar_path: str | None = None
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
    avatar_path: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PlaylistTrackOut(BaseModel):
    track: TrackOut
    position: int

    model_config = ConfigDict(from_attributes=True)

class DownloadRequest(BaseModel):
    query: str = Field(..., min_length=1)
    source: str | None = "auto"
    artist_url: str | None = None
    album_source_id: str | None = None  # For linking track to album


class SpotifyImportRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Spotify playlist URL")


class DownloadJobOut(BaseModel):
    id: str
    source: str
    query: str
    status: str
    track_id: str | None = None
    output_path: str | None = None
    log: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
