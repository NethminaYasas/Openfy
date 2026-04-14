import os
from pathlib import Path
from fastapi.testclient import TestClient
from server.app.main import app, settings

client = TestClient(app)

def get_auth_headers():
    return {"x-auth-hash": settings.admin_hash} if settings.admin_hash else {}

def test_artwork_path_traversal():
    # Create dummy album and track with artwork outside artwork_dir
    outside_art = Path(settings.artwork_dir).parent / "outside.jpg"
    outside_art.write_bytes(b"img")
    from server.app.db import SessionLocal
    from server.app.models import Album, Track
    db = SessionLocal()
    album = Album(id="alb-test", title="Test", artwork_path=str(outside_art))
    db.add(album)
    track = Track(id="trk-test", file_path="dummy.mp3", album_id=album.id, mime_type="audio/mpeg")
    db.add(track)
    db.commit()
    db.refresh(track)
    db.close()
    response = client.get(f"/tracks/{track.id}/artwork", headers=get_auth_headers())
    assert response.status_code == 403
    # cleanup
    os.remove(outside_art)
    db = SessionLocal()
    db.execute("DELETE FROM tracks WHERE id='trk-test'")
    db.execute("DELETE FROM albums WHERE id='alb-test'")
    db.commit()
    db.close()
