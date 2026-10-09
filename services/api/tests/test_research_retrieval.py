from hashlib import sha256
import json
from pathlib import Path

import pytest

from app.knowledge import EmbeddingRuntime, KnowledgeStore, load_qact_release_profile
from app.research_retrieval import export_release, snapshot_hashes
from app.research_retrieval_algorithm import dense_first_adaptive_route


def calibration(store):
    return {"claim_status": "deployment_calibration", "development_ids": ["dev-1"],
        "validation_ids": ["validation-1"], "snapshot_hashes": snapshot_hashes(store),
        "channel_weights": {"dense": .34, "sparse": .33, "graph": .33},
        "graph_reliability_threshold": .6, "graph_weight_threshold": .35,
        "sparse_fallback_min": .4}


def release(store, tmp_path, monkeypatch):
    data = calibration(store)
    result = export_release(calibration=data, calibration_bytes=json.dumps(data).encode(),
        snapshots=snapshot_hashes(store), source_sha256="a" * 64,
        profile_id="research-test", expires_at="2099-01-01T00:00:00Z")
    payload = json.dumps(result).encode()
    path = tmp_path / "release.json"
    path.write_bytes(payload)
    monkeypatch.setenv("QACT_PROFILE_PATH", str(path))
    monkeypatch.setenv("QACT_PROFILE_SHA256", sha256(payload).hexdigest())
    return result


def test_research_profile_retrieval_and_snapshot_invalidation(tmp_path, monkeypatch):
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    store.ingest_document(title="Care", content="Wasabi cooling and root temperature.",
        scope="public", source_kind="public_knowledge", version="v1")
    release(store, tmp_path, monkeypatch)
    assert load_qact_release_profile().state == "valid"
    kwargs = dict(query="Wasabi cooling", farm_id="farm-wasabi-a", include_private=False,
        selected_document_ids=None, retrieval_path=["dense", "sparse", "graph"])
    result = store.retrieve(**kwargs)
    assert result.trace["research_policy"]["decision"]["selected_mode"] == "dense_only"
    assert result.trace["fusion"]["weights"] == {"dense": 1.0}
    store.ingest_document(title="New", content="New wasabi cooling advice.", scope="public",
        source_kind="public_knowledge", version="v1")
    result = store.retrieve(**kwargs)
    assert result.trace["research_policy"]["state"] == "snapshot_mismatch"
    assert result.trace["fusion"]["weights"] == {"dense": 1.0}
    store.close()


def test_calibration_split_overlap_rejected():
    snapshots = {"corpus": "a" * 64, "embedding": "b" * 64, "graph": "c" * 64}
    data = {"claim_status": "deployment_calibration", "snapshot_hashes": snapshots,
        "development_ids": ["same"], "validation_ids": ["same"]}
    with pytest.raises(ValueError, match="disjoint"):
        export_release(calibration=data, calibration_bytes=b"{}", snapshots=snapshots,
            source_sha256="a"*64, profile_id="test", expires_at="2099-01-01T00:00:00Z")


def test_export_rejects_known_quality_failure():
    snapshots = {"corpus": "a" * 64, "embedding": "b" * 64, "graph": "c" * 64}
    with pytest.raises(ValueError, match="known failed"):
        export_release(calibration={"claim_status": "deployment_calibration", "quality_gate": {"passed": False}},
            calibration_bytes=b"{}", snapshots=snapshots, source_sha256="a" * 64,
            profile_id="test", expires_at="2099-01-01T00:00:00Z")


def test_runtime_algorithm_mismatch_fails_closed(tmp_path, monkeypatch):
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    data = release(store, tmp_path, monkeypatch)
    data["research_policy"]["algorithm_sha256"] = "0" * 64
    payload = json.dumps(data).encode()
    (tmp_path / "release.json").write_bytes(payload)
    monkeypatch.setenv("QACT_PROFILE_SHA256", sha256(payload).hexdigest())
    assert load_qact_release_profile().route("why")["mode"] == "dense_only_fallback"
    store.close()


def test_known_failed_quality_release_requires_explicit_diagnostics(tmp_path, monkeypatch):
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    store.ingest_document(title="Care", content="Wasabi cooling and root temperature.",
        scope="public", source_kind="public_knowledge", version="v1")
    data = release(store, tmp_path, monkeypatch)
    data["research_policy"]["quality_acceptance"] = False
    payload = json.dumps(data).encode()
    (tmp_path / "release.json").write_bytes(payload)
    monkeypatch.setenv("QACT_PROFILE_SHA256", sha256(payload).hexdigest())
    monkeypatch.delenv("RAG_RESEARCH_ALLOW_UNACCEPTED_DIAGNOSTICS", raising=False)
    assert load_qact_release_profile().route("why")["mode"] == "dense_only_fallback"
    monkeypatch.setenv("RAG_RESEARCH_ALLOW_UNACCEPTED_DIAGNOSTICS", "1")
    assert load_qact_release_profile().state == "valid"
    result = store.retrieve(query="why", farm_id="farm-wasabi-a", include_private=False,
        selected_document_ids=None, retrieval_path=["dense"])
    assert result.trace["research_policy"]["quality_acceptance"] is False
    assert result.trace["research_policy"]["diagnostics_only"] is True
    store.close()


@pytest.mark.parametrize("weights,graph,mode", [
    ({"dense": .34, "sparse": .33, "graph": .33}, ["source"], "dense_only"),
    ({"dense": .2, "sparse": .45, "graph": .35}, ["source"], "dense_sparse"),
    ({"dense": .2, "sparse": .2, "graph": .6}, [], "dense_only"),
    ({"dense": .2, "sparse": .2, "graph": .6}, ["source"], "adaptive_fusion"),
])
def test_research_boundary_semantics(weights, graph, mode):
    assert dense_first_adaptive_route(weights=weights, graph_rank=graph)["selected_mode"] == mode


def test_vendored_research_source_integrity():
    from app import research_retrieval_algorithm
    root = Path(__file__).resolve().parents[3]
    manifest = json.loads((root / "data/qact-profile/research-algorithm.json").read_text())
    assert sha256(Path(research_retrieval_algorithm.__file__).read_bytes()).hexdigest() == manifest["export_sha256"]


def test_reference_page_identity_survives_shared_download_url():
    store = KnowledgeStore(":memory:", embedding_runtime=EmbeddingRuntime(provider="hash"))
    documents = []
    for page in (31, 34):
        document, _ = store.ingest_document(title=f"Wasabi page {page}",
            content=f"Reference corpus provenance\nsource_id: page-{page}\ncanonical_id: handbook#pages:{page}-{page}\npage_number: {page}\n\nWasabi cultivation reference page {page}.",
            source_url="https://example.org/download?file=handbook", document_id=f"page-{page}",
            scope="public", source_kind="public_knowledge")
        documents.append(document)
    assert documents[0]["provenance"]["canonical_source_id"] != documents[1]["provenance"]["canonical_source_id"]
    assert [d["provenance"]["page_number"] for d in documents] == [31, 34]
    store.close()
