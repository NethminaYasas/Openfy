import sqlite3
import json
conn = sqlite3.connect('/data/openfy.db')
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

cursor.execute("SELECT id, name FROM artists LIMIT 1")
artist = cursor.fetchone()
if not artist:
    print("No artists found")
else:
    print(f"Artist: {artist['name']} (ID: {artist['id']})")
    cursor.execute("SELECT * FROM albums WHERE artist_id = ?", (artist['id'],))
    albums = cursor.fetchall()
    print(f"Albums from Album table: {len(albums)}")
    for a in albums:
        print(f"  - {a['title']}")

    cursor.execute("SELECT * FROM playlists WHERE type = 'album'")
    playlists = cursor.fetchall()
    print(f"Playlists of type 'album': {len(playlists)}")
    for p in playlists:
        print(f"  - {p['name']}")
