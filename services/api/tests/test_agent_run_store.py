from __future__ import annotations

import sqlite3

import pytest

from app.knowledge import KnowledgeStore


def _session(store: KnowledgeStore, *, farm_id: str = "farm-a", owner_id: str = "operator-a") -> dict:
    return store.create_advisor_session(farm_id, owner_id)


def test_agent_run_lifecycle_and_ordered_steps() -> None:
    store = KnowledgeStore(":memory:")
    session = _session(store)

    created = store.create_agent_run(
        session["id"],
        "farm-a",
        "operator-a",
        "환기 상태를 확인하고 60% 조정안을 준비해줘",
        run_id="advisor-run-fixed",
        current_target="ventilation_fan",
        current_action="set_ventilation_fan",
        current_value=60,
        context={"intent": "control_request"},
    )

    assert created is not None
    assert created["id"] == "advisor-run-fixed"
    assert created["status"] == "running"
    assert created["current_target"] == "ventilation_fan"
    assert created["current_value"] == 60
    assert created["context"] == {"intent": "control_request"}
    assert created["steps"] == []

    first = store.append_agent_run_step(
        created["id"],
        "observe_current_state",
        "completed",
        tool_name="get_farm_snapshot",
        input_payload={"farm_id": "farm-a"},
        output_payload={"ventilation_fan": 25},
    )
    second = store.append_agent_run_step(created["id"], "await_operator", "running")

    assert first is not None
    assert first["sequence"] == 1
    assert first["tool_name"] == "get_farm_snapshot"
    assert first["output"] == {"ventilation_fan": 25}
    assert first["completed_at"] is not None
    assert second is not None
    assert second["sequence"] == 2
    assert second["completed_at"] is None

    finished = store.finish_latest_agent_run_step(
        created["id"],
        "await_operator",
        "completed",
        output_payload={"label": "운영자 확인이 끝났습니다."},
    )

    assert finished is not None
    assert finished["id"] == second["id"]
    assert finished["status"] == "completed"
    assert finished["output"] == {"label": "운영자 확인이 끝났습니다."}
    assert finished["completed_at"] is not None

    updated = store.update_agent_run(
        created["id"],
        farm_id="farm-a",
        owner_id="operator-a",
        status="completed",
        current_value=55,
        result={"verification": "target_reached"},
    )

    assert updated is not None
    assert updated["status"] == "completed"
    assert updated["current_value"] == 55
    assert updated["result"] == {"verification": "target_reached"}
    assert updated["completed_at"] is not None
    assert [step["sequence"] for step in updated["steps"]] == [1, 2]
    assert store.get_agent_run(created["id"], farm_id="farm-b", owner_id="operator-a") is None


def test_agent_run_records_survive_store_reopen(tmp_path) -> None:
    database_path = tmp_path / "smartfarm.db"
    store = KnowledgeStore(str(database_path))
    session = _session(store)
    created = store.create_agent_run(
        session["id"],
        "farm-a",
        "operator-a",
        "최근 경보를 확인해줘",
        current_target="roof_vent",
        current_action="inspect",
        current_value={"window_minutes": 30},
    )
    assert created is not None
    store.append_agent_run_step(created["id"], "read_alerts", tool_name="list_alerts")
    store.close()

    reopened = KnowledgeStore(str(database_path))
    persisted = reopened.get_agent_run(created["id"])

    assert persisted is not None
    assert persisted["user_goal"] == "최근 경보를 확인해줘"
    assert persisted["current_value"] == {"window_minutes": 30}
    assert persisted["steps"][0]["kind"] == "read_alerts"


def test_control_verification_survives_store_reopen_and_stays_farm_scoped(tmp_path) -> None:
    database_path = tmp_path / "smartfarm.db"
    store = KnowledgeStore(str(database_path))
    verification = {
        "status": "verified",
        "target_state": "50%",
        "requested_value": 50,
        "checked_at": "2026-07-22T12:00:00+00:00",
        "detail": "장치 상태가 요청값과 일치합니다.",
    }

    store.store_control_verification("farm-a", "proposal-1", verification)
    store.close()

    reopened = KnowledgeStore(str(database_path))
    assert reopened.get_control_verification("farm-a", "proposal-1") == verification
    assert reopened.get_control_verification("farm-b", "proposal-1") is None


def test_latest_agent_context_uses_newest_structured_run_in_owned_session() -> None:
    store = KnowledgeStore(":memory:")
    session = _session(store)
    other_session = _session(store, owner_id="operator-b")
    first = store.create_agent_run(
        session["id"],
        "farm-a",
        "operator-a",
        "환기팬 상태를 확인해줘",
        current_target="ventilation_fan",
        current_action="inspect",
        current_value=25,
    )
    assert first is not None
    unrelated = store.create_agent_run(
        session["id"],
        "farm-a",
        "operator-a",
        "근권온도 자료를 설명해줘",
    )
    assert unrelated is not None
    assert store.create_agent_run(
        other_session["id"],
        "farm-a",
        "operator-b",
        "천창을 열어줘",
        current_target="roof_vent",
        current_action="set_roof_vent",
        current_value=30,
    ) is not None

    context = store.get_latest_agent_context(session["id"], "farm-a", "operator-a")
    assert context is None
    store.update_agent_run(unrelated["id"], current_target="ventilation_fan", current_action="inspect", current_value=25)
    context = store.get_latest_agent_context(session["id"], "farm-a", "operator-a")
    assert context is not None
    assert context["run_id"] == unrelated["id"]
    assert context["target"] == "ventilation_fan"
    assert context["action"] == "inspect"
    assert context["value"] == 25
    assert store.get_latest_agent_context(session["id"], "farm-a", "operator-b") is None

    latest = store.create_agent_run(
        session["id"],
        "farm-a",
        "operator-a",
        "그럼 50%로 낮춰줘",
        current_target="ventilation_fan",
        current_action="set_ventilation_fan",
        current_value=50,
    )
    assert latest is not None
    assert store.get_latest_agent_context(session["id"], "farm-a", "operator-a") == {
        "run_id": latest["id"],
        "target": "ventilation_fan",
        "action": "set_ventilation_fan",
        "value": 50,
        "updated_at": latest["updated_at"],
    }

    store.update_agent_run(first["id"], status="completed", result={"verification": {"status": "verified"}})
    context_after_old_run_update = store.get_latest_agent_context(session["id"], "farm-a", "operator-a")
    assert context_after_old_run_update is not None
    assert context_after_old_run_update["run_id"] == latest["id"]


def test_agent_run_validation_and_session_cleanup() -> None:
    store = KnowledgeStore(":memory:")
    session = _session(store)

    assert store.create_agent_run("missing", "farm-a", "operator-a", "상태를 확인해줘") is None
    with pytest.raises(ValueError, match="status"):
        store.create_agent_run(
            session["id"],
            "farm-a",
            "operator-a",
            "상태를 확인해줘",
            status="unknown",  # type: ignore[arg-type]
        )
    with pytest.raises(ValueError, match="goal"):
        store.create_agent_run(session["id"], "farm-a", "operator-a", "   ")

    run = store.create_agent_run(session["id"], "farm-a", "operator-a", "상태를 확인해줘")
    assert run is not None
    with pytest.raises(ValueError, match="status"):
        store.append_agent_run_step(run["id"], "observe", "unknown")  # type: ignore[arg-type]
    assert store.append_agent_run_step("missing", "observe") is None

    assert store.delete_advisor_session(session["id"], "farm-a", "operator-a") is True
    assert store.get_agent_run(run["id"]) is None
    assert store.connection.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0] == 0
    assert store.connection.execute("SELECT COUNT(*) FROM agent_run_steps").fetchone()[0] == 0


def test_agent_run_schema_rejects_invalid_status_directly() -> None:
    store = KnowledgeStore(":memory:")
    session = _session(store)

    with pytest.raises(sqlite3.IntegrityError):
        with store.connection:
            store.connection.execute(
                """
                INSERT INTO agent_runs (
                    id, session_id, farm_id, owner_id, user_goal, status,
                    context_payload, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
                """,
                (
                    "invalid-run",
                    session["id"],
                    "farm-a",
                    "operator-a",
                    "invalid",
                    "unknown",
                    "2026-07-22T00:00:00+00:00",
                    "2026-07-22T00:00:00+00:00",
                ),
            )


def test_advisor_session_hydrates_latest_agent_run_state() -> None:
    store = KnowledgeStore(":memory:")
    session = _session(store)
    run = store.create_agent_run(
        session["id"],
        "farm-a",
        "operator-a",
        "환기팬을 50%로 낮춰줘",
        run_id="advisor-hydrated",
        status="awaiting_approval",
        current_target="ventilation_fan",
    )
    assert run is not None
    store.append_agent_run_step(
        run["id"],
        "planning",
        output_payload={"label": "요청을 확인했습니다.", "detail": "현재 상태 확인을 준비했습니다."},
    )
    stored_turn, created = store.append_advisor_turn(
        session_id=session["id"],
        client_turn_id="turn-hydrated",
        farm_id="farm-a",
        owner_id="operator-a",
        question="환기팬을 50%로 낮춰줘",
        request_payload={"selected_source_ids": [], "include_simulation_context": True},
        response_payload={
            "answer": "조정안을 준비했습니다.",
            "agent_run": {
                "run_id": run["id"],
                "status": "awaiting_approval",
                "goal": "환기팬을 50%로 낮춰줘",
                "current_target": "ventilation_fan",
                "steps": [],
            },
        },
    )
    assert created is True
    assert stored_turn is not None

    store.append_agent_run_step(
        run["id"],
        "verification",
        output_payload={"label": "변경 결과를 다시 확인했습니다."},
    )
    store.update_agent_run(run["id"], status="completed", result={"verification": {"status": "verified"}})

    hydrated = store.get_advisor_session(session["id"], "farm-a", "operator-a")

    assert hydrated is not None
    current = hydrated["turns"][0]["response"]["agent_run"]
    assert current["status"] == "completed"
    assert [step["kind"] for step in current["steps"]] == ["planning", "verification"]
    assert current["steps"][-1]["label"] == "변경 결과를 다시 확인했습니다."
