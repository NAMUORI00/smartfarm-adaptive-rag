"""Deployment export boundary for the KIIT-related retrieval extension.

The research algorithm is reused; calibration on a deployment corpus is not
inferred from public benchmark outcomes. No release is enabled by default.
"""
from __future__ import annotations

from hashlib import sha256
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
from typing import Any

from . import research_retrieval_algorithm


def digest(value: Any) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def algorithm_hash() -> str:
    return sha256(Path(research_retrieval_algorithm.__file__).read_bytes()).hexdigest()


def validate_research_policy(policy: dict[str, Any]) -> None:
    if not isinstance(policy, dict) or policy.get("algorithm") != "dense_first_adaptive_route":
        raise ValueError("Unknown research policy")
    if policy.get("quality_acceptance") is False and os.getenv("RAG_RESEARCH_ALLOW_UNACCEPTED_DIAGNOSTICS") != "1":
        raise ValueError("Research release failed quality acceptance; isolated diagnostics override required")
    if policy.get("algorithm_sha256") != algorithm_hash():
        raise ValueError("Research algorithm version mismatch")
    for field in ("graph_weight_threshold", "sparse_fallback_min"):
        value = float(policy[field])
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("Invalid research threshold")
    for field in ("calibration_sha256", "source_sha256"):
        value = policy[field]
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("Missing research provenance hash")
    if policy.get("lineage") != "KIIT-related extension":
        raise ValueError("Research lineage must distinguish the extension")


def snapshot_hashes(store: Any) -> dict[str, str]:
    """Hash the actual indexed corpus, embeddings and source-backed graph inputs.

Both content and eligibility are pinned. A document upload, pause, reindex or
embedding fallback invalidates the release until a new export is validated.
The graph mirror is not its own authority; product graph evidence still has
to map to the pinned indexed source spans before the research route executes.
"""
    with store._lock:
        documents = [dict(row) for row in store.connection.execute(
            "SELECT id,sha256,status,retrieval_state,scope,farm_id,provenance_json FROM documents ORDER BY id"
        )]
        chunks = [dict(row) for row in store.connection.execute(
            "SELECT id,document_id,ordinal,text,start_char,end_char,embedding FROM chunks ORDER BY id"
        )]
        terms = [list(row) for row in store.connection.execute(
            "SELECT chunk_id,term FROM chunk_terms ORDER BY chunk_id,term"
        )]
    corpus = [{k: v for k, v in row.items() if k != "embedding"} for row in chunks]
    return {
        "corpus": digest([documents, corpus]),
        "embedding": digest({"provider": store.embedding.requested_provider,
            "model": store.embedding.active_model, "vector_size": store.embedding.vector_size,
            "query_prefix": os.getenv("RAG_RESEARCH_QUERY_PREFIX", "") if store.embedding.requested_provider == "sentence_transformers" else "",
            "preprocessing_revision": getattr(store.embedding._model, "preprocessing_revision", None),
            "vectors": [[row["id"], row["embedding"]] for row in chunks]}),
        "graph": digest([documents, corpus, terms]),
    }


def export_release(*, calibration: dict[str, Any], calibration_bytes: bytes,
                   snapshots: dict[str, str], source_sha256: str,
                   profile_id: str, expires_at: str) -> dict[str, Any]:
    """Export independently calibrated weights without relabeling research scores."""
    expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc) or not profile_id.strip():
        raise ValueError("A named release with a future timezone-aware expiry is required")
    if set(snapshots) != {"corpus", "embedding", "graph"} or any(
        not isinstance(v, str) or len(v) != 64 or any(c not in "0123456789abcdef" for c in v)
        for v in snapshots.values()
    ):
        raise ValueError("Current corpus, embedding and graph SHA256 snapshots are required")
    if calibration.get("claim_status") != "deployment_calibration":
        raise ValueError("A deployment calibration artifact is required")
    if calibration.get("quality_acceptance") is False or calibration.get("quality_gate", {}).get("passed") is False:
        raise ValueError("Cannot export an accepted release from a known failed quality evaluation")
    if calibration.get("snapshot_hashes") != snapshots:
        raise ValueError("Calibration and runtime snapshots differ")
    if not calibration.get("development_ids") or not calibration.get("validation_ids"):
        raise ValueError("Development and validation split identifiers are required")
    if set(calibration["development_ids"]) & set(calibration["validation_ids"]):
        raise ValueError("Calibration splits must be disjoint")
    weights = {key: float(calibration["channel_weights"].get(key, 0)) for key in ("dense", "sparse", "graph")}
    if any(not math.isfinite(v) or v < 0 for v in weights.values()) or weights["dense"] <= 0:
        raise ValueError("Finite nonnegative weights with a positive Dense baseline required")
    weights = {key: value / sum(weights.values()) for key, value in weights.items() if value > 0}
    reliability = float(calibration["graph_reliability_threshold"])
    if not math.isfinite(reliability) or not 0 <= reliability <= 1:
        raise ValueError("Invalid source reliability threshold")
    policy = {"algorithm": "dense_first_adaptive_route", "algorithm_sha256": algorithm_hash(),
        "lineage": "KIIT-related extension", "source_sha256": source_sha256,
        "calibration_sha256": sha256(calibration_bytes).hexdigest(),
        "graph_weight_threshold": calibration["graph_weight_threshold"],
        "sparse_fallback_min": calibration["sparse_fallback_min"]}
    validate_research_policy(policy)
    return {"schema_version": "smartfarm-qact-release-v2", "profile_id": profile_id,
        "source_provenance": "KIIT-related extension; deployment calibration, not benchmark results",
        "expires_at": expires_at, "snapshot_hashes": snapshots, "research_policy": policy,
        "query_segments": [{"segment_id": "research-candidate", "match_any": [],
            "allowed_path": list(weights), "channel_weights": weights,
            "graph_reliability_threshold": reliability if "graph" in weights else 1.0,
            "route_reason": "Research candidate channels; final family selected after source-backed Graph evidence."}],
        "fallback": {"allowed_path": ["dense"], "channel_weights": {"dense": 1.0},
            "route_reason": "Missing or incompatible research release; Dense baseline."}}
