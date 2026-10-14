"""Security regressions for credential persistence (synthetic credentials only)."""

import json
import os
import stat
from pathlib import Path

import pytest

from spotify_scraper.auth.session import Session

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Requires POSIX file permissions")


@pytest.fixture
def session():
    session = Session(cookies={"sp_dc": "test-cookie"}, headers={"X-Private": "test-header"})
    session.set_access_token("test-token", expires_in=3600)
    return session


@pytest.fixture
def permissive_umask():
    previous = os.umask(0)
    try:
        yield
    finally:
        os.umask(previous)


@pytest.mark.parametrize("filepath", [None, "session.json", Path("nested/session.json")])
@pytest.mark.parametrize("existing_mode", [None, 0o644, 0o666])
def test_save_is_private_and_round_trips(session, tmp_path, monkeypatch, permissive_umask, filepath, existing_mode):
    monkeypatch.chdir(tmp_path)
    destination = tmp_path / (filepath or ".spotify_session_cache")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if existing_mode is not None:
        destination.write_text("old session", encoding="utf-8")
        destination.chmod(existing_mode)

    assert session.save_to_file(filepath)

    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    restored = Session.load_from_file(filepath)
    assert restored is not None
    assert vars(restored) == vars(session)
    assert restored.get_auth_headers()["Authorization"] == "Bearer test-token"
    assert list(destination.parent.iterdir()) == [destination]


def test_credentials_are_private_before_serialization(session, tmp_path, monkeypatch, permissive_umask):
    original_dump = json.dump

    def check_permissions(data, file, **kwargs):
        assert stat.S_IMODE(os.fstat(file.fileno()).st_mode) == 0o600
        assert stat.S_IMODE(Path(file.name).parent.stat().st_mode) == 0o700
        original_dump(data, file, **kwargs)

    monkeypatch.setattr(json, "dump", check_permissions)

    assert session.save_to_file(tmp_path / "session.json")


@pytest.mark.parametrize("link_type", ["symlink", "hardlink"])
def test_save_replaces_links_without_writing_to_their_target(session, tmp_path, link_type):
    target = tmp_path / "target.json"
    target.write_text("unrelated data", encoding="utf-8")
    target.chmod(0o666)
    destination = tmp_path / "session.json"
    if link_type == "symlink":
        destination.symlink_to(target)
    else:
        os.link(target, destination)

    assert session.save_to_file(destination)

    assert not destination.is_symlink()
    assert not destination.samefile(target)
    assert target.read_text(encoding="utf-8") == "unrelated data"
    assert target.stat().st_mode & 0o777 == 0o666
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert Session.load_from_file(destination).access_token == session.access_token


@pytest.mark.parametrize("failure", ["serialization", "replace"])
@pytest.mark.parametrize("existing", [False, True])
def test_failed_save_preserves_destination_and_cleans_up(session, tmp_path, monkeypatch, failure, existing):
    destination = tmp_path / "session.json"
    if existing:
        destination.write_text("old session", encoding="utf-8")

    if failure == "serialization":
        def fail_dump(data, file, **kwargs):
            file.write('{"access_token":')
            raise TypeError("serialization failed")

        monkeypatch.setattr(json, "dump", fail_dump)
    else:
        def fail_replace(src, dst):
            raise OSError("replacement failed")

        monkeypatch.setattr(os, "replace", fail_replace)

    assert session.save_to_file(destination) is False

    if existing:
        assert destination.read_text(encoding="utf-8") == "old session"
    else:
        assert not destination.exists()
    assert list(tmp_path.iterdir()) == ([destination] if existing else [])


def test_missing_parent_returns_false(session, tmp_path):
    assert session.save_to_file(tmp_path / "missing" / "session.json") is False
    assert list(tmp_path.iterdir()) == []
