"""When to raise an alert. Pure functions, so every rule is easy to test. See DECISIONS.md."""
from datetime import timedelta
from typing import NamedTuple, Optional

from .status import ALERT, RANK, SUSPECTED

INFESTATION_TYPES = {
    ALERT: ('infestation_detected', 'critical'),
    SUSPECTED: ('infestation_suspected', 'warning'),
}
SYSTEM_SEVERITY = {
    'node_offline': 'warning',
    'low_battery': 'warning',
    'cluster_offline': 'critical',
    'sd_low': 'warning',
}
# Others appear in the dashboard only, so a farm with a few flat batteries isn't flooded with email.
EMAIL_TYPES = ('infestation_detected', 'infestation_suspected', 'cluster_offline')


class LastAlert(NamedTuple):
    created_at: object
    acknowledged: bool


def should_raise_infestation(previous_band, current_band, last: Optional[LastAlert], now, cooldown_hours):
    """last is the most recent alert of this band's type for this tree."""
    if current_band not in INFESTATION_TYPES:
        return False
    rising = RANK[current_band] > RANK[previous_band]
    if RANK[current_band] < RANK[previous_band]:
        return False  # improving, e.g. alert down to suspected
    if last is None:
        return True  # never told, e.g. an owner just lowered the threshold
    within_cooldown = now - last.created_at < timedelta(hours=cooldown_hours)
    if not last.acknowledged and within_cooldown:
        return False  # the cooldown: one tree doesn't email every hour
    if rising:
        return True  # a fresh crossing
    # Still in the same band: remind about an ignored alert, but not about one already handled.
    return not last.acknowledged


def should_raise_system(last: Optional[LastAlert], now, cooldown_hours, acknowledged_quiet_days):
    """The condition holds right now. An unacknowledged alert repeats daily; an acknowledged one
    stays quiet longer, since these have no 'crossing' to detect (a battery stays low)."""
    if last is None:
        return True
    quiet = timedelta(days=acknowledged_quiet_days) if last.acknowledged else timedelta(hours=cooldown_hours)
    return now - last.created_at >= quiet
