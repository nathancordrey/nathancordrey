#!/usr/bin/env python3
"""Update seeded World Cup games with real kickoff_at values.

Location:
    predictions/update_kickoffs.py

Run from repo root:
    DATABASE_URL="postgresql+psycopg2://worldcup_user:wcpass2026@127.0.0.1:5432/worldcup_db" \
    python -m predictions.update_kickoffs

Notes:
  - Times below are Eastern Time unless otherwise noted.
  - The script matches by the old JSON id stored in Game.external_ref as "json:<id>".
  - It only updates kickoff_at.
  - It does not change results, predictions, or game dates.
"""

import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask

from predictions.models import db, Game

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
APP_TZ = ZoneInfo("America/New_York")


# JSON game id -> local Eastern kickoff time.
# Format is YYYY-MM-DD HH:MM in America/New_York.
KICKOFFS_ET = {
    1:  "2026-06-11 22:00",
    2:  "2026-06-12 15:00",
    3:  "2026-06-12 21:00",
    4:  "2026-06-13 15:00",
    5:  "2026-06-13 18:00",
    6:  "2026-06-13 21:00",
    7:  "2026-06-15 12:00",
    8:  "2026-06-15 15:00",
    9:  "2026-06-15 18:00",
    10: "2026-06-16 15:00",
    11: "2026-06-16 18:00",
    12: "2026-06-16 21:00",
    13: "2026-06-17 13:00",
    14: "2026-06-17 16:00",
    15: "2026-06-17 19:00",
    16: "2026-06-18 12:00",
    17: "2026-06-18 15:00",
    18: "2026-06-18 18:00",
    19: "2026-06-18 21:00",
    20: "2026-06-19 15:00",
    21: "2026-06-19 18:00",
    22: "2026-06-19 20:30",
    23: "2026-06-19 23:00",
    24: "2026-06-20 13:00",
    25: "2026-06-20 16:00",
    26: "2026-06-20 20:00",
    # This match is just after midnight Eastern; the old JSON date may say 2026-06-20.
    27: "2026-06-21 00:00",
    28: "2026-06-21 12:00",
    29: "2026-06-21 15:00",
    30: "2026-06-21 18:00",
    31: "2026-06-21 21:00",
    32: "2026-06-22 13:00",
    33: "2026-06-22 17:00",
    34: "2026-06-22 20:00",
    35: "2026-06-22 23:00",
    36: "2026-06-23 13:00",
    37: "2026-06-23 22:00",
    38: "2026-06-23 16:00",
    39: "2026-06-23 19:00",
    40: "2026-06-24 21:00",
    41: "2026-06-24 21:00",
    42: "2026-06-24 15:00",
    43: "2026-06-24 15:00",
    44: "2026-06-24 18:00",
    45: "2026-06-24 18:00",
    46: "2026-06-25 22:00",
    47: "2026-06-25 22:00",
    48: "2026-06-25 16:00",
    49: "2026-06-25 16:00",
    50: "2026-06-25 19:00",
    51: "2026-06-25 19:00",
    52: "2026-06-26 23:00",
    53: "2026-06-26 23:00",
    54: "2026-06-26 20:00",
    55: "2026-06-26 20:00",
    56: "2026-06-26 15:00",
    57: "2026-06-26 15:00",
    58: "2026-06-27 22:00",
    59: "2026-06-27 22:00",
    60: "2026-06-27 19:30",
    61: "2026-06-27 19:30",
    62: "2026-06-27 17:00",
    63: "2026-06-27 17:00",
}


def normalize_db_url(url):
    if not url:
        raise SystemExit("DATABASE_URL is not set.")
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url[len("postgres://"):]
    if url.startswith("postgresql://") and "+psycopg2" not in url:
        return "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


def build_app():
    if load_dotenv is not None:
        load_dotenv(REPO_ROOT / ".env")
        load_dotenv(HERE / ".env")

    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = normalize_db_url(os.environ.get("DATABASE_URL"))
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)
    return app


def parse_et(value):
    local = datetime.strptime(value, "%Y-%m-%d %H:%M").replace(tzinfo=APP_TZ)
    return local.astimezone(ZoneInfo("UTC"))


def main():
    app = build_app()

    with app.app_context():
        updated = 0
        missing = []

        for json_id, local_time in KICKOFFS_ET.items():
            game = Game.query.filter_by(external_ref=f"json:{json_id}").first()
            if game is None:
                missing.append(json_id)
                continue

            game.kickoff_at = parse_et(local_time)
            updated += 1

        db.session.commit()

        print(f"Updated kickoff_at for {updated} games.")
        if missing:
            print("Missing game ids:", ", ".join(str(x) for x in missing))


if __name__ == "__main__":
    main()
