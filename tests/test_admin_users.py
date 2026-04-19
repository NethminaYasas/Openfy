import pytest
from sqlalchemy import event
from fastapi.testclient import TestClient
from server.app.models import User, Track


def test_admin_users_query_count(client, db_session):
    """Test that /admin/users endpoint uses a fixed number of queries (not N+1)"""
    # Create an admin user
    admin_user = User(name="admin", auth_hash="adminhash123", is_admin=True)
    db_session.add(admin_user)

    # Create three regular users
    user1 = User(name="user1", auth_hash="user1hash456", is_admin=False)
    user2 = User(name="user2", auth_hash="user2hash789", is_admin=False)
    user3 = User(name="user3", auth_hash="user3hash000", is_admin=False)
    db_session.add_all([user1, user2, user3])
    db_session.commit()

    # Create tracks for users (different counts per user)
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
        user_hash=user1.auth_hash
    )
    track3 = Track(
        id="track3",
        title="Track Three",
        file_path="/fake/path3.mp3",
        mime_type="audio/mpeg",
        user_hash=user2.auth_hash
    )
    # user3 has no tracks
    db_session.add_all([track1, track2, track3])
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
            "/admin/users",
            headers={"x-auth-hash": "adminhash123"}
        )

        # Verify response
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 4  # admin + 3 users

        # Verify we have the expected users with correct track counts
        usernames = {item["name"]: item for item in data}
        assert usernames["admin"]["uploaded_tracks_count"] == 0
        assert usernames["user1"]["uploaded_tracks_count"] == 2
        assert usernames["user2"]["uploaded_tracks_count"] == 1
        assert usernames["user3"]["uploaded_tracks_count"] == 0

        # Assert fixed number of queries (should be 2: main query with join + possibly another small query)
        # The key is that it doesn't scale with N (no N+1 problem). With our fix we expect around 2 queries.
        assert query_count[0] <= 2, f"Expected <= 2 queries, got {query_count[0]}"

    finally:
        # Remove the event listener
        event.remove(db_session.get_bind(), "before_cursor_execute", count_query)


def test_admin_users_search_query_count(client, db_session):
    """Test that search functionality also uses fixed queries"""
    # Create an admin user
    admin_user = User(name="admin", auth_hash="adminhash123", is_admin=True)
    db_session.add(admin_user)

    # Create users with searchable names
    user1 = User(name="alice", auth_hash="user1hash456", is_admin=False)
    user2 = User(name="bob", auth_hash="user2hash789", is_admin=False)
    db_session.add_all([user1, user2])
    db_session.commit()

    # Create tracks for users
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

    event.listen(db_session.get_bind(), "before_cursor_execute", count_query)

    try:
        # Make request with search
        response = client.get(
            "/admin/users?q=ali",
            headers={"x-auth-hash": "adminhash123"}
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["name"] == "alice"
        assert data[0]["uploaded_tracks_count"] == 1

        # With search, we expect a fixed number of queries (not scaling with N)
        # The key is that we don't have N+1 query problem anymore
        assert query_count[0] <= 2, f"Expected <= 2 queries with search, got {query_count[0]}"

    finally:
        event.remove(db_session.get_bind(), "before_cursor_execute", count_query)