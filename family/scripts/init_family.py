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
CREATE TABLE IF NOT EXISTS family_publishers (
    user_id INTEGER PRIMARY KEY REFERENCES family_users(id)
);
CREATE TABLE IF NOT EXISTS family_snapshots (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    spread_count INTEGER NOT NULL,
    created_at REAL NOT NULL,
    publisher_user_id INTEGER NOT NULL REFERENCES family_users(id),
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS family_share_links (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES family_snapshots(id),
    token_hash TEXT NOT NULL UNIQUE,
    pin_hash TEXT,
    expires_at REAL,
    created_at REAL NOT NULL,
    revoked_at REAL
);
CREATE TABLE IF NOT EXISTS family_pin_attempts (
    id INTEGER PRIMARY KEY,
    lookup_key TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_family_share_snapshot ON family_share_links(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_family_pin_attempt_key ON family_pin_attempts(lookup_key, created_at);
CREATE TABLE IF NOT EXISTS family_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revision INTEGER NOT NULL,
    spread INTEGER NOT NULL,
    parent_id INTEGER REFERENCES family_comments(id),
    author_user_id INTEGER NOT NULL REFERENCES family_users(id),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
    created_at REAL NOT NULL,
    resolved_at REAL,
    resolved_by INTEGER REFERENCES family_users(id),
    edited_at REAL,
    deleted_at REAL,
    CHECK (revision >= 1 AND spread >= 1)
);
CREATE INDEX IF NOT EXISTS idx_family_comments_spread
ON family_comments(revision, spread, created_at, id);
CREATE INDEX IF NOT EXISTS idx_family_comments_parent
ON family_comments(parent_id);
"""


def main():
    folder_string = os.environ.get("FAMILY_DATA_DIR", "")
    if not folder_string or not Path(folder_string).is_absolute():
        raise SystemExit("Set FAMILY_DATA_DIR to a private absolute path")
    folder = Path(folder_string).resolve()
    if not folder.is_dir():
        raise SystemExit("Create private directory first (mode 0700), outside web root/Git")
    path = folder / "family.sqlite3"
    if len(sys.argv) < 2 or sys.argv[1] not in {"init", "set-user", "grant-publisher"}:
        raise SystemExit("Usage: init | set-user <username> <display name> | grant-publisher <username>")
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        # Existing installations have family_comments without edit/delete columns.
        # SQLite's ADD COLUMN is additive and preserves comments, users and links.
        columns = {row[1] for row in db.execute("PRAGMA table_info(family_comments)")}
        for name in ("edited_at", "deleted_at"):
            if name not in columns:
                db.execute("ALTER TABLE family_comments ADD COLUMN " + name + " REAL")
        if sys.argv[1] == "grant-publisher":
            if len(sys.argv) != 3:
                raise SystemExit("Usage: grant-publisher <username>")
            row = db.execute("SELECT id FROM family_users WHERE username=? AND active=1", (sys.argv[2].lower(),)).fetchone()
            if not row:
                raise SystemExit("No such active account")
            db.execute("INSERT OR IGNORE INTO family_publishers(user_id) VALUES (?)", (row[0],))
            print("Publisher access granted to", sys.argv[2])
        elif sys.argv[1] == "set-user":
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
