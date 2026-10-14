"""Regression coverage for browser requests paused before following redirects."""

from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import urljoin

import pytest

pytest.importorskip("selenium")

from selenium.common.exceptions import WebDriverException

from spotify_scraper.browsers.selenium_browser import SeleniumBrowser
from spotify_scraper.core.exceptions import BrowserError, NetworkError
from spotify_scraper.utils import download


class InterceptedDriver:
    """Only send a simulated request after interception explicitly permits it."""

    def __init__(self, locations=(), navigation_error=False):
        self.locations = locations
        self.navigation_error = navigation_error
        self.requested = []
        self.get_calls = []
        self.network = MagicMock()
        self.network.add_event_handler.side_effect = self.subscribe
        self.network.continue_request.side_effect = self.send
        self.network.fail_request.side_effect = self.abort
        self.browsing_context = SimpleNamespace(navigate=self.navigate)
        self.current_window_handle = "context-id"
        self.page_source = "<html>Spotify</html>"

    def subscribe(self, event, callback):
        assert event == "before_request"
        self.callback = callback
        return 1

    def send(self, *, request, url=None):
        self.requested.append(url or self.pending_url)
        self.aborted = False

    def abort(self, *, request):
        self.aborted = True

    def intercept(self, url, navigation="navigation-id", redirect_count=0):
        self.pending_url = url
        self.callback({
            "isBlocked": True,
            "navigation": navigation,
            "redirectCount": redirect_count,
            "request": {"url": url, "request": "request-id"},
        })

    def navigate(self, *, context, url, wait):
        assert context == self.current_window_handle
        assert wait == "complete"
        self.get_calls.append(url)
        self.network.add_intercept.assert_called_once_with(phases=["beforeRequestSent"])
        self.intercept(url)
        for hop, location in enumerate(self.locations, 1):
            url = urljoin(self.requested[-1], location)
            self.intercept(url, redirect_count=hop)
            if self.aborted:
                if self.navigation_error:
                    raise WebDriverException("navigation aborted")
                break

    def quit(self):
        pass


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *args, **kwargs: [
        (2, 1, 6, "", ("93.184.216.34", 443)),
    ])


@pytest.mark.parametrize("destination", [
    "http://127.0.0.1/internal", "https://169.254.169.254/latest/meta-data",
    "https://attacker.example/", "https://open.spotify.com.attacker.example/",
    "https://user:password@open.spotify.com/track/1", "https://open.spotify.com:bad/",
    "file:///etc/passwd",
])
@pytest.mark.parametrize("navigation_error", [False, True])
def test_disallowed_later_hop_is_blocked_before_request(destination, navigation_error):
    driver = InterceptedDriver(["https://play.spotify.com/next", destination], navigation_error)
    browser = SeleniumBrowser(driver=driver)

    with pytest.raises(NetworkError):
        browser.get_page_content("https://open.spotify.com/start")

    assert driver.requested == ["https://open.spotify.com/start", "https://play.spotify.com/next"]
    driver.network.fail_request.assert_called_once_with(request="request-id")


def test_allowed_relative_redirects_and_https_upgrade():
    driver = InterceptedDriver(["/next", "//embed.spotify.com/final", "http://play.spotify.com/end"])
    browser = SeleniumBrowser(driver=driver)

    assert browser.get_page_content("http://open.spotify.com/start") == driver.page_source
    assert driver.requested == [
        "https://open.spotify.com/start", "https://open.spotify.com/next",
        "https://embed.spotify.com/final", "https://play.spotify.com/end",
    ]
    driver.network.fail_request.assert_not_called()


def test_guard_persists_for_script_navigations_and_is_installed_once():
    driver = InterceptedDriver()
    browser = SeleniumBrowser(driver=driver)
    browser.get_page_content("https://open.spotify.com/start")
    browser.get_page_content("https://open.spotify.com/next")

    driver.intercept("http://127.0.0.1/script-navigation")

    assert driver.requested == ["https://open.spotify.com/start", "https://open.spotify.com/next"]
    driver.network.add_event_handler.assert_called_once()
    driver.network.fail_request.assert_called_once()


def test_cdn_subresources_are_not_treated_as_page_navigations():
    driver = InterceptedDriver()
    browser = SeleniumBrowser(driver=driver)
    browser.get_page_content("https://open.spotify.com/start")

    driver.intercept("https://i.scdn.co/image/cover", navigation=None)

    assert driver.requested[-1] == "https://i.scdn.co/image/cover"
    driver.network.fail_request.assert_not_called()


@pytest.mark.parametrize("failure", ["missing-api", "subscribe", "intercept"])
def test_interception_unavailable_fails_before_navigation(failure):
    driver = InterceptedDriver()
    if failure == "missing-api":
        driver.network = SimpleNamespace()
    elif failure == "subscribe":
        driver.network.add_event_handler.side_effect = WebDriverException("BiDi unavailable")
    else:
        driver.network.add_intercept.side_effect = WebDriverException("interception unsupported")

    with pytest.raises(BrowserError, match="Safe navigation requires"):
        SeleniumBrowser(driver=driver).get_page_content("https://open.spotify.com/start")

    assert driver.get_calls == []
    assert driver.requested == []
    if failure == "intercept":
        driver.network.remove_event_handler.assert_called_once_with("before_request", 1)


def test_invalid_initial_url_never_calls_driver():
    driver = InterceptedDriver()
    with pytest.raises(NetworkError):
        SeleniumBrowser(driver=driver).get_page_content("http://127.0.0.1/internal")
    assert driver.get_calls == []
    driver.network.add_event_handler.assert_not_called()


def test_private_dns_answer_on_allowed_redirect_is_blocked(monkeypatch):
    driver = InterceptedDriver(["https://play.spotify.com/private"])
    browser = SeleniumBrowser(driver=driver)
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda host, *args, **kwargs: [
        (2, 1, 6, "", ("127.0.0.1" if host == "play.spotify.com" else "93.184.216.34", 443)),
    ])

    with pytest.raises(NetworkError, match="non-public destination"):
        browser.get_page_content("https://open.spotify.com/start")

    assert driver.requested == ["https://open.spotify.com/start"]


def test_unblocked_observation_does_not_continue_a_request_twice():
    driver = InterceptedDriver()
    browser = SeleniumBrowser(driver=driver)
    browser.get_page_content("https://open.spotify.com/start")
    driver.callback({"isBlocked": False})
    assert driver.requested == ["https://open.spotify.com/start"]


@pytest.mark.parametrize("url", ["data:image/png;base64,test", "blob:https://open.spotify.com/image"])
def test_non_network_subresources_need_no_protocol_command(url):
    driver = InterceptedDriver()
    SeleniumBrowser(driver=driver).get_page_content("https://open.spotify.com/start")
    driver.intercept(url, navigation=None)
    assert driver.requested == ["https://open.spotify.com/start"]
    driver.network.fail_request.assert_not_called()


@pytest.mark.parametrize("browser_name", ["chrome", "firefox"])
def test_owned_drivers_enable_bidi(monkeypatch, browser_name):
    from spotify_scraper.browsers import selenium_browser

    create_driver = MagicMock(return_value=InterceptedDriver())
    monkeypatch.setattr(selenium_browser.webdriver, browser_name.title(), create_driver)

    SeleniumBrowser(browser_name=browser_name, use_webdriver_manager=False)

    options = create_driver.call_args.kwargs["options"]
    assert options.capabilities["webSocketUrl"] is True
