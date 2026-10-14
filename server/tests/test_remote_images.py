import io
import socket
import ssl
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import main


def addresses(ip="93.184.216.34", port=80):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr = (ip, port, 0, 0) if family == socket.AF_INET6 else (ip, port)
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]


def response_socket(status=200, headers=None, body=b"image"):
    if headers is None:
        headers = {"Content-Type": "image/png"}
    headers = {**headers, "Content-Length": str(len(body))}
    wire = f"HTTP/1.1 {status} Response\r\n".encode()
    wire += "".join(f"{key}: {value}\r\n" for key, value in headers.items()).encode()
    sock = MagicMock()
    sock.makefile.return_value = io.BytesIO(wire + b"\r\n" + body)
    return sock


@pytest.fixture
def network(monkeypatch):
    sock = response_socket()
    lookup = MagicMock(side_effect=lambda host, port, **kwargs: addresses(port=port))
    create_socket = MagicMock(return_value=sock)
    monkeypatch.setattr(main.socket, "getaddrinfo", lookup)
    monkeypatch.setattr(main.socket, "socket", create_socket)
    return SimpleNamespace(sock=sock, lookup=lookup, create_socket=create_socket)


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "224.0.0.1", "240.0.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "ff02::1", "::",
    "::ffff:127.0.0.1",
])
def test_unsafe_addresses_are_rejected_before_connection(network, ip):
    network.lookup.side_effect = None
    network.lookup.return_value = addresses(ip)
    assert not main._is_public_http_image_url("http://images.example/cover")
    with pytest.raises(HTTPException) as exc:
        main._fetch_remote_image_bytes("http://images.example/cover")
    assert exc.value.status_code == 400
    network.create_socket.assert_not_called()


@pytest.mark.parametrize("answers", [[], addresses() + addresses("10.0.0.1")])
def test_empty_or_mixed_dns_answers_fail_closed(network, answers):
    network.lookup.side_effect = None
    network.lookup.return_value = answers
    with pytest.raises(HTTPException):
        main._fetch_remote_image_bytes("http://images.example/cover")
    network.create_socket.assert_not_called()


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://images.example/cover", "http://localhost/cover",
    "http:///cover", "http://images.example:bad/cover", "http://images.example:65536/cover",
])
def test_invalid_urls_are_rejected_without_dns_or_connection(network, url):
    with pytest.raises(HTTPException) as exc:
        main._fetch_remote_image_bytes(url)
    assert exc.value.status_code == 400
    network.lookup.assert_not_called()
    network.create_socket.assert_not_called()


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirects_never_contact_the_location(network, status):
    sock = response_socket(status, {"Location": "http://127.0.0.1/internal"}, body=b"")
    network.create_socket.return_value = sock
    with pytest.raises(HTTPException) as exc:
        main._fetch_remote_image_bytes("http://images.example/cover")
    assert exc.value.status_code == 400
    network.lookup.assert_called_once()
    network.create_socket.assert_called_once()
    sock.connect.assert_called_once_with(("93.184.216.34", 80))
    sock.close.assert_called_once()


def test_fetch_pins_dns_and_preserves_http_request(network, monkeypatch):
    # A second lookup would yield loopback. It must never happen.
    network.lookup.side_effect = [addresses(port=8080), addresses("127.0.0.1", 8080)]
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9999")
    assert main._fetch_remote_image_bytes(
        "http://images.example:8080/cover;size=large?token=demo#fragment", timeout_sec=3
    ) == b"image"
    network.lookup.assert_called_once_with("images.example", 8080, type=socket.SOCK_STREAM)
    network.sock.connect.assert_called_once_with(("93.184.216.34", 8080))
    network.sock.settimeout.assert_called_once_with(3)
    wire = b"".join(call.args[0] for call in network.sock.sendall.call_args_list)
    assert b"GET /cover;size=large?token=demo HTTP/1.1\r\n" in wire
    assert b"Host: images.example:8080\r\n" in wire
    assert b"User-Agent: Openfy/1.0\r\n" in wire
    assert b"fragment" not in wire
    network.sock.close.assert_called_once()


def test_https_preserves_tls_hostname_and_verification(network, monkeypatch):
    def wrap_socket(context, sock, *, server_hostname):
        assert context.check_hostname
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert server_hostname == "images.example"
        assert sock is network.sock
        return sock

    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", wrap_socket)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
    assert main._fetch_remote_image_bytes("https://images.example/cover") == b"image"
    network.lookup.assert_called_once_with("images.example", 443, type=socket.SOCK_STREAM)
    network.sock.connect.assert_called_once_with(("93.184.216.34", 443))
    wire = b"".join(call.args[0] for call in network.sock.sendall.call_args_list)
    assert b"Host: images.example\r\n" in wire


def test_tls_verification_failure_closes_connection(network, monkeypatch):
    def wrap_socket(context, sock, *, server_hostname):
        raise ssl.SSLCertVerificationError("certificate does not match hostname")

    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", wrap_socket)
    with pytest.raises(ssl.SSLCertVerificationError):
        main._fetch_remote_image_bytes("https://images.example/cover")
    network.sock.close.assert_called_once()
    network.sock.sendall.assert_not_called()


def test_connection_falls_back_only_to_validated_addresses(network):
    network.lookup.side_effect = None
    network.lookup.return_value = addresses() + addresses("2606:4700:4700::1111")
    failed = MagicMock()
    failed.connect.side_effect = TimeoutError("unreachable")
    network.create_socket.side_effect = [failed, network.sock]
    assert main._fetch_remote_image_bytes("http://images.example/cover") == b"image"
    failed.close.assert_called_once()
    network.sock.connect.assert_called_once_with(("2606:4700:4700::1111", 80, 0, 0))
    network.lookup.assert_called_once()


@pytest.mark.parametrize("status,headers,body,expected", [
    (404, {"Content-Type": "image/png"}, b"missing", 400),
    (200, {"Content-Type": "text/html"}, b"html", 400),
    (200, {"Content-Type": "image/png"}, b"123456789", 413),
])
def test_response_controls_and_cleanup(network, monkeypatch, status, headers, body, expected):
    monkeypatch.setattr(main, "_MAX_REMOTE_IMAGE_BYTES", 8)
    sock = response_socket(status, headers, body)
    network.create_socket.return_value = sock
    with pytest.raises(HTTPException) as exc:
        main._fetch_remote_image_bytes("http://images.example/cover")
    assert exc.value.status_code == expected
    sock.close.assert_called_once()


@pytest.mark.parametrize("redirect", [False, True])
def test_owner_image_update_and_cover_flow(network, monkeypatch, tmp_path, redirect):
    monkeypatch.setattr(main.settings, "artwork_dir", tmp_path)
    image = io.BytesIO()
    main.Image.new("RGB", (2, 2)).save(image, format="PNG")
    sock = response_socket(302, {"Location": "http://127.0.0.1/internal"}) if redirect else response_socket(body=image.getvalue())
    network.create_socket.return_value = sock
    engine = create_engine("sqlite://")
    main.Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            user = main.User(name="owner", auth_hash="test-owner")
            playlist = main.Playlist(name="cover test", user_hash=user.auth_hash)
            db.add_all([user, playlist])
            db.commit()
            main.update_playlist(
                playlist.id, main.PlaylistUpdate(image_url="http://images.example/cover"), user.auth_hash, db
            )
            cache_path = tmp_path / "playlist_external" / f"{playlist.id}.jpg"
            if redirect:
                with pytest.raises(HTTPException) as exc:
                    main.get_playlist_cover(playlist.id, user.auth_hash, db)
                assert exc.value.status_code == 404
                assert not cache_path.exists()
            else:
                result = main.get_playlist_cover(playlist.id, user.auth_hash, db)
                assert result.path == cache_path
                with main.Image.open(cache_path) as cover:
                    assert cover.format == "JPEG"
            network.create_socket.assert_called_once()
            sock.connect.assert_called_once_with(("93.184.216.34", 80))
    finally:
        engine.dispose()
