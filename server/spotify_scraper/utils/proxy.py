"""Validate explicit proxy policies before any network activity."""

from typing import Dict, Optional
from urllib.parse import urlsplit


def normalize_proxy(proxy: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
    """Require a proxy for HTTPS, which all Spotify and media requests use.

    Expand ``all`` into scheme keys so environment proxies cannot override it.
    Empty mappings retain the default environment-based Requests behavior.
    """
    if proxy is None:
        return None
    if not isinstance(proxy, dict):
        raise ValueError("Proxy configuration must be a mapping")
    if not proxy:
        return None
    if set(proxy) - {"http", "https", "all"}:
        raise ValueError("Proxy configuration supports only http, https and all keys")
    for value in proxy.values():
        try:
            if not isinstance(value, str) or not value.strip():
                raise ValueError
            parsed = urlsplit(value)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError
            # Accessing port validates its syntax and range.
            parsed.port
        except ValueError:
            raise ValueError("Proxy URLs must be valid HTTP or HTTPS URLs") from None
    if not (proxy.get("https") or proxy.get("all")):
        raise ValueError("Proxy configuration must cover HTTPS requests")
    result = {key: proxy[key] for key in ("http", "https") if key in proxy}
    if "all" in proxy:
        for key in ("http", "https"):
            result.setdefault(key, proxy["all"])
    return result
