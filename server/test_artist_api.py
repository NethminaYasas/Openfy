import requests
r = requests.get("http://localhost:8000/artists/some-artist-id")
print(r.status_code)
