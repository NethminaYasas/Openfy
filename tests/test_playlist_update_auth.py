import pytest
from fastapi.testclient import TestClient
from server.app.models import User, Playlist

def test_update_playlist_owner_can_update(client, db_session):
    """Test that the owner of a playlist can update it"""
    # Create a test user
    user = User(name="testuser", auth_hash="testhash123")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    # Create a playlist for the user
    playlist = Playlist(name="Test Playlist", user_hash=user.auth_hash)
    db_session.add(playlist)
    db_session.commit()
    db_session.refresh(playlist)

    # Try to update the playlist as the owner
    response = client.put(
        f"/playlists/{playlist.id}",
        json={"name": "Updated Playlist"},
        headers={"x-auth-hash": "testhash123"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Playlist"

def test_update_playlist_admin_can_update_others_playlist(client, db_session):
    """Test that an admin can update another user's playlist"""
    # Create a regular user
    regular_user = User(name="regularuser", auth_hash="regularhash456", is_admin=False)
    db_session.add(regular_user)

    # Create an admin user
    admin_user = User(name="adminuser", auth_hash="adminhash789", is_admin=True)
    db_session.add(admin_user)
    db_session.commit()
    db_session.refresh(regular_user)
    db_session.refresh(admin_user)

    # Create a playlist for the regular user
    playlist = Playlist(name="Regular User's Playlist", user_hash=regular_user.auth_hash)
    db_session.add(playlist)
    db_session.commit()
    db_session.refresh(playlist)

    # Try to update the playlist as the admin
    response = client.put(
        f"/playlists/{playlist.id}",
        json={"name": "Updated by Admin"},
        headers={"x-auth-hash": "adminhash789"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated by Admin"

def test_update_playlist_non_owner_non_admin_cannot_update(client, db_session):
    """Test that a non-owner, non-admin cannot update another user's playlist"""
    # Create two regular users
    user1 = User(name="user1", auth_hash="user1hash111", is_admin=False)
    user2 = User(name="user2", auth_hash="user2hash222", is_admin=False)
    db_session.add(user1)
    db_session.add(user2)
    db_session.commit()
    db_session.refresh(user1)
    db_session.refresh(user2)

    # Create a playlist for user1
    playlist = Playlist(name="User1's Playlist", user_hash=user1.auth_hash)
    db_session.add(playlist)
    db_session.commit()
    db_session.refresh(playlist)

    # Try to update the playlist as user2 (not owner, not admin)
    response = client.put(
        f"/playlists/{playlist.id}",
        json={"name": "Hacked Playlist"},
        headers={"x-auth-hash": "user2hash222"}
    )

    assert response.status_code == 403
    assert "Not your playlist" in response.json()["detail"]

def test_update_playlist_unauthenticated_fails(client, db_session):
    """Test that unauthenticated requests fail"""
    # Create a user and playlist
    user = User(name="testuser", auth_hash="testhash123")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    playlist = Playlist(name="Test Playlist", user_hash=user.auth_hash)
    db_session.add(playlist)
    db_session.commit()
    db_session.refresh(playlist)

    # Try to update without auth
    response = client.put(
        f"/playlists/{playlist.id}",
        json={"name": "Updated Playlist"}
    )

    assert response.status_code == 401