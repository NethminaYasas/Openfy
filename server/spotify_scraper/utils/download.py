"""Safe streaming-download helpers for SpotifyScraper.

This module centralises the mitigations for CWE-409 (decompression-bomb)
denial of service and CWE-918 (server-side request forgery) in media
downloaders and page fetchers:

- :func:`require_https_url` rejects plaintext-HTTP media URLs so an
  attacker on the network path cannot substitute metadata-selected media
  responses.
- :func:`check_content_length` fails fast when a server declares a
  ``Content-Length`` larger than the media-appropriate decoded-byte budget.
- :func:`canonicalize_https_url` upgrades ``http://`` Spotify URLs to
  canonical ``https://`` form after allowlist validation, so the initial
  request never traverses plaintext HTTP where a ``Location`` header could
  be substituted.
- :func:`resolve_redirect` resolves a redirect ``Location`` against the
  current URL and validates the destination before it is requested.
  Callers must disable automatic redirects (``allow_redirects=False``) and
  follow at most :data:`MAX_MANUAL_REDIRECTS` hops through this function.
- :func:`assert_public_host` rejects loopback, private, link-local, and
  other non-global destinations, including via DNS resolution.
- Callers must still enforce the cumulative *decoded*-byte limit inside the
  ``iter_content`` loop (``requests`` transparently decompresses gzip/deflate,
  so ``len(chunk)`` is decoded size) *before* each write, and must remove
  the partial file when the limit is exceeded.
"""

import ipaddress
import os
import socket
from typing import Any, Callable, FrozenSet, Optional, Tuple, Union
from urllib.parse import urljoin, urlparse, urlunparse

# Hosts that page/API fetches may target. Redirects are only followed when
# the destination stays on HTTPS and within an allowlist, so a
# plaintext-HTTP response with an attacker-substituted Location header
# cannot pivot the server to a private/internal endpoint (CWE-918).
ALLOWED_SPOTIFY_PAGE_HOSTS: FrozenSet[str] = frozenset(
    {
        "open.spotify.com",
        "play.spotify.com",
        "embed.spotify.com",
        "www.spotify.com",
        "spotify.com",
    }
)
ALLOWED_SPOTIFY_API_HOSTS: FrozenSet[str] = frozenset(
    set(ALLOWED_SPOTIFY_PAGE_HOSTS) | {"api.spotify.com", "accounts.spotify.com"}
)
# Media (preview/cover) destinations: Spotify hosts plus Spotify CDN
# suffixes. Any subdomain of these Spotify-controlled domains is accepted.
ALLOWED_MEDIA_HOST_SUFFIXES: Tuple[str, ...] = (".scdn.co", ".spotifycdn.com", ".spotify.com")
ALLOWED_MEDIA_HOSTS: FrozenSet[str] = frozenset(
    set(ALLOWED_SPOTIFY_API_HOSTS)
    | {"i.scdn.co", "mos.scdn.co", "p.scdn.co", "scdn.co", "spotifycdn.com"}
)
MAX_MANUAL_REDIRECTS = 5
REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})

OverwritePolicy = Union[bool, Callable[[str], bool]]


def select_download_mode(file_path: str, overwrite: OverwritePolicy) -> Optional[str]:
    """Choose a write mode after resolving the sanitized destination.

    A callback approves replacement of this specific existing path. Declining
    returns None so the downloader can skip it. Without replacement permission,
    exclusive creation protects files that appear after this check, including
    dangling symlinks. True retains the library's unconditional overwrite mode.
    """
    if overwrite is True:
        return "wb"
    if callable(overwrite) and os.path.lexists(file_path):
        return "wb" if overwrite(file_path) else None
    return "xb"


def require_https_url(url: str, *, error_factory: Any) -> None:
    """Raise ``error_factory`` unless *url* uses the HTTPS scheme.

    Args:
        url: Candidate media URL (e.g. cover or preview URL from metadata).
        error_factory: Exception class/callable raised on violation. It is
            called with a single human-readable message string.

    Raises:
        Whatever ``error_factory`` produces when the URL is missing, not a
        string, or does not use ``https``.
    """
    scheme = urlparse(url).scheme.lower() if isinstance(url, str) and url else ""
    if scheme != "https":
        raise error_factory(f"Refusing to download over insecure scheme for URL: {url!r}")


def check_content_length(response: Any, max_bytes: int, *, error_factory: Any) -> None:
    """Fail fast if the declared ``Content-Length`` exceeds *max_bytes*.

    A missing, malformed, or smaller header is *not* sufficient on its own —
    callers must still enforce the cumulative decoded-byte limit while
    streaming, because the header can lie and because decoded bytes may
    exceed the transferred size by ~1000x for compressed responses.

    Args:
        response: ``requests`` response with a ``headers`` mapping.
        max_bytes: Maximum allowed decoded bytes.
        error_factory: Exception class/callable raised on violation. It is
            called with a single human-readable message string.
    """
    try:
        declared = response.headers.get("Content-Length")
    except Exception:  # defensive: headers may be missing in tests/mocks
        return
    if declared is None or declared == "":
        return
    try:
        declared_bytes = int(str(declared).strip())
    except (TypeError, ValueError):
        return
    if declared_bytes > max_bytes:
        raise error_factory(
            f"Declared Content-Length {declared_bytes} exceeds limit of {max_bytes} bytes"
        )


def assert_public_host(hostname: str, *, error_factory: Any) -> None:
    """Raise ``error_factory`` unless *hostname* is a public destination.

    Rejects IP literals outright and rejects hostnames that resolve to
    loopback, private, link-local, multicast, reserved, or otherwise
    non-global addresses (CWE-918). DNS resolution failures fail open —
    the subsequent fetch will fail closed on its own — so offline
    environments only lose the extra check, not the request itself.

    Args:
        hostname: DNS name or IP literal (already lowercased, no port).
        error_factory: Exception class/callable raised on violation. It is
            called with a single human-readable message string.
    """
    if not isinstance(hostname, str) or not hostname:
        raise error_factory("Refusing request with missing host")
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        raise error_factory(f"Refusing request to IP-literal destination: {hostname!r}")
    try:
        addr_infos = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError, ValueError):
        return
    for info in addr_infos:
        sockaddr = info[4] if len(info) > 4 else None
        if not sockaddr:
            continue
        try:
            resolved = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
        if (
            resolved.is_private
            or resolved.is_loopback
            or resolved.is_link_local
            or resolved.is_multicast
            or resolved.is_reserved
            or resolved.is_unspecified
            or not resolved.is_global
        ):
            raise error_factory(
                f"Refusing request to non-public destination for host {hostname!r} ({resolved})"
            )


def canonicalize_https_url(
    url: str, allowed_hosts: FrozenSet[str], *, error_factory: Any, url_name: str = "URL"
) -> str:
    """Return the canonical HTTPS form of *url* after allowlist validation.

    Rejects non-HTTP(S) schemes, embedded credentials, hosts outside
    *allowed_hosts*, and non-public destinations. Plaintext ``http://``
    URLs on allowed hosts are upgraded to ``https://`` so the initial
    request never traverses plaintext HTTP where a ``Location`` header
    could be substituted (CWE-918).

    Args:
        url: Candidate URL to validate and canonicalize.
        allowed_hosts: Exact host allowlist (lowercase, no ports).
            Subdomain-suffix matching is the caller's job — see
            :func:`is_allowed_media_url` for the media variant.
        error_factory: Exception class/callable raised on violation. It is
            called with a single human-readable message string.
        url_name: Human-readable label used in error messages.
    """
    if not isinstance(url, str) or not url:
        raise error_factory(f"Invalid {url_name}: URL must be a non-empty string")
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise error_factory(f"Refusing to fetch {url_name} with non-HTTP(S) scheme: {url!r}")
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host or host not in allowed_hosts:
        raise error_factory(f"Refusing to fetch {url_name} with disallowed host: {url!r}")
    if parsed.username or parsed.password:
        raise error_factory(f"Refusing to fetch {url_name} with embedded credentials: {url!r}")
    # Force authenticated HTTPS transport; drop any explicit default port.
    netloc = host
    try:
        port = parsed.port
    except ValueError:
        raise error_factory(f"Refusing to fetch {url_name} with invalid port: {url!r}") from None
    if port and port != 443 and not (scheme == "http" and port == 80):
        netloc = f"{host}:{port}"
    assert_public_host(host, error_factory=error_factory)
    return urlunparse(parsed._replace(scheme="https", netloc=netloc))


def resolve_redirect(
    current_url: str, location: str, allowed_hosts: FrozenSet[str], *, error_factory: Any
) -> str:
    """Resolve redirect *location* against *current_url* and validate it.

    Args:
        current_url: URL that returned the redirect (already canonical).
        location: Raw ``Location`` header value (absolute or relative).
        allowed_hosts: Exact host allowlist for the destination.
        error_factory: Exception class/callable raised on violation. It is
            called with a single human-readable message string.
    """
    if not isinstance(location, str) or not location:
        raise error_factory(f"Redirect response missing Location header for {current_url!r}")
    destination = urljoin(current_url, location)
    return canonicalize_https_url(
        destination, allowed_hosts, error_factory=error_factory, url_name="redirect destination"
    )


def is_allowed_media_url(url: str) -> bool:
    """Check whether *url* is an HTTPS Spotify/media URL without raising.

    Accepts exact :data:`ALLOWED_MEDIA_HOSTS` matches as well as any
    subdomain of the Spotify-controlled suffixes in
    :data:`ALLOWED_MEDIA_HOST_SUFFIXES`.
    """
    if not isinstance(url, str) or not url:
        return False
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme.lower() != "https":
        return False
    if parsed.username or parsed.password:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return False
    if host in ALLOWED_MEDIA_HOSTS:
        return True
    return host.endswith(ALLOWED_MEDIA_HOST_SUFFIXES)
