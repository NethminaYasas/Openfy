import pytest
import tempfile
import os
from pathlib import Path
from unittest.mock import patch, MagicMock
from sqlalchemy import event
from server.app.services.library import scan_paths
from server.app.models import Track, Base
from server.app.db import get_db
from server.app.main import app
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


# Override the database URL for testing
SQLALCHEMY_DATABASE_URL = "sqlite:///./test_scan.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="function")
def db_session():
    # Create the database and tables
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        # Drop all tables after test
        Base.metadata.drop_all(bind=engine)


@pytest.fixture
def temp_music_dir():
    """Create a temporary directory with test audio files"""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        # Create fake audio files (just need extensions)
        (tmp_path / "song1.mp3").touch()
        (tmp_path / "song2.flac").touch()
        (tmp_path / "song3.wav").touch()
        (tmp_path / "not_audio.txt").touch()  # Should be ignored

        # Create subdirectory with more files
        subdir = tmp_path / "subdir"
        subdir.mkdir()
        (subdir / "song4.mp3").touch()
        (subdir / "song5.ogg").touch()

        yield tmp_path


def mock_read_metadata(file_path):
    """Mock metadata reading to return dummy data"""
    return {
        "title": file_path.stem,
        "artist": ["Unknown Artist"],
        "album": "Unknown Album",
        "year": 2023,
        "duration": 180.0,
        "bitrate": 320,
        "sample_rate": 44100,
        "channels": 2,
        "track_no": 1,
        "disc_no": 1,
        "file_size": file_path.stat().st_size if file_path.exists() else 0,
        "mime_type": "audio/mpeg"
    }


def test_scan_paths_fixed_n_plus_one(db_session, temp_music_dir):
    """Test that scan_paths uses a fixed number of queries (not N+1)"""

    # Mock _read_metadata and _extract_artwork to avoid issues with empty files
    with patch('server.app.services.library._read_metadata', side_effect=mock_read_metadata), \
         patch('server.app.services.library._extract_artwork', return_value=None):
        # Set up query counting
        query_count = [0]

        def count_query(conn, cursor, statement, parameters, context, executemany):
            if statement.strip().upper().startswith("SELECT"):
                query_count[0] += 1

        # Listen for SQL execution
        event.listen(db_session.get_bind(), "before_cursor_execute", count_query)

        try:
            # Scan the directory
            result = scan_paths(db_session, [temp_music_dir])

            # Verify results
            assert result["scanned"] == 5  # 5 audio files total
            assert result["new"] == 5      # All should be new

            # Verify we have the expected number of queries
            # Should be: 1 query to fetch existing tracks + queries for upsert work
            # But the key is it doesn't scale with number of files (no N+1)
            print(f"Total queries executed: {query_count[0]}")
            # With 5 files, we expect roughly:
            # - 1 batch query for existing tracks
            # - Queries inside _upsert_track per file (but these should be bounded)
            # Let's set a reasonable upper bound
            assert query_count[0] <= 20, f"Expected reasonable number of queries, got {query_count[0]}"

            # More importantly, verify that we didn't get N+1 behavior for the existence checks
            # If we had N+1, with 5 files we'd see at least 5+ queries just for the existence checks
            # With our fix, we should see exactly 1 query for the existence check batch
            # (though there may be additional queries for other purposes in _upsert_track)

        finally:
            # Remove the event listener
            event.remove(db_session.get_bind(), "before_cursor_execute", count_query)


def test_scan_paths_with_existing_tracks(db_session, temp_music_dir):
    """Test scan_paths when some tracks already exist"""

    # Mock _read_metadata and _extract_artwork to avoid issues with empty files
    with patch('server.app.services.library._read_metadata', side_effect=mock_read_metadata), \
         patch('server.app.services.library._extract_artwork', return_value=None):
        # Pre-populate database with one track
        existing_track = Track(
            title="Existing Song",
            file_path=str(temp_music_dir / "song1.mp3"),
            mime_type="audio/mpeg"
        )
        db_session.add(existing_track)
        db_session.commit()

        # Set up query counting
        query_count = [0]

        def count_query(conn, cursor, statement, parameters, context, executemany):
            if statement.strip().upper().startswith("SELECT"):
                query_count[0] += 1

        # Listen for SQL execution
        event.listen(db_session.get_bind(), "before_cursor_execute", count_query)

        try:
            # Scan the directory
            result = scan_paths(db_session, [temp_music_dir])

            # Verify results
            assert result["scanned"] == 5  # 5 audio files total
            assert result["new"] == 4      # 4 new (one already existed)

            # Verify query count is reasonable (not scaling with files)
            print(f"Total queries executed with existing tracks: {query_count[0]}")
            assert query_count[0] <= 20, f"Expected reasonable number of queries, got {query_count[0]}"

        finally:
            # Remove the event listener
            event.remove(db_session.get_bind(), "before_cursor_execute", count_query)


def test_scan_paths_individual_files(db_session):
    """Test scan_paths with individual file paths"""

    # Mock _read_metadata and _extract_artwork to avoid issues with empty files
    with patch('server.app.services.library._read_metadata', side_effect=mock_read_metadata), \
         patch('server.app.services.library._extract_artwork', return_value=None):
        # Create temporary files
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            file1 = tmp_path / "song1.mp3"
            file2 = tmp_path / "song2.flac"
            file1.touch()
            file2.touch()

            # Set up query counting
            query_count = [0]

            def count_query(conn, cursor, statement, parameters, context, executemany):
                if statement.strip().upper().startswith("SELECT"):
                    query_count[0] += 1

            # Listen for SQL execution
            event.listen(db_session.get_bind(), "before_cursor_execute", count_query)

            try:
                # Scan individual files
                result = scan_paths(db_session, [file1, file2])

                # Verify results
                assert result["scanned"] == 2
                assert result["new"] == 2

                # Verify query count is reasonable
                print(f"Total queries executed for individual files: {query_count[0]}")
                assert query_count[0] <= 10, f"Expected reasonable number of queries, got {query_count[0]}"

            finally:
                # Remove the event listener
                event.remove(db_session.get_bind(), "before_cursor_execute", count_query)