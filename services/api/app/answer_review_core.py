"""Shared structured-answer dependency and rendering rules; no I/O or device control."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

def state_values(
    snapshot, zone: str | None, conditions: bool = False, at: datetime | None = None
) -> dict[str, Any]:
    values = {}
    for m in snapshot.metrics:
        if zone and m.zone_id not in {None, zone}:
            continue
        stale = ((at or datetime.now(timezone.utc)) - m.observed_at).total_seconds() > 300
        values[f"metric:{m.zone_id}:{m.key}"] = [
            None
            if conditions and m.status == "normal" and m.quality == "good"
            else m.value,
            m.quality,
            m.status,
            stale,
        ]
    for d in snapshot.actuator_states:
        if not zone or d.zone_id in {None, zone}:
            values[f"device:{d.zone_id}:{d.key}"] = d.model_dump(
                mode="json", exclude={"feedback_at"}
            )
    values["alerts"] = [
        a.model_dump(mode="json")
        for a in snapshot.active_alerts
        if not zone or a.zone_id in {None, zone}
    ]
    values["control_allowed"] = snapshot.operational_control_allowed
    values["origin"] = snapshot.data_origin
    return values


def declare_review(snapshot, zone: str | None, intent: str, at: datetime | None = None) -> dict | None:
    if snapshot is None:
        return None
    conditions = intent == "live_status"
    values = state_values(snapshot, zone, conditions, at)
    # Dependencies precede answer generation. No generated text is inspected.
    # General cultivation knowledge does not depend on noisy current sensor values.
    keys = list(values) if conditions else ["origin"]
    return {
        "version": "sr-product-v1",
        "status": "current",
        "zone_id": zone,
        "comparison": "conditions" if conditions else "values",
        "baseline_revision": snapshot.state_revision,
        "baseline": values,
        "refresh_count": 0,
        "previous_response_id": None,
        "mode": "selective" if intent == "live_status" else "full",
        "units": [
            {"id": "state", "depends_on": keys},
            {"id": "action", "depends_on": keys},
            {
                "id": "evidence",
                "depends_on": [k for k in keys if k.startswith("metric:")],
            },
        ],
    }


def affected_units(review: dict, snapshot, at: datetime | None = None) -> list[str]:
    current = state_values(
        snapshot, review["zone_id"], review.get("comparison") == "conditions", at
    )
    before = review["baseline"]
    changed = {k for k in set(before) | set(current) if before.get(k) != current.get(k)}
    # New/unmapped observations require full review, never silently ignored.
    if changed - set(before):
        return [u["id"] for u in review["units"]]
    return [u["id"] for u in review["units"] if changed.intersection(u["depends_on"])]


def render_unit(unit_id: str, snapshot, zone: str | None, at: datetime | None = None) -> str:
    metrics = [m for m in snapshot.metrics if not zone or m.zone_id in {None, zone}]
    if unit_id == "state":
        if snapshot.data_origin != "telemetry_service":
            return "현재 관측 연결을 확인해야 합니다. 저장된 값만으로 지금 상태를 판단하지 않습니다."

        def uncertain(m):
            return (
                m.quality != "good"
                or ((at or datetime.now(timezone.utc)) - m.observed_at).total_seconds() > 300
            )

        flagged = [m for m in metrics if m.status != "normal" or uncertain(m)]
        if not metrics:
            return "최근 관측을 확인할 수 없습니다. 연결 상태를 확인하세요."
        if not flagged:
            return "현재 수신된 구역 관측은 기준 범위입니다. 자세한 수치는 관측값에서 확인할 수 있습니다."
        shown = flagged
        return " · ".join(
            f"{m.label} {m.value:g}{m.unit} ({'관측 확인 필요' if uncertain(m) else '점검 필요' if m.status != 'normal' else '기준 범위'})"
            for m in shown
        )
    if unit_id == "action":
        return "상태가 달라졌습니다. 필요한 조절을 다시 확인한 뒤 허용해 주세요."
    times = sorted({m.observed_at.isoformat() for m in metrics})
    return f"구역 공용 관측 {len(metrics)}개 기준입니다. 관측 시각: " + " · ".join(times)


def finish_initial(
    review: dict | None, answer: str, evidence, control_draft, snapshot=None, at: datetime | None = None
) -> dict | None:
    if review is None:
        return None
    for unit in review["units"]:
        unit["text"] = (
            answer
            if unit["id"] == "state"
            else (
                control_draft.rationale
                if control_draft
                else "직접 조절은 변경 내용을 확인한 뒤 허용할 수 있습니다."
            )
            if unit["id"] == "action"
            else "판단에 사용한 자료와 관측을 확인하세요."
        )
        if (
            review["mode"] == "selective"
            and snapshot is not None
            and unit["id"] in {"state", "evidence"}
        ):
            unit["text"] = render_unit(unit["id"], snapshot, review["zone_id"], at)
        unit["evidence_ids"] = [e.source_id for e in evidence]
    return review


