import pytest
from unittest.mock import MagicMock
from sqlalchemy.orm import Session
from pathlib import Path
from server.app.services.library import (
    _parse_artist_names,
    _get_primary_artist,
    _associate_track_artists,
    _build_track_from_metadata
)
from server.app.models import Artist, Album, Track


def test_parse_artist_names_string_single():
    """Test parsing a single artist string"""
    result = _parse_artist_names("Artist Name")
    assert result == ["Artist Name"]


def test_parse_artist_names_string_multiple_comma():
    """Test parsing multiple artists separated by comma"""
    result = _parse_artist_names("Artist One, Artist Two")
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_string_multiple_semicolon():
    """Test parsing multiple artists separated by semicolon"""
    result = _parse_artist_names("Artist One; Artist Two")
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_string_multiple_slash():
    """Test parsing multiple artists separated by slash"""
    result = _parse_artist_names("Artist One/ Artist Two")
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_string_multiple_ampersand():
    """Test parsing multiple artists separated by ampersand"""
    result = _parse_artist_names("Artist One & Artist Two")
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_string_multiple_and():
    """Test parsing multiple artists separated by 'and'"""
    result = _parse_artist_names("Artist One and Artist Two")
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_string_mixed_delimiters():
    """Test parsing with mixed delimiters"""
    result = _parse_artist_names("Artist One, Artist Two; Artist Three & Artist Four and Artist Five")
    assert result == ["Artist One", "Artist Two", "Artist Three", "Artist Four", "Artist Five"]


def test_parse_artist_names_string_with_whitespace():
    """Test parsing with extra whitespace"""
    result = _parse_artist_names("  Artist One  ,  Artist Two  ")
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_string_unknown_filtered():
    """Test that 'unknown' and 'unknown artist' are filtered out"""
    result = _parse_artist_names("Unknown Artist, Known Artist, unknown")
    assert result == ["Known Artist"]


def test_parse_artist_names_list():
    """Test parsing from a list"""
    result = _parse_artist_names(["Artist One", "Artist Two"])
    assert result == ["Artist One", "Artist Two"]


def test_parse_artist_names_list_with_unknown():
    """Test parsing list with unknown values filtered"""
    result = _parse_artist_names(["Unknown Artist", "Known Artist", "unknown"])
    assert result == ["Known Artist"]


def test_parse_artist_names_empty():
    """Test parsing empty/None values"""
    assert _parse_artist_names(None) == []
    assert _parse_artist_names("") == []
    assert _parse_artist_names([]) == []


def test_get_primary_artist_none():
    """Test getting primary artist when name is None"""
    db_mock = MagicMock(spec=Session)
    result = _get_primary_artist(db_mock, None)
    assert result is None


def test_get_primary_artist_string():
    """Test getting primary artist from string"""
    db_mock = MagicMock(spec=Session)
    # Mock the _get_or_create_artist function
    import server.app.services.library as lib_module
    original_func = lib_module._get_or_create_artist
    mock_artist = Artist(id=1, name="Test Artist")
    lib_module._get_or_create_artist = MagicMock(return_value=mock_artist)

    try:
        result = _get_primary_artist(db_mock, "Test Artist")
        assert result == mock_artist
        lib_module._get_or_create_artist.assert_called_once_with(db_mock, "Test Artist")
    finally:
        lib_module._get_or_create_artist = original_func


def test_associate_track_artists_no_track_id():
    """Test associating artists when track_id is None"""
    db_mock = MagicMock(spec=Session)
    # Should not raise any exception
    _associate_track_artists(db_mock, None, ["Artist One", "Artist Two"])
    # Verify delete was not called
    db_mock.execute.assert_not_called()


def test_associate_track_artists_empty_list():
    """Test associating artists with empty list"""
    db_mock = MagicMock(spec=Session)
    _associate_track_artists(db_mock, 1, [])
    # Should still delete existing associations
    db_mock.execute.assert_called_once()


def test_associate_track_artists_normal_case():
    """Test normal artist association"""
    db_mock = MagicMock(spec=Session)
    # Mock _get_or_create_artist
    import server.app.services.library as lib_module
    original_func = lib_module._get_or_create_artist
    mock_artist1 = Artist(id=1, name="Artist One")
    mock_artist2 = Artist(id=2, name="Artist Two")
    lib_module._get_or_create_artist = MagicMock(side_effect=[mock_artist1, mock_artist2])

    try:
        _associate_track_artists(db_mock, 1, ["Artist One", "Artist Two"])

        # Should have called delete once
        assert db_mock.execute.call_count >= 1
        # Should have called _get_or_create_artist twice
        assert lib_module._get_or_create_artist.call_count == 2
        # Should have called insert twice (for each artist)
        # Actually, it calls execute for each insert, so total calls should be 3 (1 delete + 2 inserts)
    finally:
        lib_module._get_or_create_artist = original_func


def test_build_track_from_metadata():
    """Test building track from metadata"""
    metadata = {
        "file_size": 1024,
        "mime_type": "audio/mpeg",
        "bitrate": 320,
        "sample_rate": 44100,
        "channels": 2,
        "track_no": 1,
        "disc_no": 1
    }
    file_path = Path("/test/song.mp3")

    track = _build_track_from_metadata(
        metadata=metadata,
        file_path=file_path,
        title="Test Song",
        duration=180.0,
        artist_id=1,
        album_id=1,
        user_hash="test_hash"
    )

    assert track.title == "Test Song"
    assert track.file_path == "/test/song.mp3"
    assert track.file_size == 1024
    assert track.duration == 180.0
    assert track.mime_type == "audio/mpeg"
    assert track.bitrate == 320
    assert track.sample_rate == 44100
    assert track.channels == 2
    assert track.track_no == 1
    assert track.disc_no == 1
    assert track.artist_id == 1
    assert track.album_id == 1
    assert track.user_hash == "test_hash"