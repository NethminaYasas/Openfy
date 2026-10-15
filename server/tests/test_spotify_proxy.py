"""Regression coverage for explicit proxy routing at the Requests transport boundary."""

import io
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests
from requests.utils import select_proxy

from spotify_scraper.client import SpotifyClient
from spotify_scraper.core.exceptions import DownloadError, MediaError, NetworkError
from spotify_scraper.utils import download

PROXY = "http://selected-proxy.example:8080"
PAGE = "https://open.spotify.com/track/example"
MEDIA = "https://p.scdn.co/preview/example"
FLOWS = ["page", "json", "file", "cover", "track", "embedded-cover", "episode"]


@pytest.fixture
def transport(monkeypatch):
    """Exercise real Requests proxy merging, replacing only the final send."""
    calls = []
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *args, **kwargs: [
        (2, 1, 6, "", ("93.184.216.34", 443)),
    ])
    for name in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://environment-proxy.example:8080")

    def send(adapter, request, **kwargs):
        calls.append((request.url, select_proxy(request.url, kwargs["proxies"])))
        response = requests.Response()
        response.status_code = 200
        response.url = request.url
        response.request = request
        response.raw = io.BytesIO(b'{}')
        return response

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    return calls


def exercise(client, flow, tmp_path, monkeypatch):
    if flow == "page":
        client.browser.get_page_content(PAGE)
    elif flow == "json":
        client.browser.get_json(PAGE)
    elif flow == "file":
        client.browser.download_file(MEDIA, str(tmp_path / "file"))
    elif flow in {"cover", "embedded-cover"}:
        downloader = (
            client._image_downloader if flow == "cover"
            else client._audio_downloader._get_image_downloader()
        )
        downloader.download_cover({"images": [{"url": MEDIA}]}, path=str(tmp_path))
    elif flow == "track":
        client._audio_downloader.download_preview(
            {"preview_url": MEDIA}, path=str(tmp_path), with_cover=False
        )
    else:
        monkeypatch.setattr(client, "get_episode_info", lambda url: {"audio_preview_url": MEDIA})
        client.download_episode_preview(PAGE, path=str(tmp_path))


@pytest.mark.parametrize("flow", FLOWS)
@pytest.mark.parametrize("policy", [{"https": PROXY}, {"http": PROXY, "https": PROXY}, {"all": PROXY}])
@pytest.mark.parametrize("no_proxy", ["", "*"])
def test_every_client_transport_uses_explicit_proxy(transport, tmp_path, monkeypatch, flow, policy, no_proxy):
    monkeypatch.setenv("NO_PROXY", no_proxy)
    monkeypatch.setenv("no_proxy", no_proxy)
    original = policy.copy()
    client = SpotifyClient(proxy=policy)
    client.browser.rate_limit_delay = 0
    try:
        exercise(client, flow, tmp_path, monkeypatch)
    finally:
        client.close()

    assert transport == [(PAGE if flow in {"page", "json"} else MEDIA, PROXY)]
    assert policy == original


@pytest.mark.parametrize("flow", ["page", "json", "file", "track", "episode"])
def test_proxy_is_used_on_each_redirect(transport, tmp_path, monkeypatch, flow):
    original_send = requests.adapters.HTTPAdapter.send

    def redirect_once(adapter, request, **kwargs):
        response = original_send(adapter, request, **kwargs)
        if len(transport) == 1:
            response.status_code = 302
            response.headers["Location"] = "/redirected"
        return response

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", redirect_once)
    client = SpotifyClient(proxy={"https": PROXY})
    client.browser.rate_limit_delay = 0
    try:
        exercise(client, flow, tmp_path, monkeypatch)
    finally:
        client.close()
    assert len(transport) == 2
    assert transport[-1][0].endswith("/redirected")
    assert [proxy for _, proxy in transport] == [PROXY, PROXY]


@pytest.mark.parametrize("flow", FLOWS)
def test_proxy_failure_does_not_retry_directly(transport, tmp_path, monkeypatch, flow):
    def fail(adapter, request, **kwargs):
        transport.append(select_proxy(request.url, kwargs["proxies"]))
        raise requests.exceptions.ProxyError("proxy unavailable")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", fail)
    client = SpotifyClient(proxy={"https": PROXY})
    try:
        with pytest.raises((DownloadError, MediaError, NetworkError)):
            exercise(client, flow, tmp_path, monkeypatch)
    finally:
        client.close()
    assert transport == [PROXY]
    assert not any(path.stat().st_size for path in Path(tmp_path).iterdir())


@pytest.mark.parametrize("proxy", [
    "http://proxy.example:8080", {"http": PROXY}, {"https": None}, {"https": ""},
    {"https://open.spotify.com": PROXY}, {"https": "http://"},
    {"https": "http://proxy.example:invalid"}, {"https": "ftp://proxy.example"},
])
def test_unsupported_policies_fail_before_browser_creation(monkeypatch, proxy):
    create = Mock()
    monkeypatch.setattr("spotify_scraper.client.create_browser", create)
    with pytest.raises(ValueError, match="Proxy"):
        SpotifyClient(proxy=proxy)
    create.assert_not_called()


@pytest.mark.parametrize("browser_type", ["selenium", "auto"])
def test_unsupported_backends_fail_before_browser_creation(monkeypatch, browser_type):
    create = Mock()
    monkeypatch.setattr("spotify_scraper.client.create_browser", create)
    with pytest.raises(ValueError, match="Explicit proxies require"):
        SpotifyClient(proxy={"https": PROXY}, browser_type=browser_type)
    create.assert_not_called()


@pytest.mark.parametrize("proxy", [None, {}])
def test_no_explicit_policy_preserves_environment_proxy(transport, proxy):
    client = SpotifyClient(proxy=proxy)
    try:
        client.browser.get_page_content(PAGE)
    finally:
        client.close()
    assert transport == [(PAGE, "http://environment-proxy.example:8080")]


def test_cli_proxy_reaches_the_transport(transport):
    from spotify_scraper.cli import cli
    from spotify_scraper.cli.utils import create_client

    with cli.make_context("spotify-scraper", ["--proxy", PROXY]) as context:
        cli.invoke(context)
        client = create_client(context.obj)
    try:
        client.browser.get_page_content(PAGE)
    finally:
        client.close()
    assert transport == [(PAGE, PROXY)]


def test_audio_then_lazy_cover_preserves_policy(transport, tmp_path, monkeypatch):
    # Requests adds environment keys to the per-request proxies dictionary.
    # They must not become part of the policy reused for lazy cover downloads.
    monkeypatch.setenv("NO_PROXY", "other.example")
    monkeypatch.setenv("no_proxy", "other.example")
    monkeypatch.setenv("HTTP_PROXY", "http://environment-proxy.example:8080")
    client = SpotifyClient(proxy={"https": PROXY})
    try:
        exercise(client, "track", tmp_path, monkeypatch)
        exercise(client, "embedded-cover", tmp_path, monkeypatch)
    finally:
        client.close()
    assert transport == [(MEDIA, PROXY), (MEDIA, PROXY)]
    assert client._audio_downloader.proxy == {"https": PROXY}
