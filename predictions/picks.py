"""Per-user pick entry for the DB-backed predictions app.

Canonical pool-aware route:
  /predictions/pools/<pool_slug>/picks

Legacy route:
  /predictions/picks
redirects to the user's primary pool. Keeping this endpoint name as
picks.my_picks preserves existing auth redirects in auth.py.
"""

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from predictions import timing
from predictions.models import db, Prediction, score_prediction
from predictions.pool_helpers import (
    get_pool_or_404,
    primary_pool_for_user,
    require_pool_user,
)


picks = Blueprint("picks", __name__)

MAX_REASONABLE_SCORE = 50


def _winner_from_score(home_score, away_score):
    if home_score > away_score:
        return "home"
    if away_score > home_score:
        return "away"
    return "draw"


@picks.route("/picks")
@login_required
def my_picks():
    """Legacy no-slug picks route used by auth.py.

    Redirect to the canonical pool-aware picks page.
    """
    pool = primary_pool_for_user()
    if pool is None:
        abort(403)

    return redirect(url_for("picks.pool_picks", pool_slug=pool.slug))


@picks.route("/pools/<pool_slug>/picks")
@login_required
def pool_picks(pool_slug):
    pool = get_pool_or_404(pool_slug)
    require_pool_user(pool)

    mine = {
        pred.game_id: pred
        for pred in current_user.predictions
        if pred.pool_id == pool.id
    }

    open_games = []
    locked_games = []

    games = sorted(pool.competition.games, key=lambda game: game.kickoff_at)

    for game in games:
        pick = mine.get(game.id)

        if timing.is_pickable(game):
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
        current_pool=pool,
        me=current_user,
        open_games=open_games,
        locked_games=locked_games,
    )


@picks.post("/pools/<pool_slug>/picks")
@login_required
def save_picks(pool_slug):
    pool = get_pool_or_404(pool_slug)
    require_pool_user(pool)

    games = {game.id: game for game in pool.competition.games}
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
        if not timing.is_pickable(game):
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

    return redirect(url_for("picks.pool_picks", pool_slug=pool.slug))
