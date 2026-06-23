"""Database models for the predictions app.

Design summary:
  - Users can belong to one or more Pools.
  - A Pool is a friend prediction league for one Competition.
  - Games/results are global per Competition and shared by every Pool.
  - Predictions are scoped to a Pool, User, and Game.

Stack: Flask-SQLAlchemy + Flask-Login + Postgres.
This file is still compatible with SQLite for local testing.
"""

from datetime import datetime, timezone

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash


db = SQLAlchemy()


# ───────────────────────── Time helpers ─────────────────────────

def _now():
    """Timezone-aware UTC timestamp for model defaults."""
    return datetime.now(timezone.utc)


def _as_utc(dt):
    """Return a datetime that can safely be compared with aware UTC datetimes.

    PostgreSQL normally returns timezone-aware values for DateTime(timezone=True),
    while SQLite often returns naive values during local testing. Treat naive
    values as UTC so Game.locked works in both environments.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ───────────────────────── Users ─────────────────────────

class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)

    # For the first friend-group version, name is the login identifier.
    # Later, email can become required and name/display_name can become purely
    # cosmetic. The auth route already performs a case-insensitive lookup.
    name = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)

    # Global site/admin permissions, distinct from per-pool roles.
    is_site_admin = db.Column(db.Boolean, nullable=False, default=False)

    # Admin-created accounts should change their temporary password on login.
    must_change_password = db.Column(db.Boolean, nullable=False, default=True)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )

    memberships = db.relationship(
        "PoolMember",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    predictions = db.relationship(
        "Prediction",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    owned_pools = db.relationship(
        "Pool",
        back_populates="owner",
        foreign_keys="Pool.owner_id",
    )

    def set_password(self, raw):
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw):
        return check_password_hash(self.password_hash, raw)

    def __repr__(self):
        return f"<User {self.name!r}>"


# ───────────────────── Competitions & Games (global) ─────────────────────

class Competition(db.Model):
    """A real-world tournament/season, e.g. 'World Cup 2026'."""

    __tablename__ = "competitions"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    sport = db.Column(db.String(40), nullable=False, default="soccer")
    slug = db.Column(db.String(80), unique=True, nullable=False, index=True)

    starts_on = db.Column(db.Date)
    ends_on = db.Column(db.Date)

    # Provider/catalog reference. For the JSON migration this can be
    # "json:worldcup". Later it could be a sports-data provider competition id.
    external_ref = db.Column(db.String(120), index=True)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )

    games = db.relationship(
        "Game",
        back_populates="competition",
        cascade="all, delete-orphan",
        order_by="Game.kickoff_at",
    )
    pools = db.relationship(
        "Pool",
        back_populates="competition",
        cascade="all, delete-orphan",
    )

    def __repr__(self):
        return f"<Competition {self.slug!r}>"


class Game(db.Model):
    """One real fixture. Results are shared across all pools."""

    __tablename__ = "games"
    __table_args__ = (
        db.CheckConstraint(
            "home_score IS NULL OR home_score >= 0",
            name="ck_games_home_score_nonnegative",
        ),
        db.CheckConstraint(
            "away_score IS NULL OR away_score >= 0",
            name="ck_games_away_score_nonnegative",
        ),
        db.CheckConstraint(
            "status IN ('scheduled', 'live', 'final', 'postponed', 'cancelled')",
            name="ck_games_status_valid",
        ),
        db.UniqueConstraint(
            "competition_id",
            "external_ref",
            name="uq_games_competition_external_ref",
        ),
        db.Index("ix_games_competition_kickoff", "competition_id", "kickoff_at"),
    )

    id = db.Column(db.Integer, primary_key=True)

    competition_id = db.Column(
        db.Integer,
        db.ForeignKey("competitions.id"),
        nullable=False,
        index=True,
    )

    stage = db.Column(db.String(60), nullable=False)
    group_label = db.Column(db.String(8))
    home = db.Column(db.String(80), nullable=False)
    away = db.Column(db.String(80), nullable=False)

    # Single source of truth for pick locking. Store in UTC.
    kickoff_at = db.Column(db.DateTime(timezone=True), nullable=False, index=True)

    home_score = db.Column(db.Integer)
    away_score = db.Column(db.Integer)
    status = db.Column(db.String(16), nullable=False, default="scheduled", index=True)

    # For migration/debugging: seed_from_json.py stores original ids as
    # external_ref="json:<id>".
    external_ref = db.Column(db.String(120), index=True)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )

    competition = db.relationship("Competition", back_populates="games")
    predictions = db.relationship(
        "Prediction",
        back_populates="game",
        cascade="all, delete-orphan",
    )

    @property
    def is_final(self):
        return self.home_score is not None and self.away_score is not None

    @property
    def actual_winner(self):
        if not self.is_final:
            return None
        if self.home_score > self.away_score:
            return "home"
        if self.home_score < self.away_score:
            return "away"
        return "draw"

    @property
    def locked(self):
        """True once no more predictions should be accepted."""
        return _now() >= _as_utc(self.kickoff_at)

    @property
    def has_kicked_off(self):
        return self.locked

    def __repr__(self):
        return f"<Game {self.home} v {self.away}>"


# ───────────────────────── Pools (friend prediction leagues) ─────────────────────────

class Pool(db.Model):
    __tablename__ = "pools"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    slug = db.Column(db.String(80), unique=True, nullable=False, index=True)

    competition_id = db.Column(
        db.Integer,
        db.ForeignKey("competitions.id"),
        nullable=False,
        index=True,
    )
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)

    # Per-pool scoring rules.
    score_correct_winner = db.Column(db.Integer, nullable=False, default=1)
    score_exact_bonus = db.Column(db.Integer, nullable=False, default=2)

    # Anyone with the invite code/link can join, once join routes exist.
    invite_code = db.Column(db.String(40), unique=True, index=True)
    is_public = db.Column(db.Boolean, nullable=False, default=False)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )

    competition = db.relationship("Competition", back_populates="pools")
    owner = db.relationship(
        "User",
        back_populates="owned_pools",
        foreign_keys=[owner_id],
    )
    members = db.relationship(
        "PoolMember",
        back_populates="pool",
        cascade="all, delete-orphan",
    )
    predictions = db.relationship(
        "Prediction",
        back_populates="pool",
        cascade="all, delete-orphan",
    )

    def __repr__(self):
        return f"<Pool {self.slug!r}>"


class PoolMember(db.Model):
    """Join table: which users belong to which pools, and their role there."""

    __tablename__ = "pool_members"
    __table_args__ = (
        db.UniqueConstraint("pool_id", "user_id", name="uq_pool_member"),
        db.CheckConstraint(
            "role IN ('owner', 'admin', 'member')",
            name="ck_pool_members_role_valid",
        ),
        db.Index("ix_pool_members_user_pool", "user_id", "pool_id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    pool_id = db.Column(
        db.Integer,
        db.ForeignKey("pools.id"),
        nullable=False,
        index=True,
    )
    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    role = db.Column(db.String(16), nullable=False, default="member")
    joined_at = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)

    pool = db.relationship("Pool", back_populates="members")
    user = db.relationship("User", back_populates="memberships")

    def __repr__(self):
        return f"<PoolMember pool={self.pool_id} user={self.user_id}>"


# ───────────────────────── Predictions (per pool) ─────────────────────────

class Prediction(db.Model):
    __tablename__ = "predictions"
    __table_args__ = (
        # One pick per user, per game, per pool.
        db.UniqueConstraint("pool_id", "user_id", "game_id", name="uq_one_pick"),
        db.CheckConstraint(
            "winner IN ('home', 'away', 'draw')",
            name="ck_predictions_winner_valid",
        ),
        db.CheckConstraint(
            "home_score >= 0",
            name="ck_predictions_home_score_nonnegative",
        ),
        db.CheckConstraint(
            "away_score >= 0",
            name="ck_predictions_away_score_nonnegative",
        ),
        db.Index("ix_predictions_pool_game", "pool_id", "game_id"),
        db.Index("ix_predictions_user_pool", "user_id", "pool_id"),
    )

    id = db.Column(db.Integer, primary_key=True)

    pool_id = db.Column(
        db.Integer,
        db.ForeignKey("pools.id"),
        nullable=False,
        index=True,
    )
    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    game_id = db.Column(
        db.Integer,
        db.ForeignKey("games.id"),
        nullable=False,
        index=True,
    )

    winner = db.Column(db.String(4), nullable=False)
    home_score = db.Column(db.Integer, nullable=False)
    away_score = db.Column(db.Integer, nullable=False)

    # User-controlled privacy before kickoff:
    #   false = show "Submitted" only before kickoff
    #   true  = reveal this user's score pick early
    # At kickoff, all submitted picks reveal automatically regardless.
    show_before_kickoff = db.Column(db.Boolean, nullable=False, default=False)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )

    pool = db.relationship("Pool", back_populates="predictions")
    user = db.relationship("User", back_populates="predictions")
    game = db.relationship("Game", back_populates="predictions")

    @property
    def score_winner(self):
        if self.home_score > self.away_score:
            return "home"
        if self.home_score < self.away_score:
            return "away"
        return "draw"

    def __repr__(self):
        return f"<Prediction user={self.user_id} game={self.game_id}>"


# ───────────────────────── Scoring ─────────────────────────

def score_prediction(pred, game, pool):
    """Return (points, winner_correct, exact_score) for one prediction.

    This mirrors the JSON-era scoring:
      - 0 if the game is not final or the result winner is wrong
      - score_correct_winner for correct result/winner/draw
      - plus score_exact_bonus for exact scoreline
    """
    if pred is None or game is None or pool is None:
        return 0, False, False

    if not game.is_final or pred.winner != game.actual_winner:
        return 0, False, False

    points = pool.score_correct_winner
    exact = (
        pred.home_score == game.home_score
        and pred.away_score == game.away_score
    )

    if exact:
        points += pool.score_exact_bonus

    return points, True, exact


def pool_leaderboard(pool):
    """Aggregate standings for one pool.

    Returns a list of dicts sorted by total points, then exact scores, then
    correct winners. This intentionally stays simple; richer matchday/daily
    views can be built in a separate view-model helper.
    """
    totals = {}

    for membership in pool.members:
        totals[membership.user_id] = {
            "user": membership.user,
            "role": membership.role,
            "total": 0,
            "winners": 0,
            "exact": 0,
        }

    games_by_id = {game.id: game for game in pool.competition.games}

    for pred in pool.predictions:
        row = totals.get(pred.user_id)
        if row is None:
            continue

        game = games_by_id.get(pred.game_id)
        pts, winner_ok, exact = score_prediction(pred, game, pool)

        row["total"] += pts
        row["winners"] += int(winner_ok)
        row["exact"] += int(exact)

    return sorted(
        totals.values(),
        key=lambda row: (row["total"], row["exact"], row["winners"]),
        reverse=True,
    )
