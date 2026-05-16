# Changelog
All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
### Security
- Removed user_hash from TrackOut schema to prevent credential exposure
- Added SSRF hardening for remote artwork fetch endpoints
- Added remote image fetch byte cap (8MB) and content-type validation
- Hardened auth_hash input validation (strict hex format)

### Fixed
- Artwork endpoint auth regression restored browser image loading compatibility
