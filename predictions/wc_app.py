"""Standalone parallel app for the DB-backed version. Runs alongside the live
JSON site without touching it. Wires the database, login, and picks blueprints.

  Dev:     python wc_app.py                       (sqlite, debug)
  Server:  DATABASE_URL=postgresql+psycopg2://...  gunicorn 'wc_app:app'
"""
import os
from flask import Flask, redirect, url_for

from models import db
from auth import auth, login_manager
from picks import picks

HERE = os.path.dirname(os.path.abspath(__file__))


def create_app():
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("WORLDCUP_SECRET_KEY", "dev-only-change-me"),
        SQLALCHEMY_DATABASE_URI=os.environ.get(
            "DATABASE_URL", "sqlite:///" + os.path.join(HERE, "wc_dev.db")),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )
    db.init_app(app)
    login_manager.init_app(app)
    app.register_blueprint(auth)
    app.register_blueprint(picks)

    @app.route("/")
    def home():
        return redirect(url_for("picks.my_picks"))

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5001)
