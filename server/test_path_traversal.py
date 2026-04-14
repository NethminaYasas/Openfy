import os
from pathlib import Path
from fastapi.testclient import TestClient
from server.app.main import app, settings

client = TestClient(app)

def get_auth_headers():
    # Assuming admin auth hash is set in settings.admin_hash for tests
    return {"x-auth-hash": settings.admin_hash} if settings.admin_hash else {}

def test_track_stream_path_traversal():
    # Create a dummy track with a path outside music_dir using ../ traversal
    outside_path = Path(settings.music_dir).parent / "outside.mp3"
    # Ensure file exists for test
    outside_path.write_bytes(b"test")
    # Insert track directly via DB
    from server.app.db import SessionLocal
    from server.app.models import Track
    db = SessionLocal()
    track = Track(id="traversal-test", file_path=str(outside_path), mime_type="audio/mpeg")
    db.add(track)
    db.commit()
    db.refresh(track)
    db.close()
    # Attempt to stream
    response = client.get(f"/tracks/{track.id}/stream", headers=get_auth_headers())
    assert response.status_code == 403
    # Clean up
    os.remove(outside_path)
    db = SessionLocal()
    db.execute("DELETE FROM tracks WHERE id='traversal-test'")
    db.commit()
    db.close()
