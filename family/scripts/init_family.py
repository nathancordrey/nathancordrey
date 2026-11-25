"""Initialize and administer the private Family SQLite DB, offline on Linode.

Usage:
  FAMILY_DATA_DIR=/srv/family-album python family/scripts/init_family.py init
  FAMILY_DATA_DIR=/srv/family-album python family/scripts/init_family.py set-user nathan "Nathan"

The command prompts for passwords without echo. Never run against a public directory.
"""
import getpass
import os
import sqlite3
import sys
from pathlib import Path

from werkzeug.security import generate_password_hash

SCHEMA = """
CREATE TABLE IF NOT EXISTS family_users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS family_login_attempts (
    id INTEGER PRIMARY KEY,
    lookup_key TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_family_attempt_key_time
ON family_login_attempts (lookup_key, created_at);
"""


def main():
    folder_string = os.environ.get("FAMILY_DATA_DIR", "")
    if not folder_string or not Path(folder_string).is_absolute():
        raise SystemExit("Set FAMILY_DATA_DIR to a private absolute path")
    folder = Path(folder_string).resolve()
    if not folder.is_dir():
        raise SystemExit("Create private directory first (mode 0700), outside web root/Git")
    path = folder / "family.sqlite3"
    if len(sys.argv) < 2 or sys.argv[1] not in {"init", "set-user"}:
        raise SystemExit("Usage: init | set-user <username> <display name>")
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        if sys.argv[1] == "set-user":
            if len(sys.argv) != 4:
                raise SystemExit("Usage: set-user <username> <display name>")
            username, display_name = sys.argv[2].strip().lower(), sys.argv[3].strip()
            if not username or not display_name or len(username) > 80:
                raise SystemExit("Invalid username or display name")
            password = getpass.getpass("New password (16+ characters): ")
            confirm = getpass.getpass("Confirm password: ")
            if len(password) < 16 or password != confirm:
                raise SystemExit("Passwords differ or are too short")
            password_hash = generate_password_hash(password, method="scrypt")
            db.execute(
                "INSERT INTO family_users(username, display_name, password_hash, active) "
                "VALUES(?,?,?,1) ON CONFLICT(username) DO UPDATE SET "
                "display_name=excluded.display_name, password_hash=excluded.password_hash, active=1",
                (username, display_name, password_hash),
            )
            print("Saved account", username)
        else:
            print("Initialized database", path)
    path.chmod(0o600)


if __name__ == "__main__":
    main()
