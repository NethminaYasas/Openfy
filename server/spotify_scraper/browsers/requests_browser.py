"""
Requests-based browser implementation for SpotifyScraper.

This module provides a browser implementation using the requests library.
Think of this as a simple web client that can fetch Spotify pages without
the complexity of a full browser like Selenium. It's lighter weight but
still handles the essential tasks of getting web page content.
"""

import logging
import os
import time
from typing import Any, Dict, FrozenSet, Optional

import requests
from requests.adapters import HTTPAdapter

try:
    from requests.packages.urllib3.util.retry import Retry
except ImportError:
    from urllib3.util.retry import Retry

from spotify_scraper.auth.session import Session
from spotify_scraper.browsers.base import Browser
from spotify_scraper.core.constants import (
    DEFAULT_HEADERS,
    DEFAULT_RETRIES,
    DEFAULT_TIMEOUT,
    MAX_GENERIC_DOWNLOAD_BYTES,
    STREAM_CHUNK_SIZE,
)
from spotify_scraper.core.exceptions import AuthenticationError, BrowserError, NetworkError
from spotify_scraper.utils.download import (
    ALLOWED_MEDIA_HOSTS,
    ALLOWED_SPOTIFY_API_HOSTS,
    ALLOWED_SPOTIFY_PAGE_HOSTS,
    MAX_MANUAL_REDIRECTS,
    REDIRECT_STATUS_CODES,
    canonicalize_https_url,
    is_allowed_media_url,
    resolve_redirect,
)

logger = logging.getLogger(__name__)

# Re-exported for backwards compatibility (also imported by selenium_browser).
__all__ = [
    "ALLOWED_MEDIA_HOSTS",
    "ALLOWED_SPOTIFY_API_HOSTS",
    "ALLOWED_SPOTIFY_PAGE_HOSTS",
    "MAX_MANUAL_REDIRECTS",
    "RequestsBrowser",
]
_REDIRECT_STATUS_CODES = REDIRECT_STATUS_CODES


def _canonicalize_https_url(url: str, allowed_hosts: FrozenSet[str], *, url_name: str = "URL") -> str:
    """Canonicalize *url* to HTTPS after allowlist validation (CWE-918).

    Thin wrapper binding :exc:`NetworkError` as the error factory; see
    :func:`spotify_scraper.utils.download.canonicalize_https_url`.
    """
    return canonicalize_https_url(
        url, allowed_hosts, error_factory=NetworkError, url_name=url_name
    )


def _resolve_redirect(current_url: str, location: str, allowed_hosts: FrozenSet[str]) -> str:
    """Resolve and validate a redirect destination (CWE-918).

    Thin wrapper binding :exc:`NetworkError` as the error factory; see
    :func:`spotify_scraper.utils.download.resolve_redirect`.
    """
    return resolve_redirect(current_url, location, allowed_hosts, error_factory=NetworkError)


def _is_allowed_media_url(url: str) -> bool:
    """Check whether *url* is an HTTPS Spotify/media URL without raising."""
    return is_allowed_media_url(url)


class RequestsBrowser(Browser):
    """
    Browser implementation using the requests library.

    This browser handles HTTP requests to Spotify using the popular requests
    library. It's designed to be simple but robust, with automatic retries,
    proper error handling, and session management.

    Think of this as your primary tool for fetching Spotify web pages. It knows
    how to handle authentication, cookies, and the various quirks of making
    requests to Spotify's servers.
    """

    def __init__(
        self,
        session: Optional[Session] = None,
        timeout: int = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
        headers: Optional[Dict[str, str]] = None,
        rate_limit_delay: float = 0.5,
        rate_limit_backoff: float = 2.0,
    ):
        """
        Initialize the requests-based browser.

        Args:
            session: Authentication session to use
            timeout: Request timeout in seconds
            retries: Number of retry attempts for failed requests
            headers: Additional headers to include in requests
            rate_limit_delay: Minimum delay between requests in seconds
            rate_limit_backoff: Backoff multiplier for rate limit errors
        """
        self.session = session
        self.timeout = timeout
        self.retries = retries
        self.rate_limit_delay = rate_limit_delay
        self.rate_limit_backoff = rate_limit_backoff
        self._last_request_time = 0

        # Set up the requests session with retry strategy
        self.requests_session = requests.Session()

        # Configure automatic retries for network issues
        retry_strategy = Retry(
            total=retries,
            backoff_factor=1,  # Wait 1, 2, 4 seconds between retries
            status_forcelist=[429, 500, 502, 503, 504],  # Retry on these HTTP status codes
            respect_retry_after_header=True,  # Respect Retry-After header
            raise_on_status=False,  # Don't raise on status to handle rate limits manually
        )

        adapter = HTTPAdapter(max_retries=retry_strategy)
        self.requests_session.mount("http://", adapter)
        self.requests_session.mount("https://", adapter)

        # Set up headers
        self.default_headers = DEFAULT_HEADERS.copy()
        if headers:
            self.default_headers.update(headers)

        self.requests_session.headers.update(self.default_headers)
        # Keep constructor headers separate from replaceable session credentials.
        self._base_headers = self.requests_session.headers.copy()
        self.update_session(session)

        logger.debug("Initialized RequestsBrowser")

    def _apply_rate_limit(self):
        """
        Apply rate limiting to avoid hitting Spotify's rate limits.
        """
        current_time = time.time()
        time_since_last_request = current_time - self._last_request_time

        if time_since_last_request < self.rate_limit_delay:
            sleep_time = self.rate_limit_delay - time_since_last_request
            logger.debug("Rate limiting: sleeping for %.2f seconds", sleep_time)
            time.sleep(sleep_time)

        self._last_request_time = time.time()

    def get_page_content(self, url: str) -> str:
        """
        Get the HTML content of a web page.

        This is the main method for fetching Spotify pages. It handles all the
        complexity of making HTTP requests, dealing with errors, and returning
        clean HTML content that can be parsed.

        Args:
            url: URL of the page to get

        Returns:
            HTML content of the page as a string

        Raises:
            NetworkError: If the page cannot be accessed
            AuthenticationError: If authentication is required but fails
        """
        # Canonicalize to authenticated HTTPS on an allowed Spotify host
        # before any network I/O (CWE-918: plaintext HTTP would let a
        # network attacker substitute a Location header pointing at a
        # private endpoint).
        try:
            canonical_url = _canonicalize_https_url(url, ALLOWED_SPOTIFY_PAGE_HOSTS)
        except (NetworkError, BrowserError):
            raise
        except Exception as e:
            raise NetworkError(f"Invalid Spotify URL: {e}", url=url) from e

        retry_count = 0
        while retry_count <= self.retries:
            try:
                logger.debug("Fetching page content from: %s", canonical_url)

                # Follow redirects manually so each destination's HTTPS
                # scheme and allowed authority is validated before the
                # next request is issued.
                current_url = canonical_url
                response = None
                for _ in range(MAX_MANUAL_REDIRECTS + 1):
                    # Apply rate limiting
                    self._apply_rate_limit()

                    response = self.requests_session.get(
                        current_url,
                        timeout=self.timeout,
                        allow_redirects=False,
                    )

                    if response.status_code not in _REDIRECT_STATUS_CODES:
                        break
                    location = response.headers.get("Location")
                    try:
                        current_url = _resolve_redirect(
                            current_url, location, ALLOWED_SPOTIFY_PAGE_HOSTS
                        )
                    except (NetworkError, BrowserError):
                        raise
                    except Exception as e:
                        raise NetworkError(f"Invalid redirect destination: {e}", url=current_url) from e
                    logger.debug("Following validated Spotify redirect to: %s", current_url)
                    response = None
                else:
                    raise NetworkError(
                        f"Too many redirects fetching {canonical_url}", url=canonical_url
                    )

                if response is None:
                    raise NetworkError(f"Too many redirects fetching {canonical_url}", url=canonical_url)

                # Handle rate limiting (429 Too Many Requests)
                if response.status_code == 429:
                    retry_after = response.headers.get("Retry-After", None)
                    if retry_after:
                        sleep_time = float(retry_after)
                    else:
                        sleep_time = self.rate_limit_delay * (self.rate_limit_backoff**retry_count)

                    logger.warning("Rate limited by Spotify. Sleeping for %.2f seconds", sleep_time)
                    time.sleep(sleep_time)
                    retry_count += 1
                    continue

                # Check for authentication issues
                if response.status_code == 401:
                    raise AuthenticationError(f"Authentication required for {current_url}")
                elif response.status_code == 403:
                    raise AuthenticationError(f"Access forbidden for {current_url}")

                # Check for other HTTP errors
                response.raise_for_status()

                # Log success
                logger.debug("Successfully fetched %d characters from %s", len(response.text), current_url)

                return response.text

            except requests.exceptions.Timeout as e:
                logger.error("Request timeout for %s: %s", canonical_url, e)
                raise NetworkError("Request timeout", url=canonical_url) from e

            except requests.exceptions.ConnectionError as e:
                logger.error("Connection error for %s: %s", canonical_url, e)
                raise NetworkError("Connection error", url=canonical_url) from e

            except requests.exceptions.HTTPError as e:
                if e.response and e.response.status_code != 429:  # Don't retry non-429 errors
                    status_code = e.response.status_code if e.response else None
                    logger.error("HTTP error for %s: %s", canonical_url, e)
                    raise NetworkError(f"HTTP error: {e}", url=canonical_url, status_code=status_code) from e
                retry_count += 1

            except (NetworkError, AuthenticationError):
                raise

            except Exception as e:
                logger.error("Unexpected error fetching %s: %s", canonical_url, e)
                raise BrowserError(f"Unexpected error: {e}", browser_type="requests") from e

        # If we've exhausted all retries
        raise NetworkError(f"Failed to fetch {canonical_url} after {self.retries} retries", url=canonical_url)

    def get_json(self, url: str) -> Dict[str, Any]:
        """
        Get JSON data from a URL.

        This method is useful for API endpoints that return JSON directly,
        though most Spotify scraping will use get_page_content instead.

        Args:
            url: URL to get JSON data from

        Returns:
            Parsed JSON data as a dictionary

        Raises:
            NetworkError: If the URL cannot be accessed
            ParsingError: If the response is not valid JSON
        """
        try:
            canonical_url = _canonicalize_https_url(url, ALLOWED_SPOTIFY_API_HOSTS)
            logger.debug("Fetching JSON from: %s", canonical_url)

            # Follow redirects manually with per-hop HTTPS + allowlist
            # validation (CWE-918).
            current_url = canonical_url
            response = None
            for _ in range(MAX_MANUAL_REDIRECTS + 1):
                # Apply rate limiting
                self._apply_rate_limit()

                response = self.requests_session.get(
                    current_url,
                    timeout=self.timeout,
                    headers={"Accept": "application/json"},
                    allow_redirects=False,
                )

                if response.status_code not in _REDIRECT_STATUS_CODES:
                    break
                location = response.headers.get("Location")
                current_url = _resolve_redirect(current_url, location, ALLOWED_SPOTIFY_API_HOSTS)
                logger.debug("Following validated Spotify JSON redirect to: %s", current_url)
                response = None
            else:
                raise NetworkError(f"Too many redirects fetching {canonical_url}", url=canonical_url)

            if response is None:
                raise NetworkError(f"Too many redirects fetching {canonical_url}", url=canonical_url)

            response.raise_for_status()

            json_data = response.json()
            logger.debug("Successfully fetched JSON with %d keys from %s", len(json_data), current_url)

            return json_data

        except requests.exceptions.JSONDecodeError as e:
            logger.error("Invalid JSON response from %s: %s", url, e)
            raise NetworkError("Invalid JSON response", url=url) from e

        except (NetworkError, BrowserError):
            raise

        except Exception as e:
            logger.error("Error fetching JSON from %s: %s", url, e)
            raise NetworkError(f"Error fetching JSON: {e}", url=url) from e

    def download_file(self, url: str, path: str) -> str:
        """
        Download a file from a URL and save it to disk.

        This method handles downloading media files like images and audio previews.
        It streams the download to avoid loading large files entirely into memory.

        Args:
            url: URL of the file to download
            path: Path where the file should be saved

        Returns:
            Path to the downloaded file

        Raises:
            NetworkError: If the file cannot be downloaded
            MediaError: If the file cannot be saved
        """
        try:
            logger.debug("Downloading file from %s to %s", url, path)

            # Require HTTPS Spotify/media URLs so substituted metadata cannot
            # downgrade the media fetch to plaintext HTTP, and reject
            # credentials in the URL (CWE-918 MITM substitution vector).
            if not _is_allowed_media_url(url):
                raise NetworkError(f"Refusing to download from disallowed URL: {url!r}", url=url)
            canonical_url = _canonicalize_https_url(url, ALLOWED_MEDIA_HOSTS, url_name="download URL")

            # Apply rate limiting
            self._apply_rate_limit()

            # Resolve redirects manually, validating HTTPS + allowlisted
            # media authority on every hop before streaming any body.
            current_url = canonical_url
            redirect_count = 0
            response = None
            while True:
                resp = self.requests_session.get(
                    current_url,
                    stream=True,
                    timeout=self.timeout,
                    allow_redirects=False,
                )
                if resp.status_code in _REDIRECT_STATUS_CODES:
                    location = resp.headers.get("Location")
                    resp.close()
                    try:
                        current_url = _resolve_redirect(current_url, location, ALLOWED_MEDIA_HOSTS)
                    except (NetworkError, BrowserError):
                        raise
                    except Exception as e:
                        raise NetworkError(f"Invalid download redirect destination: {e}", url=current_url) from e
                    redirect_count += 1
                    if redirect_count > MAX_MANUAL_REDIRECTS:
                        raise NetworkError(
                            f"Too many redirects downloading {canonical_url}", url=canonical_url
                        )
                    if not _is_allowed_media_url(current_url):
                        raise NetworkError(
                            f"Refusing download redirect to disallowed URL: {current_url!r}",
                            url=current_url,
                        )
                    logger.debug("Following validated media redirect to: %s", current_url)
                    self._apply_rate_limit()
                    continue
                response = resp
                break

            # Stream the download to handle large files efficiently
            with response as response:
                response.raise_for_status()

                try:
                    declared = response.headers.get("Content-Length")
                    if declared not in (None, "") and int(str(declared).strip()) > MAX_GENERIC_DOWNLOAD_BYTES:
                        raise NetworkError(
                            f"Download exceeds size limit of {MAX_GENERIC_DOWNLOAD_BYTES} bytes",
                            url=current_url,
                        )
                except NetworkError:
                    raise
                except (TypeError, ValueError):
                    pass

                # Save the file in chunks, enforcing the cumulative
                # *decoded*-byte limit before each write (CWE-409:
                # compressed responses expand ~1000x on disk).
                total_bytes = 0
                try:
                    with open(path, "wb") as f:
                        for chunk in response.iter_content(chunk_size=STREAM_CHUNK_SIZE):
                            if chunk:  # Filter out keep-alive chunks
                                total_bytes += len(chunk)
                                if total_bytes > MAX_GENERIC_DOWNLOAD_BYTES:
                                    raise NetworkError(
                                        f"Download exceeds size limit of {MAX_GENERIC_DOWNLOAD_BYTES} bytes",
                                        url=current_url,
                                    )
                                f.write(chunk)
                except Exception:
                    try:
                        if os.path.exists(path):
                            os.remove(path)
                    except OSError:
                        pass
                    raise

            logger.debug("Successfully downloaded file to %s", path)
            return path

        except (NetworkError, BrowserError):
            raise
        except Exception as e:
            logger.error("Error downloading file from %s: %s", url, e)
            raise NetworkError(f"Download error: {e}", url=url) from e

    def get_auth_token(self) -> Optional[str]:
        """
        Get an authentication token for Spotify API access.

        This method attempts to extract an authentication token from the current
        session or from Spotify pages. These tokens can be used for API calls
        that require authentication.

        Returns:
            Authentication token if available, None otherwise
        """
        if self.session and self.session.access_token:
            return self.session.access_token

        # For now, we don't have a way to extract tokens from pages
        # This could be implemented by parsing the __NEXT_DATA__ script tag
        # and extracting the session token from there
        logger.debug("No authentication token available")
        return None

    def close(self) -> None:
        """
        Close the browser and release any resources.

        This method cleans up the requests session and any other resources
        that the browser was using. It's good practice to call this when
        you're done using the browser.
        """
        if self.requests_session:
            self.requests_session.close()
        logger.debug("Closed RequestsBrowser")

    def update_session(self, session: Optional[Session]) -> None:
        """
        Update the authentication session used by this browser.

        This method allows you to change the authentication credentials
        without creating a new browser instance.

        Args:
            session: New session to use for authentication, or None to clear it
        """
        self.session = session

        # Discard the previous identity, including cookies received from servers
        # and custom authentication headers, before installing the replacement.
        self.requests_session.headers.clear()
        self.requests_session.headers.update(self._base_headers)
        self.requests_session.cookies.clear()

        # Update headers with new authentication info
        if session:
            auth_headers = session.get_auth_headers()
            self.requests_session.headers.update(auth_headers)

            # Update cookies
            if session.cookies:
                self.requests_session.cookies.update(session.cookies)

        logger.debug("Updated browser session")
