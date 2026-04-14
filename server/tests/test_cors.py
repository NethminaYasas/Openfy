import os
from fastapi.testclient import TestClient

# Ensure settings uses the updated allowed_origins
os.environ['OPENFY_ALLOWED_ORIGINS'] = 'http://localhost'

from server.app.main import app

client = TestClient(app)

def test_cors_headers():
    response = client.options(
        "/tracks",
        headers={
            "Origin": "http://localhost",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "*",
        },
    )
    assert response.status_code == 200
    # The CORS middleware should echo back the allowed origin
    assert response.headers.get("access-control-allow-origin") == "http://localhost"
