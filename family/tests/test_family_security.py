"""Auth and private file delivery boundary tests.

Run: python -m unittest discover -s family/tests -v
"""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from werkzeug.security import generate_password_hash
from family import family, init_app


class FamilyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        with sqlite3.connect(cls.root / "family.sqlite3") as db:
            db.executescript("""
                CREATE TABLE family_users (
                    id INTEGER PRIMARY KEY, username TEXT UNIQUE, display_name TEXT,
                    password_hash TEXT, active INTEGER DEFAULT 1
                );
                CREATE TABLE family_login_attempts (
                    id INTEGER PRIMARY KEY, lookup_key TEXT, created_at REAL
                );
            """)
            db.execute(
                "INSERT INTO family_users VALUES(1,?,?,?,1)",
                ("nathan", "Nathan", generate_password_hash("test-password-for-local-tests", method="scrypt")),
            )
        rev = cls.root / "revisions" / "revision-2"
        (rev / "spreads").mkdir(parents=True)
        (rev / "review.pdf").write_bytes(b"%PDF-1.4\n")
        (rev / "spreads" / "spread-01.jpg").write_bytes(b"\xff\xd8\xff\xd9")
        cls.env = patch.dict(os.environ, {"FAMILY_DATA_DIR": str(cls.root)})
        cls.env.start()
        cls.app = Flask(__name__)
        cls.app.secret_key = "development-test-" + "x" * 40
        cls.app.config.update(TESTING=True, SESSION_COOKIE_SECURE=True)
        init_app(cls.app)
        cls.app.register_blueprint(family)

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.tmp.cleanup()

    def setUp(self):
        self.client = self.app.test_client()

    def sign_in(self):
        self.client.get("/family/login")
        with self.client.session_transaction() as sess:
            csrf = sess["family_csrf"]
        response = self.client.post("/family/login", data={
            "csrf": csrf, "username": "nathan",
            "password": "test-password-for-local-tests"
        })
        self.assertEqual(response.status_code, 302)
        return csrf

    def test_anonymous_assets_rejected(self):
        for url in ("/family/", "/family/revisions/2/pdf",
                    "/family/revisions/2/spreads/1"):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 302)
            self.assertNotIn("X-Accel-Redirect", response.headers)

    def test_login_csrf(self):
        response = self.client.post("/family/login", data={
            "username": "nathan", "password": "test-password-for-local-tests"
        })
        self.assertEqual(response.status_code, 403)

    def test_authenticated_whitelist(self):
        self.sign_in()
        response = self.client.get("/family/revisions/2/pdf")
        self.assertEqual(response.headers["X-Accel-Redirect"],
                         "/__family_private__/revision-2/review.pdf")
        response = self.client.get("/family/revisions/2/spreads/1")
        self.assertEqual(response.headers["X-Accel-Redirect"],
                         "/__family_private__/revision-2/spreads/spread-01.jpg")
        self.assertEqual(self.client.get("/family/revisions/3/pdf").status_code, 404)
        self.assertEqual(self.client.get("/family/revisions/2/spreads/999").status_code, 404)

    def test_logout_blocks_assets(self):
        csrf = self.sign_in()
        self.assertEqual(self.client.post("/family/logout", data={"csrf": csrf}).status_code, 302)
        response = self.client.get("/family/revisions/2/pdf")
        self.assertEqual(response.status_code, 302)
        self.assertNotIn("X-Accel-Redirect", response.headers)

    def test_missing_storage_fails_closed(self):
        with patch.dict(os.environ, {"FAMILY_DATA_DIR": "/no-such-family-test-path"}):
            self.assertEqual(self.client.get("/family/login").status_code, 503)


if __name__ == "__main__":
    unittest.main()
