"""Standalone DB-backed predictions app.

Runs alongside the live JSON site without touching it.

Public URL plan:
  /worldcup      -> existing JSON site
  /predictions   -> new DB/user app dashboard
  /predictions/picks -> logged-in pick entry
"""

import os
from pathlib import Path

from flask import Flask, flash, redirect, request, url_for
from flask_wtf.csrf import CSRFError, CSRFProtect
from werkzeug.middleware.proxy_fix import ProxyFix

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

from predictions.admin import admin
from predictions.auth import auth, login_manager
from predictions.models import db
from predictions.picks import picks
from predictions.public import public


HERE = Path(__file__).resolve().parent
csrf = CSRFProtect()


def _load_env():
    """Load .env from the repo root if python-dotenv is installed."""
    if load_dotenv is not None:
        load_dotenv(HERE / ".env")


def _database_url():
    """Return SQLAlchemy database URL.

    Defaults to local SQLite for quick dev testing.
    On Linode, set DATABASE_URL to Postgres.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        return "sqlite:///" + str(HERE / "wc_dev.db")

    if url.startswith("postgres://"):
        url = "postgresql+psycopg2://" + url[len("postgres://"):]
    elif url.startswith("postgresql://") and "+psycopg2" not in url:
        url = "postgresql+psycopg2://" + url[len("postgresql://"):]

    return url


def _bool_env(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def create_app():
    _load_env()

    app = Flask(
        __name__,
        template_folder=str(HERE / "predictions" / "templates"),
        static_folder=str(HERE / "predictions" / "static"),
        static_url_path="/predictions/static",
    )

    app_env = os.environ.get("APP_ENV", os.environ.get("FLASK_ENV", "development"))
    is_production = app_env.lower() == "production"

    app.config.update(
        SECRET_KEY=os.environ.get("WORLDCUP_SECRET_KEY", "dev-only-change-me"),
        SQLALCHEMY_DATABASE_URI=_database_url(),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=_bool_env("SESSION_COOKIE_SECURE", is_production),
        WTF_CSRF_TIME_LIMIT=int(
            os.environ.get("WTF_CSRF_TIME_LIMIT", str(12 * 60 * 60))
        ),
        MAX_CONTENT_LENGTH=256 * 1024,
    )

    if is_production and app.config["SECRET_KEY"] == "dev-only-change-me":
        raise RuntimeError("Set WORLDCUP_SECRET_KEY before running in production.")

    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

    db.init_app(app)
    login_manager.init_app(app)
    csrf.init_app(app)

    # Make stored (UTC) kickoff times render in the app's timezone (Eastern).
    from predictions import timing
    app.jinja_env.filters["app_tz"] = timing.as_app_tz

    app.register_blueprint(public, url_prefix="/predictions")
    app.register_blueprint(auth, url_prefix="/predictions")
    app.register_blueprint(picks, url_prefix="/predictions")
    app.register_blueprint(admin, url_prefix="/predictions")

    @app.errorhandler(CSRFError)
    def handle_csrf_error(error):
        flash("That form expired or was invalid. Please try again.")
        if request.referrer and request.referrer.startswith(request.host_url):
            return redirect(request.referrer)
        return redirect(url_for("public.home"))

    @app.route("/")
    def root():
        return redirect(url_for("public.home"))

    @app.route("/predictions/healthz")
    def healthz():
        return {"ok": True}

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
