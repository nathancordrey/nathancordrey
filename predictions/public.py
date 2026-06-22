"""Public DB-backed homepage for the predictions app.

Routes are registered under /predictions by wc_app.py.

First-pass goal:
  - Show a public dashboard from Postgres.
  - Keep /predictions/picks as the logged-in pick-entry page.
  - Leave the old JSON /worldcup page untouched for comparison.
"""

import datetime as dt
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, render_template
from flask_login import current_user

from predictions.models import Pool, Prediction, score_prediction


public = Blueprint("public", __name__, template_folder="templates")

APP_TZ = ZoneInfo("America/New_York")


def _as_utc(value):
    """Return a timezone-aware UTC datetime.

    PostgreSQL generally returns aware datetimes for timezone=True, but SQLite
    can return naive datetimes in local/dev testing. Treat naive kickoff_at as
    UTC because that is the storage convention in this app.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def _as_app_tz(value):
    return _as_utc(value).astimezone(APP_TZ)


def _pick_open_date():
    """Same 4 AM Eastern rollover used by the picks page."""
    now = dt.datetime.now(APP_TZ)
    if now.hour < 4:
        now = now - dt.timedelta(days=1)
    return now.date()


def _fmt_dt(value):
    local = _as_app_tz(value)
    return local.strftime("%a %b %d, %I:%M %p").replace(" 0", " ")


def _fmt_date(value):
    local = _as_app_tz(value)
    return local.strftime("%a %b %d").replace(" 0", " ")


def _fmt_time(value):
    local = _as_app_tz(value)
    return local.strftime("%I:%M %p").lstrip("0")


def _first_pool():
    return Pool.query.order_by(Pool.id.asc()).first()


def _leaderboard(pool):
    """Build basic standings for one pool."""
    members = list(pool.members)
    totals = {
        member.user_id: {
            "user": member.user,
            "name": member.user.name,
            "total": 0,
            "winners": 0,
            "exact": 0,
            "submitted": 0,
        }
        for member in members
    }

    for pred in pool.predictions:
        row = totals.get(pred.user_id)
        if row is None:
            continue

        row["submitted"] += 1
        points, winner_ok, exact = score_prediction(pred, pred.game, pool)
        row["total"] += points
        row["winners"] += int(winner_ok)
        row["exact"] += int(exact)

    rows = sorted(
        totals.values(),
        key=lambda r: (r["total"], r["exact"], r["winners"], r["name"].lower()),
        reverse=True,
    )

    for index, row in enumerate(rows, start=1):
        row["rank"] = index
        row["is_me"] = current_user.is_authenticated and row["user"].id == current_user.id

    return rows


def _prediction_counts(pool):
    """Return {game_id: number_of_pool_predictions}."""
    counts = {
        game_id: count
        for game_id, count in (
            Prediction.query
            .with_entities(Prediction.game_id, Prediction.id)
            .filter(Prediction.pool_id == pool.id)
            .all()
        )
    }

    # The query above is not an aggregate; keep the implementation explicit
    # and easy to reason about for this first pass.
    counts = {}
    for pred in pool.predictions:
        counts[pred.game_id] = counts.get(pred.game_id, 0) + 1
    return counts


def _game_card(game, pick_count, member_count):
    is_final = game.is_final
    local = _as_app_tz(game.kickoff_at)

    if is_final:
        status_label = "Final"
    elif game.locked:
        status_label = "Locked"
    else:
        status_label = "Open"

    return {
        "game": game,
        "kickoff": local,
        "date_label": _fmt_date(game.kickoff_at),
        "time_label": _fmt_time(game.kickoff_at),
        "kickoff_label": _fmt_dt(game.kickoff_at),
        "status_label": status_label,
        "is_final": is_final,
        "is_locked": game.locked,
        "pick_count": pick_count,
        "missing_count": max(member_count - pick_count, 0),
        "scoreline": (
            f"{game.home_score}–{game.away_score}"
            if is_final else None
        ),
    }


@public.route("")
@public.route("/")
def home():
    pool = _first_pool()
    if pool is None:
        abort(404)

    competition = pool.competition
    member_count = len(pool.members)
    counts = _prediction_counts(pool)
    open_date = _pick_open_date()

    games = sorted(competition.games, key=lambda g: g.kickoff_at)

    # Games that are not final and have reached their visible/pickable day.
    current_games = [
        _game_card(g, counts.get(g.id, 0), member_count)
        for g in games
        if not g.is_final and _as_app_tz(g.kickoff_at).date() <= open_date
    ]

    # Recent final games, newest first.
    recent_results = [
        _game_card(g, counts.get(g.id, 0), member_count)
        for g in sorted(games, key=lambda g: g.kickoff_at, reverse=True)
        if g.is_final
    ][:8]

    total_games = len(games)
    final_games = sum(1 for g in games if g.is_final)

    return render_template(
        "home.html",
        pool=pool,
        competition=competition,
        leaderboard=_leaderboard(pool),
        current_games=current_games,
        recent_results=recent_results,
        member_count=member_count,
        total_games=total_games,
        final_games=final_games,
    )
