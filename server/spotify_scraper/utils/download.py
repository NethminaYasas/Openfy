"""Safe streaming-download helpers for SpotifyScraper.

This module centralises the mitigations for CWE-409 (decompression-bomb)
denial of service in media downloaders:

- :func:`require_https_url` rejects plaintext-HTTP media URLs so an
  attacker on the network path cannot substitute metadata-selected media
  responses.
- :func:`check_content_length` fails fast when a server declares a
  ``Content-Length`` larger than the media-appropriate decoded-byte budget.
- Callers must still enforce the cumulative *decoded*-byte limit inside the
  ``iter_content`` loop (``requests`` transparently decompresses gzip/deflate,
  so ``len(chunk)`` is decoded size) *before* each write, and must remove
  the partial file when the limit is exceeded.
"""

from typing import Any
from urllib.parse import urlparse


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
