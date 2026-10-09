from datetime import datetime, timedelta, timezone

from app.simulator import _latest_per_interval


def test_series_keeps_the_latest_reading_of_each_interval() -> None:
    start = datetime(2026, 9, 23, 0, 0, tzinfo=timezone.utc)
    ticks = [{"observed_at": (start + timedelta(seconds=2 * i)).isoformat(), "value": float(i)} for i in range(1800)]
    thinned = _latest_per_interval(ticks, 10)
    # One hour of 2-second ticks becomes six 10-minute points.
    assert len(thinned) == 6
    # Each point is the last tick of its interval, so the newest reading is always kept.
    assert thinned[-1] is ticks[-1]
    assert [p["observed_at"] for p in thinned] == sorted(p["observed_at"] for p in thinned)


def test_short_series_are_returned_unchanged() -> None:
    one = [{"observed_at": "2026-09-23T00:00:00+00:00", "value": 1.0}]
    assert _latest_per_interval(one, 10) == one
