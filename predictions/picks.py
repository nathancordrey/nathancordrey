"""Per-user pick entry for the DB-backed predictions app.

This module is intended to live at:

    predictions/picks.py

Routes are registered under /predictions by wc_app.py.

Each logged-in member sees only their own predictions, can edit games that
are open and not locked, and is blocked server-side from saving late picks.

Users may also choose whether to show an individual pick before kickoff.
The pick is still editable until kickoff either way.
"""

import datetime as dt
import os
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from predictions.models import db, Pool, Prediction, score_prediction


picks = Blueprint("picks", __name__)

APP_TZ = ZoneInfo("America/New_York")
PICK_AHEAD_HOUR = int(os.environ.get("WC_PICK_AHEAD_HOUR", "15"))
MAX_REASONABLE_SCORE = 50


def _winner_from_score(home_score, away_score):
    if home_score > away_score:
        return "home"
    if away_score > home_score:
        return "away"
    return "draw"


def _as_utc(value):
    """Return a timezone-aware UTC datetime.

    PostgreSQL preserves timezone info, but SQLite may return naive datetimes
    during local testing. Treat naive values as UTC because kickoff_at is
    stored as UTC by convention.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def _as_app_tz(value):
    return _as_utc(value).astimezone(APP_TZ)


def _pick_open_date():
    """Return the latest local date open for picking.

    Games are visible/editable on their match day, and the next day's games
    become available starting at PICK_AHEAD_HOUR Eastern time the day before.
    Default: 3 PM ET.
    """
    now = dt.datetime.now(APP_TZ)
    open_date = now.date()

    if now.hour >= PICK_AHEAD_HOUR:
        open_date = open_date + dt.timedelta(days=1)

    return open_date

def _game_is_visible(game, open_date):
    """Whether this game should appear on the user's picks page."""
    return _as_app_tz(game.kickoff_at).date() <= open_date


def _game_is_open_for_picks(game, open_date):
    """Whether the user may save/edit a pick for this game."""
    return _game_is_visible(game, open_date) and not game.locked


def _user_pool():
    """Return the pool this user plays in.

    This is intentionally simple for the current single-pool app. When you
    add multiple pools, switch to URLs like /pools/<slug>/picks and load the
    pool by slug instead.
    """
    if current_user.memberships:
        return current_user.memberships[0].pool

    # Let a site admin see the first pool even if not explicitly a member.
    if current_user.is_site_admin:
        return Pool.query.order_by(Pool.id.asc()).first()

    return None


@picks.route("/picks")
@login_required
def my_picks():
    pool = _user_pool()
    if pool is None:
        abort(403)

    mine = {
        pred.game_id: pred
        for pred in current_user.predictions
        if pred.pool_id == pool.id
    }

    open_date = _pick_open_date()

    open_games = []
    locked_games = []

    games = sorted(pool.competition.games, key=lambda game: game.kickoff_at)

    for game in games:
        pick = mine.get(game.id)

        if _game_is_open_for_picks(game, open_date):
            open_games.append({"game": game, "pick": pick})
            continue

        if game.locked:
            row = {"game": game, "pick": pick}

            if game.is_final and pick:
                points, win_ok, exact = score_prediction(pick, game, pool)
                row.update(points=points, win_ok=win_ok, exact=exact)
            else:
                row.update(points=0, win_ok=False, exact=False)

            locked_games.append(row)

        # Else: future game is not visible yet.

    locked_games.reverse()  # Most recent locked games first.

    return render_template(
        "picks.html",
        pool=pool,
        me=current_user,
        open_games=open_games,
        locked_games=locked_games,
    )


@picks.post("/picks")
@login_required
def save_picks():
    pool = _user_pool()
    if pool is None:
        abort(403)

    open_date = _pick_open_date()

    games = {
        game.id: game
        for game in pool.competition.games
    }
    mine = {
        pred.game_id: pred
        for pred in current_user.predictions
        if pred.pool_id == pool.id
    }

    saved = 0
    skipped_locked = 0
    skipped_invalid = 0

    for key in request.form:
        if not key.startswith("h_"):
            continue

        try:
            game_id = int(key[2:])
        except ValueError:
            skipped_invalid += 1
            continue

        game = games.get(game_id)
        if game is None:
            skipped_invalid += 1
            continue

        # Hard server-side lock. Do not trust the form/UI.
        if not _game_is_open_for_picks(game, open_date):
            skipped_locked += 1
            continue

        raw_home = request.form.get(f"h_{game_id}", "").strip()
        raw_away = request.form.get(f"a_{game_id}", "").strip()

        # Both scores are required. Blank means leave any existing pick as-is.
        if raw_home == "" or raw_away == "":
            continue

        try:
            home_score = int(raw_home)
            away_score = int(raw_away)
        except ValueError:
            skipped_invalid += 1
            continue

        if (
            home_score < 0
            or away_score < 0
            or home_score > MAX_REASONABLE_SCORE
            or away_score > MAX_REASONABLE_SCORE
        ):
            skipped_invalid += 1
            continue

        prediction = mine.get(game_id)

        if prediction is None:
            prediction = Prediction(
                pool_id=pool.id,
                user_id=current_user.id,
                game_id=game_id,
            )
            db.session.add(prediction)
            mine[game_id] = prediction

        prediction.winner = _winner_from_score(home_score, away_score)
        prediction.home_score = home_score
        prediction.away_score = away_score
        prediction.show_before_kickoff = request.form.get(f"show_{game_id}") == "1"
        saved += 1

    db.session.commit()

    if saved:
        flash("Saved %d pick%s." % (saved, "" if saved == 1 else "s"))
    elif skipped_locked:
        flash("No picks saved. One or more games are already locked.")
    elif skipped_invalid:
        flash("No picks saved. Check that scores are valid numbers.")
    else:
        flash("No changes to save.")

    return redirect(url_for("picks.my_picks"))
