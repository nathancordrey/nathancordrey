"""Private spread discussions for album editors (never exposed through /album).

The current family_publishers role belongs to Nathan and Rachel and gates both
layout discussion and publishing. Publishing/guest blueprints do not query notes.
"""
from __future__ import annotations

from datetime import datetime, timezone

from flask import abort, redirect, request, url_for
from flask_login import current_user, login_required

from . import REVISIONS, check_csrf, db_connection, family

MAX_COMMENT_LENGTH = 2000


def editor_allowed(db):
    return bool(
        current_user.is_authenticated
        and db.execute(
            "SELECT 1 FROM family_publishers WHERE user_id=?",
            (int(current_user.get_id()),),
        ).fetchone()
    )


def require_editor(db):
    if not editor_allowed(db):
        abort(403)


def valid_spread(revision, spread):
    if revision not in REVISIONS or not 1 <= spread <= REVISIONS[revision]["spreads"]:
        abort(404)


def spread_redirect(revision, spread):
    return redirect(
        url_for("family.revision_view", revision=revision, spread=spread) + "#comments",
        code=303,
    )


def label_date(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%b %-d, %Y")


def fetch_discussions(db, revision, spread):
    """Return display-ready roots with one level of replies, ordered oldest first."""
    rows = db.execute(
        "SELECT c.id, c.body, c.parent_id, c.created_at, c.resolved_at, "
        "c.author_user_id, c.edited_at, c.deleted_at, "
        "u.display_name AS author_name "
        "FROM family_comments c JOIN family_users u ON u.id=c.author_user_id "
        "WHERE c.revision=? AND c.spread=? "
        "ORDER BY c.created_at, c.id",
        (revision, spread),
    ).fetchall()
    roots = []
    by_id = {}
    for row in rows:
        item = {
            "id": row["id"], "body": row["body"] if row["deleted_at"] is None else "",
            "author": row["author_name"], "date": label_date(row["created_at"]),
            "mine": int(current_user.get_id()) == row["author_user_id"],
            "edited": row["edited_at"] is not None,
            "deleted": row["deleted_at"] is not None,
            "resolved": row["resolved_at"] is not None, "replies": [],
        }
        if row["parent_id"] is None:
            roots.append(item)
            by_id[row["id"]] = item
        elif row["parent_id"] in by_id:
            by_id[row["parent_id"]]["replies"].append(item)
    return roots


def summary_for_revision(db, revision):
    rows = db.execute(
        "SELECT spread, COUNT(*) AS threads, "
        "SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open_threads "
        "FROM family_comments "
        "WHERE revision=? AND parent_id IS NULL "
        "AND (deleted_at IS NULL OR EXISTS "
        "(SELECT 1 FROM family_comments r WHERE r.parent_id=family_comments.id)) "
        "GROUP BY spread",
        (revision,),
    ).fetchall()
    return {
        row["spread"]: {"threads": row["threads"], "open": row["open_threads"]}
        for row in rows
    }


@family.post("/revisions/<int:revision>/comments")
@login_required
def create_comment(revision):
    check_csrf()
    try:
        spread = int(request.form.get("spread", ""))
    except ValueError:
        abort(400, "Invalid spread")
    valid_spread(revision, spread)
    body = request.form.get("body", "").strip()
    if not body or len(body) > MAX_COMMENT_LENGTH:
        abort(400, "Comment must contain 1–2000 characters.")
    parent_text = request.form.get("parent_id", "").strip()
    try:
        parent_id = int(parent_text) if parent_text else None
    except ValueError:
        abort(400, "Invalid discussion")
    with db_connection() as db:
        require_editor(db)
        if parent_id is not None:
            parent = db.execute(
                "SELECT id FROM family_comments "
                "WHERE id=? AND revision=? AND spread=? AND parent_id IS NULL",
                (parent_id, revision, spread),
            ).fetchone()
            if not parent:
                abort(400, "Discussion not found on this spread.")
        db.execute(
            "INSERT INTO family_comments "
            "(revision,spread,parent_id,author_user_id,body,created_at) "
            "VALUES (?,?,?,?,?,strftime('%s','now'))",
            (revision, spread, parent_id, int(current_user.get_id()), body),
        )
    return spread_redirect(revision, spread)


@family.post("/revisions/<int:revision>/comments/<int:comment_id>/status")
@login_required
def comment_status(revision, comment_id):
    check_csrf()
    if revision not in REVISIONS:
        abort(404)
    action = request.form.get("action")
    if action not in ("resolve", "reopen"):
        abort(400)
    with db_connection() as db:
        require_editor(db)
        row = db.execute(
            "SELECT spread FROM family_comments "
            "WHERE id=? AND revision=? AND parent_id IS NULL",
            (comment_id, revision),
        ).fetchone()
        if not row:
            abort(404)
        if action == "resolve":
            db.execute(
                "UPDATE family_comments SET resolved_at=strftime('%s','now'), "
                "resolved_by=? WHERE id=?",
                (int(current_user.get_id()), comment_id),
            )
        else:
            db.execute(
                "UPDATE family_comments SET resolved_at=NULL, resolved_by=NULL WHERE id=?",
                (comment_id,),
            )
    return spread_redirect(revision, row["spread"])


@family.post("/revisions/<int:revision>/comments/<int:comment_id>/edit")
@login_required
def edit_comment(revision, comment_id):
    """Authors may edit their own existing root or reply; no history is exposed."""
    check_csrf()
    if revision not in REVISIONS:
        abort(404)
    body = request.form.get("body", "").strip()
    if not body or len(body) > MAX_COMMENT_LENGTH:
        abort(400, "Comment must contain 1–2000 characters.")
    with db_connection() as db:
        require_editor(db)
        row = db.execute(
            "SELECT spread, author_user_id, deleted_at FROM family_comments "
            "WHERE id=? AND revision=?",
            (comment_id, revision),
        ).fetchone()
        if not row:
            abort(404)
        if row["author_user_id"] != int(current_user.get_id()):
            abort(403)
        if row["deleted_at"] is not None:
            abort(404)
        db.execute(
            "UPDATE family_comments SET body=?, edited_at=strftime('%s','now') "
            "WHERE id=? AND revision=? AND author_user_id=? AND deleted_at IS NULL",
            (body, comment_id, revision, int(current_user.get_id())),
        )
    return spread_redirect(revision, row["spread"])


@family.post("/revisions/<int:revision>/comments/<int:comment_id>/delete")
@login_required
def delete_comment(revision, comment_id):
    """Author-only delete. Preserve reply context without revealing deleted text."""
    check_csrf()
    if revision not in REVISIONS:
        abort(404)
    with db_connection() as db:
        require_editor(db)
        row = db.execute(
            "SELECT spread, parent_id, author_user_id, deleted_at "
            "FROM family_comments WHERE id=? AND revision=?",
            (comment_id, revision),
        ).fetchone()
        if not row:
            abort(404)
        if row["author_user_id"] != int(current_user.get_id()):
            abort(403)
        if row["deleted_at"] is not None:
            abort(404)
        if row["parent_id"] is None and db.execute(
            "SELECT 1 FROM family_comments WHERE parent_id=? LIMIT 1",
            (comment_id,),
        ).fetchone():
            # Keeping the root keeps its replies reachable. Clear its text.
            db.execute(
                "UPDATE family_comments SET body='[deleted]', deleted_at=strftime('%s','now') "
                "WHERE id=? AND revision=? AND author_user_id=? AND deleted_at IS NULL",
                (comment_id, revision, int(current_user.get_id())),
            )
        else:
            db.execute(
                "DELETE FROM family_comments WHERE id=? AND revision=? AND author_user_id=?",
                (comment_id, revision, int(current_user.get_id())),
            )
    return spread_redirect(revision, row["spread"])
