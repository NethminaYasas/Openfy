"""
Openfy's local SpotiFLAC customizations.

Contains the custom Apple Music/Spotify downloader (appleDL) and
configuration that Openfy uses on top of the upstream SpotiFLAC package.
"""

from .appleDL import AppleMusicDownloader

__all__ = ["AppleMusicDownloader"]
