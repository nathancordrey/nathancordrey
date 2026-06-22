"""Authentication routes for the DB-backed predictions app.

This module is intended to live at:

    predictions/auth.py

Routes are registered under /predictions by wc_app.py.

Current flow:
  - Users log in with name + password.
  - Seeded/admin-created users can be forced to change their password.
  - Site admins can create users and reset temporary passwords.
  - Pool membership helpers are provided for routes that need authorization.

CSRF:
  - CSRF protection is initialized app-wide in wc_app.py.
  - Templates must include csrf_token() in POST forms.
"""

import secrets
from functools import wraps

from flask import (
    Blueprint,
    abort,
    flash,
    redirect,
    render_template,
    request,
    url_for,
)
from flask_login import (
    LoginManager,
    current_user,
    login_required,
    login_user,
    logout_user,
)

from predictions.models import db, PoolMember, User


login_manager = LoginManager()
login_manager.login_view = "auth.login"
login_manager.login_message = "Please log in to view that."


@login_manager.user_loader
def load_user(user_id):
    try:
        return db.session.get(User, int(user_id))
    except (TypeError, ValueError):
        return None


auth = Blueprint("auth", __name__)


# ───────────────────────── Authorization helpers ─────────────────────────

def site_admin_required(view):
    """Require global site-admin privileges."""
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not current_user.is_site_admin:
            abort(403)
        return view(*args, **kwargs)

    return wrapped


def member_of(pool):
    """Return the caller's PoolMember row for this pool, or None."""
    if not current_user.is_authenticated:
        return None

    return PoolMember.query.filter_by(
        pool_id=pool.id,
        user_id=current_user.id,
    ).first()


def require_member(pool, admin=False):
    """Require pool membership, optionally requiring pool admin/owner.

    Site admins are allowed through for both normal and admin checks.
    """
    membership = member_of(pool)

    if membership is None and not current_user.is_site_admin:
        abort(403)

    if admin and not (
        current_user.is_site_admin
        or (membership and membership.role in ("owner", "admin"))
    ):
        abort(403)

    return membership


# ───────────────────────── Forced password change ─────────────────────────

@auth.before_app_request
def enforce_password_change():
    """Force users with temporary passwords to set their own password."""
    if not current_user.is_authenticated:
        return None

    if not current_user.must_change_password:
        return None

    allowed_endpoints = {
        "auth.change_password",
        "auth.logout",
        "static",
    }

    if request.endpoint in allowed_endpoints:
        return None

    # Avoid interfering with static assets from the predictions app.
    if request.path.startswith("/predictions/static/"):
        return None

    return redirect(url_for("auth.change_password"))


# ───────────────────────── Auth routes ─────────────────────────

@auth.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("picks.my_picks"))

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        password = request.form.get("password", "")

        # Case-insensitive name match so "nate" and "Nate" both work.
        user = User.query.filter(db.func.lower(User.name) == name.lower()).first()

        # Same message for unknown name and wrong password to avoid account
        # enumeration.
        if user is None or not user.check_password(password):
            flash("Incorrect name or password.")
            return render_template("auth/login.html"), 401

        login_user(user, remember=True)

        # Open-redirect guard: only allow same-site relative redirects.
        next_url = request.args.get("next", "")
        if next_url.startswith("/") and not next_url.startswith("//"):
            return redirect(next_url)

        return redirect(url_for("picks.my_picks"))

    return render_template("auth/login.html")


@auth.post("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("auth.login"))


@auth.route("/change-password", methods=["GET", "POST"])
@login_required
def change_password():
    if request.method == "POST":
        new_password = request.form.get("new_password", "")
        confirm = request.form.get("confirm", "")

        if len(new_password) < 8:
            flash("Password must be at least 8 characters.")
        elif new_password != confirm:
            flash("Passwords don't match.")
        else:
            current_user.set_password(new_password)
            current_user.must_change_password = False
            db.session.commit()

            flash("Password updated.")
            return redirect(url_for("picks.my_picks"))

    return render_template("auth/change_password.html")


# ───────────────────────── Site-admin user management ─────────────────────────

@auth.route("/admin/users/new", methods=["GET", "POST"])
@site_admin_required
def admin_create_user():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower() or None

        if not name:
            flash("Name required.")
            return render_template("auth/admin_create_user.html")

        existing_name = User.query.filter(
            db.func.lower(User.name) == name.lower()
        ).first()
        if existing_name:
            flash("That name already has an account.")
            return render_template("auth/admin_create_user.html")

        if email:
            existing_email = User.query.filter(
                db.func.lower(User.email) == email.lower()
            ).first()
            if existing_email:
                flash("That email already has an account.")
                return render_template("auth/admin_create_user.html")

        # Show this password once. It is stored only as a hash.
        temp_password = secrets.token_urlsafe(9)

        user = User(
            name=name,
            email=email,
            must_change_password=True,
        )
        user.set_password(temp_password)

        db.session.add(user)
        db.session.commit()

        return render_template(
            "auth/admin_user_created.html",
            created=user,
            temp_password=temp_password,
        )

    return render_template("auth/admin_create_user.html")


@auth.post("/admin/users/<int:user_id>/reset-password")
@site_admin_required
def admin_reset_password(user_id):
    user = db.session.get(User, user_id)
    if user is None:
        abort(404)

    temp_password = secrets.token_urlsafe(9)
    user.set_password(temp_password)
    user.must_change_password = True
    db.session.commit()

    return render_template(
        "auth/admin_user_created.html",
        created=user,
        temp_password=temp_password,
    )
