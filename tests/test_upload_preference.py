import pytest
from fastapi.testclient import TestClient
from server.app.models import User
from server.app.main import app
from sqlalchemy import select


def test_update_upload_preference_returns_database_value(client, db_session):
    """Test that the update_upload_preference endpoint returns the actual database value"""
    # Create a test user
    user = User(name="testuser", auth_hash="testhash123")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    # Verify initial state (default should be True)
    assert user.upload_enabled == True  # Because default is 1 -> True

    # Update to False
    response = client.put(
        "/user/upload-preference",
        json={"upload_enabled": False},
        headers={"x-auth-hash": "testhash123"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "updated"
    # The response should reflect the actual database value, not just the payload
    assert data["upload_enabled"] == False

    # Verify the database value was actually updated by querying in the same session
    user_from_db = db_session.execute(
        select(User).where(User.auth_hash == "testhash123")
    ).scalar_one_or_none()
    assert user_from_db.upload_enabled == False


def test_update_upload_preference_true(client, db_session):
    """Test updating upload preference to True"""
    # Create a test user
    user = User(name="testuser2", auth_hash="testhash456", upload_enabled=False)
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    # Verify initial state
    assert user.upload_enabled == False

    # Update to True
    response = client.put(
        "/user/upload-preference",
        json={"upload_enabled": True},
        headers={"x-auth-hash": "testhash456"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "updated"
    # The response should reflect the actual database value
    assert data["upload_enabled"] == True

    # Verify the database value was actually updated by querying in the same session
    user_from_db = db_session.execute(
        select(User).where(User.auth_hash == "testhash456")
    ).scalar_one_or_none()
    assert user_from_db.upload_enabled == True