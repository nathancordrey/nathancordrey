"""Admin tools for the DB-backed predictions app.

Canonical pool-aware admin routes:
  /predictions/pools/<pool_slug>/admin/results
  /predictions/pools/<pool_slug>/admin/games/<game_id>/picks

Legacy admin routes redirect to the default pool.
"""

import re
import secrets

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from predictions import timing
from predictions.models import db, Competition, Game, Pool, PoolMember, Prediction
from predictions.pool_helpers import (
    default_pool,
    get_pool_or_404,
    require_pool_admin,
)


admin = Blueprint("admin", __name__, template_folder="templates")

MAX_REASONABLE_SCORE = 50
_as_app_tz = timing.as_app_tz


def _site_admin_required():
    if not current_user.is_site_admin:
        abort(403)


def _slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
    slug = slug.strip("-")
    return slug or "pool"


def _slug_available(slug):
    return Pool.query.filter_by(slug=slug).first() is None


def _unique_invite_code():
    while True:
        code = secrets.token_urlsafe(12)
        if Pool.query.filter_by(invite_code=code).first() is None:
            return code


def _int_setting(name, default, minimum=0, maximum=50):
    raw = (request.form.get(name) or "").strip()
    if raw == "":
        return default

    value = int(raw)
    if value < minimum or value > maximum:
        raise ValueError("Scoring values are out of range.")

    return value


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


def _optional_score_pair(home_name, away_name):
    raw_home = (request.form.get(home_name) or "").strip()
    raw_away = (request.form.get(away_name) or "").strip()

    if raw_home == "" and raw_away == "":
        return None

    if raw_home == "" or raw_away == "":
        raise ValueError("Enter both scores or leave both blank.")

    home_score = int(raw_home)
    away_score = int(raw_away)

    if (
        home_score < 0
        or away_score < 0
        or home_score > MAX_REASONABLE_SCORE
        or away_score > MAX_REASONABLE_SCORE
    ):
        raise ValueError("Score is out of range.")

    return home_score, away_score


def _winner_from_score(home_score, away_score):
    if home_score > away_score:
        return "home"
    if away_score > home_score:
        return "away"
    return "draw"


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


def _filtered_games(pool, filter_value):
    games = list(pool.competition.games)

    if filter_value == "needs":
        return [g for g in games if g.locked and not g.is_final]

    if filter_value == "final":
        return [g for g in games if g.is_final]

    if filter_value == "future":
        return [g for g in games if not g.locked and not g.is_final]

    if filter_value == "live":
        return [g for g in games if g.status == "live" and not g.is_final]

    return sorted(games, key=lambda g: g.kickoff_at)




@admin.route("/admin/pools/new", methods=["GET", "POST"])
@login_required
def create_pool():
    """Site-admin-only first pass for creating another pool.

    This intentionally starts as a private/admin tool. Public self-serve pool
    creation can reuse most of this once signup/invites are ready.
    """
    _site_admin_required()

    competitions = Competition.query.order_by(Competition.name.asc()).all()
    if not competitions:
        flash("Create or seed a competition before creating a pool.")
        return redirect(url_for("public.my_pools"))

    defaults = {
        "name": "",
        "slug": "",
        "competition_id": competitions[0].id,
        "score_correct_winner": 1,
        "score_exact_bonus": 2,
        "is_public": False,
    }

    if request.method == "POST":
        form = {
            "name": (request.form.get("name") or "").strip(),
            "slug": _slugify(request.form.get("slug") or request.form.get("name")),
            "competition_id": request.form.get("competition_id", type=int),
            "score_correct_winner": request.form.get("score_correct_winner", "").strip() or "1",
            "score_exact_bonus": request.form.get("score_exact_bonus", "").strip() or "2",
            "is_public": request.form.get("is_public") == "1",
        }

        try:
            if not form["name"]:
                raise ValueError("Pool name is required.")

            competition = db.session.get(Competition, form["competition_id"])
            if competition is None:
                raise ValueError("Choose a valid competition.")

            if not _slug_available(form["slug"]):
                raise ValueError("That pool URL slug is already taken.")

            score_correct_winner = _int_setting("score_correct_winner", 1, minimum=0, maximum=20)
            score_exact_bonus = _int_setting("score_exact_bonus", 2, minimum=0, maximum=20)

            pool = Pool(
                name=form["name"],
                slug=form["slug"],
                competition_id=competition.id,
                owner_id=current_user.id,
                score_correct_winner=score_correct_winner,
                score_exact_bonus=score_exact_bonus,
                invite_code=_unique_invite_code(),
                is_public=form["is_public"],
            )

            db.session.add(pool)
            db.session.flush()

            db.session.add(PoolMember(
                pool_id=pool.id,
                user_id=current_user.id,
                role="owner",
            ))

            db.session.commit()

            flash(f"Created pool: {pool.name}")
            return redirect(url_for("public.pool_home", pool_slug=pool.slug))

        except ValueError as exc:
            db.session.rollback()
            flash(str(exc))
            defaults.update(form)
        except Exception:
            db.session.rollback()
            raise

    return render_template(
        "admin/create_pool.html",
        competitions=competitions,
        form=defaults,
    )


@admin.route("/admin/results")
@login_required
def results():
    """Legacy no-slug admin results route.

    Keeps existing links working, then redirects to the canonical pool-aware route.
    """
    pool = default_pool()
    if pool is None:
        abort(404)

    require_pool_admin(pool)

    return redirect(
        url_for(
            "admin.pool_results",
            pool_slug=pool.slug,
            filter=request.args.get("filter", "needs"),
        )
    )


@admin.route("/admin/games/<int:game_id>/picks")
@login_required
def game_picks(game_id):
    """Legacy no-slug admin pick edit route."""
    pool = default_pool()
    if pool is None:
        abort(404)

    require_pool_admin(pool)

    return redirect(
        url_for(
            "admin.pool_game_picks",
            pool_slug=pool.slug,
            game_id=game_id,
            filter=request.args.get("filter", "needs"),
        )
    )


@admin.route("/pools/<pool_slug>/admin/results", methods=["GET", "POST"])
@login_required
def pool_results(pool_slug):
    pool = get_pool_or_404(pool_slug)
    require_pool_admin(pool)

    filter_value = request.values.get("filter") or "needs"
    if filter_value not in {"needs", "all", "final", "future", "live"}:
        filter_value = "needs"

    if request.method == "POST":
        try:
            game_id = int(request.form.get("game_id", ""))
        except ValueError:
            abort(400)

        game = Game.query.get_or_404(game_id)
        if game.competition_id != pool.competition_id:
            abort(404)

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
                game.home_score = None
                game.away_score = None
                game.status = "live"
                flash(f"Marked live: {game.home} v {game.away}")

            elif action in {"scheduled", "clear"}:
                game.home_score = None
                game.away_score = None
                game.status = "scheduled"
                flash(f"Cleared result: {game.home} v {game.away}")

            else:
                abort(400)

        except ValueError as exc:
            flash(str(exc))
            return redirect(url_for("admin.pool_results", pool_slug=pool.slug, filter=filter_value))

        db.session.commit()
        return redirect(url_for("admin.pool_results", pool_slug=pool.slug, filter=filter_value))

    all_games = list(pool.competition.games)
    stats = {
        "total": len(all_games),
        "final": sum(1 for g in all_games if g.is_final),
        "needs": sum(1 for g in all_games if g.locked and not g.is_final),
        "future": sum(1 for g in all_games if not g.locked and not g.is_final),
        "live": sum(1 for g in all_games if g.status == "live" and not g.is_final),
    }

    games = _filtered_games(pool, filter_value)

    if filter_value == "final":
        games = sorted(games, key=lambda g: g.kickoff_at, reverse=True)
    else:
        games = sorted(games, key=lambda g: g.kickoff_at)

    rows = [_game_row(game) for game in games]

    return render_template(
        "admin/results.html",
        pool=pool,
        current_pool=pool,
        rows=rows,
        stats=stats,
        filter_value=filter_value,
    )


@admin.route("/pools/<pool_slug>/admin/games/<int:game_id>/picks", methods=["GET", "POST"])
@login_required
def pool_game_picks(pool_slug, game_id):
    """Edit all users' predictions for one game.

    This bypasses the normal user-side kickoff lock, but remains restricted
    to pool admins/site admins. It is intended for corrections and missed
    manual entries.
    """
    pool = get_pool_or_404(pool_slug)
    require_pool_admin(pool)

    game = Game.query.get_or_404(game_id)
    if game.competition_id != pool.competition_id:
        abort(404)

    filter_value = request.values.get("filter") or "needs"

    members = sorted(pool.members, key=lambda membership: membership.user.name.lower())
    existing = {
        pred.user_id: pred
        for pred in Prediction.query.filter_by(pool_id=pool.id, game_id=game.id).all()
    }

    if request.method == "POST":
        saved = 0
        cleared = 0

        try:
            for membership in members:
                user = membership.user
                user_id = user.id
                pred = existing.get(user_id)

                if request.form.get(f"clear_{user_id}") == "1":
                    if pred is not None:
                        db.session.delete(pred)
                        cleared += 1
                    continue

                pair = _optional_score_pair(f"h_{user_id}", f"a_{user_id}")
                if pair is None:
                    continue

                home_score, away_score = pair

                if pred is None:
                    pred = Prediction(
                        pool_id=pool.id,
                        user_id=user_id,
                        game_id=game.id,
                    )
                    db.session.add(pred)
                    existing[user_id] = pred

                pred.home_score = home_score
                pred.away_score = away_score
                pred.winner = _winner_from_score(home_score, away_score)
                pred.show_before_kickoff = request.form.get(f"show_{user_id}") == "1"
                saved += 1

        except ValueError as exc:
            db.session.rollback()
            flash(str(exc))
            return redirect(
                url_for(
                    "admin.pool_game_picks",
                    pool_slug=pool.slug,
                    game_id=game.id,
                    filter=filter_value,
                )
            )

        db.session.commit()

        bits = []
        if saved:
            bits.append(f"saved {saved}")
        if cleared:
            bits.append(f"cleared {cleared}")
        if not bits:
            bits.append("no changes saved")

        flash("Admin picks update: " + ", ".join(bits) + ".")
        return redirect(
            url_for(
                "admin.pool_game_picks",
                pool_slug=pool.slug,
                game_id=game.id,
                filter=filter_value,
            )
        )

    rows = []
    for membership in members:
        user = membership.user
        pred = existing.get(user.id)
        rows.append({
            "user": user,
            "prediction": pred,
            "home_score": pred.home_score if pred else "",
            "away_score": pred.away_score if pred else "",
            "show_before_kickoff": bool(pred.show_before_kickoff) if pred else False,
        })

    return render_template(
        "admin/game_picks.html",
        pool=pool,
        current_pool=pool,
        game=game,
        rows=rows,
        filter_value=filter_value,
        date_label=_fmt_date(game.kickoff_at),
        time_label=_fmt_time(game.kickoff_at),
        status_label=_status_label(game),
        status_class=_status_class(game),
    )
