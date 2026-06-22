#!/usr/bin/env python3
"""Seed Postgres from predictions/worldcup.json.

Run from repo root:

DATABASE_URL="postgresql+psycopg2://worldcup_user:wcpass2026@127.0.0.1:5432/worldcup_db" \
NATE_PASSWORD="worldcup2026" \
python -m predictions.seed_from_json --force

This version refuses to silently use SQLite unless --sqlite-dev is passed.
"""

import argparse
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from flask import Flask

from predictions.models import (
    db,
    User,
    Competition,
    Game,
    Pool,
    PoolMember,
    Prediction,
)

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
JSON_PATH = Path(os.environ.get("WC_JSON", HERE / "worldcup.json"))

COMP_NAME = "World Cup 2026"
COMP_SLUG = "wc-2026"
POOL_NAME = "The Pool"
POOL_SLUG = "the-pool"
OWNER = "Nate"

DEFAULT_PASSWORD = os.environ.get("DEFAULT_WC_PASSWORD", "worldcup2026")
PASSWORDS = {
    OWNER: os.environ.get("NATE_PASSWORD") or DEFAULT_PASSWORD,
}

PLACEHOLDER_KICKOFF_UTC_HOUR = 16

GROUP_FIXES = {
    ("Scotland", "Morocco", "2026-06-19"): "C",
    ("Brazil", "Haiti", "2026-06-19"): "C",
    ("Netherlands", "Sweden", "2026-06-20"): "F",
    ("Germany", "Ivory Coast", "2026-06-20"): "E",
    ("Ecuador", "Curacao", "2026-06-20"): "E",
    ("Tunisia", "Japan", "2026-06-20"): "F",
}


def load_env():
    if load_dotenv is not None:
        load_dotenv(REPO_ROOT / ".env")
        load_dotenv(HERE / ".env")


def normalize_db_url(url):
    if not url:
        return url
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url[len("postgres://"):]
    if url.startswith("postgresql://") and "+psycopg2" not in url:
        return "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


def safe_db_url(url):
    try:
        parts = urlsplit(url)
        if not parts.password:
            return url
        netloc = parts.hostname or ""
        if parts.username:
            netloc = parts.username + ":***@" + netloc
        if parts.port:
            netloc += f":{parts.port}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        return "(could not parse database URL)"


def get_db_url(sqlite_dev=False):
    load_env()
    url = normalize_db_url(os.environ.get("DATABASE_URL"))

    if url:
        return url

    if sqlite_dev:
        return "sqlite:///" + str(REPO_ROOT / "wc_dev.db")

    raise SystemExit(
        "DATABASE_URL is not set. Refusing to seed SQLite by accident.\n"
        "Example:\n"
        "  DATABASE_URL=\"postgresql+psycopg2://worldcup_user:wcpass2026@127.0.0.1:5432/worldcup_db\" "
        "python -m predictions.seed_from_json --force\n"
        "Use --sqlite-dev only for an intentional local SQLite test."
    )


def kickoff(date_str):
    y, m, d = (int(x) for x in date_str.split("-"))
    return datetime(y, m, d, PLACEHOLDER_KICKOFF_UTC_HOUR, 0, tzinfo=timezone.utc)


def winner_from_score(home_score, away_score):
    if home_score > away_score:
        return "home"
    if away_score > home_score:
        return "away"
    return "draw"


def group_label(game):
    if game.get("group"):
        return game.get("group")
    return GROUP_FIXES.get((game.get("home"), game.get("away"), game.get("date")))


def build_app(db_url):
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = db_url
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)
    return app


def load_json():
    with JSON_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_json(data):
    friends = set(data.get("friends", []))
    if OWNER not in friends:
        raise SystemExit(f'OWNER "{OWNER}" is not in the JSON friends list.')

    seen_ids = set()
    warnings = []

    for game in data.get("games", []):
        gid = game.get("id")

        if gid in seen_ids:
            raise SystemExit(f"Duplicate game id in JSON: {gid}")
        seen_ids.add(gid)

        for field in ("stage", "home", "away", "date"):
            if not game.get(field):
                raise SystemExit(f"Game {gid} is missing required field: {field}")

        result = game.get("result")
        if result is not None and (
            "home_score" not in result or "away_score" not in result
        ):
            raise SystemExit(f"Game {gid} has incomplete result.")

        for player, pred in game.get("predictions", {}).items():
            if player not in friends:
                raise SystemExit(f"Game {gid} has prediction for unknown player: {player}")

            for field in ("winner", "home_score", "away_score"):
                if field not in pred:
                    raise SystemExit(f"Game {gid}, {player} missing {field}")

            implied = winner_from_score(pred["home_score"], pred["away_score"])
            if pred["winner"] != implied:
                warnings.append(
                    f"Game {gid}, {player}: winner={pred['winner']} but score implies {implied}"
                )

    return warnings


def seed(force=False):
    data = load_json()
    warnings = validate_json(data)

    if force:
        print("Force mode: dropping and recreating app tables...")
        db.drop_all()
        db.create_all()
    else:
        db.create_all()

    if Competition.query.filter_by(slug=COMP_SLUG).first():
        raise SystemExit(
            f"Competition '{COMP_SLUG}' already seeded — aborting to avoid duplicates.\n"
            "Use --force while testing to drop/recreate the app tables and reseed."
        )

    friends = data["friends"]
    scoring = data.get("scoring", {"correct_winner": 1, "exact_score_bonus": 2})
    dates = [g["date"] for g in data["games"] if g.get("date")]

    comp = Competition(
        name=COMP_NAME,
        sport="soccer",
        slug=COMP_SLUG,
        starts_on=datetime.strptime(min(dates), "%Y-%m-%d").date(),
        ends_on=datetime.strptime(max(dates), "%Y-%m-%d").date(),
        external_ref="json:worldcup",
    )
    db.session.add(comp)
    db.session.flush()

    users = {}
    credentials = []

    for name in friends:
        password = PASSWORDS.get(name, DEFAULT_PASSWORD)
        user = User(
            name=name,
            email=None,
            is_site_admin=(name == OWNER),
            must_change_password=False,
        )
        user.set_password(password)
        db.session.add(user)
        users[name] = user
        credentials.append((name, password))

    db.session.flush()

    pool = Pool(
        name=POOL_NAME,
        slug=POOL_SLUG,
        competition_id=comp.id,
        owner_id=users[OWNER].id,
        score_correct_winner=scoring["correct_winner"],
        score_exact_bonus=scoring["exact_score_bonus"],
        invite_code=secrets.token_urlsafe(8),
    )
    db.session.add(pool)
    db.session.flush()

    for name, user in users.items():
        db.session.add(
            PoolMember(
                pool_id=pool.id,
                user_id=user.id,
                role=("owner" if name == OWNER else "member"),
            )
        )

    n_games = n_results = n_predictions = 0

    for item in data["games"]:
        result = item.get("result")

        game = Game(
            competition_id=comp.id,
            stage=item["stage"],
            group_label=group_label(item),
            home=item["home"],
            away=item["away"],
            kickoff_at=kickoff(item["date"]),
            home_score=(result["home_score"] if result else None),
            away_score=(result["away_score"] if result else None),
            status=("final" if result else "scheduled"),
            external_ref=f"json:{item['id']}",
        )
        db.session.add(game)
        db.session.flush()

        n_games += 1
        if result:
            n_results += 1

        for player_name, pred in item.get("predictions", {}).items():
            user = users.get(player_name)
            if user is None:
                continue

            db.session.add(
                Prediction(
                    pool_id=pool.id,
                    user_id=user.id,
                    game_id=game.id,
                    winner=pred["winner"],
                    home_score=pred["home_score"],
                    away_score=pred["away_score"],
                )
            )
            n_predictions += 1

    db.session.commit()

    print()
    print("Seed complete.")
    print(f"  Competition: {COMP_NAME} ({COMP_SLUG})")
    print(f"  Pool:        {POOL_NAME} ({POOL_SLUG})")
    print(f"  Users:       {len(users)}")
    print(f"  Games:       {n_games}")
    print(f"  Results:     {n_results}")
    print(f"  Predictions: {n_predictions}")
    print()

    if warnings:
        print("Warnings:")
        for warning in warnings:
            print(f"  - {warning}")
        print()

    print(f"Everyone logs in with their name + password '{DEFAULT_PASSWORD}'")
    print("Users: " + ", ".join(name for name, _ in credentials))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--force",
        action="store_true",
        help="Drop/recreate app tables before seeding. Use only during setup/testing.",
    )
    parser.add_argument(
        "--sqlite-dev",
        action="store_true",
        help="Use repo-root wc_dev.db if DATABASE_URL is not set.",
    )
    args = parser.parse_args()

    db_url = get_db_url(sqlite_dev=args.sqlite_dev)

    print("Using database:", safe_db_url(db_url))
    print("Using JSON:", JSON_PATH)

    if not JSON_PATH.exists():
        raise SystemExit(f"JSON file not found: {JSON_PATH}")

    app = build_app(db_url)
    with app.app_context():
        seed(force=args.force)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        db.session.rollback()
        raise
