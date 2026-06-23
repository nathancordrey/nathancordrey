"""Helpers for pool-aware prediction routes."""

from flask import abort
from flask_login import current_user

from predictions.models import Pool, PoolMember


def default_pool():
    """Return the first pool.

    This preserves the current single-pool behavior while routes move to
    /pools/<pool_slug>/...
    """
    return Pool.query.order_by(Pool.id.asc()).first()


def get_pool_or_404(pool_slug):
    return Pool.query.filter_by(slug=pool_slug).first_or_404()


def membership_for(pool, user=None):
    user = user or current_user

    if not getattr(user, "is_authenticated", False):
        return None

    return PoolMember.query.filter_by(pool_id=pool.id, user_id=user.id).first()


def user_can_use_pool(pool, user=None):
    """Whether a user can enter picks for a pool."""
    user = user or current_user

    if not getattr(user, "is_authenticated", False):
        return False

    if user.is_site_admin:
        return True

    return membership_for(pool, user) is not None


def user_can_view_pool(pool, user=None):
    """Whether a user may view a pool dashboard.

    Public pools are visible to anyone with the link.
    Private pools are visible only to members and site admins.
    """
    user = user or current_user

    if pool.is_public:
        return True

    if not getattr(user, "is_authenticated", False):
        return False

    if user.is_site_admin:
        return True

    return membership_for(pool, user) is not None


def user_can_admin_pool(pool, user=None):
    """Whether a user can administer a pool.

    Site admins can administer everything. Pool owners/admins can administer
    their own pools.
    """
    user = user or current_user

    if not getattr(user, "is_authenticated", False):
        return False

    if user.is_site_admin:
        return True

    membership = membership_for(pool, user)
    return bool(membership and membership.role in {"owner", "admin"})


def require_pool_user(pool):
    if not user_can_use_pool(pool):
        abort(403)


def require_pool_admin(pool):
    if not user_can_admin_pool(pool):
        abort(403)


def primary_pool_for_user(user=None):
    """Best pool to use for legacy redirects such as /predictions/picks."""
    user = user or current_user

    if getattr(user, "is_authenticated", False) and user.memberships:
        return sorted(user.memberships, key=lambda m: m.joined_at)[0].pool

    if getattr(user, "is_authenticated", False) and user.is_site_admin:
        return default_pool()

    return None
