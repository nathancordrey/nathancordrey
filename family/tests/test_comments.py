"""Private spread comments must remain restricted to authenticated editors."""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from werkzeug.security import generate_password_hash

from family import family, init_app
from family.scripts.init_family import SCHEMA
from family.sharing import album


class CommentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.directory = Path(cls.temp.name)
        db_path = cls.directory / "family.sqlite3"
        with sqlite3.connect(db_path) as db:
            db.executescript(SCHEMA)
            for ident, name in ((1, "nathan"), (2, "rachel"), (3, "viewer")):
                db.execute(
                    "INSERT INTO family_users(id,username,display_name,password_hash,active)"
                    "VALUES(?,?,?,?,1)",
                    (ident, name, name.title(),
                     generate_password_hash("testing-password-at-least-16", method="scrypt")),
                )
            db.execute("INSERT INTO family_publishers(user_id) VALUES (1),(2)")
        cls.patch = patch.dict(os.environ, {"FAMILY_DATA_DIR": str(cls.directory)})
        cls.patch.start()
        cls.app = Flask(__name__)
        cls.app.secret_key = "development-test-only-" + ("a" * 40)
        cls.app.config.update(TESTING=True)
        init_app(cls.app)
        cls.app.register_blueprint(family)
        cls.app.register_blueprint(album)

    @classmethod
    def tearDownClass(cls):
        cls.patch.stop()
        cls.temp.cleanup()

    def setUp(self):
        with sqlite3.connect(self.directory / "family.sqlite3") as db:
            db.execute("DELETE FROM family_comments")
            db.execute("DELETE FROM family_login_attempts")
        self.client = self.app.test_client()

    def login(self, name):
        self.client.get("/family/login")
        with self.client.session_transaction() as sess:
            old_csrf = sess["family_csrf"]
        resp = self.client.post("/family/login", data={
            "username": name, "password": "testing-password-at-least-16", "csrf": old_csrf,
        })
        self.assertEqual(resp.status_code, 302)
        with self.client.session_transaction() as sess:
            return sess["family_csrf"]

    def add(self, csrf, message, revision=2, spread=1, parent=None):
        data = {"csrf": csrf, "body": message, "spread": str(spread)}
        if parent is not None:
            data["parent_id"] = str(parent)
        return self.client.post(f"/family/revisions/{revision}/comments", data=data)

    def only_id(self):
        with sqlite3.connect(self.directory / "family.sqlite3") as db:
            return db.execute("SELECT id FROM family_comments ORDER BY id LIMIT 1").fetchone()[0]

    def test_anonymous_and_noneditor_cannot_read_or_write(self):
        self.assertEqual(self.client.get("/family/revisions/2").status_code, 302)
        self.assertEqual(self.add("", "anonymous").status_code, 302)
        csrf = self.login("viewer")
        response = self.client.get("/family/revisions/2")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"Private layout notes", response.data)
        self.assertEqual(self.add(csrf, "not allowed").status_code, 403)

    def test_editor_discussion_rachel_reply_and_resolve(self):
        csrf = self.login("nathan")
        response = self.add(csrf, "Try Rachel's other photo on the right")
        self.assertEqual(response.status_code, 303)
        root_id = self.only_id()
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"Try Rachel", page.data)
        self.assertIn(b"Mark resolved", page.data)
        self.client.post("/family/logout", data={"csrf": csrf})
        csrf = self.login("rachel")
        response = self.add(csrf, "Yes, let's try it", parent=root_id)
        self.assertEqual(response.status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"Rachel", page.data)
        self.assertIn(b"Yes, let", page.data)
        self.assertEqual(self.client.post(
            f"/family/revisions/2/comments/{root_id}/status",
            data={"csrf": csrf, "action": "resolve"},
        ).status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"Reopen discussion", page.data)
        self.assertEqual(self.client.post(
            f"/family/revisions/2/comments/{root_id}/status",
            data={"csrf": csrf, "action": "reopen"},
        ).status_code, 303)
        self.assertIn(b"Mark resolved", self.client.get("/family/revisions/2?spread=1").data)

    def test_revision_and_spread_isolation(self):
        csrf = self.login("nathan")
        self.assertEqual(self.add(csrf, "Only revision two, spread three", spread=3).status_code, 303)
        root_id = self.only_id()
        self.assertNotIn(b"Only revision two", self.client.get("/family/revisions/2?spread=2").data)
        self.assertNotIn(b"Only revision two", self.client.get("/family/revisions/1?spread=3").data)
        self.assertIn(b"Only revision two", self.client.get("/family/revisions/2?spread=3").data)
        self.assertEqual(self.add(csrf, "Invalid cross-spread reply", spread=4, parent=root_id).status_code, 400)
        self.assertEqual(self.add(csrf, "Invalid cross-revision reply", revision=1, spread=3, parent=root_id).status_code, 400)

    def test_html_is_escaped_and_input_validated(self):
        csrf = self.login("nathan")
        self.assertEqual(self.add(csrf, "<script>alert('private')</script>").status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertNotIn(b"<script>", page.data)
        self.assertIn(b"&lt;script&gt;", page.data)
        self.assertEqual(self.add(csrf, " ").status_code, 400)
        self.assertEqual(self.add(csrf, "x" * 2001).status_code, 400)
        self.assertEqual(self.add("invalid", "changed").status_code, 403)
        self.assertEqual(self.add(csrf, "bad", spread=999).status_code, 404)
        self.assertEqual(self.add(csrf, "bad", revision=999).status_code, 404)

    def update_comment(self, csrf, comment_id, text, revision=2):
        return self.client.post(
            f"/family/revisions/{revision}/comments/{comment_id}/edit",
            data={"csrf": csrf, "body": text},
        )

    def remove_comment(self, csrf, comment_id, revision=2):
        return self.client.post(
            f"/family/revisions/{revision}/comments/{comment_id}/delete",
            data={"csrf": csrf},
        )

    def test_author_can_edit_and_delete_unreplied_comment(self):
        csrf = self.login("nathan")
        self.assertEqual(self.add(csrf, "Original comment").status_code, 303)
        comment_id = self.only_id()
        self.assertEqual(self.update_comment(csrf, comment_id, "Revised photo selection").status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"Revised photo selection", page.data)
        self.assertIn(b"edited", page.data)
        self.assertNotIn(b"Original comment", page.data)
        self.assertEqual(self.remove_comment(csrf, comment_id).status_code, 303)
        with sqlite3.connect(self.directory / "family.sqlite3") as db:
            self.assertIsNone(db.execute(
                "SELECT id FROM family_comments WHERE id=?", (comment_id,)
            ).fetchone())
        self.assertNotIn(b"Revised photo selection", self.client.get("/family/revisions/2?spread=1").data)

    def test_cannot_edit_or_delete_others_comments(self):
        csrf = self.login("nathan")
        self.assertEqual(self.add(csrf, "Nathan's private note").status_code, 303)
        comment_id = self.only_id()
        self.client.post("/family/logout", data={"csrf": csrf})
        csrf = self.login("rachel")
        self.assertEqual(self.update_comment(csrf, comment_id, "Overwritten").status_code, 403)
        self.assertEqual(self.remove_comment(csrf, comment_id).status_code, 403)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"Nathan", page.data)
        self.assertNotIn(b"Overwritten", page.data)
        self.assertNotIn(b'action="/family/revisions/2/comments/'+str(comment_id).encode()+b'/edit"', page.data)

    def test_delete_root_keeps_replies_without_original_text(self):
        csrf = self.login("nathan")
        self.add(csrf, "Remove this root text")
        root_id = self.only_id()
        self.client.post("/family/logout", data={"csrf": csrf})
        rachel_csrf = self.login("rachel")
        self.assertEqual(self.add(rachel_csrf, "Keep Rachel's reply", parent=root_id).status_code, 303)
        self.client.post("/family/logout", data={"csrf": rachel_csrf})
        csrf = self.login("nathan")
        self.assertEqual(self.remove_comment(csrf, root_id).status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"This comment was deleted.", page.data)
        self.assertIn(b"Keep Rachel", page.data)
        self.assertNotIn(b"Remove this root text", page.data)
        with sqlite3.connect(self.directory / "family.sqlite3") as db:
            row = db.execute("SELECT body, deleted_at FROM family_comments WHERE id=?", (root_id,)).fetchone()
            self.assertEqual(row[0], "[deleted]")
            self.assertIsNotNone(row[1])
        self.assertEqual(self.update_comment(csrf, root_id, "Restore secret").status_code, 404)
        self.assertEqual(self.remove_comment(csrf, root_id).status_code, 404)

    def test_reply_author_can_edit_and_delete_reply(self):
        csrf = self.login("nathan")
        self.add(csrf, "Root question")
        root_id = self.only_id()
        self.client.post("/family/logout", data={"csrf": csrf})
        csrf = self.login("rachel")
        self.add(csrf, "Initial reply", parent=root_id)
        with sqlite3.connect(self.directory / "family.sqlite3") as db:
            reply_id = db.execute(
                "SELECT id FROM family_comments WHERE parent_id=?", (root_id,)
            ).fetchone()[0]
        self.assertEqual(self.update_comment(csrf, reply_id, "Updated reply").status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertIn(b"Updated reply", page.data)
        self.assertNotIn(b"Initial reply", page.data)
        self.assertEqual(self.remove_comment(csrf, reply_id).status_code, 303)
        page = self.client.get("/family/revisions/2?spread=1")
        self.assertNotIn(b"Updated reply", page.data)
        self.assertIn(b"Root question", page.data)

    def test_invalid_edits_and_wrong_revision_rejected(self):
        csrf = self.login("nathan")
        self.add(csrf, "Good content")
        comment_id = self.only_id()
        self.assertEqual(self.update_comment("wrong", comment_id, "Bad").status_code, 403)
        self.assertEqual(self.update_comment(csrf, comment_id, " ").status_code, 400)
        self.assertEqual(self.update_comment(csrf, comment_id, "x"*2001).status_code, 400)
        self.assertEqual(self.update_comment(csrf, comment_id, "Bad", revision=1).status_code, 404)
        self.assertEqual(self.remove_comment(csrf, comment_id, revision=1).status_code, 404)
        self.assertEqual(self.client.get("/album/view/" + "x"*32).status_code, 404)

    def test_mobile_page_controls_on_private_revision(self):
        self.login("nathan")
        response = self.client.get("/family/revisions/2?spread=1")
        self.assertEqual(response.status_code, 200)
        for choice in (b"Full spread", b"Left page", b"Right page", b"Open full image"):
            self.assertIn(choice, response.data)
        self.assertIn(b"/family/revisions/2/spreads/1", response.data)

    def test_no_leak_to_guest_blueprint(self):
        csrf = self.login("nathan")
        self.add(csrf, "PRIVATE EDITORIAL NOTE")
        with sqlite3.connect(self.directory / "family.sqlite3") as db:
            db.execute(
                "INSERT INTO family_snapshots "
                "(id,title,source_revision,spread_count,created_at,publisher_user_id,active)"
                "VALUES(?,?,2,1,1,1,1)",
                ("a" * 32, "Public test",),
            )
            db.execute(
                "INSERT INTO family_share_links "
                "(id,snapshot_id,token_hash,pin_hash,expires_at,created_at) "
                "VALUES (?,?,?,NULL,NULL,1)",
                ("b" * 32, "a" * 32, "c" * 64),
            )
        with self.client.session_transaction() as sess:
            sess["family_shared_links"] = ["b" * 32]
        response = self.client.get("/album/view/" + "b" * 32)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"PRIVATE EDITORIAL NOTE", response.data)
        self.assertNotIn(b"Private layout notes", response.data)


if __name__ == "__main__":
    unittest.main()
