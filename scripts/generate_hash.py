#!/usr/bin/env python3
import hashlib, sys
if len(sys.argv) != 2:
    print("Usage: python generate_hash.py <password>")
    sys.exit(1)
print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
