#!/usr/bin/env python3
import secrets
import sys

if len(sys.argv) != 1:
    sys.exit("Usage: python scripts/generate_hash.py (no password argument)")

# Keep the credential within the existing 64-character database columns.
# The prefix distinguishes new random credentials from legacy password digests.
print("of1_" + secrets.token_urlsafe(45))
