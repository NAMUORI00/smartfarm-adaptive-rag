from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any


class SQLiteTelemetryStore:
    """Small durable store for simulator state and idempotency ledgers."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS simulator_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    revision INTEGER NOT NULL,
                    state_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS control_executions (
                    proposal_id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    execution_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ingress_messages (
                    message_id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS telemetry_observations (
                    observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    farm_id TEXT NOT NULL,
                    zone_id TEXT NOT NULL,
                    sensor_id TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    ingested_at TEXT NOT NULL,
                    message_id TEXT,
                    sequence INTEGER,
                    value REAL NOT NULL,
                    unit TEXT NOT NULL,
                    quality TEXT NOT NULL,
                    source TEXT NOT NULL,
                    simulated_only INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS telemetry_observations_message_idx
                    ON telemetry_observations(message_id, zone_id, sensor_id, metric)
                    WHERE message_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS telemetry_observations_series_idx
                    ON telemetry_observations(farm_id, zone_id, metric, observed_at);
                CREATE TABLE IF NOT EXISTS incident_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    incident_id TEXT NOT NULL,
                    farm_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS incident_events_farm_idx
                    ON incident_events(farm_id, occurred_at DESC);
                CREATE TABLE IF NOT EXISTS ingress_rejections (
                    rejection_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    farm_id TEXT NOT NULL,
                    source TEXT,
                    message_id TEXT,
                    rejected_at TEXT NOT NULL,
                    reason_code TEXT NOT NULL,
                    detail TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ingress_rejections_farm_idx
                    ON ingress_rejections(farm_id, rejection_id DESC);
                """
            )

    def load_state(self) -> tuple[int, dict[str, Any]]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT revision, state_json FROM simulator_state WHERE singleton = 1"
            ).fetchone()
        if row is None:
            return 0, {}
        return int(row[0]), json.loads(row[1])

    def control_execution(self, proposal_id: str) -> tuple[str, dict[str, Any]] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT fingerprint, execution_json FROM control_executions WHERE proposal_id = ?",
                (proposal_id,),
            ).fetchone()
        if row is None:
            return None
        return str(row[0]), json.loads(row[1])

    def ingress_fingerprint(self, message_id: str) -> str | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT fingerprint FROM ingress_messages WHERE message_id = ?",
                (message_id,),
            ).fetchone()
        return None if row is None else str(row[0])

    def record_ingress_rejection(
        self,
        *,
        farm_id: str,
        source: str | None,
        message_id: str | None,
        rejected_at: str,
        reason_code: str,
        detail: str,
    ) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO ingress_rejections (
                    farm_id, source, message_id, rejected_at, reason_code, detail
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (farm_id, source, message_id, rejected_at, reason_code, detail[:500]),
            )
            connection.execute(
                """
                DELETE FROM ingress_rejections
                WHERE farm_id = ? AND rejection_id NOT IN (
                    SELECT rejection_id FROM ingress_rejections
                    WHERE farm_id = ? ORDER BY rejection_id DESC LIMIT 500
                )
                """,
                (farm_id, farm_id),
            )

    def ingress_rejection_summary(self, farm_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            counts = connection.execute(
                """
                SELECT reason_code, COUNT(*) FROM ingress_rejections
                WHERE farm_id = ? GROUP BY reason_code
                """,
                (farm_id,),
            ).fetchall()
            latest = connection.execute(
                """
                SELECT rejected_at, reason_code, detail FROM ingress_rejections
                WHERE farm_id = ? ORDER BY rejection_id DESC LIMIT 1
                """,
                (farm_id,),
            ).fetchone()
        rejection_counts = {str(row[0]): int(row[1]) for row in counts}
        return {
            "count": sum(rejection_counts.values()),
            "counts": rejection_counts,
            "last_rejection_at": None if latest is None else str(latest[0]),
            "last_rejection_reason": None if latest is None else str(latest[2]),
        }

    def save_state(
        self,
        revision: int,
        state: dict[str, Any],
        *,
        execution: tuple[str, str, dict[str, Any]] | None = None,
        ingress_message: tuple[str, str] | None = None,
        observations: list[dict[str, Any]] | None = None,
        incident_events: list[dict[str, Any]] | None = None,
    ) -> None:
        serialized_state = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if execution is not None:
                proposal_id, fingerprint, payload = execution
                connection.execute(
                    "INSERT INTO control_executions (proposal_id, fingerprint, execution_json) VALUES (?, ?, ?)",
                    (
                        proposal_id,
                        fingerprint,
                        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    ),
                )
            if ingress_message is not None:
                connection.execute(
                    "INSERT INTO ingress_messages (message_id, fingerprint) VALUES (?, ?)",
                    ingress_message,
                )
            if observations:
                connection.executemany(
                    """
                    INSERT INTO telemetry_observations (
                        farm_id, zone_id, sensor_id, metric, observed_at, ingested_at,
                        message_id, sequence, value, unit, quality, source, simulated_only
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            item["farm_id"],
                            item["zone_id"],
                            item["sensor_id"],
                            item["metric"],
                            item["observed_at"],
                            item["ingested_at"],
                            item.get("message_id"),
                            item.get("sequence"),
                            item["value"],
                            item["unit"],
                            item["quality"],
                            item["source"],
                            1 if item["simulated_only"] else 0,
                        )
                        for item in observations
                    ],
                )
            if incident_events:
                connection.executemany(
                    """
                    INSERT INTO incident_events (
                        incident_id, farm_id, status, occurred_at, payload_json
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            item["incident_id"],
                            item["farm_id"],
                            item["status"],
                            item.get("resolved_at")
                            or item.get("recovering_at")
                            or item.get("acknowledged_at")
                            or item["opened_at"],
                            json.dumps(item, ensure_ascii=False, separators=(",", ":")),
                        )
                        for item in incident_events
                    ],
                )
            connection.execute(
                """
                INSERT INTO simulator_state (singleton, revision, state_json)
                VALUES (1, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                    revision = excluded.revision,
                    state_json = excluded.state_json
                """,
                (revision, serialized_state),
            )

    def observations(
        self,
        farm_id: str,
        metric: str,
        start: str,
        end: str,
        *,
        zone_id: str = "zone-a",
    ) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT zone_id, sensor_id, metric, observed_at, value, unit,
                       quality, source, simulated_only, message_id, sequence
                FROM telemetry_observations
                WHERE farm_id = ? AND zone_id = ? AND metric = ?
                  AND observed_at >= ? AND observed_at <= ?
                ORDER BY observed_at, observation_id
                """,
                (farm_id, zone_id, metric, start, end),
            ).fetchall()
        return [
            {
                "zone_id": str(row[0]),
                "sensor_id": str(row[1]),
                "metric": str(row[2]),
                "observed_at": str(row[3]),
                "value": float(row[4]),
                "unit": str(row[5]),
                "quality": str(row[6]),
                "source": str(row[7]),
                "simulated_only": bool(row[8]),
                "message_id": None if row[9] is None else str(row[9]),
                "sequence": None if row[10] is None else int(row[10]),
            }
            for row in rows
        ]

    def incident_history(self, farm_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM incident_events
                WHERE farm_id = ?
                ORDER BY event_id DESC
                LIMIT ?
                """,
                (farm_id, limit),
            ).fetchall()
        return [json.loads(row[0]) for row in reversed(rows)]

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection
