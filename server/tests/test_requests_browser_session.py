"""Security regressions for replacing a browser's authentication identity."""

from http.cookies import SimpleCookie

import pytest
import requests

from spotify_scraper.auth.session import Session
from spotify_scraper.browsers.requests_browser import RequestsBrowser
from spotify_scraper.utils import download


@pytest.fixture
def browser(monkeypatch):
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *args, **kwargs: [
        (2, 1, 6, "", ("93.184.216.34", 443)),
    ])
    old = Session(
        access_token="old-token", cookies={"sp_dc": "old-cookie"},
        headers={"X-Session-Auth": "old-secret", "user-agent": "old-agent"},
    )
    browser = RequestsBrowser(
        session=old, headers={"User-Agent": "configured-agent", "X-Client": "configured"},
        rate_limit_delay=0,
    )
    browser.requests_session.trust_env = False
    yield browser
    browser.close()


@pytest.mark.parametrize("flow,url", [
    ("get_page_content", "https://open.spotify.com/track/test"),
    ("get_json", "https://api.spotify.com/v1/me"),
    ("download_file", "https://i.scdn.co/image/test"),
])
@pytest.mark.parametrize("replacement", ["none", "anonymous", "token", "cookies", "headers", "cleared"])
def test_replacement_sends_only_current_credentials(browser, monkeypatch, tmp_path, flow, url, replacement):
    transport = browser.requests_session
    adapters = dict(transport.adapters)
    # Include domain/path scoped cookies as might be installed by Set-Cookie.
    transport.cookies.set("sp_dc", "old-scoped-cookie", domain=".spotify.com", path="/v1")
    transport.cookies.set("server_auth", "old-server-cookie", domain=".scdn.co", path="/")
    sent = []

    def send(request, **kwargs):
        sent.append(request)
        response = requests.Response()
        response.status_code = 200
        response.url = request.url
        response.request = request
        response._content = b'{"ok": true}'
        response._content_consumed = True
        return response

    # Intercept after Requests has prepared the actual wire headers and cookies.
    monkeypatch.setattr(transport, "send", send)

    def fetch():
        if flow == "download_file":
            path = str(tmp_path / "download")
            assert browser.download_file(url, path) == path
            assert (tmp_path / "download").read_bytes() == b'{"ok": true}'
        elif flow == "get_json":
            assert browser.get_json(url) == {"ok": True}
        else:
            assert browser.get_page_content(url) == '{"ok": true}'

    fetch()
    assert sent[-1].headers["Authorization"] == "Bearer old-token"
    assert sent[-1].headers["X-Session-Auth"] == "old-secret"

    new = None
    if replacement == "cleared":
        new = browser.session
        new.clear()
    elif replacement == "anonymous":
        new = Session()
    elif replacement == "token":
        new = Session(access_token="new-token")
    elif replacement == "cookies":
        new = Session(cookies={"sp_t": "new-cookie"})
    elif replacement == "headers":
        new = Session(headers={"X-New-Auth": "new-secret"})
    browser.update_session(new)
    fetch()

    headers = sent[-1].headers
    assert headers.get("Authorization") == ("Bearer new-token" if replacement == "token" else None)
    assert "X-Session-Auth" not in headers
    assert headers.get("X-New-Auth") == ("new-secret" if replacement == "headers" else None)
    cookies = SimpleCookie(headers.get("Cookie", ""))
    assert {name: value.value for name, value in cookies.items()} == (
        {"sp_t": "new-cookie"} if replacement == "cookies" else {}
    )
    assert headers["User-Agent"] == "configured-agent"
    assert headers["X-Client"] == "configured"
    assert "Accept-Encoding" in headers
    assert browser.get_auth_token() == ("new-token" if replacement == "token" else None)
    assert browser.requests_session is transport
    assert transport.adapters == adapters
    assert dict(transport.cookies) == ({"sp_t": "new-cookie"} if replacement == "cookies" else {})


@pytest.mark.parametrize("header", ["Cookie", "Proxy-Authorization", "X-Custom-Auth"])
def test_repeated_replacement_removes_custom_auth_headers(browser, header):
    browser.update_session(Session(headers={header: "old-secret"}))
    request = browser.requests_session.prepare_request(requests.Request("GET", "https://open.spotify.com/"))
    assert request.headers[header] == "old-secret"

    browser.update_session(Session())
    request = browser.requests_session.prepare_request(requests.Request("GET", "https://open.spotify.com/"))
    assert header not in request.headers
