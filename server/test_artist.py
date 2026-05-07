from app.database import SessionLocal
from app.models import Artist, Album
db = SessionLocal()
artist = db.query(Artist).first()
if artist:
    print(f"Artist: {artist.name}, Albums: {[a.title for a in artist.albums]}")
else:
    print("No artist found")
