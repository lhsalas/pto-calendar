#!/usr/bin/python3
"""A synthetic credential lookup that stays pending until it is stopped.

This program is a test fixture. It replaces the bundled Secret Service helper
inside a private copy of the build, so a lookup is observably pending: it
records its own process id next to itself and then waits without answering.

It never reads a credential, never writes one, never opens a session bus and
never answers the helper protocol. It exists only to hold a lookup open until
the caller stops it, and it is the only process this fixture owns.
"""

import os
import sys
import time

# The file the fixture writes next to itself when its lookup is pending.
MARKER_NAME = "pending-lookup.pid"

# The longest one wait of the fixture. The lookup is stopped long before it.
WAIT_SECONDS = 3600


def main():
    # The request is read to the end and never used: this fixture answers
    # nothing, so the caller waits for the answer that never comes.
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    marker = os.path.join(os.path.dirname(os.path.abspath(__file__)), MARKER_NAME)
    try:
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
    except OSError:
        pass
    while True:
        time.sleep(WAIT_SECONDS)


if __name__ == "__main__":
    main()
