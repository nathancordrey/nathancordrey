"""Private family album viewer. No photo/PDF content belongs in Git."""
from __future__ import annotations

import os
import secrets
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager

from flask import (
    Blueprint, abort, current_app, make_response, redirect,
    render_template, request, session, url_for,
)
from flask_login import (
    LoginManager, UserMixin, current_user, login_required, login_user, logout_user,
)
from werkzeug.security import check_password_hash

family = Blueprint("family", __name__, url_prefix="/family", template_folder="templates")
login_manager = LoginManager()
login_manager.login_view = "family.login"
login_manager.login_message = None

# Deliberately static catalog for the initial read-only release.
# Private artifacts live on Linode, not in this public repository.
REVISIONS = {
    1: {"title": "Revision 1 · Original", "description": "Initial January–October album", "spreads": 18},
    2: {"title": "Revision 2 · Updated", "description": "Rachel's selections and expanded Hawaii/August", "spreads": 20},
}

LOGIN_WINDOW_SECONDS = 15 * 60
MAX_ATTEMPTS = 8


class FamilyUser(UserMixin):
    def __init__(self, user_id: int, username: str, display_name: str):
        self.id = str(user_id)
        self.username = username
        self.display_name = display_name


def root() -> Path | None:
    """Return the private storage root; never create it during a web request."""
    value = os.environ.get("FAMILY_DATA_DIR", "")
    if not value or not Path(value).is_absolute():
        return None
    folder = Path(value).resolve()
    return folder if folder.is_dir() else None


def db_path() -> Path | None:
    folder = root()
    return folder / "family.sqlite3" if folder else None


@contextmanager
def db_connection():
    path = db_path()
    if not path or not path.is_file():
        raise RuntimeError("Family database is not initialized")
    # rw mode prevents SQLite silently creating a new empty database.
    connection = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def is_ready() -> bool:
    key = current_app.secret_key
    folder = root()
    return bool(
        folder and db_path().is_file()
        and isinstance(key, (str, bytes))
        and len(key) >= 32
        and key != "dev-only-change-me"
    )


def init_app(app):
    """Install Flask-Login into the existing site without changing other routes."""
    login_manager.init_app(app)


@login_manager.user_loader
def load_user(user_id):
    if not str(user_id).isdigit() or not db_path() or not db_path().is_file():
        return None
    try:
        with db_connection() as conn:
            row = conn.execute(
                "SELECT id, username, display_name FROM family_users WHERE id=? AND active=1",
                (int(user_id),),
            ).fetchone()
    except (sqlite3.Error, RuntimeError):
        return None
    return FamilyUser(row["id"], row["username"], row["display_name"]) if row else None


@family.before_request
def guard():
    # Fail closed until storage, the database, and the production secret exist.
    if not is_ready():
        return "Private family album is not configured.", 503
    # This read-only release accepts only small login/logout form requests.
    if request.content_length and request.content_length > 16 * 1024:
        abort(413)


@family.after_request
def private_headers(response):
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; "
        "form-action 'self'"
    )
    return response


def csrf_token() -> str:
    if "family_csrf" not in session:
        session["family_csrf"] = secrets.token_urlsafe(32)
    return session["family_csrf"]


def check_csrf():
    received = request.form.get("csrf", "")
    expected = session.get("family_csrf", "")
    if not expected or not secrets.compare_digest(received, expected):
        abort(403)


def login_limited(conn, username: str, ip: str) -> bool:
    threshold = time.time() - LOGIN_WINDOW_SECONDS
    conn.execute("DELETE FROM family_login_attempts WHERE created_at < ?", (threshold,))
    for key in ("user:" + username, "ip:" + ip):
        count = conn.execute(
            "SELECT COUNT(*) FROM family_login_attempts WHERE lookup_key=?",
            (key,),
        ).fetchone()[0]
        if count >= MAX_ATTEMPTS:
            return True
    return False


def record_failure(conn, username: str, ip: str):
    now = time.time()
    conn.executemany(
        "INSERT INTO family_login_attempts (lookup_key, created_at) VALUES (?,?)",
        [("user:" + username, now), ("ip:" + ip, now)],
    )


@family.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("family.index"))
    error = None
    status = 200
    csrf_token()
    if request.method == "POST":
        check_csrf()
        username = request.form.get("username", "").strip().lower()[:80]
        password = request.form.get("password", "")
        ip = (request.remote_addr or "unknown")[:120]
        with db_connection() as conn:
            if login_limited(conn, username, ip):
                error, status = "Too many attempts. Please try again later.", 429
            else:
                row = conn.execute(
                    "SELECT id, username, display_name, password_hash "
                    "FROM family_users WHERE username=? AND active=1",
                    (username,),
                ).fetchone()
                if row and check_password_hash(row["password_hash"], password):
                    conn.execute(
                        "DELETE FROM family_login_attempts WHERE lookup_key IN (?,?)",
                        ("user:" + username, "ip:" + ip),
                    )
                    conn.commit()
                    session["family_csrf"] = secrets.token_urlsafe(32)
                    login_user(FamilyUser(row["id"], row["username"], row["display_name"]))
                    return redirect(url_for("family.index"))
                record_failure(conn, username, ip)
                conn.commit()
                error, status = "Incorrect username or password.", 401
    return render_template("family_login.html", error=error, csrf=csrf_token()), status


@family.post("/logout")
@login_required
def logout():
    check_csrf()
    logout_user()
    session.pop("family_csrf", None)
    return redirect(url_for("family.login"))


@family.get("/")
@login_required
def index():
    with db_connection() as conn:
        can_publish = conn.execute(
            "SELECT 1 FROM family_publishers WHERE user_id=?",
            (int(current_user.get_id()),),
        ).fetchone() is not None
    return render_template(
        "family_index.html", revisions=REVISIONS,
        csrf=csrf_token(), can_publish=can_publish,
    )


def protected_file(revision: int, filename: str, content_type: str, download: bool = False):
    if revision not in REVISIONS:
        abort(404)
    folder = root() / "revisions"
    item = (folder / ("revision-" + str(revision)) / filename).resolve()
    # Do not follow private file symlinks outside our designated revisions folder.
    if not item.is_relative_to(folder.resolve()) or not item.is_file():
        abort(404)
    internal_path = "/__family_private__/revision-" + str(revision) + "/" + filename
    response = make_response("", 200)
    response.headers["X-Accel-Redirect"] = internal_path
    response.headers["Content-Type"] = content_type
    disposition = "attachment" if download else "inline"
    response.headers["Content-Disposition"] = (
        disposition + '; filename="' + ("family-revision-%s.pdf" % revision if filename.endswith(".pdf") else filename) + '"'
    )
    return response


@family.get("/revisions/<int:revision>")
@login_required
def revision_view(revision):
    details = REVISIONS.get(revision)
    if not details:
        abort(404)
    try:
        number = int(request.args.get("spread", "1"))
    except ValueError:
        number = 1
    number = min(max(number, 1), details["spreads"])
    spread_name = "spreads/spread-%02d.jpg" % number
    root_path = root() / "revisions" / ("revision-" + str(revision))
    from .gallery import gallery_items
    image_items = gallery_items(
        root_path / "spreads", details["spreads"],
        lambda n: url_for("family.revision_spread", revision=revision, spread=n),
    )
    from .comments import editor_allowed, fetch_discussions, summary_for_revision
    with db_connection() as db:
        can_comment = editor_allowed(db)
        discussions = fetch_discussions(db, revision, number) if can_comment else []
        comment_summary = summary_for_revision(db, revision) if can_comment else {}
    return render_template(
        "family_revision.html",
        details=details,
        revision=revision,
        spread=number,
        spread_count=details["spreads"],
        has_spread=(root_path / spread_name).is_file(),
        has_pdf=(root_path / "review.pdf").is_file(),
        image_items=image_items,
        thumbnail_spreads=[
            item["number"] for item in image_items
        ],
        discussions=discussions, comment_summary=comment_summary,
        can_comment=can_comment,
        csrf=csrf_token(),
    )


@family.get("/revisions/<int:revision>/thumbs/<int:spread>")
@login_required
def revision_thumbnail(revision, spread):
    details = REVISIONS.get(revision)
    if not details or spread < 1 or spread > details["spreads"]:
        abort(404)
    from .gallery import ensure_private_thumbnail
    location = root() / "revisions" / ("revision-" + str(revision))
    if not ensure_private_thumbnail(location, spread):
        abort(404)
    response = make_response("", 200)
    response.headers["X-Accel-Redirect"] = (
        "/__family_private__/revision-%d/thumbs/thumb-%02d.jpg" % (revision, spread)
    )
    response.headers["Content-Type"] = "image/jpeg"
    return response


@family.get("/revisions/<int:revision>/pdf")
@login_required
def revision_pdf(revision):
    return protected_file(revision, "review.pdf", "application/pdf", download=True)


@family.get("/revisions/<int:revision>/spreads/<int:spread>")
@login_required
def revision_spread(revision, spread):
    details = REVISIONS.get(revision)
    if not details or spread < 1 or spread > details["spreads"]:
        abort(404)
    return protected_file(
        revision, "spreads/spread-%02d.jpg" % spread, "image/jpeg",
    )


# Register publishing routes on the family blueprint before the app attaches it.
from . import sharing  # noqa: E402,F401
from . import comments  # noqa: E402,F401
