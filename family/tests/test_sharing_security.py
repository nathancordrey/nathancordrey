"""Sharing security tests; no actual family photos used.

Run: python -m unittest discover -s family/tests -v
"""
import hashlib
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from PIL import Image
from werkzeug.security import generate_password_hash

from family import family, init_app
from family.sharing import album


class SharingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        source = cls.root / "revisions" / "revision-2" / "spreads"
        source.mkdir(parents=True)
        im = Image.new("RGB", (100, 80), color=(80, 140, 110))
        # EXIF metadata deliberately included to verify stripping on publish.
        exif = Image.Exif()
        exif[0x010E] = "private camera note"
        im.save(source / "spread-01.jpg", exif=exif)
        with sqlite3.connect(cls.root / "family.sqlite3") as db:
            db.executescript("""
                CREATE TABLE family_users (
                    id INTEGER PRIMARY KEY, username TEXT UNIQUE,
                    display_name TEXT, password_hash TEXT, active INTEGER DEFAULT 1
                );
                CREATE TABLE family_publishers (user_id INTEGER PRIMARY KEY);
                CREATE TABLE family_login_attempts (
                    id INTEGER PRIMARY KEY, lookup_key TEXT, created_at REAL
                );
                CREATE TABLE family_snapshots (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, source_revision INTEGER NOT NULL,
                    spread_count INTEGER NOT NULL, created_at REAL NOT NULL,
                    publisher_user_id INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE family_share_links (
                    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
                    pin_hash TEXT, expires_at REAL, created_at REAL NOT NULL, revoked_at REAL
                );
                CREATE TABLE family_pin_attempts (
                    id INTEGER PRIMARY KEY, lookup_key TEXT, created_at REAL NOT NULL
                );
            """)
            db.execute("INSERT INTO family_users VALUES (1,'nathan','Nathan',?,1)",
                       (generate_password_hash("local-test-only-password-long", method="scrypt"),))
            db.execute("INSERT INTO family_users VALUES (2,'guest-account','Guest',?,1)",
                       (generate_password_hash("local-test-guest-password-long", method="scrypt"),))
            db.execute("INSERT INTO family_publishers VALUES (1)")
        cls.env = patch.dict(os.environ, {"FAMILY_DATA_DIR": str(cls.root)})
        cls.env.start()
        cls.app = Flask(__name__)
        cls.app.config.update(TESTING=True)
        cls.app.secret_key = "test-signing-secret-not-production-" + "x" * 35
        init_app(cls.app)
        cls.app.register_blueprint(family)
        cls.app.register_blueprint(album)

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.tmp.cleanup()

    def setUp(self):
        self.client = self.app.test_client()

    def login(self, username="nathan", password="local-test-only-password-long"):
        self.client.get("/family/login")
        with self.client.session_transaction() as sess:
            csrf = sess["family_csrf"]
        response = self.client.post("/family/login", data={
            "csrf": csrf, "username": username, "password": password,
        })
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as sess:
            return sess["family_csrf"]

    def publish(self):
        csrf = self.login()
        resp = self.client.post("/family/sharing/publish", data={
            "csrf": csrf, "title": "Test family selection", "revision": "2",
            "spreads": "1", "approved": "yes",
        })
        self.assertEqual(resp.status_code, 303)
        with sqlite3.connect(self.root / "family.sqlite3") as db:
            snapshot = db.execute("SELECT id FROM family_snapshots ORDER BY created_at DESC LIMIT 1").fetchone()[0]
        return csrf, snapshot

    def link(self, csrf, snapshot, pin="", duration="30"):
        resp = self.client.post("/family/sharing/links/" + snapshot, data={
            "csrf": csrf, "pin": pin, "duration": duration,
        })
        self.assertEqual(resp.status_code, 200)
        # Token returned in link exactly once and not stored in plaintext.
        with sqlite3.connect(self.root / "family.sqlite3") as db:
            row = db.execute(
                "SELECT id,token_hash FROM family_share_links WHERE snapshot_id=? ORDER BY created_at DESC LIMIT 1",
                (snapshot,),
            ).fetchone()
        import re
        token = re.search(rb"/album/([A-Za-z0-9_-]{32,160})", resp.data).group(1).decode()
        self.assertEqual(hashlib.sha256(token.encode()).hexdigest(), row[1])
        return row[0], token

    def test_unauthenticated_and_unprivileged_cannot_publish(self):
        resp = self.client.post("/family/sharing/publish", data={})
        self.assertEqual(resp.status_code, 302)
        self.login("guest-account", "local-test-guest-password-long")
        self.assertEqual(self.client.get("/family/sharing").status_code, 403)

    def test_approval_and_csrf_required(self):
        csrf = self.login()
        endpoint = "/family/sharing/publish"
        body = {"csrf": csrf, "title": "Test", "revision": "2", "spreads": "1"}
        self.assertEqual(self.client.post(endpoint, data=body).status_code, 400)
        body["approved"] = "yes"
        body["csrf"] = "invalid"
        self.assertEqual(self.client.post(endpoint, data=body).status_code, 403)

    def test_publish_all_spreads_and_keep_manual_selection(self):
        # Build all 20 small, synthetic spread fixtures for the complete-revision option.
        source = self.root / "revisions" / "revision-2" / "spreads"
        original = (source / "spread-01.jpg").read_bytes()
        for number in range(2, 21):
            (source / ("spread-%02d.jpg" % number)).write_bytes(original)
        csrf = self.login()
        response = self.client.post("/family/sharing/publish", data={
            "csrf": csrf, "title": "Complete test revision", "revision": "2",
            "spread_selection": "all", "approved": "yes",
        })
        self.assertEqual(response.status_code, 303)
        with sqlite3.connect(self.root / "family.sqlite3") as db:
            record = db.execute(
                "SELECT id,spread_count FROM family_snapshots "
                "WHERE title='Complete test revision' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        self.assertIsNotNone(record)
        self.assertEqual(record[1], 20)
        target = self.root / "published" / record[0] / "spreads"
        self.assertEqual(len(list(target.glob("spread-*.jpg"))), 20)

        invalid = self.client.post("/family/sharing/publish", data={
            "csrf": csrf, "title": "Invalid selection", "revision": "2",
            "spread_selection": "unknown", "approved": "yes",
        })
        self.assertEqual(invalid.status_code, 400)

    def test_snapshot_metadata_removed_and_publisher_preview(self):
        csrf, snapshot = self.publish()
        path = self.root / "published" / snapshot / "spreads" / "spread-01.jpg"
        self.assertTrue(path.is_file())
        with Image.open(path) as im:
            self.assertEqual(len(im.getexif()), 0)
        self.assertEqual(self.client.get("/family/sharing/preview/" + snapshot).status_code, 200)
        response = self.client.get("/family/sharing/preview/" + snapshot + "/spreads/1")
        self.assertEqual(response.status_code, 200)
        self.assertIn(snapshot, response.headers["X-Accel-Redirect"])

    def test_link_pin_and_revocation(self):
        csrf, snapshot = self.publish()
        share_id, token = self.link(csrf, snapshot, pin="private-PIN-123")
        entry = "/album/" + token
        self.assertEqual(self.client.get(entry).status_code, 200)
        self.assertEqual(self.client.get("/album/view/" + share_id).status_code, 404)
        with self.client.session_transaction() as sess:
            pin_csrf = sess["family_csrf"]
        self.assertEqual(self.client.post(entry, data={"csrf": pin_csrf, "pin": "incorrect"}).status_code, 401)
        self.assertEqual(self.client.post(entry, data={"csrf": pin_csrf, "pin": "private-PIN-123"}).status_code, 303)
        self.assertEqual(self.client.get("/album/view/" + share_id).status_code, 200)
        image = self.client.get("/album/view/" + share_id + "/spreads/1")
        self.assertEqual(image.status_code, 200)
        self.assertIn(snapshot, image.headers["X-Accel-Redirect"])
        self.assertEqual(self.client.post("/family/sharing/revoke/" + share_id, data={"csrf": csrf}).status_code, 303)
        self.assertEqual(self.client.get("/album/view/" + share_id + "/spreads/1").status_code, 404)

    def test_no_pin_and_unpublish_revokes_issued_link(self):
        csrf, snapshot = self.publish()
        share_id, token = self.link(csrf, snapshot)
        self.assertEqual(self.client.get("/album/" + token).status_code, 303)
        self.assertEqual(self.client.get("/album/view/" + share_id).status_code, 200)
        self.assertEqual(self.client.post("/family/sharing/unpublish/" + snapshot, data={"csrf": csrf}).status_code, 303)
        self.assertEqual(self.client.get("/album/view/" + share_id).status_code, 404)

    def test_expired_link_rejected(self):
        csrf, snapshot = self.publish()
        share_id, token = self.link(csrf, snapshot)
        with sqlite3.connect(self.root / "family.sqlite3") as db:
            db.execute("UPDATE family_share_links SET expires_at=? WHERE id=?", (time.time()-1, share_id))
        self.assertEqual(self.client.get("/album/" + token).status_code, 404)


if __name__ == "__main__":
    unittest.main()
