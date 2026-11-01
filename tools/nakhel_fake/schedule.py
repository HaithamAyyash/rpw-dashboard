"""The node wake-up schedule: 12 wake-ups per day, in the organization's local time."""
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

# Night 22:00-06:00 hourly, day 06:00-22:00 every 4 h.
WAKE_HOURS = (0, 1, 2, 3, 4, 5, 6, 10, 14, 18, 22, 23)
SLOT_SECONDS = 0.9


def wake_times(start, end, tz_name):
    """Every wake-up in [start, end), as UTC datetimes, for local time zone tz_name."""
    tz = ZoneInfo(tz_name)
    local_day = start.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    times = []
    while local_day < end:
        for hour in WAKE_HOURS:
            wake = local_day.replace(hour=hour).astimezone(timezone.utc)
            if start <= wake < end:
                times.append(wake)
        local_day += timedelta(days=1)
    return times


def slot_offset_seconds(slot_index):
    """A node's TDMA offset after a wake-up. Wraps at one hour; see DECISIONS.md (TDMA capacity)."""
    return (slot_index * SLOT_SECONDS) % 3600
