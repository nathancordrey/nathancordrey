"""Public DB-backed homepage for the predictions app.

Routes are registered under /predictions by wc_app.py.

Behavior:
  - Before kickoff, score picks stay hidden by default.
  - A user may choose to show an individual pick before kickoff.
  - At kickoff, all submitted picks reveal automatically.
  - Final results show target/check/x result labels and points.
"""

import datetime as dt
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, render_template
from flask_login import current_user

from predictions.models import Pool, score_prediction


public = Blueprint("public", __name__, template_folder="templates")

APP_TZ = ZoneInfo("America/New_York")

DAILY_WAGER_FROM = "2026-06-19"
WAGER_STAKE = 1

_MD1 = "Group Stage: Matchday 1"

STAGE_ORDER = [
    "Group Stage: Matchday 1",
    "Group Stage: Matchday 2",
    "Group Stage: Matchday 3",
    "Round of 32",
    "Round of 16",
    "Round of 8",
    "Round of 4",
    "Final",
]

STAGE_SHORT = {
    "Group Stage: Matchday 1": "MD1",
    "Group Stage: Matchday 2": "MD2",
    "Group Stage: Matchday 3": "MD3",
    "Round of 32": "R32",
    "Round of 16": "R16",
    "Round of 8": "R8",
    "Round of 4": "R4",
    "Final": "F",
}


def _fmt_money(value):
    rv = round(value, 2)
    if rv == 0:
        return "$0"
    body = "{:d}".format(abs(int(rv))) if rv == int(rv) else "{:.2f}".format(abs(rv))
    return ("+$" if rv > 0 else "−$") + body


def _as_utc(value):
    """Return a timezone-aware UTC datetime."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def _as_app_tz(value):
    return _as_utc(value).astimezone(APP_TZ)


def _et_date(game):
    """ET calendar date (ISO string) of a game's kickoff."""
    return _as_app_tz(game.kickoff_at).date().isoformat()


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
    for (uid, gid) in preds:
        if uid in rows:
            rows[uid]["submitted"] += 1

    # Score final games; remember per (game, user) points for daily/wager.
    pts_by = {}

    for game in games:
        if not game.is_final:
            continue

        for user in members:
            pred = preds.get((user.id, game.id))
            if pred is None:
                continue

            points, winner_ok, exact = score_prediction(pred, game, pool)
            row = rows[user.id]
            row["total"] += points
            row["winners"] += int(winner_ok)
            row["exact"] += int(exact)

            stage_row = row["by_stage"].setdefault(
                game.stage,
                {"points": 0, "winners": 0, "exact": 0},
            )
            stage_row["points"] += points
            stage_row["winners"] += int(winner_ok)
            stage_row["exact"] += int(exact)
            pts_by[(game.id, user.id)] = points

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

    # Active matchday = most advanced stage present; earlier ones are settled.
    present = {g.stage for g in games}
    ordered = [s for s in STAGE_ORDER if s in present]
    ordered += sorted(present - set(STAGE_ORDER))

    active = ordered[-1] if ordered else None
    lb_past = [{"full": s, "short": STAGE_SHORT.get(s, s)} for s in ordered[:-1]]
    lb_active = (
        {"full": active, "short": STAGE_SHORT.get(active, active)}
        if active else None
    )

    def active_points(uid):
        return rows[uid]["by_stage"].get(active, {}).get("points", 0) if active else 0

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
            g.is_final for g in games
            if _et_date(g) == latest
        )

        winners = set()
        if day_complete:
            top = max(rows[uid]["daily"] for uid in member_ids)
            winners = {
                uid for uid in member_ids
                if rows[uid]["daily"] == top and top > 0
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
                day_winners = [uid for uid in member_ids if day_points[uid] == top and top > 0]
                if day_winners:
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
        key=lambda r: (active_points(r["user"].id), r["total"]),
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
    pool = _first_pool()
    if pool is None:
        abort(404)

    competition = pool.competition
    member_count = len(pool.members)
    pred_index = _prediction_index(pool)
    open_date = _pick_open_date()

    games = sorted(competition.games, key=lambda g: g.kickoff_at)

    visible_games = [
        game for game in games
        if _as_app_tz(game.kickoff_at).date() <= open_date
    ]

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
