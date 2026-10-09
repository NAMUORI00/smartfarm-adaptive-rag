from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from .contracts import DerivedIndicators, SensorMetric, SensorReading


KST = timezone(timedelta(hours=9), name="KST")


def derived_indicators(
    readings: list[SensorReading],
    observed_at: datetime,
    *,
    exposure_minutes: float,
    zone_id: str = "zone-a",
) -> DerivedIndicators:
    values = {
        item.metric: item.value
        for item in readings
        if item.zone_id == zone_id and item.quality.value not in {"bad", "missing", "stale"}
    }
    air_temperature = values.get(SensorMetric.AIR_TEMPERATURE, 0.0)
    relative_humidity = min(100.0, max(0.0, values.get(SensorMetric.RELATIVE_HUMIDITY, 100.0)))
    saturation_vapor_pressure = 0.6108 * math.exp(
        17.27 * air_temperature / (air_temperature + 237.3)
    )
    vpd = max(0.0, saturation_vapor_pressure * (1.0 - relative_humidity / 100.0))

    local = observed_at.astimezone(KST)
    daylight_elapsed_hours = min(12.0, max(0.0, local.hour + local.minute / 60.0 - 6.0))
    ppfd = max(0.0, values.get(SensorMetric.PPFD, 0.0))
    dli = ppfd * daylight_elapsed_hours * 3_600 / 1_000_000

    supply_ec = values.get(SensorMetric.SUPPLY_EC, 0.0)
    drain_ec = values.get(SensorMetric.DRAIN_EC, supply_ec)
    root_temperature = values.get(SensorMetric.ROOT_ZONE_TEMPERATURE, 18.0)
    root_heat_exposure = max(0.0, root_temperature - 18.0) * max(0.0, exposure_minutes)

    return DerivedIndicators(
        zone_id=zone_id,
        vpd_kpa=round(vpd, 3),
        dli_mol_m2_day=round(dli, 3),
        ec_delta_ds_m=round(drain_ec - supply_ec, 3),
        root_heat_exposure_degree_minutes=round(root_heat_exposure, 2),
    )
