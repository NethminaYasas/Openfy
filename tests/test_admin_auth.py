import pytest
from fastapi.testclient import TestClient
from server.app.main import app

client = TestClient(app)
# Ensure database tables are created
from server.app.main import _startup
_startup()

def test_admin_endpoint_requires_auth():
    response = client.get('/admin/users')
    assert response.status_code == 401

def test_non_admin_cannot_access_admin():
    # create a regular user via signup endpoint
    signup_resp = client.post('/auth/signup', json={'name': 'testuser', 'auth_hash': 'testhash'})
    assert signup_resp.status_code == 200
    # attempt admin endpoint with this user
    resp = client.get('/admin/users', headers={'x-auth-hash': 'testhash'})
    assert resp.status_code == 403
