"""Regression coverage for metadata-selected destinations and overwrite approval."""

import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner

from spotify_scraper.cli.commands import download as commands
from spotify_scraper.client import SpotifyClient
from spotify_scraper.core.exceptions import DownloadError
from spotify_scraper.media import audio, image
from spotify_scraper.utils import download

TRACK_URL = "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6"
ORIGINAL = b"existing local file contents"
MEDIA = b"downloaded media"
COVER_NAME = "Collision_name_track_cover.jpg"
AUDIO_NAME = "Collision_name_by_Artistone.mp3"


class Response:
    status_code = 200
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size):
        yield MEDIA


@pytest.fixture
def media_flow(monkeypatch):
    # Remote names collide only after the writers' existing sanitization.
    metadata = {
        "name": "Collision? name",
        "type": "track",
        "artists": [{"name": "Artist/one"}],
        "album": {"images": [{"url": "https://i.scdn.co/image/cover", "width": 640}]},
        "preview_url": "https://p.scdn.co/mp3-preview/preview",
    }
    client = SpotifyClient.__new__(SpotifyClient)
    client._image_downloader = image.ImageDownloader(None)
    client._audio_downloader = audio.AudioDownloader(None)
    client.get_all_info = lambda url: deepcopy(metadata)
    client.get_track_info = lambda url: deepcopy(metadata)
    client.close = MagicMock()
    monkeypatch.setattr(commands, "create_client", lambda ctx: client)
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *args, **kwargs: [
        (2, 1, 6, "", ("93.184.216.34", 443)),
    ])
    request = MagicMock(side_effect=lambda *args, **kwargs: Response())
    monkeypatch.setattr(image.requests, "get", request)
    return client, metadata, request


@pytest.mark.parametrize("command", ["cover", "track", "batch"])
@pytest.mark.parametrize("decision", ["new", "decline", "approve", "force"])
def test_cli_checks_permission_before_writing(tmp_path, monkeypatch, media_flow, command, decision):
    client, _, request = media_flow
    names = [COVER_NAME] if command == "cover" else [AUDIO_NAME]
    if command == "batch":
        names = [COVER_NAME, AUDIO_NAME]
    output_dir = tmp_path / "media"
    output_dir.mkdir()
    if decision != "new":
        for name in names:
            (output_dir / name).write_bytes(ORIGINAL)

    prompts = []

    def confirm(message):
        name = message.removeprefix("File ").removesuffix(" already exists. Overwrite?")
        assert name in names
        assert (output_dir / name).read_bytes() == ORIGINAL
        prompts.append(name)
        return decision == "approve"

    monkeypatch.setattr(commands, "confirm_action", confirm)
    args = [command, "--output", str(output_dir)]
    if decision == "force":
        args.append("--force")
    if command == "batch":
        urls = tmp_path / "urls.txt"
        urls.write_text(TRACK_URL + "\n")
        args.append(str(urls))
    else:
        args.append(TRACK_URL)

    result = CliRunner().invoke(commands.download, args, obj={})

    assert result.exit_code == 0, result.output
    assert prompts == (names if decision in {"approve", "decline"} else [])
    for name in names:
        assert (output_dir / name).read_bytes() == (ORIGINAL if decision == "decline" else MEDIA)
    assert request.call_count == (0 if decision == "decline" else len(names))
    client.close.assert_called_once()


@pytest.mark.parametrize("kind", ["cover", "audio"])
@pytest.mark.parametrize("collision", ["file", "symlink", "dangling-symlink", "late-file"])
def test_exclusive_creation_never_truncates_or_removes_collisions(
    tmp_path, media_flow, kind, collision
):
    client, metadata, request = media_flow
    destination = tmp_path / (COVER_NAME if kind == "cover" else AUDIO_NAME)
    target = tmp_path / "target"
    if collision == "file":
        destination.write_bytes(ORIGINAL)
    elif collision in {"symlink", "dangling-symlink"}:
        if collision == "symlink":
            target.write_bytes(ORIGINAL)
        destination.symlink_to(target)
    else:
        def respond(*args, **kwargs):
            # A destination appears after permission is resolved, before open.
            destination.write_bytes(ORIGINAL)
            return Response()

        request.side_effect = respond

    downloader = client._image_downloader if kind == "cover" else client._audio_downloader
    method = downloader.download_cover if kind == "cover" else downloader.download_preview
    with pytest.raises(DownloadError) as exc:
        method(metadata, path=str(tmp_path), overwrite=False)

    assert isinstance(exc.value.__cause__, FileExistsError)
    if "symlink" in collision:
        assert destination.is_symlink()
        if collision == "dangling-symlink":
            assert not target.exists()
        else:
            assert target.read_bytes() == ORIGINAL
    else:
        assert destination.read_bytes() == ORIGINAL


@pytest.mark.parametrize("kind", ["cover", "audio"])
def test_cli_refuses_a_destination_created_during_download(tmp_path, media_flow, kind):
    _, _, request = media_flow
    destination = tmp_path / (COVER_NAME if kind == "cover" else AUDIO_NAME)

    def respond(*args, **kwargs):
        destination.write_bytes(ORIGINAL)
        return Response()

    request.side_effect = respond
    result = CliRunner().invoke(
        commands.download,
        ["cover" if kind == "cover" else "track", "--output", str(tmp_path), TRACK_URL],
        obj={},
    )

    assert result.exit_code == 1
    assert destination.read_bytes() == ORIGINAL


@pytest.mark.parametrize("kind", ["cover", "audio"])
def test_failed_download_still_removes_its_partial_file(tmp_path, media_flow, monkeypatch, kind):
    client, metadata, _ = media_flow
    destination = tmp_path / (COVER_NAME if kind == "cover" else AUDIO_NAME)
    module = image if kind == "cover" else audio
    limit = "MAX_IMAGE_DOWNLOAD_BYTES" if kind == "cover" else "MAX_AUDIO_DOWNLOAD_BYTES"
    monkeypatch.setattr(module, limit, len(MEDIA) - 1)
    method = client._image_downloader.download_cover if kind == "cover" else client._audio_downloader.download_preview

    with pytest.raises(DownloadError, match="exceeds size limit"):
        method(metadata, path=str(tmp_path), overwrite=False)

    assert not destination.exists()


def test_cover_embedding_preserves_existing_temporary_basename(tmp_path, media_flow, monkeypatch):
    client, metadata, request = media_flow
    existing_cover = tmp_path / "_temp_cover.jpg"
    existing_cover.write_bytes(ORIGINAL)
    tag = MagicMock()
    eyed3 = SimpleNamespace(load=MagicMock(return_value=SimpleNamespace(tag=tag)))
    monkeypatch.setitem(sys.modules, "eyed3", eyed3)
    downloader = client._audio_downloader._get_image_downloader()
    real_download = downloader.download_cover
    temporary_paths = []

    def download_cover(**kwargs):
        result = real_download(**kwargs)
        temporary_paths.append(Path(result))
        return result

    monkeypatch.setattr(downloader, "download_cover", download_cover)

    result = client.download_preview_mp3(TRACK_URL, path=str(tmp_path), with_cover=True, overwrite=False)

    assert Path(result).read_bytes() == MEDIA
    assert existing_cover.read_bytes() == ORIGINAL
    tag.images.set.assert_called_once_with(3, MEDIA, "image/jpeg")
    tag.save.assert_called_once()
    assert request.call_count == 2
    assert temporary_paths and not temporary_paths[0].parent.exists()
