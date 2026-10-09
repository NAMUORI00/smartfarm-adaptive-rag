"""Exact research routing functions; provenance in data/qact-profile/research-algorithm.json."""
from __future__ import annotations
from typing import Any, Dict, Sequence

DEFAULT_STRUCTURAL_WEIGHTS = {"dense": 0.34, "sparse": 0.33, "graph": 0.33}

DENSE_FIRST_ADAPTIVE_GRAPH_THRESHOLD = 0.35

DENSE_FIRST_ADAPTIVE_SPARSE_FALLBACK_MIN = 0.40

DENSE_FIRST_UNIFORM_PROFILE_EPSILON = 0.02

def _normalize_channel_weights(raw: Dict[str, float] | None) -> Dict[str, float]:
    if not raw:
        return dict(DEFAULT_STRUCTURAL_WEIGHTS)
    dense = max(0.0, float(raw.get("dense", 0.0)))
    sparse = max(0.0, float(raw.get("sparse", 0.0)))
    graph = max(0.0, float(raw.get("graph", 0.0)))
    total = dense + sparse + graph
    if total <= 0.0:
        return dict(DEFAULT_STRUCTURAL_WEIGHTS)
    return {"dense": dense / total, "sparse": sparse / total, "graph": graph / total}

def dense_first_adaptive_route(
    *,
    weights: Dict[str, float] | None,
    graph_rank: Sequence[str] | None,
    graph_threshold: float = DENSE_FIRST_ADAPTIVE_GRAPH_THRESHOLD,
    sparse_fallback_min: float = DENSE_FIRST_ADAPTIVE_SPARSE_FALLBACK_MIN,
) -> Dict[str, Any]:
    norm = _normalize_channel_weights(weights)
    graph_weight = float(norm.get("graph", 0.0))
    sparse_weight = float(norm.get("sparse", 0.0))
    graph_evidence_count = len([x for x in list(graph_rank or []) if str(x).strip()])
    threshold = max(0.0, min(1.0, float(graph_threshold)))
    sparse_threshold = max(0.0, min(1.0, float(sparse_fallback_min)))
    uniform_profile = (
        abs(float(norm.get("dense", 0.0)) - float(DEFAULT_STRUCTURAL_WEIGHTS["dense"])) <= DENSE_FIRST_UNIFORM_PROFILE_EPSILON
        and abs(sparse_weight - float(DEFAULT_STRUCTURAL_WEIGHTS["sparse"])) <= DENSE_FIRST_UNIFORM_PROFILE_EPSILON
        and abs(graph_weight - float(DEFAULT_STRUCTURAL_WEIGHTS["graph"])) <= DENSE_FIRST_UNIFORM_PROFILE_EPSILON
    )

    def _non_graph_route(reason: str) -> Dict[str, Any]:
        selected_mode = "dense_only" if uniform_profile else ("dense_sparse" if sparse_weight >= sparse_threshold else "dense_only")
        fallback_reason = "untuned_uniform_profile" if uniform_profile else ("sparse_weight_supported" if selected_mode == "dense_sparse" else reason)
        return {
            "selected_mode": selected_mode,
            "graph_active": False,
            "fallback_reason": fallback_reason,
            "graph_weight": graph_weight,
            "graph_threshold": threshold,
            "sparse_weight": sparse_weight,
            "sparse_fallback_min": sparse_threshold,
            "uniform_profile": bool(uniform_profile),
            "graph_evidence_count": int(graph_evidence_count),
        }

    if graph_weight <= threshold:
        reason = "graph_weight_at_or_below_threshold" if graph_weight >= threshold else "graph_weight_below_threshold"
        return _non_graph_route(reason)
    if graph_evidence_count <= 0:
        return _non_graph_route("graph_evidence_absent")
    return {
        "selected_mode": "adaptive_fusion",
        "graph_active": True,
        "fallback_reason": "",
        "graph_weight": graph_weight,
        "graph_threshold": threshold,
        "sparse_weight": sparse_weight,
        "sparse_fallback_min": sparse_threshold,
        "uniform_profile": bool(uniform_profile),
        "graph_evidence_count": int(graph_evidence_count),
    }
