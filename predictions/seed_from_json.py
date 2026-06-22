#!/usr/bin/env python3
"""Seed the relational DB from the existing worldcup.json.

This is the bridge from the JSON era to the Postgres era: it creates the
Competition, all Games (with results), the 10 users, the pool, and imports
EVERY existing prediction so the new system starts life identical to the old
one. Nothing is lost.

Runs anywhere SQLAlchemy can reach:
  - locally for testing:   python seed_from_json.py          (uses sqlite file)
  - on the server:         DATABASE_URL=postgresql+psycopg2://... python seed_from_json.py

SAFE: refuses to run if the competition already exists, so you can't double-seed.
"""
import os
import json
import secrets

from flask import Flask
from models import (db, User, Competition, Game, Pool, PoolMember, Prediction)
from datetime import datetime, timezone, time

HERE = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.environ.get('WC_JSON', os.path.join(HERE, 'worldcup.json'))
DB_URL = os.environ.get('DATABASE_URL', 'sqlite:///' + os.path.join(HERE, 'wc_dev.db'))

COMP_NAME = "World Cup 2026"
COMP_SLUG = "wc-2026"
POOL_NAME = "The Pool"
POOL_SLUG = "the-pool"
OWNER = "Nate"          # site admin + pool owner

# Password for every account, for now (a shared starter password — friends can
# change their own later via the change-password page). Override any individual
# one in PASSWORDS below if you want.
DEFAULT_PASSWORD = "worldcup2026"
PASSWORDS = {
    # "Nate": "something-personal",
}

# Placeholder kickoff time until real per-game times are loaded. Past games are
# already final so it doesn't affect them; for future games we'll set true
# kickoff_at before pick-locking goes live. Noon ET (= 16:00 UTC) as a default.
PLACEHOLDER_KICKOFF_UTC_HOUR = 16


def _kickoff(date_str):
    y, m, d = (int(x) for x in date_str.split('-'))
    return datetime(y, m, d, PLACEHOLDER_KICKOFF_UTC_HOUR, 0, tzinfo=timezone.utc)


def build_app():
    app = Flask(__name__)
    app.config['SQLALCHEMY_DATABASE_URI'] = DB_URL
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    db.init_app(app)
    return app


def seed():
    data = json.load(open(JSON_PATH))
    friends = data['friends']
    scoring = data.get('scoring', {'correct_winner': 1, 'exact_score_bonus': 2})

    if Competition.query.filter_by(slug=COMP_SLUG).first():
        raise SystemExit("Competition '%s' already seeded — aborting to avoid duplicates." % COMP_SLUG)

    dates = [g['date'] for g in data['games'] if g.get('date')]
    comp = Competition(name=COMP_NAME, sport="soccer", slug=COMP_SLUG,
                       starts_on=datetime.strptime(min(dates), '%Y-%m-%d').date(),
                       ends_on=datetime.strptime(max(dates), '%Y-%m-%d').date())
    db.session.add(comp)
    db.session.flush()

    # Users (login by name; shared starter password unless overridden).
    users, credentials = {}, []
    for name in friends:
        pw = PASSWORDS.get(name, DEFAULT_PASSWORD)
        u = User(name=name, is_site_admin=(name == OWNER),
                 must_change_password=False)
        u.set_password(pw)
        db.session.add(u)
        users[name] = u
        credentials.append((name, pw))
    db.session.flush()

    # Pool, owned by the site admin, scoring carried over from the JSON.
    pool = Pool(name=POOL_NAME, slug=POOL_SLUG, competition_id=comp.id,
                owner_id=users[OWNER].id,
                score_correct_winner=scoring['correct_winner'],
                score_exact_bonus=scoring['exact_score_bonus'],
                invite_code=secrets.token_urlsafe(8))
    db.session.add(pool)
    db.session.flush()
    for name, u in users.items():
        db.session.add(PoolMember(pool_id=pool.id, user_id=u.id,
                                  role=("owner" if name == OWNER else "member")))

    # Games + predictions.
    n_games = n_preds = 0
    for g in data['games']:
        res = g.get('result')
        game = Game(
            competition_id=comp.id,
            stage=g['stage'],
            group_label=g.get('group'),
            home=g['home'], away=g['away'],
            kickoff_at=_kickoff(g['date']),
            home_score=(res['home_score'] if res else None),
            away_score=(res['away_score'] if res else None),
            status=("final" if res else "scheduled"),
        )
        db.session.add(game)
        db.session.flush()
        n_games += 1
        for pname, p in g.get('predictions', {}).items():
            if pname not in users:
                continue
            db.session.add(Prediction(
                pool_id=pool.id, user_id=users[pname].id, game_id=game.id,
                winner=p['winner'], home_score=p['home_score'], away_score=p['away_score']))
            n_preds += 1

    db.session.commit()

    print("Seeded: 1 competition, %d games, %d users, 1 pool, %d predictions." % (
        n_games, len(users), n_preds))
    print("\nEveryone logs in with their name + password '%s'" % DEFAULT_PASSWORD)
    print("Users: " + ", ".join(name for name, _ in credentials))


if __name__ == '__main__':
    app = build_app()
    with app.app_context():
        db.create_all()
        seed()
