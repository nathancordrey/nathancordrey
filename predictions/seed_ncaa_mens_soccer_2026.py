"""Idempotent seed for 2026 NCAA Division I men's soccer round one.

Run after applying sql/003_ncaa_tiebreak_winner.sql:
    python -m predictions.seed_ncaa_mens_soccer_2026

Uses the production DATABASE_URL just like predictions.seed_from_json.
Does not change existing competitions, pools, users, predictions, or results.
"""
import argparse
import secrets
from datetime import date, datetime
from zoneinfo import ZoneInfo

from predictions.models import Competition, Game, Pool, PoolMember, User, db
from predictions.seed_from_json import build_app, get_db_url, safe_db_url

COMP_SLUG = "ncaa-mens-soccer-2026"
POOL_SLUG = "ncaa-soccer-2026"
ET = ZoneInfo("America/New_York")

# Thursday Nov. 19; all time values are Eastern, based on the published slate.
# Verify any late kickoff changes with the host schools before match day.
FIRST_ROUND = [
    ("Charlotte", "Lehigh", "18:00"),
    ("NC State", "College of Charleston", "18:00"),
    ("Syracuse", "Sacred Heart", "18:00"),
    ("UNC Wilmington", "Liberty", "18:00"),
    ("Wake Forest", "Longwood", "18:00"),
    ("Bryant", "Houston Christian", "19:00"),
    ("Vermont", "North Florida", "19:00"),
    ("Cornell", "FDU", "19:00"),
    ("Marshall", "Bowling Green", "19:15"),
    ("Creighton", "Omaha", "19:30"),
    ("Missouri State", "Saint Louis", "19:30"),
    ("Oregon State", "Cal State Bakersfield", "21:00"),
    ("Stanford", "Tulsa", "21:00"),
    ("Portland", "California", "22:00"),
    ("Washington", "Cleveland State", "22:00"),
    ("San Diego", "Grand Canyon", "22:00"),
]


def seed(owner_name="Nate"):
    owner = User.query.filter(db.func.lower(User.name) == owner_name.lower()).first()
    if owner is None:
        raise SystemExit(f"No existing account called {owner_name!r}. Use --owner.")

    comp = Competition.query.filter_by(slug=COMP_SLUG).first()
    if comp is None:
        comp = Competition(
            name="2026 NCAA Division I Men's Soccer Championship",
            slug=COMP_SLUG,
            sport="soccer",
            starts_on=date(2026, 11, 19),
            ends_on=date(2026, 12, 14),
            external_ref="ncaa:di:mens-soccer:2026",
        )
        db.session.add(comp)
        db.session.flush()

    created = 0
    for idx, (home, away, kickoff_et) in enumerate(FIRST_ROUND, start=1):
        ref = f"ncaa:2026:men:r1:{idx:02d}"
        match = Game.query.filter_by(competition_id=comp.id, external_ref=ref).first()
        if match is not None:
            if (match.home, match.away) != (home, away):
                raise SystemExit(f"Fixture conflict for {ref}; refusing to overwrite.")
            continue
        clock = datetime.strptime(kickoff_et, "%H:%M")
        kick = datetime(2026, 11, 19, clock.hour, clock.minute, tzinfo=ET)
        db.session.add(Game(
            competition_id=comp.id,
            stage="First Round",
            home=home,
            away=away,
            kickoff_at=kick,
            status="scheduled",
            external_ref=ref,
        ))
        created += 1

    pool = Pool.query.filter_by(slug=POOL_SLUG).first()
    if pool is None:
        pool = Pool(
            name="NCAA Soccer 2026",
            slug=POOL_SLUG,
            competition_id=comp.id,
            owner_id=owner.id,
            is_public=False,
            invite_code=secrets.token_urlsafe(12),
            score_correct_winner=1,
            score_exact_bonus=2,
        )
        db.session.add(pool)
        db.session.flush()
    elif pool.competition_id != comp.id:
        raise SystemExit("This pool slug belongs to another competition.")

    member = PoolMember.query.filter_by(pool_id=pool.id, user_id=owner.id).first()
    if member is None:
        db.session.add(PoolMember(pool_id=pool.id, user_id=owner.id, role="owner"))

    db.session.commit()
    print(f"Competition: {comp.name}")
    print(f"First-round fixtures: {len(FIRST_ROUND)} ({created} newly added)")
    print(f"Private pool: /predictions/pools/{pool.slug}")
    print("Copy the invite link in /predictions/my-pools.")
    print("After each knockout round, add only verified future opponents and kickoffs.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", default="Nate")
    parser.add_argument("--sqlite-dev", action="store_true", help="Explicit SQLite test only")
    args = parser.parse_args()
    url = get_db_url(sqlite_dev=args.sqlite_dev)
    print("Using database:", safe_db_url(url))
    app = build_app(url)
    with app.app_context():
        try:
            seed(args.owner)
        except Exception:
            db.session.rollback()
            raise


if __name__ == "__main__":
    main()
