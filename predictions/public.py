"""Public DB-backed homepage for the predictions app.

Routes are registered under /predictions by wc_app.py.

This pass adds:
  - recent final results with each player's score prediction
  - revealed picks after kickoff
  - hidden picks before kickoff
"""

import datetime as dt
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, render_template
from flask_login import current_user

from predictions.models import Pool, Prediction, score_prediction


public = Blueprint("public", __name__, template_folder="templates")

APP_TZ = ZoneInfo("America/New_York")


def _as_utc(value):
    """Return a timezone-aware UTC datetime."""
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
    totals = {
        member.user_id: {
            "user": member.user,
            "name": member.user.name,
            "total": 0,
            "winners": 0,
            "exact": 0,
            "submitted": 0,
        }
        for member in pool.members
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
        key=lambda r: (-r["total"], -r["exact"], -r["winners"], r["name"].lower()),
    )

    for index, row in enumerate(rows, start=1):
        row["rank"] = index
        row["is_me"] = current_user.is_authenticated and row["user"].id == current_user.id

    return rows


def _prediction_index(pool):
    """Return predictions indexed by game_id and user_id."""
    by_game = {}
    for pred in pool.predictions:
        by_game.setdefault(pred.game_id, {})[pred.user_id] = pred
    return by_game


def _winner_label(winner, game):
    if winner == "home":
        return game.home
    if winner == "away":
        return game.away
    if winner == "draw":
        return "Draw"
    return "—"


def _pick_rows(pool, game, pred_by_user):
    """Rows of pool members' predictions for one revealed game."""
    rows = []

    for member in sorted(pool.members, key=lambda m: m.user.name.lower()):
        pred = pred_by_user.get(member.user_id)

        if pred is None:
            rows.append({
                "name": member.user.name,
                "has_pick": False,
                "pick_label": "No pick",
                "winner_label": "—",
                "points": None,
                "winner_ok": False,
                "exact": False,
            })
            continue

        points, winner_ok, exact = score_prediction(pred, game, pool)

        rows.append({
            "name": member.user.name,
            "has_pick": True,
            "pick_label": f"{pred.home_score}–{pred.away_score}",
            "winner_label": _winner_label(pred.winner, game),
            "points": points if game.is_final else None,
            "winner_ok": winner_ok,
            "exact": exact,
            "is_me": current_user.is_authenticated and member.user.id == current_user.id,
        })

    if game.is_final:
        rows.sort(
            key=lambda r: (
                -(r["points"] or 0),
                not r["exact"],
                not r["winner_ok"],
                r["name"].lower(),
            )
        )

    return rows


def _game_status_label(game):
    if game.is_final:
        return "Final"
    if game.locked:
        return "Picks revealed"
    return "Open"


def _game_status_class(game):
    if game.is_final:
        return "final"
    if game.locked:
        return "locked"
    return "open"


def _game_card(pool, game, pred_by_user, member_count):
    pick_count = len(pred_by_user)
    reveal_picks = game.locked or game.is_final

    return {
        "game": game,
        "kickoff": _as_app_tz(game.kickoff_at),
        "date_label": _fmt_date(game.kickoff_at),
        "time_label": _fmt_time(game.kickoff_at),
        "kickoff_label": _fmt_dt(game.kickoff_at),
        "status_label": _game_status_label(game),
        "status_class": _game_status_class(game),
        "is_final": game.is_final,
        "is_locked": game.locked,
        "reveal_picks": reveal_picks,
        "pick_count": pick_count,
        "missing_count": max(member_count - pick_count, 0),
        "scoreline": f"{game.home_score}–{game.away_score}" if game.is_final else None,
        "pick_rows": _pick_rows(pool=pool, game=game, pred_by_user=pred_by_user)
        if reveal_picks else [],
    }


@public.route("")
@public.route("/")
def home():
    pool = _first_pool()
    if pool is None:
        abort(404)

    competition = pool.competition
    member_count = len(pool.members)
    pred_index = _prediction_index(pool)
    open_date = _pick_open_date()

    # Small helper so _game_card can build rows without threading pool through
    # the Jinja-facing dict repeatedly.
    _game_card.pool = pool

    games = sorted(competition.games, key=lambda g: g.kickoff_at)

    visible_games = [
        game for game in games
        if _as_app_tz(game.kickoff_at).date() <= open_date
    ]

    # Non-final games that are visible today. Before kickoff, picks are hidden.
    # After kickoff, picks are revealed.
    current_games = [
        _game_card(g, pred_index.get(g.id, {}), member_count)
        for g in visible_games
        if not g.is_final
    ]

    # Recent final games, newest first, with all score predictions shown.
    recent_results = [
        _game_card(g, pred_index.get(g.id, {}), member_count)
        for g in sorted(games, key=lambda g: g.kickoff_at, reverse=True)
        if g.is_final
    ][:8]

    total_games = len(games)
    final_games = sum(1 for g in games if g.is_final)
    locked_not_final = sum(1 for g in games if g.locked and not g.is_final)

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
        locked_not_final=locked_not_final,
    )
