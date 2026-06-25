"""Sync World Cup fixtures and results from football-data.org into Game rows.

Safe by design:
  * DRY-RUN by default — prints exactly what it *would* change and writes nothing.
    Add --commit to actually apply the plan.
  * Idempotent — every match is keyed by external_ref="fd:<matchId>", so running
    it repeatedly only writes real changes.

Usage (on the server, inside the app's venv):
    export FOOTBALL_DATA_TOKEN=your_free_token
    python3 -m predictions.sync_football_data            # dry-run, shows the plan
    python3 -m predictions.sync_football_data --commit    # apply it

The network call is isolated in fetch_matches() so the mapping/plan logic can be
unit-tested with a sample payload (see the bottom of this file / the test harness).
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

from .models import db, Competition, Game

# football-data.org config -------------------------------------------------
API_BASE = "https://api.football-data.org/v4"
DEFAULT_COMPETITION = "WC"            # World Cup competition code
TOKEN_ENV = "FOOTBALL_DATA_TOKEN"

# Map football-data.org stage tokens -> our STAGE_ORDER strings.
# NOTE: the 48-team WC2026 format is new; confirm the knockout tokens (esp. the
# round of 32) against the first live dry-run and adjust here if they differ.
STAGE_MAP = {
    "LAST_32": "Round of 32",
    "ROUND_OF_32": "Round of 32",
    "LAST_16": "Round of 16",
    "ROUND_OF_16": "Round of 16",
    "QUARTER_FINALS": "Round of 8",
    "QUARTER_FINAL": "Round of 8",
    "SEMI_FINALS": "Round of 4",
    "SEMI_FINAL": "Round of 4",
    "THIRD_PLACE": "Third place",   # not in STAGE_ORDER; sorts last — see README note
    "FINAL": "Final",
}

# Map their status -> our constrained status set
# (scheduled / live / final / postponed / cancelled).
STATUS_MAP = {
    "SCHEDULED": "scheduled",
    "TIMED": "scheduled",
    "IN_PLAY": "live",
    "PAUSED": "live",
    "SUSPENDED": "postponed",
    "POSTPONED": "postponed",
    "CANCELLED": "cancelled",
    "CANCELED": "cancelled",
    "FINISHED": "final",
    "AWARDED": "final",
}

# Team-name fixups: feed spelling (football-data.org) -> your seeded spelling.
# Applied to the feed's names when matching against existing games, so a
# group-stage game shows as ~UPDATE (not +CREATE = a duplicate). Mapping a name
# to itself is harmless and just guards against whichever spelling the feed
# happens to send. Add any remaining mismatches a dry-run surfaces.
NAME_ALIASES = {
    "United States": "USA",
    "Cape Verde Islands": "Cape Verde",
    "Congo DR": "DR Congo",
    "DR Congo": "DR Congo",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
    "Bosnia and Herzegovina": "Bosnia and Herzegovina",
    "Czech Republic": "Czechia",
    "Curaçao": "Curacao",
    "Türkiye": "Turkey",
    "Turkey": "Turkey",
    "Korea Republic": "South Korea",
    "South Korea": "South Korea",
    "Côte d'Ivoire": "Ivory Coast",
    "Ivory Coast": "Ivory Coast",
}


# --- helpers --------------------------------------------------------------
def _norm(name):
    name = (name or "").strip()
    return NAME_ALIASES.get(name, name)


def _parse_utc(value):
    """ISO8601 like '2026-06-24T19:00:00Z' -> aware UTC datetime."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _group_label(match):
    g = match.get("group")  # e.g. "GROUP_A" or None
    if not g:
        return None
    return g.replace("GROUP_", "").replace("Group ", "").strip()[:8] or None


def map_match(match):
    """Translate one football-data.org match into our Game field dict."""
    stage_token = (match.get("stage") or "").upper()
    if stage_token == "GROUP_STAGE":
        stage = f"Group Stage: Matchday {match.get('matchday')}"
    else:
        stage = STAGE_MAP.get(stage_token)

    score = (match.get("score") or {}).get("fullTime") or {}
    status = STATUS_MAP.get((match.get("status") or "").upper(), "scheduled")

    return {
        "external_ref": f"fd:{match['id']}",
        "stage": stage,                       # may be None if token unknown
        "stage_token": stage_token,           # kept for reporting only
        "group_label": _group_label(match),
        "home": _norm((match.get("homeTeam") or {}).get("name")),
        "away": _norm((match.get("awayTeam") or {}).get("name")),
        "kickoff_at": _parse_utc(match["utcDate"]),
        "home_score": score.get("home"),
        "away_score": score.get("away"),
        "status": status,
    }


# --- planning -------------------------------------------------------------
def build_plan(competition, matches):
    """Compare feed matches to existing games. Returns (creates, updates, skips,
    warnings) without touching the session."""
    games = Game.query.filter_by(competition_id=competition.id).all()
    by_ref = {g.external_ref: g for g in games if g.external_ref}
    by_exact = {(g.stage, g.home, g.away): g for g in games}
    by_pair = {(g.stage, frozenset((g.home, g.away))): g for g in games}

    creates, updates, skips, warnings, pending = [], [], [], [], []

    for match in matches:
        m = map_match(match)
        if m["stage"] is None:
            warnings.append(f"Unknown stage token {m['stage_token']!r} for "
                            f"{m['home']} v {m['away']} — add it to STAGE_MAP.")
            continue

        # Knockout slots whose teams aren't decided yet (groups not finished):
        # skip until the feed fills them in, rather than create blank games.
        if not m["home"] or not m["away"]:
            pending.append(m)
            continue

        game = (by_ref.get(m["external_ref"])
                or by_exact.get((m["stage"], m["home"], m["away"]))
                or by_pair.get((m["stage"], frozenset((m["home"], m["away"])))))

        if game is None:
            creates.append(m)
            continue

        # The DB game may store home/away in the opposite order to the feed.
        # Keep the DB's orientation (existing picks depend on it) and swap the
        # feed's scores to match, rather than flipping the teams.
        swapped = game.home != m["home"]
        target = {
            "group_label": m["group_label"],
            "kickoff_at": m["kickoff_at"],
            "status": m["status"],
            "external_ref": m["external_ref"],
            "home_score": m["away_score"] if swapped else m["home_score"],
            "away_score": m["home_score"] if swapped else m["away_score"],
        }
        # home/away strings are intentionally NOT updated — orientation stays put.

        changes = {}
        for field, new in target.items():
            old = getattr(game, field)
            # Never clobber an existing value with a missing one from the feed
            # (e.g. group_label absent in the payload shouldn't blank ours).
            if new in (None, "") and old not in (None, ""):
                continue
            if field == "kickoff_at" and old is not None:
                old_cmp = old if old.tzinfo else old.replace(tzinfo=dt.timezone.utc)
                if old_cmp.astimezone(dt.timezone.utc) == new:
                    continue
            if new != old:
                changes[field] = (old, new)
        if changes:
            updates.append((game, m, changes, swapped))
        else:
            skips.append(game)

    return creates, updates, skips, warnings, pending


def print_plan(creates, updates, skips, warnings, pending):
    print(f"\nPLAN: {len(creates)} create, {len(updates)} update, "
          f"{len(skips)} unchanged, {len(pending)} pending-teams, "
          f"{len(warnings)} warning(s)\n")
    for w in warnings:
        print(f"  ⚠️  {w}")
    for m in creates:
        score = ""
        if m["home_score"] is not None:
            score = f"  [{m['home_score']}-{m['away_score']}]"
        print(f"  + CREATE  {m['stage']:<22} {m['home']} v {m['away']}"
              f"  @ {m['kickoff_at']:%Y-%m-%d %H:%MZ}  ({m['status']}){score}")
    for game, m, changes, swapped in updates:
        flag = " [swap]" if swapped else ""
        bits = ", ".join(f"{f}: {o!r}->{n!r}" for f, (o, n) in changes.items())
        print(f"  ~ UPDATE  {m['stage']:<22} {game.home} v {game.away}{flag}  | {bits}")
    if pending:
        stages = ", ".join(sorted({m["stage"] for m in pending}))
        print(f"\n  {len(pending)} knockout slot(s) waiting on teams, skipped: {stages}")
    if not creates and not updates:
        print("  (nothing to change — already in sync)")


# --- apply ----------------------------------------------------------------
def apply_plan(competition, creates, updates):
    for m in creates:
        db.session.add(Game(
            competition_id=competition.id,
            stage=m["stage"],
            group_label=m["group_label"],
            home=m["home"],
            away=m["away"],
            kickoff_at=m["kickoff_at"],
            home_score=m["home_score"],
            away_score=m["away_score"],
            status=m["status"],
            external_ref=m["external_ref"],
        ))
    for game, m, changes, *_ in updates:
        for field, (_old, new) in changes.items():
            setattr(game, field, new)
    db.session.commit()


# --- network (isolated so the rest is unit-testable) ----------------------
def fetch_matches(token, competition_code):
    import requests  # imported lazily so the module loads without requests
    resp = requests.get(
        f"{API_BASE}/competitions/{competition_code}/matches",
        headers={"X-Auth-Token": token},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("matches", [])


# --- entrypoint -----------------------------------------------------------
def run(commit=False, competition_code=DEFAULT_COMPETITION, token=None,
        matches=None):
    """matches can be injected (for testing); otherwise fetched from the API."""
    competition = Competition.query.filter(
        (Competition.external_ref == "json:worldcup")
        | (Competition.slug.ilike("%world%"))
    ).first()
    if competition is None:
        competition = Competition.query.first()
    if competition is None:
        print("No competition found in the database.")
        return 1

    if matches is None:
        token = token or os.environ.get(TOKEN_ENV)
        if not token:
            print(f"Set {TOKEN_ENV} (your free football-data.org token).")
            return 1
        matches = fetch_matches(token, competition_code)

    print(f"Competition: {competition.name!r}  |  {len(matches)} feed matches"
          f"  |  mode: {'COMMIT' if commit else 'DRY-RUN'}")
    creates, updates, skips, warnings, pending = build_plan(competition, matches)
    print_plan(creates, updates, skips, warnings, pending)

    if commit:
        apply_plan(competition, creates, updates)
        print(f"\n✅ Applied: {len(creates)} created, {len(updates)} updated.")
    else:
        print("\n(dry-run — nothing written. Re-run with --commit to apply.)")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Sync WC data from football-data.org")
    parser.add_argument("--commit", action="store_true",
                        help="apply the plan (default is dry-run)")
    parser.add_argument("--competition", default=DEFAULT_COMPETITION,
                        help="football-data.org competition code (default WC)")
    args = parser.parse_args(argv)

    # Import here so `python3 -m predictions.sync_football_data` sets up the app.
    from wc_app import create_app
    app = create_app()
    with app.app_context():
        return run(commit=args.commit, competition_code=args.competition)


if __name__ == "__main__":
    sys.exit(main())
