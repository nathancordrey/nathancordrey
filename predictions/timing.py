"""Single source of truth for match timing.

Every surface (picks page, dashboard/standings, admin) imports from here so the
rules can't drift apart. A game moves through these moments:

  released   -> visible and pickable. The whole day's slate opens at
                PICK_AHEAD_HOUR Eastern the day before (default 3pm ET).
  kicked off -> picks lock, all picks reveal, and the standings' active
                matchday rolls to this game's stage.
  final      -> an admin has entered the result; it scores.

Release opens a slate early; the active matchday only advances once a round
actually kicks off. Those are deliberately different triggers: you can see and
pick tomorrow's games this afternoon, but the table keeps ranking by the round
that's live, not an all-zero column for a round nobody has played yet.

No schema is involved -- everything here is derived from kickoff_at. If you ever
need to hand-tune a single oddball game, add an optional opens_at override
column later and special-case it in is_released().
"""
import datetime as dt
import os
from zoneinfo import ZoneInfo

APP_TZ = ZoneInfo("America/New_York")

# Next day's slate opens at this Eastern hour the day before. 15 = 3pm ET.
# Overridable with the WC_PICK_AHEAD_HOUR environment variable.
PICK_AHEAD_HOUR = int(os.environ.get("WC_PICK_AHEAD_HOUR", "15"))

# Stage ordering (earliest -> latest) and short labels for the standings.
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


def now():
    """Timezone-aware current time, in UTC."""
    return dt.datetime.now(dt.timezone.utc)


def as_utc(value):
    """Return value as a tz-aware UTC datetime.

    PostgreSQL preserves tzinfo; SQLite may hand back naive datetimes in local
    testing. kickoff_at is stored as UTC by convention, so naive values are
    treated as UTC.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def as_app_tz(value):
    """Return value in the app's Eastern timezone."""
    return as_utc(value).astimezone(APP_TZ)


def et_date(game):
    """ET calendar date (ISO string) of a game's kickoff."""
    return as_app_tz(game.kickoff_at).date().isoformat()


def release_date(at=None):
    """The latest ET date currently released for viewing/picking.

    A slate opens at PICK_AHEAD_HOUR ET the day before, so once it's past that
    hour we also include tomorrow's date. Pass `at` (any tz-aware datetime) to
    evaluate the rule at a specific moment, e.g. for tests.
    """
    local = as_utc(at).astimezone(APP_TZ) if at is not None else dt.datetime.now(APP_TZ)
    d = local.date()
    if local.hour >= PICK_AHEAD_HOUR:
        d = d + dt.timedelta(days=1)
    return d


def has_kicked_off(game, at=None):
    """Whether the game's kickoff time has passed (i.e. it's locked)."""
    moment = as_utc(at) if at is not None else now()
    return as_utc(game.kickoff_at) <= moment


def is_released(game, at=None):
    """Whether a game's slate has opened (visible on picks page + dashboard)."""
    return as_app_tz(game.kickoff_at).date() <= release_date(at)


def is_pickable(game, at=None):
    """Whether a user may still save/edit a pick: released but not kicked off."""
    return is_released(game, at) and not has_kicked_off(game, at)


def started_stages_ordered(games, at=None):
    """Stages that have kicked off, in tournament order (earliest -> latest).

    The last entry is the active matchday; everything before it is settled.
    Released-but-not-started stages are excluded, so opening tomorrow's slate
    for picks does NOT advance the active matchday -- only a real kickoff does.
    """
    started = {g.stage for g in games if has_kicked_off(g, at)}
    ordered = [s for s in STAGE_ORDER if s in started]
    ordered += sorted(started - set(STAGE_ORDER))
    return ordered


def active_matchday(games, at=None):
    """The stage the standings rank by: the most advanced one that's kicked off."""
    ordered = started_stages_ordered(games, at)
    return ordered[-1] if ordered else None
