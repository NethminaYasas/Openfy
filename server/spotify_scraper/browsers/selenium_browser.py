"""
Selenium-based browser implementation for SpotifyScraper.

This module provides a browser implementation using Selenium for handling
dynamic web content.
"""

try:
    from selenium import webdriver
    from selenium.common.exceptions import TimeoutException, WebDriverException
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    SELENIUM_AVAILABLE = True
except ImportError:
    SELENIUM_AVAILABLE = False

try:
    from selenium.webdriver.chrome.service import Service as ChromeService
    from selenium.webdriver.firefox.service import Service as FirefoxService
    from webdriver_manager.chrome import ChromeDriverManager
    from webdriver_manager.firefox import GeckoDriverManager

    WEBDRIVER_MANAGER_AVAILABLE = True
except ImportError:
    WEBDRIVER_MANAGER_AVAILABLE = False

import json
import logging
import os
from threading import Lock
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from spotify_scraper.browsers.base import Browser
from spotify_scraper.browsers.requests_browser import (
    ALLOWED_SPOTIFY_PAGE_HOSTS,
    _canonicalize_https_url,
)
from spotify_scraper.core.constants import MAX_GENERIC_DOWNLOAD_BYTES, STREAM_CHUNK_SIZE
from spotify_scraper.core.exceptions import BrowserError, NetworkError, ParsingError

logger = logging.getLogger(__name__)


class SeleniumBrowser(Browser):
    """
    Browser implementation using Selenium.

    This class provides an implementation of the Browser interface
    using Selenium for handling dynamic web content.
    """

    def __init__(
        self,
        driver: Optional[Any] = None,
        browser_name: str = "chrome",
        use_webdriver_manager: bool = True,
    ):
        """
        Initialize the SeleniumBrowser.

        Args:
            driver: Selenium WebDriver instance with WebDriver BiDi enabled (optional).
                Requires Selenium's BiDi network event and interception APIs.
            browser_name: Browser to use ("chrome" or "firefox")
            use_webdriver_manager: Whether to use webdriver-manager for automatic driver
                downloads (default: True)
        """
        if not SELENIUM_AVAILABLE:
            raise ImportError(
                "Selenium is not available. Please install it with 'pip install selenium'"
            )

        if driver is None:
            browser_name = browser_name.lower()

            if browser_name == "firefox":
                # Create a new Firefox driver
                options = webdriver.FirefoxOptions()
                options.set_capability("webSocketUrl", True)
                options.add_argument("--headless")
                options.add_argument("--window-size=1920,1080")
                # Firefox-specific preferences
                options.set_preference("dom.webnotifications.enabled", False)
                options.set_preference("dom.push.enabled", False)

                try:
                    if use_webdriver_manager and WEBDRIVER_MANAGER_AVAILABLE:
                        # Use webdriver-manager to automatically download and manage driver
                        service = FirefoxService(GeckoDriverManager().install())
                        self.driver = webdriver.Firefox(service=service, options=options)
                        logger.info("Initialized Firefox WebDriver using webdriver-manager")
                    else:
                        # Fall back to system-installed driver
                        if use_webdriver_manager and not WEBDRIVER_MANAGER_AVAILABLE:
                            logger.warning(
                                "webdriver-manager requested but not available. "
                                "Install with: pip install webdriver-manager"
                            )
                        self.driver = webdriver.Firefox(options=options)
                        logger.info("Initialized Firefox WebDriver using system driver")
                except WebDriverException as e:
                    logger.error("Failed to create Firefox driver: %s", e)
                    raise BrowserError(f"Failed to create Firefox driver: {e}") from e
            elif browser_name == "chrome":
                # Create a new Chrome driver
                options = webdriver.ChromeOptions()
                options.set_capability("webSocketUrl", True)
                options.add_argument("--headless")
                options.add_argument("--no-sandbox")
                options.add_argument("--disable-dev-shm-usage")
                options.add_argument("--disable-gpu")
                options.add_argument("--window-size=1920,1080")

                try:
                    if use_webdriver_manager and WEBDRIVER_MANAGER_AVAILABLE:
                        # Use webdriver-manager to automatically download and manage driver
                        service = ChromeService(ChromeDriverManager().install())
                        self.driver = webdriver.Chrome(service=service, options=options)
                        logger.info("Initialized Chrome WebDriver using webdriver-manager")
                    else:
                        # Fall back to system-installed driver
                        if use_webdriver_manager and not WEBDRIVER_MANAGER_AVAILABLE:
                            logger.warning(
                                "webdriver-manager requested but not available. "
                                "Install with: pip install webdriver-manager"
                            )
                        self.driver = webdriver.Chrome(options=options)
                        logger.info("Initialized Chrome WebDriver using system driver")
                except WebDriverException as e:
                    logger.error("Failed to create Chrome driver: %s", e)
                    raise BrowserError(f"Failed to create Chrome driver: {e}") from e
            else:
                raise ValueError(f"Unsupported browser: {browser_name}. Use 'chrome' or 'firefox'")
        else:
            self.driver = driver

        self._navigation_network = None
        self._navigation_error = None
        self._navigation_lock = Lock()

        logger.debug(
            "Initialized SeleniumBrowser with %s",
            browser_name if driver is None else "custom driver",
        )

    def _enable_navigation_guard(self) -> None:
        """Pause navigation requests, including each redirect, before network I/O."""
        if self._navigation_network is not None:
            return

        try:
            network = self.driver.network

            def check_request(event):
                if not event["isBlocked"]:
                    return
                request = event["request"]
                # BiDi callbacks run on separate threads. Serialize protocol commands.
                with self._navigation_lock:
                    try:
                        if event["navigation"] is not None:
                            destination = _canonicalize_https_url(
                                request["url"], ALLOWED_SPOTIFY_PAGE_HOSTS
                            )
                            network.continue_request(request=request["request"], url=destination)
                        else:
                            # Scripts, images and API calls are not page navigations.
                            # data/blob resources have no interceptable network request.
                            if urlparse(request["url"]).scheme.lower() in ("http", "https"):
                                network.continue_request(request=request["request"])
                    except Exception as e:
                        self._navigation_error = (
                            e if isinstance(e, (NetworkError, BrowserError))
                            else BrowserError(f"Failed to intercept browser request: {e}")
                        )
                        network.fail_request(request=request["request"])

            # Subscribe before adding the intercept so no paused request is missed.
            callback_id = network.add_event_handler("before_request", check_request)
            try:
                network.add_intercept(phases=["beforeRequestSent"])
            except Exception:
                network.remove_event_handler("before_request", callback_id)
                raise
            # Keep interception installed for delayed script/meta-refresh navigations.
            self._navigation_network = network
        except Exception as e:
            raise BrowserError(
                "Safe navigation requires Selenium BiDi network interception and a driver "
                "created with the webSocketUrl capability enabled"
            ) from e

    def get_page_content(self, url: str) -> str:
        """
        Get page content from URL.

        Args:
            url: URL to retrieve

        Returns:
            Page content as string
        """
        try:
            # Canonicalize to HTTPS on an allowed Spotify host before
            # navigating, so plaintext-HTTP URLs cannot expose the fetch
            # to Location-header substitution (CWE-918).
            canonical_url = _canonicalize_https_url(url, ALLOWED_SPOTIFY_PAGE_HOSTS)
        except (NetworkError, BrowserError):
            raise
        except Exception as e:
            raise NetworkError(f"Invalid Spotify URL: {e}", url=url) from e
        try:
            self._enable_navigation_guard()
            self._navigation_error = None
            logger.debug("Navigating to %s", canonical_url)
            # Use BiDi navigation too: a blocking classic get() can prevent
            # ChromeDriver from processing the interception's continue/fail commands.
            self.driver.browsing_context.navigate(
                context=self.driver.current_window_handle, url=canonical_url, wait="complete"
            )
            if self._navigation_error is not None:
                raise self._navigation_error
            return self.driver.page_source
        except (NetworkError, BrowserError):
            raise
        except WebDriverException as e:
            if self._navigation_error is not None:
                raise self._navigation_error from e
            logger.error("Failed to navigate to %s: %s", canonical_url, e)
            raise BrowserError(f"Failed to navigate to {canonical_url}: {e}") from e

    def get_json(self, url: str) -> Dict[str, Any]:
        """
        Get JSON data from a URL.

        Args:
            url: URL that returns JSON data

        Returns:
            Parsed JSON data as a dictionary
        """
        try:
            content = self.get_page_content(url)
            return json.loads(content)
        except json.JSONDecodeError as e:
            logger.error("Failed to parse JSON data: %s", e)
            raise ParsingError(f"Failed to parse JSON data: {e}") from e

    def download_file(self, url: str, path: str) -> str:
        """
        Download a file from a URL.

        Args:
            url: URL to download
            path: Local path to save file

        Returns:
            Path where file was saved
        """
        import requests

        try:
            # Require HTTPS so substituted metadata cannot downgrade the
            # media fetch to plaintext HTTP (MITM substitution vector).
            if urlparse(url).scheme.lower() != "https":
                raise BrowserError(f"Refusing to download over insecure scheme: {url!r}")

            with requests.get(url, stream=True, timeout=30, allow_redirects=False) as response:
                if 300 <= response.status_code < 400:
                    raise BrowserError(f"Refusing redirected file download from {url!r}")
                response.raise_for_status()

                try:
                    declared = response.headers.get("Content-Length")
                    if declared not in (None, "") and int(str(declared).strip()) > MAX_GENERIC_DOWNLOAD_BYTES:
                        raise BrowserError(
                            f"Download exceeds size limit of {MAX_GENERIC_DOWNLOAD_BYTES} bytes"
                        )
                except BrowserError:
                    raise
                except (TypeError, ValueError):
                    pass

                parent = os.path.dirname(path)
                if parent:
                    os.makedirs(parent, exist_ok=True)

                # Enforce the cumulative *decoded*-byte limit before each write
                # (CWE-409: compressed responses expand ~1000x on disk).
                total_bytes = 0
                try:
                    with open(path, "wb") as f:
                        for chunk in response.iter_content(chunk_size=STREAM_CHUNK_SIZE):
                            if not chunk:  # Filter out keep-alive chunks
                                continue
                            total_bytes += len(chunk)
                            if total_bytes > MAX_GENERIC_DOWNLOAD_BYTES:
                                raise BrowserError(
                                    f"Download exceeds size limit of {MAX_GENERIC_DOWNLOAD_BYTES} bytes"
                                )
                            f.write(chunk)
                except Exception:
                    try:
                        if os.path.exists(path):
                            os.remove(path)
                    except OSError:
                        pass
                    raise

            return path
        except BrowserError:
            raise
        except Exception as e:
            logger.error("Failed to download file: %s", e)
            raise BrowserError(f"Failed to download file: {e}") from e

    def get_auth_token(self) -> Optional[str]:
        """
        Get authentication token.

        Returns:
            Authentication token if available
        """
        # Selenium browser doesn't have built-in auth
        return None

    def extract_json(self, selector: str) -> Dict[str, Any]:
        """
        Extract JSON data from page using JavaScript.

        Args:
            selector: CSS selector to locate the JSON data

        Returns:
            Parsed JSON data as a dictionary
        """
        try:
            # Wait for the selector to be available
            self.wait_for_element(selector)

            # Get the JSON string from the page. Selector is passed as a
            # separate script argument to keep data separate from code.
            script = "var el = document.querySelector(arguments[0]); return el ? el.textContent : null;"
            json_str = self.driver.execute_script(script, selector)

            if not json_str:
                logger.error("JSON data not found with selector: %s", selector)
                raise ParsingError(f"JSON data not found with selector: {selector}")

            # Parse the JSON data
            json_data = json.loads(json_str)

            return json_data
        except json.JSONDecodeError as e:
            logger.error("Failed to parse JSON data: %s", e)
            raise ParsingError(f"Failed to parse JSON data: {e}") from e
        except Exception as e:
            logger.error("Failed to extract JSON data: %s", e)
            raise BrowserError(f"Failed to extract JSON data: {e}") from e

    def wait_for_element(self, selector: str, timeout: int = 10) -> bool:
        """
        Wait for element to be available.

        Args:
            selector: CSS selector for the element
            timeout: Maximum time to wait in seconds

        Returns:
            True if element is found, False otherwise
        """
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, selector))
            )
            return True
        except TimeoutException:
            logger.warning("Timeout waiting for element: %s", selector)
            return False

    def close(self) -> None:
        """
        Close browser session.
        """
        logger.debug("Closing SeleniumBrowser")
        self.driver.quit()
