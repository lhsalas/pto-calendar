"""Drive a compiled CLI with a disposable terminal and separate JSON stdout."""

import json
import os
import pty
import select
import signal
import subprocess
import sys
import time


SCREEN_LIMIT = 8192


def drain(master):
    """Collect only the bytes the terminal already holds, never waiting for more."""
    screen = bytearray()
    while True:
        readable, _, _ = select.select([master], [], [], 0)
        if not readable:
            break
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break  # Linux PTY returns EIO when the owned child has closed its terminal.
        if not chunk:
            break
        screen.extend(chunk)
        if len(screen) > SCREEN_LIMIT:
            raise RuntimeError("CLI terminal output was not bounded")
    return screen


def run_piped(executable, argv):
    """Input is a disposable terminal and diagnostics are a pipe. Nothing is typed."""
    master, slave = pty.openpty()
    child = subprocess.Popen(
        [executable, *argv],
        stdin=slave,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    os.close(slave)
    try:
        stdout, stderr = child.communicate(timeout=8)
        terminal = drain(master)
        print(json.dumps({
            "exit": child.returncode,
            "stdout": stdout.decode("utf-8"),
            "stderr": stderr.decode("utf-8"),
            "terminal": terminal.decode("utf-8"),
        }))
    finally:
        os.close(master)
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)


def run():
    decision, executable, *argv = sys.argv[1:]
    assert decision in {"yes", "no", "interrupt", "pipe"}
    if decision == "pipe":
        run_piped(executable, argv)
        return
    master, slave = pty.openpty()
    child = subprocess.Popen(
        [executable, *argv],
        stdin=slave,
        stderr=slave,
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    os.close(slave)
    screen = bytearray()
    answered = False
    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
            if not readable:
                break
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break  # Linux PTY returns EIO when the owned child closes its terminal.
            if not chunk:
                break
            screen.extend(chunk)
            if len(screen) > SCREEN_LIMIT:
                raise RuntimeError("CLI terminal output was not bounded")
            if not answered and b"Type yes and press Enter to confirm: " in screen:
                answered = True
                if decision == "interrupt":
                    child.send_signal(signal.SIGINT)
                else:
                    os.write(master, decision.encode("ascii") + b"\n")
        stdout, _ = child.communicate(timeout=5)
        if not answered:
            raise RuntimeError("The CLI did not present a confirmation prompt")
        print(json.dumps({
            "exit": child.returncode,
            "stdout": stdout.decode("utf-8"),
            "stderr": screen.decode("utf-8"),
        }))
    finally:
        os.close(master)
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)


if __name__ == "__main__":
    try:
        run()
    except Exception:
        # No child args, terminal bytes, environment or raw traceback on error.
        sys.stderr.write("Disposable write confirmation process failed\n")
        sys.exit(1)
