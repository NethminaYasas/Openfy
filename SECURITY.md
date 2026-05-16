# Security Policy

## Supported Versions
Only the latest commit on `main` receives security fixes at this stage.

## Reporting a Vulnerability
Please do NOT open a public GitHub issue for security vulnerabilities.

Report vulnerabilities privately via GitHub Security Advisories:
https://github.com/NethminaYasas/Openfy/security/advisories/new

You can expect an initial response within 7 days.

## Known Limitations (by Design)
- Artwork endpoints are unauthenticated by design to support browser <img> loading
- Rate limiting is in-memory only; not suitable for multi-worker deployments
- The auth_hash model has no session expiry; treat it as a long-lived token
