"""Explicit, read-only sharing of immutable album snapshots.

Share tokens are never stored in plaintext or reused in media URLs.
Publishing copies only selected spreads, removes metadata and downsizes images.
"""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import (
    Blueprint, abort, make_response, redirect, render_template, request, session, url_for,
)
from flask_login import current_user, login_required
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash

from . import REVISIONS, check_csrf, csrf_token, db_connection, family, is_ready, root

album = Blueprint("album", __name__, url_prefix="/album", template_folder="templates")

SHARE_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,160}$")
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
PIN_WINDOW = 15 * 60
MAX_PIN_ATTEMPTS = 8
MAX_PUBLIC_PIXELS = (3200, 3200)
PUBLIC_ORIGIN = "https://nathancordrey.com"


@album.before_request
def configured():
    if not is_ready():
        return "Family album sharing is not configured.", 503
    if request.content_length and request.content_length > 16 * 1024:
        abort(413)


@album.after_request
def private_headers(response):
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, noimageindex"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    )
    return response


def publisher_only():
    if not current_user.is_authenticated:
        abort(403)
    with db_connection() as db:
        row = db.execute(
            "SELECT 1 FROM family_publishers WHERE user_id=?",
            (int(current_user.get_id()),),
        ).fetchone()
    if not row:
        abort(403)


def valid_id(item):
    return bool(ID_PATTERN.fullmatch(item))


def valid_share(db, share_id):
    if not valid_id(share_id):
        return None
    row = db.execute(
        "SELECT l.id, l.snapshot_id, l.pin_hash, l.expires_at, "
        "s.title, s.spread_count FROM family_share_links l "
        "JOIN family_snapshots s ON s.id=l.snapshot_id "
        "WHERE l.id=? AND l.revoked_at IS NULL AND s.active=1 "
        "AND (l.expires_at IS NULL OR l.expires_at > ?)",
        (share_id, time.time()),
    ).fetchone()
    return row


def grant_share(share_id):
    items = list(session.get("family_shared_links", []))
    items = [i for i in items if i != share_id and valid_id(str(i))]
    items.append(share_id)
    session["family_shared_links"] = items[-8:]


def authorized_share(share_id):
    # Every view and every asset is reauthorized, so revocation is immediate.
    if share_id not in session.get("family_shared_links", []):
        abort(404)
    with db_connection() as db:
        row = valid_share(db, share_id)
    if not row:
        abort(404)
    return row


def pin_limited(db, share_id, ip):
    cutoff = time.time() - PIN_WINDOW
    db.execute("DELETE FROM family_pin_attempts WHERE created_at < ?", (cutoff,))
    key = share_id + ":" + ip
    return db.execute(
        "SELECT COUNT(*) FROM family_pin_attempts WHERE lookup_key=?",
        (key,),
    ).fetchone()[0] >= MAX_PIN_ATTEMPTS


@album.route("/<token>", methods=["GET", "POST"])
def enter(token):
    if not SHARE_TOKEN_PATTERN.fullmatch(token):
        abort(404)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    with db_connection() as db:
        record = db.execute(
            "SELECT id FROM family_share_links WHERE token_hash=?", (token_hash,),
        ).fetchone()
        row = valid_share(db, record["id"]) if record else None
        if not row:
            abort(404)
        if not row["pin_hash"]:
            if request.method == "POST":
                abort(405)
            grant_share(row["id"])
            return redirect(url_for("album.view", share_id=row["id"]), code=303)
        csrf_token()
        if request.method == "POST":
            check_csrf()
            ip = (request.remote_addr or "unknown")[:120]
            if pin_limited(db, row["id"], ip):
                db.commit()
                return render_template(
                    "album_pin.html", title=row["title"], token=token,
                    csrf=csrf_token(), error="Too many attempts. Try later."
                ), 429
            pin = request.form.get("pin", "")
            if len(pin) <= 128 and check_password_hash(row["pin_hash"], pin):
                db.execute(
                    "DELETE FROM family_pin_attempts WHERE lookup_key=?",
                    (row["id"] + ":" + ip,),
                )
                db.commit()
                grant_share(row["id"])
                return redirect(url_for("album.view", share_id=row["id"]), code=303)
            db.execute(
                "INSERT INTO family_pin_attempts (lookup_key, created_at) VALUES (?,?)",
                (row["id"] + ":" + ip, time.time()),
            )
            db.commit()
            return render_template(
                "album_pin.html", title=row["title"], token=token,
                csrf=csrf_token(), error="Incorrect PIN."
            ), 401
    return render_template(
        "album_pin.html", title=row["title"], token=token,
        csrf=csrf_token(), error=None,
    )


@album.get("/view/<share_id>")
def view(share_id):
    row = authorized_share(share_id)
    try:
        spread = int(request.args.get("spread", "1"))
    except ValueError:
        spread = 1
    spread = min(max(1, spread), row["spread_count"])
    return render_template(
        "album_view.html", title=row["title"], share_id=share_id,
        spread=spread, spread_count=row["spread_count"],
    )


@album.get("/view/<share_id>/spreads/<int:spread>")
def spread_image(share_id, spread):
    row = authorized_share(share_id)
    if spread < 1 or spread > row["spread_count"]:
        abort(404)
    snapshot_id = row["snapshot_id"]
    if not valid_id(snapshot_id):
        abort(404)
    file_path = root() / "published" / snapshot_id / "spreads" / ("spread-%02d.jpg" % spread)
    if not file_path.is_file() or file_path.is_symlink():
        abort(404)
    response = make_response("", 200)
    response.headers["X-Accel-Redirect"] = (
        "/__family_published__/" + snapshot_id + "/spreads/spread-%02d.jpg" % spread
    )
    response.headers["Content-Type"] = "image/jpeg"
    response.headers["Content-Disposition"] = 'inline; filename="album-spread.jpg"'
    return response


def clean_spreads(revision, chosen, destination):
    """Produce new web JPEGs with no EXIF, ICC or GPS metadata."""
    base = root() / "revisions" / ("revision-%d" % revision) / "spreads"
    for index, old_spread in enumerate(chosen, start=1):
        source = (base / ("spread-%02d.jpg" % old_spread)).resolve()
        if not source.is_relative_to(base.resolve()) or not source.is_file():
            raise FileNotFoundError("Source spread %s is unavailable" % old_spread)
        with Image.open(source) as original:
            if original.format not in ("JPEG", "PNG", "WEBP"):
                raise ValueError("Unsupported source image format")
            original.load()
            image = ImageOps.exif_transpose(original).convert("RGB")
            image.thumbnail(MAX_PUBLIC_PIXELS, Image.Resampling.LANCZOS)
            target = destination / ("spread-%02d.jpg" % index)
            image.save(target, format="JPEG", quality=84, optimize=True)
            target.chmod(0o640)


@family.get("/sharing")
@login_required
def sharing():
    publisher_only()
    with db_connection() as db:
        snapshots = db.execute(
            "SELECT id, title, source_revision, spread_count, active, created_at "
            "FROM family_snapshots ORDER BY created_at DESC"
        ).fetchall()
        links = db.execute(
            "SELECT l.id, l.snapshot_id, l.created_at, l.expires_at, l.revoked_at, "
            "s.title FROM family_share_links l JOIN family_snapshots s ON l.snapshot_id=s.id "
            "ORDER BY l.created_at DESC"
        ).fetchall()
    return render_template(
        "family_sharing.html", snapshots=snapshots, links=links,
        revisions=REVISIONS, csrf=csrf_token(), now=time.time(),
    )


@family.post("/sharing/publish")
@login_required
def publish():
    publisher_only()
    check_csrf()
    if request.form.get("approved") != "yes":
        abort(400, "Explicit publication approval is required.")
    try:
        revision = int(request.form.get("revision", ""))
    except ValueError:
        abort(400)
    if revision not in REVISIONS:
        abort(400)
    title = request.form.get("title", "").strip()[:100]
    if not title or len(title) < 3:
        abort(400)
    selection = request.form.get("spread_selection", "selected")
    if selection == "all":
        chosen = list(range(1, REVISIONS[revision]["spreads"] + 1))
    elif selection == "selected":
        try:
            chosen = sorted({int(s) for s in request.form.get("spreads", "").replace(",", " ").split()})
        except ValueError:
            abort(400)
    else:
        abort(400, "Unknown spread selection.")
    if not chosen or len(chosen) > REVISIONS[revision]["spreads"] or any(
        i < 1 or i > REVISIONS[revision]["spreads"] for i in chosen
    ):
        abort(400, "Select valid spread numbers, such as 1 2 3 5.")
    published = root() / "published"
    published.mkdir(mode=0o750, exist_ok=True)
    snapshot_id = secrets.token_hex(16)
    staging = published / ("stage-" + snapshot_id)
    target = published / snapshot_id
    staging.mkdir(mode=0o700)
    (staging / "spreads").mkdir(mode=0o700)
    try:
        clean_spreads(revision, chosen, staging / "spreads")
        (staging / "spreads").chmod(0o750)
        staging.chmod(0o750)
        staging.rename(target)
        with db_connection() as db:
            db.execute(
                "INSERT INTO family_snapshots "
                "(id,title,source_revision,spread_count,created_at,publisher_user_id,active) "
                "VALUES (?,?,?,?,?,?,1)",
                (snapshot_id, title, revision, len(chosen), time.time(), int(current_user.get_id())),
            )
            db.commit()
    except (FileNotFoundError, UnidentifiedImageError, ValueError, OSError) as exc:
        shutil.rmtree(staging, ignore_errors=True)
        abort(400, str(exc))
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return redirect(url_for("family.sharing"), code=303)


@family.post("/sharing/links/<snapshot_id>")
@login_required
def create_link(snapshot_id):
    publisher_only()
    check_csrf()
    if not valid_id(snapshot_id):
        abort(404)
    with db_connection() as db:
        snapshot = db.execute(
            "SELECT title FROM family_snapshots WHERE id=? AND active=1",
            (snapshot_id,),
        ).fetchone()
        if not snapshot:
            abort(404)
        pin = request.form.get("pin", "").strip()
        if pin and not (6 <= len(pin) <= 128):
            abort(400, "PIN must have at least six characters.")
        days = request.form.get("duration", "30")
        if days not in {"0", "7", "30", "90"}:
            abort(400)
        expires_at = time.time() + int(days) * 86400 if days != "0" else None
        token = secrets.token_urlsafe(32)
        share_id = secrets.token_hex(16)
        db.execute(
            "INSERT INTO family_share_links "
            "(id,snapshot_id,token_hash,pin_hash,expires_at,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (share_id, snapshot_id, hashlib.sha256(token.encode("ascii")).hexdigest(),
             generate_password_hash(pin, method="scrypt") if pin else None,
             expires_at, time.time()),
        )
        db.commit()
    # This full token exists only in this one-time response, not in the DB.
    return render_template(
        "family_share_created.html",
        link=PUBLIC_ORIGIN + url_for("album.enter", token=token),
        pin_protected=bool(pin), title=snapshot["title"],
    )


@family.post("/sharing/revoke/<share_id>")
@login_required
def revoke(share_id):
    publisher_only()
    check_csrf()
    if not valid_id(share_id):
        abort(404)
    with db_connection() as db:
        db.execute(
            "UPDATE family_share_links SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
            (time.time(), share_id),
        )
        db.commit()
    return redirect(url_for("family.sharing"), code=303)


@family.post("/sharing/unpublish/<snapshot_id>")
@login_required
def unpublish(snapshot_id):
    publisher_only()
    check_csrf()
    if not valid_id(snapshot_id):
        abort(404)
    with db_connection() as db:
        db.execute("UPDATE family_snapshots SET active=0 WHERE id=?", (snapshot_id,))
        db.commit()
    return redirect(url_for("family.sharing"), code=303)


@family.get("/sharing/preview/<snapshot_id>")
@login_required
def preview_snapshot(snapshot_id):
    publisher_only()
    if not valid_id(snapshot_id):
        abort(404)
    with db_connection() as db:
        row = db.execute(
            "SELECT id,title,spread_count,active FROM family_snapshots WHERE id=?",
            (snapshot_id,),
        ).fetchone()
    if not row:
        abort(404)
    try:
        spread = int(request.args.get("spread", "1"))
    except ValueError:
        spread = 1
    spread = min(max(spread, 1), row["spread_count"])
    return render_template(
        "family_snapshot_preview.html", snapshot=row, spread=spread,
    )


@family.get("/sharing/preview/<snapshot_id>/spreads/<int:spread>")
@login_required
def preview_image(snapshot_id, spread):
    publisher_only()
    if not valid_id(snapshot_id):
        abort(404)
    with db_connection() as db:
        row = db.execute(
            "SELECT spread_count FROM family_snapshots WHERE id=?",
            (snapshot_id,),
        ).fetchone()
    if not row or spread < 1 or spread > row["spread_count"]:
        abort(404)
    path = root() / "published" / snapshot_id / "spreads" / ("spread-%02d.jpg" % spread)
    if not path.is_file() or path.is_symlink():
        abort(404)
    response = make_response("", 200)
    response.headers["X-Accel-Redirect"] = (
        "/__family_published__/" + snapshot_id + "/spreads/spread-%02d.jpg" % spread
    )
    response.headers["Content-Type"] = "image/jpeg"
    return response
