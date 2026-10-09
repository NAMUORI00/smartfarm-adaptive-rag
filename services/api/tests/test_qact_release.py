from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path

import pytest

from app.knowledge import EmbeddingRuntime, KnowledgeStore, load_qact_release_profile


ROOT = Path(__file__).resolve().parents[3]


def _release(*, expires_at: str = "2099-01-01T00:00:00Z") -> dict[str, object]:
    return {
        "schema_version": "smartfarm-qact-release-v2",
        "profile_id": "qact-test-v2",
        "source_provenance": "offline deterministic test fixture",
        "expires_at": expires_at,
        "snapshot_hashes": {
            "corpus": "a" * 64,
            "embedding": "b" * 64,
            "graph": "c" * 64,
        },
        "query_segments": [
            {
                "segment_id": "causal",
                "match_any": ["왜", "원인"],
                "allowed_path": ["dense", "sparse", "graph"],
                "channel_weights": {"dense": 0.5, "sparse": 0.3, "graph": 0.2},
                "graph_reliability_threshold": 0.6,
                "route_reason": "verified causal evidence route",
            },
            {
                "segment_id": "exact",
                "match_any": ["ec", "센서"],
                "allowed_path": ["dense", "sparse"],
                "channel_weights": {"dense": 0.7, "sparse": 0.3},
                "graph_reliability_threshold": 1.0,
                "route_reason": "exact operating term route",
            },
            {
                "segment_id": "default",
                "match_any": [],
                "allowed_path": ["dense"],
                "channel_weights": {"dense": 1.0},
                "graph_reliability_threshold": 1.0,
                "route_reason": "dense semantic baseline",
            },
        ],
        "fallback": {
            "allowed_path": ["dense"],
            "channel_weights": {"dense": 1.0},
            "route_reason": "dense-only fallback",
        },
    }


def _write_release(tmp_path, artifact: dict[str, object]) -> tuple[str, str]:
    payload = json.dumps(artifact, ensure_ascii=False, indent=2).encode("utf-8")
    path = tmp_path / "qact-release.json"
    path.write_bytes(payload)
    return str(path), sha256(payload).hexdigest()


def test_qact_v2_routes_with_release_weights_and_auditable_reasons(tmp_path) -> None:
    path, checksum = _write_release(tmp_path, _release())
    profile = load_qact_release_profile(path, checksum)

    assert profile.state == "valid"
    causal = profile.route("근권 온도가 상승한 원인은 무엇인가?")
    assert causal["mode"] == "qact"
    assert causal["query_segment_id"] == "causal"
    assert causal["retrieval_path"] == ["dense", "sparse", "graph"]
    assert causal["channel_weights"] == {"dense": 0.5, "sparse": 0.3, "graph": 0.2}
    assert causal["graph_reliability_threshold"] == 0.6
    assert causal["route_reason"] == "verified causal evidence route"
    assert causal["snapshot_hashes"] == {"corpus": "a" * 64, "embedding": "b" * 64, "graph": "c" * 64}

    assert profile.route("EC 센서 기준을 찾아줘")["query_segment_id"] == "exact"
    assert profile.route("고추냉이 재배 자료를 요약해줘")["query_segment_id"] == "default"


def test_versioned_demo_release_satisfies_qact_routing_golden_suite() -> None:
    artifact_path = ROOT / "data" / "qact-profile" / "demo-release.json"
    checksum = sha256(artifact_path.read_bytes()).hexdigest()
    profile = load_qact_release_profile(str(artifact_path), checksum)
    suite = json.loads((ROOT / "data" / "rag-eval" / "qact-routing-golden.json").read_text(encoding="utf-8"))

    assert suite["claim_status"] == "prototype_regression_only"
    assert profile.state == "valid"
    for case in suite["cases"]:
        route = profile.route(case["question"])
        assert route["query_segment_id"] == case["expected_segment_id"]
        assert route["retrieval_path"] == case["expected_path"]
        assert route["channel_weights"] == pytest.approx(case["expected_weights"])
        assert route["graph_reliability_threshold"] == case["expected_graph_threshold"]


def test_qact_invalid_and_expired_releases_fail_closed_to_dense_only(tmp_path) -> None:
    path, checksum = _write_release(tmp_path, _release(expires_at="2020-01-01T00:00:00Z"))
    expired = load_qact_release_profile(
        path,
        checksum,
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    ).route("원인은?")
    assert expired["mode"] == "dense_only_fallback"
    assert expired["qact_profile_state"] == "expired"
    assert expired["retrieval_path"] == ["dense"]
    assert expired["channel_weights"] == {"dense": 1.0}

    invalid = load_qact_release_profile(path, "0" * 64).route("원인은?")
    assert invalid["qact_profile_state"] == "invalid"
    assert invalid["retrieval_path"] == ["dense"]


def test_qact_schema_rejects_non_dense_fallback(tmp_path) -> None:
    artifact = _release()
    artifact["fallback"] = {
        "allowed_path": ["dense", "graph"],
        "channel_weights": {"dense": 0.8, "graph": 0.2},
        "route_reason": "unsafe fallback",
    }
    path, checksum = _write_release(tmp_path, artifact)

    profile = load_qact_release_profile(path, checksum)
    assert profile.state == "invalid"
    assert profile.route("원인은?")["retrieval_path"] == ["dense"]


def test_retrieval_uses_release_weights_and_suppresses_unverified_graph_relations() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    store.ingest_document(
        title="파생 설명",
        content=(
            "Reference corpus provenance\n"
            "canonical_id: source-a\n"
            "derived_evidence: true\n\n"
            "고추냉이 근권 온도 상승 원인과 냉각기 상태를 설명한다."
        ),
        scope="public",
        source_kind="public_knowledge",
        version="v2",
    )

    result = store.retrieve(
        query="근권 온도 상승 원인은 무엇인가",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense", "sparse", "graph"],
        channel_weights={"dense": 0.8, "sparse": 0.15, "graph": 0.05},
        graph_reliability_threshold=0.0,
    )

    assert result.trace["graph_gate"]["enabled"] is False
    assert result.trace["graph_gate"]["reason"] == "no_source_span_verified_graph_relation"
    assert result.trace["graph_gate"]["harm_suppressed"] is True
    assert "graph" not in result.trace["fusion"]["weights"]
    assert result.trace["fusion"]["weights"] == pytest.approx(
        {"dense": 0.8 / 0.95, "sparse": 0.15 / 0.95}
    )
    store.close()


def test_derived_page_region_and_table_provenance_survives_index_and_retrieval() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    document, job = store.ingest_document(
        title="고추냉이 시험 표",
        content=(
            "Reference corpus provenance\n"
            "canonical_id: wasabi-study-2009\n"
            "source_version: publisher-v1\n"
            "derived_evidence: true\n"
            "derived_from_source_id: doi:10.0000/example\n"
            "page_number: 8\n"
            "region_locator: figure-2\n"
            "table_locator: table-3,row-2\n\n"
            "근권 온도 13도 처리와 20도 처리를 비교한 파생 표 설명이다."
        ),
        scope="public",
        source_kind="public_knowledge",
        version="derived-v2",
    )

    provenance = document["provenance"]
    assert provenance["canonical_source_id"] == "reference:wasabi-study-2009"
    assert provenance["source_version"] == "publisher-v1"
    assert provenance["derived_evidence"] is True
    assert provenance["page_number"] == 8
    assert provenance["region_locator"] == "figure-2"
    assert provenance["table_locator"] == "table-3,row-2"
    assert provenance["provenance_status"] == "derived_with_source_locator"
    assert job["details"]["provenance"] == provenance

    result = store.retrieve(
        query="근권 온도 13도와 20도 비교 원인",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={document["id"]},
        retrieval_path=["dense", "sparse", "graph"],
        graph_reliability_threshold=0.0,
        explicit_single_source_selection=True,
    )
    assert result.trace["graph_gate"]["enabled"] is True
    assert result.hits[0].provenance == provenance
    assert result.hits[0].content_checksum == provenance["content_sha256"]
    store.close()


@pytest.mark.parametrize(
    "content",
    [
        (
            "Reference corpus provenance\n"
            "content_role: raw_timeseries\n\n"
            "sampled_at,metric,value\n2026-01-01T00:00:00Z,temperature,16.2"
        ),
        "sampled_at,metric,value\n"
        + "\n".join(
            f"2026-01-01T00:00:{second:02d}Z,temperature,{16 + second / 100:.2f}"
            for second in range(30)
        ),
    ],
)
def test_raw_timeseries_is_not_embedded_as_a_knowledge_document(content: str) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    with pytest.raises(ValueError, match="Raw telemetry timeseries are not embedded"):
        store.ingest_document(
            title="원시 센서 스트림",
            content=content,
            scope="public",
            source_kind="public_knowledge",
        )
    assert store.connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
    store.close()
