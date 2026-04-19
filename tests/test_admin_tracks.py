import pytest
from sqlalchemy import event
from fastapi.testclient import TestClient
from server.app.models import User, Track


def test_admin_tracks_query_count(client, db_session):
    """Test that /admin/tracks endpoint uses a fixed number of queries (not N+1)"""
    # Create an admin user
    admin_user = User(name="admin", auth_hash="adminhash123", is_admin=True)
    db_session.add(admin_user)

    # Create two regular users
    user1 = User(name="user1", auth_hash="user1hash456", is_admin=False)
    user2 = User(name="user2", auth_hash="user2hash789", is_admin=False)
    db_session.add_all([user1, user2])
    db_session.commit()

    # Create two tracks, each assigned to a different user
    track1 = Track(
        id="track1",
        title="Track One",
        file_path="/fake/path1.mp3",
        mime_type="audio/mpeg",
        user_hash=user1.auth_hash
    )
    track2 = Track(
        id="track2",
        title="Track Two",
        file_path="/fake/path2.mp3",
        mime_type="audio/mpeg",
        user_hash=user2.auth_hash
    )
    db_session.add_all([track1, track2])
    db_session.commit()

    # Set up query counting
    query_count = [0]

    def count_query(conn, cursor, statement, parameters, context, executemany):
        if statement.strip().upper().startswith("SELECT"):
            query_count[0] += 1

    # Listen for SQL execution
    event.listen(db_session.get_bind(), "before_cursor_execute", count_query)

    try:
        # Make request as admin
        response = client.get(
            "/admin/tracks",
            headers={"x-auth-hash": "adminhash123"}
        )

        # Verify response
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2

        # Verify we have the expected tracks
        titles = {item["title"] for item in data}
        assert titles == {"Track One", "Track Two"}

        # Verify user names are correct
        for item in data:
            if item["title"] == "Track One":
                assert item["user_name"] == "user1"
            elif item["title"] == "Track Two":
                assert item["user_name"] == "user2"

        # Assert fixed number of queries (should be 3: tracks+users join, artists via selectinload, and possibly another small query)
        # The key is that it doesn't scale with N (no N+1 problem). With our fix we expect around 3 queries.
        assert query_count[0] <= 3, f"Expected <= 3 queries, got {query_count[0]}"

    finally:
        # Remove the event listener
        event.remove(db_session.get_bind(), "before_cursor_execute", count_query)


def test_admin_tracks_search_query_count(client, db_session):
    """Test that search functionality also uses fixed queries"""
    # Create an admin user
    admin_user = User(name="admin", auth_hash="adminhash123", is_admin=True)
    db_session.add(admin_user)

    # Create a user
    user = User(name="user1", auth_hash="user1hash456", is_admin=False)
    db_session.add(user)
    db_session.commit()

    # Create a track with artist
    from server.app.models import Artist, Album
    artist = Artist(name="Test Artist")
    album = Album(title="Test Album")
    db_session.add_all([artist, album])
    db_session.commit()

    track = Track(
        id="track1",
        title="Test Track",
        file_path="/fake/path.mp3",
        mime_type="audio/mpeg",
        user_hash=user.auth_hash
    )
    track.artists.append(artist)
    track.album = album
    db_session.add(track)
    db_session.commit()

    # Set up query counting
    query_count = [0]

    def count_query(conn, cursor, statement, parameters, context, executemany):
        if statement.strip().upper().startswith("SELECT"):
            query_count[0] += 1

    event.listen(db_session.get_bind(), "before_cursor_execute", count_query)

    try:
        # Make request with search
        response = client.get(
            "/admin/tracks?q=Test",
            headers={"x-auth-hash": "adminhash123"}
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["title"] == "Test Track"

        # With search, we expect a fixed number of queries (not scaling with N)
        # The key is that we don't have N+1 query problem anymore
        assert query_count[0] <= 3, f"Expected <= 3 queries with search, got {query_count[0]}"

    finally:
        event.remove(db_session.get_bind(), "before_cursor_execute", count_query)