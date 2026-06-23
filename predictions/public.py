"""Public DB-backed pool dashboard for the predictions app.

Pool-aware routes:
  /predictions                         -> redirects to default pool dashboard
  /predictions/my-pools                -> logged-in user's pool list
  /predictions/pools/<pool_slug>       -> one pool dashboard

Behavior:
  - Before kickoff, score picks stay hidden by default.
  - A user may choose to show an individual pick before kickoff.
  - At kickoff, all submitted picks reveal automatically.
  - Final results show target/check/x result labels and points.
"""

import datetime as dt

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from predictions import timing
from predictions.models import db, Pool, PoolMember, score_prediction
from predictions.pool_helpers import default_pool, get_pool_or_404, user_can_admin_pool, user_can_view_pool


public = Blueprint("public", __name__, template_folder="templates")

_as_app_tz = timing.as_app_tz
_et_date = timing.et_date
_pick_open_date = timing.release_date

DAILY_WAGER_FROM = "2026-06-19"
WAGER_STAKE = 1
_MD1 = "Group Stage: Matchday 1"


def _fmt_money(value):
    rv = round(value, 2)
    if rv == 0:
        return "$0"

    body = "{:d}".format(abs(int(rv))) if rv == int(rv) else "{:.2f}".format(abs(rv))
    return ("+$" if rv > 0 else "−$") + body


def _fmt_dt(value):
    local = _as_app_tz(value)
    return local.strftime("%a %b %d, %I:%M %p").replace(" 0", " ")


def _fmt_date(value):
    local = _as_app_tz(value)
    return local.strftime("%a %b %d").replace(" 0", " ")


def _fmt_time(value):
    local = _as_app_tz(value)
    return local.strftime("%I:%M %p").lstrip("0")


def _leaderboard(pool):
    """Build standings for one pool."""
    members = [m.user for m in pool.members]
    member_ids = [u.id for u in members]
    open_date = _pick_open_date()

    games = [
        g for g in sorted(pool.competition.games, key=lambda g: g.kickoff_at)
        if _as_app_tz(g.kickoff_at).date() <= open_date
    ]

    preds = {(p.user_id, p.game_id): p for p in pool.predictions}

    rows = {
        u.id: {
            "user": u,
            "name": u.name,
            "total": 0,
            "winners": 0,
            "exact": 0,
            "score_diff": 0,
            "submitted": 0,
            "by_stage": {},
            "award": "",
            "daily": 0,
            "daily_win": False,
            "money": 0,
            "money_str": "$0",
            "is_leader": False,
        }
        for u in members
    }

    # Submitted = every prediction this user has made, including upcoming games.
    for (uid, _gid) in preds:
        if uid in rows:
            rows[uid]["submitted"] += 1

    # Score final games; remember per (game, user) points and goal-difference
    # so daily/wager/matchday tiebreaks can each scope closeness to their own
    # games.
    pts_by = {}
    diff_by = {}

    for game in games:
        if not game.is_final:
            continue

        for user in members:
            pred = preds.get((user.id, game.id))
            if pred is None:
                continue

            points, winner_ok, exact = score_prediction(pred, game, pool)

            # Closeness to the real scoreline (lower is better).
            gdiff = (
                abs(pred.home_score - game.home_score)
                + abs(pred.away_score - game.away_score)
            )

            row = rows[user.id]
            row["total"] += points
            row["winners"] += int(winner_ok)
            row["exact"] += int(exact)
            row["score_diff"] += gdiff

            stage_row = row["by_stage"].setdefault(
                game.stage,
                {"points": 0, "winners": 0, "exact": 0, "score_diff": 0},
            )
            stage_row["points"] += points
            stage_row["winners"] += int(winner_ok)
            stage_row["exact"] += int(exact)
            stage_row["score_diff"] += gdiff

            pts_by[(game.id, user.id)] = points
            diff_by[(game.id, user.id)] = gdiff

    def md_points(uid, stage):
        return rows[uid]["by_stage"].get(stage, {}).get("points", 0)

    # Matchday 1 trophies for the top 3 once MD1 has been played.
    if any(g.is_final and g.stage == _MD1 for g in games):
        ranked = sorted(
            member_ids,
            key=lambda uid: (md_points(uid, _MD1), rows[uid]["exact"]),
            reverse=True,
        )
        for medal, uid in zip(("🥇", "🥈", "🥉"), ranked[:3]):
            rows[uid]["award"] = medal

    # Active matchday = the most advanced stage that has actually KICKED OFF;
    # released-but-not-started stages do not count.
    ordered = timing.started_stages_ordered(games)
    active = ordered[-1] if ordered else None
    lb_past = [
        {"full": s, "short": timing.STAGE_SHORT.get(s, s)}
        for s in ordered[:-1]
    ]
    lb_active = (
        {"full": active, "short": timing.STAGE_SHORT.get(active, active)}
        if active else None
    )

    def active_points(uid):
        return rows[uid]["by_stage"].get(active, {}).get("points", 0) if active else 0

    def active_diff(uid):
        # Closeness within the active matchday only.
        return rows[uid]["by_stage"].get(active, {}).get("score_diff", 0) if active else 0

    def day_diff(uid, et):
        # Closeness within a single match day only.
        return sum(
            diff_by[(g.id, uid)]
            for g in games
            if g.is_final and _et_date(g) == et and (g.id, uid) in diff_by
        )

    # Daily wager column: most recent day with results.
    daily_label = None
    wager_dates = sorted({
        _et_date(g)
        for g in games
        if g.is_final and _et_date(g) >= DAILY_WAGER_FROM
    })

    if wager_dates:
        latest = wager_dates[-1]

        for game in games:
            if game.is_final and _et_date(game) == latest:
                for user in members:
                    if (game.id, user.id) in pts_by:
                        rows[user.id]["daily"] += pts_by[(game.id, user.id)]

        day_complete = all(
            g.is_final
            for g in games
            if _et_date(g) == latest
        )

        winners = set()
        if day_complete:
            top = max(rows[uid]["daily"] for uid in member_ids)
            top_scorers = [
                uid for uid in member_ids
                if rows[uid]["daily"] == top and top > 0
            ]
            if top_scorers:
                closest = min(day_diff(uid, latest) for uid in top_scorers)
                winners = {
                    uid for uid in top_scorers
                    if day_diff(uid, latest) == closest
                }

        for uid in member_ids:
            rows[uid]["daily_win"] = uid in winners

        d = dt.date.fromisoformat(latest)
        daily_label = "{} {}".format(d.strftime("%b"), d.day)

    # Season money ledger: $1 ante per wager day, day's top scorer takes the pot.
    n_players = len(members)
    result_dates = [_et_date(g) for g in games if g.is_final]
    wager_active = False

    if result_dates:
        last_result_date = max(result_dates)
        wager_days = sorted({
            _et_date(g)
            for g in games
            if DAILY_WAGER_FROM <= _et_date(g) <= last_result_date
        })

        money = {uid: 0 for uid in member_ids}

        for wager_day in wager_days:
            day_games = [g for g in games if _et_date(g) == wager_day]
            complete = all(g.is_final for g in day_games)

            day_points = {uid: 0 for uid in member_ids}
            for game in day_games:
                if not game.is_final:
                    continue

                for user in members:
                    if (game.id, user.id) in pts_by:
                        day_points[user.id] += pts_by[(game.id, user.id)]

            pot = WAGER_STAKE * n_players

            if complete:
                top = max(day_points.values())
                top_scorers = [
                    uid for uid in member_ids
                    if day_points[uid] == top and top > 0
                ]
                if top_scorers:
                    closest = min(day_diff(uid, wager_day) for uid in top_scorers)
                    day_winners = [
                        uid for uid in top_scorers
                        if day_diff(uid, wager_day) == closest
                    ]
                    wager_active = True
                    share = pot / len(day_winners)
                    for uid in member_ids:
                        money[uid] -= WAGER_STAKE
                        if uid in day_winners:
                            money[uid] += share
            else:
                wager_active = True
                for uid in member_ids:
                    money[uid] -= WAGER_STAKE

        for uid in member_ids:
            rows[uid]["money"] = round(money[uid], 2)
            rows[uid]["money_str"] = _fmt_money(money[uid])

    ranked_rows = sorted(
        rows.values(),
        # Rank by active-matchday points, then closeness within that same
        # matchday (smaller goal-difference), then total points.
        key=lambda r: (active_points(r["user"].id), -active_diff(r["user"].id), r["total"]),
        reverse=True,
    )

    for index, row in enumerate(ranked_rows, start=1):
        uid = row["user"].id
        row["rank"] = index
        row["is_leader"] = index == 1 and active_points(uid) > 0
        row["is_me"] = current_user.is_authenticated and uid == current_user.id
        row["active_points"] = active_points(uid)
        row["active_winners"] = (
            rows[uid]["by_stage"].get(active, {}).get("winners", 0)
            if active else 0
        )
        row["active_exact"] = (
            rows[uid]["by_stage"].get(active, {}).get("exact", 0)
            if active else 0
        )
        row["past_points"] = [md_points(uid, s["full"]) for s in lb_past]

    return {
        "rows": ranked_rows,
        "lb_past": lb_past,
        "lb_active": lb_active,
        "daily_label": daily_label,
        "show_money": wager_active,
    }


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


def _public_pick_label(pred):
    return f"{pred.home_score}–{pred.away_score}"


def _roster_rows(pool, game, pred_by_user):
    """Rows for the pre-kickoff roster.

    A user's score is shown before kickoff only when they explicitly opted in
    with show_before_kickoff. Otherwise it shows Submitted/Pending only.
    """
    rows = []

    for member in sorted(pool.members, key=lambda m: m.user.name.lower()):
        pred = pred_by_user.get(member.user_id)
        has_pick = pred is not None
        visible_score = has_pick and bool(pred.show_before_kickoff)

        rows.append({
            "name": member.user.name,
            "has_pick": has_pick,
            "visible_score": visible_score,
            "status_label": "Public" if visible_score else ("Submitted" if has_pick else "Pending"),
            "mark": "✓" if has_pick else "○",
            "pick_label": _public_pick_label(pred) if visible_score else "",
            "winner_label": _winner_label(pred.winner, game) if visible_score else "",
            "is_me": current_user.is_authenticated and member.user.id == current_user.id,
        })

    return rows


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
                "is_me": current_user.is_authenticated and member.user.id == current_user.id,
            })
            continue

        if game.is_final:
            points, winner_ok, exact = score_prediction(pred, game, pool)
        else:
            points, winner_ok, exact = None, False, False

        rows.append({
            "name": member.user.name,
            "has_pick": True,
            "pick_label": f"{pred.home_score}–{pred.away_score}",
            "winner_label": _winner_label(pred.winner, game),
            "points": points,
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


def _private_pool_redirect_or_abort(pool):
    """Return a response if the current user cannot view this private pool."""
    if user_can_view_pool(pool):
        return None

    if not current_user.is_authenticated:
        next_url = request.full_path
        if next_url.endswith("?"):
            next_url = next_url[:-1]
        return redirect(url_for("auth.login", next=next_url))

    abort(403)


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
        "roster_rows": _roster_rows(pool=pool, game=game, pred_by_user=pred_by_user),
        "pick_rows": (
            _pick_rows(pool=pool, game=game, pred_by_user=pred_by_user)
            if reveal_picks else []
        ),
    }


@public.route("")
@public.route("/")
def home():
    pool = default_pool()
    if pool is None:
        abort(404)
    return redirect(url_for("public.pool_home", pool_slug=pool.slug))


@public.route("/my-pools")
@login_required
def my_pools():
    memberships = sorted(
        current_user.memberships,
        key=lambda m: (m.pool.name.lower(), m.pool.id),
    )

    pools = [m.pool for m in memberships]
    membership_by_pool_id = {m.pool_id: m for m in memberships}

    if current_user.is_site_admin:
        # Site admin can see all pools, including pools they are not a member of.
        seen = {p.id for p in pools}
        for pool in Pool.query.order_by(Pool.name.asc()).all():
            if pool.id not in seen:
                pools.append(pool)
                seen.add(pool.id)

    rows = []
    for pool in pools:
        membership = membership_by_pool_id.get(pool.id)
        can_admin = user_can_admin_pool(pool)

        if membership is not None:
            role_label = {
                "owner": "Owner",
                "admin": "Admin",
                "member": "Member",
            }.get(membership.role, membership.role.title())
        elif current_user.is_site_admin:
            role_label = "Site admin"
        else:
            role_label = ""

        rows.append({
            "pool": pool,
            "can_admin": can_admin,
            "role_label": role_label,
            "visibility_label": "Public" if pool.is_public else "Private",
            "invite_url": (
                url_for("public.join_pool", invite_code=pool.invite_code, _external=True)
                if can_admin and pool.invite_code else None
            ),
        })

    return render_template("my_pools.html", rows=rows)


@public.route("/join/<invite_code>")
@login_required
def join_pool(invite_code):
    """Join a pool by invite code.

    First pass: users must already have an account. Later public signup can
    redirect back here after account creation.
    """
    pool = Pool.query.filter_by(invite_code=invite_code).first_or_404()

    existing = PoolMember.query.filter_by(
        pool_id=pool.id,
        user_id=current_user.id,
    ).first()

    if existing is None:
        db.session.add(PoolMember(
            pool_id=pool.id,
            user_id=current_user.id,
            role="member",
        ))
        db.session.commit()
        flash(f"You joined {pool.name}.")
    else:
        flash(f"You are already in {pool.name}.")

    return redirect(url_for("public.pool_home", pool_slug=pool.slug))


@public.route("/pools/<pool_slug>")
def pool_home(pool_slug):
    pool = get_pool_or_404(pool_slug)

    access_response = _private_pool_redirect_or_abort(pool)
    if access_response is not None:
        return access_response

    competition = pool.competition
    member_count = len(pool.members)
    pred_index = _prediction_index(pool)

    games = sorted(competition.games, key=lambda g: g.kickoff_at)
    visible_games = [game for game in games if timing.is_released(game)]

    current_games = [
        _game_card(pool, game, pred_index.get(game.id, {}), member_count)
        for game in visible_games
        if not game.is_final
    ]

    recent_results = [
        _game_card(pool, game, pred_index.get(game.id, {}), member_count)
        for game in sorted(games, key=lambda g: g.kickoff_at, reverse=True)
        if game.is_final
    ][:8]

    total_games = len(games)
    final_games = sum(1 for g in games if g.is_final)
    locked_not_final = sum(1 for g in games if g.locked and not g.is_final)

    board = _leaderboard(pool)

    return render_template(
        "home.html",
        pool=pool,
        current_pool=pool,
        can_admin_pool=user_can_admin_pool(pool),
        competition=competition,
        leaderboard=board["rows"],
        lb_past=board["lb_past"],
        lb_active=board["lb_active"],
        daily_label=board["daily_label"],
        show_money=board["show_money"],
        current_games=current_games,
        recent_results=recent_results,
        member_count=member_count,
        total_games=total_games,
        final_games=final_games,
        locked_not_final=locked_not_final,
    )
