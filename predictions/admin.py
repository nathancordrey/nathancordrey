"""Admin tools for the DB-backed predictions app.

Routes are registered under /predictions by wc_app.py.

First-pass admin result entry:
  - site admin only
  - mark a game live
  - enter a final score
  - clear a result back to scheduled
"""

import datetime as dt
from functools import wraps
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from predictions.models import db, Game


admin = Blueprint("admin", __name__, template_folder="templates")

APP_TZ = ZoneInfo("America/New_York")
MAX_REASONABLE_SCORE = 50


def site_admin_required(func):
    @wraps(func)
    @login_required
    def wrapper(*args, **kwargs):
        if not current_user.is_site_admin:
            abort(403)
        return func(*args, **kwargs)
    return wrapper


def _as_utc(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def _as_app_tz(value):
    return _as_utc(value).astimezone(APP_TZ)


def _fmt_date(value):
    return _as_app_tz(value).strftime("%a %b %d").replace(" 0", " ")


def _fmt_time(value):
    return _as_app_tz(value).strftime("%I:%M %p").lstrip("0")


def _score_from_form(name):
    raw = (request.form.get(name) or "").strip()
    if raw == "":
        raise ValueError("Score is required.")
    value = int(raw)
    if value < 0 or value > MAX_REASONABLE_SCORE:
        raise ValueError("Score is out of range.")
    return value


def _status_label(game):
    if game.is_final:
        return "Final"
    if game.status == "live":
        return "Live"
    if game.locked:
        return "Locked / awaiting result"
    return "Scheduled"


def _status_class(game):
    if game.is_final:
        return "final"
    if game.status == "live" or game.locked:
        return "live"
    return "scheduled"


def _game_row(game):
    return {
        "game": game,
        "date_label": _fmt_date(game.kickoff_at),
        "time_label": _fmt_time(game.kickoff_at),
        "status_label": _status_label(game),
        "status_class": _status_class(game),
        "prediction_count": len(game.predictions),
    }


def _filtered_games(filter_value):
    games = Game.query.order_by(Game.kickoff_at.asc()).all()

    if filter_value == "needs":
        return [g for g in games if g.locked and not g.is_final]

    if filter_value == "final":
        return [g for g in games if g.is_final]

    if filter_value == "future":
        return [g for g in games if not g.locked and not g.is_final]

    if filter_value == "live":
        return [g for g in games if g.status == "live" and not g.is_final]

    return games


@admin.route("/admin/results", methods=["GET", "POST"])
@site_admin_required
def results():
    filter_value = request.values.get("filter") or "needs"
    if filter_value not in {"needs", "all", "final", "future", "live"}:
        filter_value = "needs"

    if request.method == "POST":
        try:
            game_id = int(request.form.get("game_id", ""))
        except ValueError:
            abort(400)

        game = Game.query.get_or_404(game_id)
        action = request.form.get("action")

        try:
            if action == "final":
                home_score = _score_from_form("home_score")
                away_score = _score_from_form("away_score")
                game.home_score = home_score
                game.away_score = away_score
                game.status = "final"
                flash(f"Saved final: {game.home} {home_score}–{away_score} {game.away}")

            elif action == "live":
                # Scores are intentionally cleared because the current model
                # treats non-null scores as final.
                game.home_score = None
                game.away_score = None
                game.status = "live"
                flash(f"Marked live: {game.home} v {game.away}")

            elif action == "scheduled":
                game.home_score = None
                game.away_score = None
                game.status = "scheduled"
                flash(f"Marked scheduled: {game.home} v {game.away}")

            elif action == "clear":
                game.home_score = None
                game.away_score = None
                game.status = "scheduled"
                flash(f"Cleared result: {game.home} v {game.away}")

            else:
                abort(400)

        except ValueError as exc:
            flash(str(exc))
            return redirect(url_for("admin.results", filter=filter_value))

        db.session.commit()
        return redirect(url_for("admin.results", filter=filter_value))

    all_games = Game.query.all()
    stats = {
        "total": len(all_games),
        "final": sum(1 for g in all_games if g.is_final),
        "needs": sum(1 for g in all_games if g.locked and not g.is_final),
        "future": sum(1 for g in all_games if not g.locked and not g.is_final),
        "live": sum(1 for g in all_games if g.status == "live" and not g.is_final),
    }

    games = _filtered_games(filter_value)

    # For final results, show newest first. For everything else, show next/oldest first.
    if filter_value == "final":
        games = sorted(games, key=lambda g: g.kickoff_at, reverse=True)

    rows = [_game_row(game) for game in games]

    return render_template(
        "admin/results.html",
        rows=rows,
        stats=stats,
        filter_value=filter_value,
    )
