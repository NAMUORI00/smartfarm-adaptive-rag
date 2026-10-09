from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import sys
from threading import Barrier, BrokenBarrierError, Lock, get_ident
from types import ModuleType

import pytest

from app.knowledge import (
    EmbeddingReindexError,
    EmbeddingRuntime,
    FalkorGraphMirror,
    KnowledgeMetadataUpdateError,
    KnowledgeRevisionRestoreError,
    KnowledgeStore,
)
from app.pdf_extractor import ImageTextExtractionError, extract_image_text


def degraded_runtime() -> EmbeddingRuntime:
    return EmbeddingRuntime(provider="hash")


def test_source_search_collapses_chunks_to_roots_and_validates_tenant_scope() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    source_url = "https://example.org/root-cooling-guide.pdf"
    first, _ = store.ingest_document(
        title="ROOTSEARCH731 근권 냉각 지침 1쪽",
        content="ROOTSEARCH731 근권 냉각 운전 첫 번째 구간입니다.",
        scope="public",
        source_kind="public_knowledge",
        source_url=source_url,
        source_key="root_cooling_p1",
    )
    second, _ = store.ingest_document(
        title="ROOTSEARCH731 근권 냉각 지침 2쪽",
        content="ROOTSEARCH731 근권 냉각 운전 두 번째 구간입니다.",
        scope="public",
        source_kind="public_knowledge",
        source_url=source_url,
        source_key="root_cooling_p2",
    )
    private, _ = store.ingest_document(
        title="ROOTSEARCH731 농장 내부 기록",
        content="ROOTSEARCH731 현재 농장의 비공개 기록입니다.",
        scope="private",
        source_kind="private_knowledge",
        farm_id="farm-a",
    )

    public_results = store.search_source_groups("ROOTSEARCH731", "farm-a", visibility="public")
    all_results = store.search_source_groups("ROOTSEARCH731", "farm-a", visibility="all")
    other_farm_results = store.search_source_groups("ROOTSEARCH731", "farm-b", visibility="all")

    assert first["source_group_id"] == second["source_group_id"]
    assert [item["source_group_id"] for item in public_results] == [first["source_group_id"]]
    assert public_results[0]["document_count"] == 2
    assert {item["source_group_id"] for item in all_results} == {
        first["source_group_id"],
        private["source_group_id"],
    }
    assert private["source_group_id"] not in {item["source_group_id"] for item in other_farm_results}


def test_fastembed_runtime_uses_multilingual_model_without_hash_fallback(monkeypatch) -> None:
    fake_module = ModuleType("fastembed")

    class FakeTextEmbedding:
        embedding_size = 384

        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

        def passage_embed(self, texts):
            return [[1.0] + [0.0] * 383 for _text in texts]

        def query_embed(self, texts):
            return [[0.5] + [0.0] * 383 for _text in texts]

    fake_module.TextEmbedding = FakeTextEmbedding
    monkeypatch.setitem(sys.modules, "fastembed", fake_module)

    runtime = EmbeddingRuntime(provider="fastembed")
    vectors = runtime.embed_passages(["고추냉이 근권 온도", "wasabi root-zone temperature"])

    assert len(vectors) == 2
    assert all(len(vector) == 384 for vector in vectors)
    assert runtime.status()["state"] == "ready"
    assert runtime.status()["degraded"] is False
    assert runtime.status()["model"] == "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def test_reference_ingest_is_idempotent_without_exposing_source_key() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    content = (
        "Reference corpus provenance\n"
        "source_id: official_wasabi_manual_s3\n"
        "source: official_agronomy_kr\n"
        "url: https://example.org/wasabi/manual.pdf\n\n"
        "고추냉이 근권 온도와 관수 유량을 함께 점검한다."
    )

    first, _ = store.ingest_document(
        title="wasabi_manual.pdf",
        content=content,
        scope="public",
        source_kind="public_knowledge",
        source_key="hidden-import-key-a_s3",
    )
    second, job = store.ingest_document(
        title="renamed_wasabi_manual.pdf",
        content=content,
        scope="public",
        source_kind="public_knowledge",
        source_key="hidden-import-key-b_s3",
    )

    assert first["id"] == second["id"]
    assert job["details"]["result_kind"] == "reused"
    assert job["details"]["idempotent_reuse"] is True
    assert len(store.list_documents("farm-wasabi-a")) == 1
    assert "source_key" not in json.dumps(second, ensure_ascii=False)
    assert second["canonical_source_id"] == "reference:official_wasabi_manual"
    assert second["source_locator"] == "섹션 3"
    indexed_text = store.connection.execute(
        "SELECT text FROM chunks WHERE document_id=?",
        (first["id"],),
    ).fetchone()[0]
    assert indexed_text == "고추냉이 근권 온도와 관수 유량을 함께 점검한다."
    assert "Reference corpus provenance" not in indexed_text
    store.close()


def test_reference_sections_keep_one_canonical_source_and_distinct_locators() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    documents = []
    for section in (1, 2):
        document, _ = store.ingest_document(
            title=f"Wasabi guide [sec.{section}]",
            content=(
                "Reference corpus provenance\n"
                f"source_id: scholarly_wasabi_s{section}\n"
                "source: scholarly_focus\n"
                "url: https://example.org/paper\n\n"
                f"Section {section} evidence for wasabi cultivation."
            ),
            scope="public",
            source_kind="public_knowledge",
        )
        documents.append(document)

    assert documents[0]["id"] != documents[1]["id"]
    assert {item["canonical_source_id"] for item in documents} == {"reference:scholarly_wasabi"}
    assert {item["source_locator"] for item in documents} == {"섹션 1", "섹션 2"}
    store.close()


def test_curated_source_version_refreshes_metadata_without_becoming_archive() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    body = "고추냉이 근권 온도는 생육 판단과 냉각 운전에 함께 사용한다."
    first_content = (
        "Reference corpus provenance\n"
        "url: https://example.org/wasabi/guide.pdf\n"
        "crop: wasabi\n\n"
        f"{body}"
    )
    updated_content = (
        "Reference corpus provenance\n"
        "url: https://example.org/wasabi/guide.pdf\n"
        "crop: wasabi\n"
        "cultivation_system: hydroponic\n"
        "evidence_class: peer_reviewed\n\n"
        f"{body}"
    )

    first, _ = store.ingest_document(
        title="guide.pdf",
        display_title="기존 표시 제목",
        content=first_content,
        scope="public",
        source_kind="public_knowledge",
        version="source-v1",
        source_key="curated_wasabi_guide",
    )
    updated, job = store.ingest_document(
        title="guide.pdf",
        display_title="고추냉이 근권 온도 연구",
        content=updated_content,
        scope="public",
        source_kind="public_knowledge",
        version="source-v2",
        source_key="curated_wasabi_guide",
    )

    assert updated["id"] == first["id"]
    assert job["details"]["result_kind"] == "updated"
    assert job["details"].get("idempotent_reuse") is not True
    assert updated["version"] == "source-v2"
    assert updated["title"] == "고추냉이 근권 온도 연구"
    assert updated["cultivation_system"] == "hydroponic"
    assert updated["evidence_class"] == "peer_reviewed"
    assert updated["is_research_archive"] is False
    store.close()


def test_new_source_ingest_reports_created_result() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())

    document, job = store.ingest_document(
        title="new-wasabi-guide.txt",
        content="고추냉이 새 재배 자료는 근권 온도와 관수 상태를 함께 설명한다.",
        scope="public",
        source_kind="public_knowledge",
    )

    assert document["status"] == "ready"
    assert job["status"] == "completed"
    assert job["details"]["result_kind"] == "created"
    assert job["details"].get("idempotent_reuse") is not True
    store.close()


def test_source_group_retrieval_state_blocks_every_channel_and_reactivation_restores_results() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="근권 온도 점검 근거",
        content="고추냉이 근권 온도 상승 시 관수 유량과 냉각기 상태를 함께 점검한다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
    )

    def retrieve(path: list[str]):
        return store.retrieve(
            query="고추냉이 근권 온도 관수 유량 점검",
            farm_id="farm-wasabi-a",
            include_private=False,
            selected_document_ids={document["id"]},
            retrieval_path=path,
            graph_reliability_threshold=0.0,
        )

    assert retrieve(["dense", "sparse", "graph"]).hits
    paused = store.update_source_group_retrieval_state(
        document["source_group_id"], "farm-wasabi-a", "paused"
    )
    assert paused is not None
    paused_documents, paused_job, previous_state = paused
    assert previous_state == "active"
    assert paused_job["status"] == "completed"
    assert {item["retrieval_state"] for item in paused_documents} == {"paused"}
    for path in (["dense"], ["dense", "sparse"], ["dense", "sparse", "graph"]):
        result = retrieve(path)
        assert result.hits == []
        assert result.trace["candidate_count"] == 0
        assert all(count == 0 for count in result.trace["channels"].values())

    reactivated = store.update_source_group_retrieval_state(
        document["source_group_id"], "farm-wasabi-a", "active"
    )
    assert reactivated is not None
    active_documents, active_job, previous_state = reactivated
    assert previous_state == "paused"
    assert active_job["details"]["embedding_recomputed"] is False
    assert {item["retrieval_state"] for item in active_documents} == {"active"}
    assert retrieve(["dense", "sparse", "graph"]).hits
    store.close()


def test_previous_revision_restores_content_rag_state_and_swaps_for_immediate_undo() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    original, _ = store.ingest_document(
        title="근권 운영 지침",
        content="PREVIOUS-ROOT-771 고추냉이 근권 온도는 관수 유량과 함께 점검한다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        version="v1",
        source_url="https://example.org/wasabi/root-guide",
        retrieval_state="active",
    )
    updated, _ = store.ingest_document(
        title="근권 운영 지침",
        content="CURRENT-ROOT-882 고추냉이 근권 온도는 냉각기 출력과 함께 점검한다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        version="v2",
        source_url="https://example.org/wasabi/root-guide",
        retrieval_state="needs_review",
    )
    assert updated["id"] == original["id"]
    found, revision = store.get_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert found is True
    assert revision is not None
    assert revision["document_count"] == 1
    assert revision["versions"] == ["v1"]
    assert "content" not in revision

    restored = store.restore_previous_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert restored is not None
    restored_documents, restore_job = restored
    assert restore_job["operation"] == "revision_restore_group"
    assert restore_job["status"] == "completed"
    assert restored_documents[0]["version"] == "v1"
    assert restored_documents[0]["retrieval_state"] == "active"
    detail = store.get_document(original["id"], "farm-wasabi-a")
    assert detail is not None
    assert "PREVIOUS-ROOT-771" in detail["chunks"][0]["text"]
    retrieved = store.retrieve(
        query="PREVIOUS-ROOT-771 근권 온도 관수 유량",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={original["id"]},
        retrieval_path=["dense", "sparse", "graph"],
        graph_reliability_threshold=0.0,
    )
    assert {hit.document_id for hit in retrieved.hits} == {original["id"]}

    found, swapped = store.get_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert found is True
    assert swapped is not None
    assert swapped["versions"] == ["v2"]
    undone = store.restore_previous_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert undone is not None
    undone_documents, _undo_job = undone
    assert undone_documents[0]["version"] == "v2"
    assert undone_documents[0]["retrieval_state"] == "needs_review"
    detail = store.get_document(original["id"], "farm-wasabi-a")
    assert detail is not None
    assert "CURRENT-ROOT-882" in detail["chunks"][0]["text"]
    store.close()


def test_previous_revision_restores_multi_document_group_membership_and_swaps() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    first, _ = store.ingest_document(
        title="통합 운영 자료 1쪽",
        content="GROUP-PAGE-ONE-771 고추냉이 관수 운영 첫 번째 근거입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        source_url="https://example.org/wasabi/group-guide.pdf",
        source_key="revision_group_p1",
        document_id="revision-doc-a",
    )
    second, _ = store.ingest_document(
        title="통합 운영 자료 2쪽",
        content="GROUP-PAGE-TWO-882 고추냉이 관수 운영 두 번째 근거입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        source_url="https://example.org/wasabi/group-guide.pdf",
        source_key="revision_group_p2",
        document_id="revision-doc-b",
    )
    assert first["source_group_id"] == second["source_group_id"]
    _found, revision = store.get_source_group_revision(first["source_group_id"], "farm-wasabi-a")
    assert revision is not None
    assert revision["document_count"] == 1

    restored = store.restore_previous_source_group_revision(first["source_group_id"], "farm-wasabi-a")
    assert restored is not None
    restored_documents, _job = restored
    assert {document["id"] for document in restored_documents} == {first["id"]}
    assert store.get_document(second["id"], "farm-wasabi-a") is None

    undone = store.restore_previous_source_group_revision(first["source_group_id"], "farm-wasabi-a")
    assert undone is not None
    undone_documents, _job = undone
    assert {document["id"] for document in undone_documents} == {first["id"], second["id"]}
    assert store.get_document(second["id"], "farm-wasabi-a") is not None
    store.close()


def test_delete_snapshot_restores_single_member_and_swaps_back_to_empty_group() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="삭제 복원 자료",
        content="DELETE-RESTORE-771 고추냉이 관수 삭제 복원 근거입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
    )
    assert store.delete_document(document["id"], "farm-wasabi-a") is True
    _found, revision = store.get_source_group_revision(document["source_group_id"], "farm-wasabi-a")
    assert revision is not None
    assert revision["document_count"] == 1
    deleted = store.connection.execute(
        "SELECT status, chunk_count FROM documents WHERE id=?", (document["id"],)
    ).fetchone()
    assert tuple(deleted) == ("deleted", 0)

    restored = store.restore_previous_source_group_revision(document["source_group_id"], "farm-wasabi-a")
    assert restored is not None
    assert {item["id"] for item in restored[0]} == {document["id"]}
    _found, empty_revision = store.get_source_group_revision(document["source_group_id"], "farm-wasabi-a")
    assert empty_revision is not None
    assert empty_revision["document_count"] == 0

    undone = store.restore_previous_source_group_revision(document["source_group_id"], "farm-wasabi-a")
    assert undone is not None
    assert undone[0] == []
    deleted_again = store.connection.execute(
        "SELECT status, chunk_count FROM documents WHERE id=?", (document["id"],)
    ).fetchone()
    assert tuple(deleted_again) == ("deleted", 0)
    running_jobs = store.connection.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]
    assert running_jobs == 0
    store.close()


def test_deleted_smoke_revision_stays_out_of_operator_recovery_list() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="통합 검증용 임시 자료",
        content="SMOKE-RECOVERY-HIDDEN-771 고추냉이 통합 검증 자료입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="smoke-live-v1",
        source_key="__smartfarm_smoke__:recovery-hidden-771",
    )
    assert store.delete_document(document["id"], "farm-wasabi-a") is True
    assert store.list_recoverable_source_groups("farm-wasabi-a") == []
    store.close()


def test_reindex_metadata_idempotent_and_seed_paths_do_not_create_previous_revision() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="무변경 운영 자료",
        content="NO-REVISION-771 고추냉이 관수 점검 자료입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        source_url="https://example.org/wasabi/no-revision.pdf",
        source_key="no_revision_p1",
    )
    _found, revision = store.get_source_group_revision(document["source_group_id"], "farm-wasabi-a")
    assert revision is None
    store.ingest_document(
        title="무변경 운영 자료",
        content="NO-REVISION-771 고추냉이 관수 점검 자료입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        source_url="https://example.org/wasabi/no-revision.pdf",
        source_key="no_revision_p1",
    )
    assert store.reindex_document(document["id"], "farm-wasabi-a") is not None
    store.update_source_group_metadata(
        document["source_group_id"], "farm-wasabi-a", {"title": "표시 제목만 변경"}
    )
    store.ingest_document(
        title="seed member",
        content="SEED-MEMBER-882 고추냉이 운영 자료입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        source_url="https://example.org/wasabi/no-revision.pdf",
        source_key="no_revision_p2",
        operation="seed",
    )
    store.ingest_document(
        title="무변경 운영 자료",
        content="SEED-REPAIR-993 고추냉이 관수 점검 자료입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        source_url="https://example.org/wasabi/no-revision.pdf",
        source_key="no_revision_p1",
        document_id=document["id"],
        operation="seed_repair",
    )
    _found, revision = store.get_source_group_revision(document["source_group_id"], "farm-wasabi-a")
    assert revision is None
    store.close()


@pytest.mark.parametrize("failure_stage", ["embedding", "graph"])
def test_revision_restore_failure_rolls_back_partial_group_and_keeps_previous_snapshot(
    monkeypatch, failure_stage: str
) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    common = {
        "scope": "public",
        "farm_id": "farm-wasabi-a",
        "source_kind": "public_knowledge",
        "source_url": "https://example.org/wasabi/failure-guide.pdf",
    }
    first, _ = store.ingest_document(
        title="복원 실패 자료 A",
        content="ROLLBACK-OLD-A-771 고추냉이 관수 이전 근거입니다.",
        source_key="failure_group_p1",
        document_id="failure-doc-a",
        **common,
    )
    second, _ = store.ingest_document(
        title="복원 실패 자료 B",
        content="ROLLBACK-OLD-B-772 고추냉이 근권 이전 근거입니다.",
        source_key="failure_group_p2",
        document_id="failure-doc-b",
        **common,
    )
    store.ingest_document(
        title="복원 실패 자료 A",
        content="ROLLBACK-CURRENT-A-881 고추냉이 관수 현재 근거입니다.",
        source_key="failure_group_p1",
        document_id=first["id"],
        **common,
    )
    _found, previous_before = store.get_source_group_revision(first["source_group_id"], "farm-wasabi-a")
    assert previous_before is not None

    if failure_stage == "embedding":
        original_embed = store.embedding.embed_passages
        embed_calls = 0

        def fail_second_restore_embedding(texts):
            nonlocal embed_calls
            embed_calls += 1
            if embed_calls == 2:
                raise RuntimeError("forced_second_member_failure")
            return original_embed(texts)

        monkeypatch.setattr(store.embedding, "embed_passages", fail_second_restore_embedding)
    else:
        original_graph_upsert = store.graph.upsert_document
        graph_calls = 0

        def fail_second_restore_graph(document, chunks):
            nonlocal graph_calls
            graph_calls += 1
            if graph_calls == 2:
                raise RuntimeError("forced_second_member_graph_failure")
            return original_graph_upsert(document, chunks)

        monkeypatch.setattr(store.graph, "upsert_document", fail_second_restore_graph)
    with pytest.raises(KnowledgeRevisionRestoreError) as raised:
        store.restore_previous_source_group_revision(first["source_group_id"], "farm-wasabi-a")
    failed_job = store.get_job(raised.value.job_id)
    assert failed_job is not None
    assert failed_job["status"] == "failed"
    assert failed_job["details"]["rollback_succeeded"] is True
    current_first = store.get_document(first["id"], "farm-wasabi-a")
    current_second = store.get_document(second["id"], "farm-wasabi-a")
    assert current_first is not None and "ROLLBACK-CURRENT-A-881" in current_first["chunks"][0]["text"]
    assert current_second is not None and "ROLLBACK-OLD-B-772" in current_second["chunks"][0]["text"]
    _found, previous_after = store.get_source_group_revision(first["source_group_id"], "farm-wasabi-a")
    assert previous_after is not None
    assert previous_after["id"] == previous_before["id"]
    running_jobs = store.connection.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]
    assert running_jobs == 0
    store.close()


def test_revision_restore_late_job_failure_restores_current_and_original_revision(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    original, _ = store.ingest_document(
        title="늦은 실패 복원 자료",
        content="LATE-PREVIOUS-771 고추냉이 관수 이전 근거입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        version="v1",
        source_url="https://example.org/wasabi/late-restore.pdf",
    )
    current, _ = store.ingest_document(
        title="늦은 실패 복원 자료",
        content="LATE-CURRENT-882 고추냉이 냉각 현재 근거입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        version="v2",
        source_url="https://example.org/wasabi/late-restore.pdf",
    )
    _found, revision_before = store.get_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert revision_before is not None
    original_finish_job = store._finish_job
    late_failure_injected = False

    def fail_once_after_revision_swap(job_id, *, details, error=None):
        nonlocal late_failure_injected
        job = store.get_job(job_id)
        if (
            not late_failure_injected
            and error is None
            and job is not None
            and job["operation"] == "revision_restore_group"
            and details.get("swapped_revision_id")
        ):
            late_failure_injected = True
            raise RuntimeError("forced_late_finish_failure")
        return original_finish_job(job_id, details=details, error=error)

    monkeypatch.setattr(store, "_finish_job", fail_once_after_revision_swap)
    with pytest.raises(KnowledgeRevisionRestoreError) as raised:
        store.restore_previous_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    failed_job = store.get_job(raised.value.job_id)
    assert failed_job is not None
    assert failed_job["status"] == "failed"
    assert failed_job["details"]["rollback_succeeded"] is True
    assert failed_job["details"]["revision_rollback_succeeded"] is True
    current_detail = store.get_document(current["id"], "farm-wasabi-a")
    assert current_detail is not None
    assert "LATE-CURRENT-882" in current_detail["chunks"][0]["text"]
    _found, revision_after = store.get_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert revision_after is not None
    assert revision_after["id"] == revision_before["id"]
    assert revision_after["versions"] == ["v1"]

    restored = store.restore_previous_source_group_revision(original["source_group_id"], "farm-wasabi-a")
    assert restored is not None
    assert restored[0][0]["version"] == "v1"
    store.close()


def test_source_group_uploads_are_serialized_without_losing_the_immediate_previous_revision(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    initial, _ = store.ingest_document(
        title="동시 업로드 자료",
        content="CONCURRENT-V1-771 고추냉이 관수 최초 근거입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        version="v1",
        operation="upload",
        original_filename="concurrent-manual.txt",
    )
    barrier = Barrier(2)
    snapshot_barrier = Barrier(2)
    original_snapshot = store._source_group_snapshot

    def synchronized_snapshot(*args, **kwargs):
        snapshot = original_snapshot(*args, **kwargs)
        try:
            snapshot_barrier.wait(timeout=0.2)
        except BrokenBarrierError:
            pass
        return snapshot

    monkeypatch.setattr(store, "_source_group_snapshot", synchronized_snapshot)

    def upload(version: str) -> str:
        barrier.wait(timeout=5)
        document, _job = store.ingest_document(
            title="동시 업로드 자료",
            content=f"CONCURRENT-{version.upper()} 고추냉이 관수 갱신 근거입니다.",
            scope="public",
            farm_id="farm-wasabi-a",
            source_kind="public_knowledge",
            version=version,
            operation="upload",
            original_filename="concurrent-manual.txt",
        )
        return document["version"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        completed = list(executor.map(upload, ("v2", "v3")))
    assert set(completed) == {"v2", "v3"}
    documents = [
        document
        for document in store.list_documents("farm-wasabi-a")
        if document["source_group_id"] == initial["source_group_id"]
    ]
    assert len(documents) == 1
    _found, previous = store.get_source_group_revision(initial["source_group_id"], "farm-wasabi-a")
    assert previous is not None
    assert {documents[0]["version"], *previous["versions"]} == {"v2", "v3"}
    store.close()


def test_upload_delete_and_restore_never_enter_one_group_mutation_concurrently(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="동시 변경 통합 자료",
        content="SERIAL-V1-771 고추냉이 관수 최초 근거입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="v1",
        operation="upload",
        original_filename="serialized-operations.txt",
    )
    store.ingest_document(
        title="동시 변경 통합 자료",
        content="SERIAL-V2-882 고추냉이 냉각 현재 근거입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="v2",
        operation="upload",
        original_filename="serialized-operations.txt",
    )
    counter_lock = Lock()
    thread_depth: dict[int, int] = {}
    active_threads: set[int] = set()
    max_active_threads = 0
    entry_barrier = Barrier(3)

    def instrument(original):
        def wrapped(*args, **kwargs):
            nonlocal max_active_threads
            thread_id = get_ident()
            with counter_lock:
                depth = thread_depth.get(thread_id, 0)
                thread_depth[thread_id] = depth + 1
                if depth == 0:
                    active_threads.add(thread_id)
                    max_active_threads = max(max_active_threads, len(active_threads))
            if depth == 0:
                try:
                    entry_barrier.wait(timeout=0.2)
                except BrokenBarrierError:
                    pass
            try:
                return original(*args, **kwargs)
            finally:
                with counter_lock:
                    remaining = thread_depth[thread_id] - 1
                    if remaining:
                        thread_depth[thread_id] = remaining
                    else:
                        thread_depth.pop(thread_id)
                        active_threads.discard(thread_id)

        return wrapped

    monkeypatch.setattr(store, "_ingest_document", instrument(store._ingest_document))
    monkeypatch.setattr(store, "_delete_document", instrument(store._delete_document))
    monkeypatch.setattr(
        store,
        "_restore_previous_source_group_revision",
        instrument(store._restore_previous_source_group_revision),
    )
    start = Barrier(3)

    def upload():
        start.wait(timeout=5)
        return store.ingest_document(
            title="동시 변경 통합 자료",
            content="SERIAL-V3-993 고추냉이 환기 갱신 근거입니다.",
            scope="private",
            farm_id="farm-wasabi-a",
            source_kind="private_knowledge",
            version="v3",
            operation="upload",
            original_filename="serialized-operations.txt",
        )

    def delete():
        start.wait(timeout=5)
        return store.delete_document(document["id"], "farm-wasabi-a")

    def restore():
        start.wait(timeout=5)
        return store.restore_previous_source_group_revision(document["source_group_id"], "farm-wasabi-a")

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(operation) for operation in (upload, delete, restore)]
        for future in futures:
            future.result(timeout=10)
    assert max_active_threads == 1
    assert not active_threads
    store.close()


def test_local_file_root_groups_page_locators_but_preserves_farm_and_scope_isolation() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())

    def ingest(*, farm_id: str, scope: str, page: int):
        return store.ingest_document(
            title=f"local manual page {page}",
            content=f"LOCAL-FILE-PAGE-{page} 고추냉이 운영 근거입니다.",
            scope=scope,
            farm_id=farm_id,
            source_kind="private_knowledge" if scope == "private" else "public_knowledge",
            source_key=f"local_manual_p{page}",
            original_filename="local-manual.pdf",
            operation="upload",
        )[0]

    farm_a_page_1 = ingest(farm_id="farm-wasabi-a", scope="public", page=1)
    farm_a_page_2 = ingest(farm_id="farm-wasabi-a", scope="public", page=2)
    farm_b_page_1 = ingest(farm_id="farm-other", scope="public", page=1)
    farm_a_private = ingest(farm_id="farm-wasabi-a", scope="private", page=1)
    assert farm_a_page_1["id"] != farm_a_page_2["id"]
    assert farm_a_page_1["source_group_id"] == farm_a_page_2["source_group_id"]
    assert farm_b_page_1["source_group_id"] != farm_a_page_1["source_group_id"]
    assert farm_a_private["source_group_id"] != farm_a_page_1["source_group_id"]
    store.close()


def test_existing_content_identity_upload_migrates_to_stable_file_root(tmp_path) -> None:
    database_path = tmp_path / "legacy-local-upload.db"
    store = KnowledgeStore(str(database_path), embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="legacy-manual.txt",
        content="LEGACY-FILE-V1-771 고추냉이 관수 이전 근거입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="v1",
        operation="upload",
        original_filename="legacy-manual.txt",
    )
    row = store.connection.execute(
        "SELECT content_checksum FROM documents WHERE id=?", (document["id"],)
    ).fetchone()
    legacy_canonical = f"content:{row['content_checksum']}"
    with store.connection:
        store.connection.execute(
            "UPDATE documents SET canonical_source_id=?, source_group_id=? WHERE id=?",
            (
                legacy_canonical,
                f"source-group:private:owner:farm-wasabi-a:{legacy_canonical}",
                document["id"],
            ),
        )
    store.close()

    reopened = KnowledgeStore(str(database_path), embedding_runtime=degraded_runtime())
    migrated = reopened.list_documents("farm-wasabi-a")[0]
    assert "file:" in migrated["source_group_id"]
    updated, _ = reopened.ingest_document(
        title="legacy-manual.txt",
        content="LEGACY-FILE-V2-882 고추냉이 냉각 현재 근거입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="v2",
        operation="upload",
        original_filename="legacy-manual.txt",
    )
    assert updated["id"] == document["id"]
    _found, previous = reopened.get_source_group_revision(updated["source_group_id"], "farm-wasabi-a")
    assert previous is not None
    assert previous["versions"] == ["v1"]
    reopened.close()


def test_default_rag_quality_gate_quarantines_irrelevant_legacy_sources() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    legacy_sources = [
        (
            "legacy-wasabi-zuke",
            "Wasabi zuke | Our Regional Cuisines",
            "https://www.maff.go.jp/e/policies/market/k_ryouri/search_menu/1975/index.html",
            "official_agronomy_jp_zuke_s1",
            "crop: wasabi\n\nWasabi zuke recipe and serving instructions.",
        ),
        (
            "legacy-valentine-event",
            "バレンタイン・ホワイトデーイベントのご案内",
            "https://izu-wasavc.city.izu.shizuoka.jp/valentine-event/",
            "official_izu_wasabi_event",
            "crop: wasabi\n\nVisitor center Valentine event notice.",
        ),
        (
            "legacy-visitor-center",
            "トップページ - 伊豆わさビジターセンター",
            "https://izu-wasavc.city.izu.shizuoka.jp/",
            "official_izu_wasabi_public_s2",
            "crop: wasabi\n\nVisitor center hours, tours, shops, and telephone numbers.",
        ),
        (
            "legacy-ogalpi-page",
            "official_agronomy_kr [p.25]",
            "https://www.nongsaro.go.kr/portal/ps/psb/psbx/cropsEbookWonFileDownload.do?ebookCode=57",
            "official_agronomy_kr_book_p25_25",
            "\n\n오갈피나무와 가시오갈피 번식 방법을 설명한다.",
        ),
        (
            "legacy-konjac-page",
            "official_agronomy_kr [p.46]",
            "https://www.nongsaro.go.kr/portal/ps/psb/psbx/cropsEbookWonFileDownload.do?ebookCode=57",
            "official_agronomy_kr_book_p46_46",
            "\n\n곤약의 재배 특성을 설명한다.",
        ),
    ]
    for document_id, title, source_url, source_key, body in legacy_sources:
        store.ingest_document(
            title=f"[legacy:{source_key}] {title}",
            content=f"Reference corpus provenance\nurl: {source_url}\n{body}",
            scope="public",
            source_kind="public_knowledge",
            version="legacy-release-v1",
            source_key=source_key,
            document_id=document_id,
        )

    eligible_legacy, _ = store.ingest_document(
        title="[legacy:official_agronomy_kr_book_p34_34] 고추냉이 재배 기술 [p.34]",
        content=(
            "Reference corpus provenance\n"
            "url: https://www.nongsaro.go.kr/portal/ps/psb/psbx/cropsEbookWonFileDownload.do?ebookCode=57\n"
            "crop: wasabi\n\n"
            "고추냉이 포장의 수온과 그늘 환경을 점검한다."
        ),
        scope="public",
        source_kind="public_knowledge",
        version="legacy-release-v1",
        source_key="official_agronomy_kr_book_p34_34",
        document_id="legacy-wasabi-page-34",
    )
    current_public, _ = store.ingest_document(
        title="고추냉이 펄라이트 운영 지침",
        content="고추냉이 근권 온도와 관수 유량을 함께 점검한다.",
        scope="public",
        source_kind="public_knowledge",
        version="source-2026-v1",
    )
    private_sop, _ = store.ingest_document(
        title="고추냉이 A동 운영 SOP",
        content="근권 고온 경보에서는 냉각기 출력과 관수 유량을 확인한다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
    )
    user_upload, _ = store.ingest_document(
        title="농가가 업로드한 관수 메모",
        content="고추냉이 관수 유량과 배액 상태를 기록한 사용자 자료다.",
        scope="public",
        source_kind="public_knowledge",
    )
    e2e_artifact, _ = store.ingest_document(
        title="E2E 고추냉이 근권·관수 대응 메모",
        content="RAG-DEMO-test: 반복 검증을 위해 생성한 임시 문서다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="verify-v1",
    )

    listed_ids = {item["id"] for item in store.list_documents("farm-wasabi-a")}
    quarantined_ids = {item[0] for item in legacy_sources} | {e2e_artifact["id"]}
    assert listed_ids.isdisjoint(quarantined_ids)
    assert {eligible_legacy["id"], current_public["id"], private_sop["id"], user_upload["id"]} <= listed_ids

    for document_id in quarantined_ids:
        result = store.retrieve(
            query="고추냉이 재배 자료",
            farm_id="farm-wasabi-a",
            include_private=True,
            selected_document_ids={document_id},
            retrieval_path=["dense", "sparse", "graph"],
        )
        assert result.hits == []
        assert result.trace["candidate_count"] == 0
        assert store.get_document(document_id, "farm-wasabi-a") is not None

    selected, ignored, include_private = store.resolve_selected_document_ids(
        ["legacy-wasabi-zuke", private_sop["id"]], "farm-wasabi-a"
    )
    assert selected == {private_sop["id"]}
    assert ignored == ["legacy-wasabi-zuke"]
    assert include_private is True
    readiness = store.readiness()
    assert readiness["documents"] == 4
    assert readiness["chunks"] == 4
    assert readiness["vectors"] == 4
    store.close()


def test_answerability_gate_rejects_unsupported_queries_but_preserves_relevant_hits() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="고추냉이 펄라이트 양액 지침",
        content="고추냉이 펄라이트 고설베드의 양액 EC는 1.8~2.4 범위이고 pH는 6.2를 기준으로 점검한다.",
        scope="public",
        source_kind="public_knowledge",
    )

    relevant = store.retrieve(
        query="고추냉이 펄라이트 양액 EC 1.8~2.4와 pH 6.2 근거는?",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense", "sparse", "graph"],
    )
    unsupported = store.retrieve(
        query="프랑스 수도의 달 탐사선 발사 날짜는 언제인가?",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense", "sparse", "graph"],
    )
    selected_but_unsupported = store.retrieve(
        query="프랑스 수도의 달 탐사선 발사 날짜는 언제인가?",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={document["id"]},
        retrieval_path=["dense", "sparse", "graph"],
        explicit_single_source_selection=True,
    )

    assert relevant.trace["answerable"] is True
    assert relevant.hits[0].document_id == document["id"]
    assert relevant.trace["answerability"]["signals"]["numeric_overlap"]
    assert unsupported.hits == []
    assert unsupported.trace["answerable"] is False
    assert unsupported.trace["returned_count"] == 0
    assert unsupported.trace["answerability_reason"] == "no_supported_query_evidence_alignment"
    assert selected_but_unsupported.hits == []
    assert selected_but_unsupported.trace["answerable"] is False
    store.close()


def test_live_corpus_graph_relationship_query_keeps_supported_source_chunks(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    store.seed_defaults()
    selected_ids = {
        "public:wasabi:fao-traditional-water:2020",
        "public:wasabi:jstage-root-zone-temperature:2009",
        "public:wasabi:nies-soft-rot-risk:2019",
        "public:wasabi:nongsaro-perlite-field-case:2026",
    }

    def dense_scores(_query_vector, allowed, _filters, _limit):
        return {
            chunk_id: (
                0.99
                if chunk_id.startswith("public:wasabi:nongsaro-perlite-field-case:2026:")
                else 0.41
            )
            for chunk_id in allowed
        }

    monkeypatch.setattr(store, "_qdrant_dense_scores", dense_scores)
    result = store.retrieve(
        query="선택한 공개 자료만 근거로 고추냉이 수온, 흐르는 물의 산소 공급, 연부병 위험의 관계를 설명해줘.",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=selected_ids,
        retrieval_path=["dense", "sparse", "graph"],
        channel_weights={"dense": 0.55, "sparse": 0.25, "graph": 0.2},
        graph_reliability_threshold=0.62,
    )

    returned_ids = {hit.document_id for hit in result.hits}
    assert result.trace["graph_gate"]["enabled"] is True
    assert result.trace["graph_gate"]["verified_candidate_count"] >= 3
    assert result.trace["answerable"] is True
    assert {
        "public:wasabi:fao-traditional-water:2020",
        "public:wasabi:nies-soft-rot-risk:2019",
    } <= returned_ids
    assert all(hit.scope == "public" for hit in result.hits)
    store.close()


def test_answerability_normalizes_numeric_range_separators() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="물와사비 연부병 수온 자료",
        content="물와사비는 수온 18-19℃ 이상에서 연부병 발생 위험이 증가한다.",
        scope="public",
        source_kind="public_knowledge",
    )

    result = store.retrieve(
        query="물와사비 수온이 18~19도 이상일 때 연부병 위험은?",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense"],
    )

    assert result.trace["answerable"] is True
    assert result.trace["answerability"]["signals"]["numeric_overlap"] == ["18-19"]
    assert result.hits[0].document_id == document["id"]
    store.close()


def test_numeric_anchor_does_not_hide_an_unsupported_subject() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    store.ingest_document(
        title="2026 고추냉이 양액 운영 자료",
        content="고추냉이 펄라이트 재배에서는 근권 온도와 관수 유량을 점검한다. 2026년 현장 기록이다.",
        scope="public",
        source_kind="public_knowledge",
        published_year=2026,
    )

    result = store.retrieve(
        query="2026년 고추냉이 CRISPR 유전자 편집 연구 결과를 알려줘",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense", "sparse", "graph"],
    )

    assert result.hits == []
    assert result.trace["answerable"] is False
    assert result.trace["answerability"]["signals"]["numeric_overlap"] == ["2026"]
    assert result.trace["answerability"]["query_signals"][
        "anchor_subject_alignment_satisfied"
    ] is False
    store.close()


@pytest.mark.parametrize(
    "query",
    [
        "순환수경 고추냉이에서 명기 공기온도 16·20·25도와 양액온도 13도를 비교한 결과는 무엇인가?",
        "양액온도 20도에서도 간헐 급액과 뿌리 산소 공급이 생육에 어떤 영향을 주었는가?",
    ],
)
def test_multilingual_dense_support_preserves_anchored_hydroponic_queries(
    query: str,
    monkeypatch,
) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    expected, _ = store.ingest_document(
        title="고추냉이 순환수경의 공기·양액 온도 실험",
        content=(
            "Experiments used a circulation-type hydroponics system for Japanese horseradish. "
            "The light-period air temperatures were 16, 20, and 25°C while nutrient solution "
            "temperature was maintained at 13°C. "
            + "Indoor cultivation conditions were recorded for comparison. " * 12
            + "Plants were also cultivated at solution temperatures of 13 and 20°C. "
            "An intermittent supply of 20°C solution promoted growth because it enhanced "
            "oxygen supplies to the roots."
        ),
        scope="public",
        source_kind="public_knowledge",
        summary="공식 영문 초록을 색인한 고추냉이 순환수경 논문입니다.",
    )
    distractor, _ = store.ingest_document(
        title="고추냉이 펄라이트 생육 기록",
        content="고추냉이 뿌리 생육과 양액 운전 기록에서 20도를 점검했다.",
        scope="public",
        source_kind="public_knowledge",
    )
    expected_chunks = store.connection.execute(
        "SELECT id, text FROM chunks WHERE document_id=? ORDER BY ordinal",
        (expected["id"],),
    ).fetchall()
    assert len(expected_chunks) >= 2
    air_chunk = next(row for row in expected_chunks if "16, 20, and 25" in row["text"])
    oxygen_chunk = next(row for row in expected_chunks if "oxygen supplies" in row["text"])

    def multilingual_dense_scores(_query_vector, allowed, _filters, _limit):
        return {
            chunk_id: (
                0.65
                if chunk_id == oxygen_chunk["id"]
                else 0.64
                if chunk_id == air_chunk["id"]
                else 0.24
                if chunk_id.startswith(f"{distractor['id']}:")
                else 0.1
            )
            for chunk_id in allowed
        }

    monkeypatch.setattr(store, "_qdrant_dense_scores", multilingual_dense_scores)
    result = store.retrieve(
        query=query,
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={expected["id"], distractor["id"]},
        retrieval_path=["dense"],
    )

    assert result.trace["answerable"] is True
    assert result.trace["answerability"]["query_signals"]["anchor_semantic_alignment"] is True
    assert result.hits[0].document_id == expected["id"]
    store.close()


@pytest.mark.parametrize(
    "query",
    [
        "고추냉이 CRISPR 유전자 편집 성공률은?",
        "ISO-WASABI-9999 규격의 제7조 안전계수는?",
        "고추냉이 잎의 비소 77 ppm 허용 기준은?",
    ],
)
def test_open_corpus_rejects_high_dense_matches_without_subject_or_anchor_support(
    query: str,
    monkeypatch,
) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="고추냉이 잎 재배 기준",
        content="고추냉이 잎 생산과 ISO wasabi 시설의 온도, 관수 기준을 설명한다.",
        scope="public",
        source_kind="public_knowledge",
    )
    chunk_id = f"{document['id']}:chunk-001"
    monkeypatch.setattr(
        store,
        "_qdrant_dense_scores",
        lambda *_args, **_kwargs: {chunk_id: 0.95},
    )

    result = store.retrieve(
        query=query,
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense"],
    )

    assert result.hits == []
    assert result.trace["answerable"] is False
    store.close()


def test_answerability_supporting_chunk_is_kept_in_returned_citations(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="고추냉이 시설 환경 기록",
        content=("고추냉이 시설 일반 운영 기록입니다. " * 35)
        + "\n고추냉이 시설 이산화탄소 4242 기준과 천창·측창·환기팬 구성을 확인한다.",
        scope="public",
        source_kind="public_knowledge",
    )
    assert document["chunk_count"] >= 2

    def reversed_dense_scores(_query_vector, allowed, _filters, _limit):
        return {
            chunk_id: 0.99 if chunk_id.endswith("chunk-001") else 0.10
            for chunk_id in allowed
        }

    monkeypatch.setattr(store, "_qdrant_dense_scores", reversed_dense_scores)
    result = store.retrieve(
        query="고추냉이 시설 이산화탄소 4242와 천창·측창·환기팬 구성은?",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense"],
    )

    supporting_chunk = result.trace["answerability"]["signals"]["chunk_id"]
    assert result.trace["answerable"] is True
    assert supporting_chunk is not None
    assert result.hits[0].chunk_id == supporting_chunk
    store.close()


@pytest.mark.parametrize(
    "query",
    [
        "고추냉이 CRISPR 성공률은?",
        "고추냉이 비소 허용 기준은?",
        "이 실험에서 프랑스 수도는?",
    ],
)
def test_single_selected_source_requires_subject_bearing_overlap(query: str) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="고추냉이 근권 온도 실험",
        content="고추냉이 근권 수온을 13도와 18도로 나누어 생육 차이를 관찰한 실험이다.",
        scope="public",
        source_kind="public_knowledge",
    )

    result = store.retrieve(
        query=query,
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={document["id"]},
        retrieval_path=["dense", "sparse", "graph"],
        explicit_single_source_selection=True,
    )

    assert result.hits == []
    assert result.trace["answerable"] is False
    assert "explicit_selected_source_context" not in result.trace["answerability"]["matched_rules"]
    store.close()


def test_single_selected_source_allows_a_genuine_document_summary_request() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="고추냉이 근권 온도 실험",
        content="고추냉이 근권 수온을 13도와 18도로 나누어 생육 차이를 관찰한 실험이다.",
        scope="public",
        source_kind="public_knowledge",
    )

    result = store.retrieve(
        query="이 문서 내용을 요약해줘",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={document["id"]},
        retrieval_path=["dense", "sparse", "graph"],
        explicit_single_source_selection=True,
    )

    assert result.hits[0].document_id == document["id"]
    assert result.trace["answerable"] is True
    assert result.trace["answerability_reason"] == "explicit_selected_source_context"
    store.close()


def test_open_corpus_caps_chunks_per_canonical_source_and_single_group_can_relax() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    first_source_ids: set[str] = set()
    for page in (1, 2, 3):
        document, _ = store.ingest_document(
            title=f"고추냉이 근권 지침 {page}",
            content=f"RAG-DIVERSITY-42 고추냉이 근권 온도와 관수 점검 원칙 {page}.",
            scope="public",
            source_kind="public_knowledge",
            source_url="https://example.org/wasabi-guide.pdf",
            source_key=f"wasabi_guide_p{page}",
        )
        first_source_ids.add(document["id"])
    for page in (1, 2):
        store.ingest_document(
            title=f"고추냉이 보조 지침 {page}",
            content=f"RAG-DIVERSITY-42 고추냉이 근권 온도 기록과 관수 확인 {page}.",
            scope="public",
            source_kind="public_knowledge",
            source_url="https://example.org/secondary-guide.pdf",
            source_key=f"secondary_guide_p{page}",
        )

    default = store.retrieve(
        query="RAG-DIVERSITY-42 고추냉이 근권 온도와 관수 근거",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=None,
        retrieval_path=["dense", "sparse", "graph"],
    )
    relaxed = store.retrieve(
        query="RAG-DIVERSITY-42 고추냉이 근권 온도와 관수 근거",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids=first_source_ids,
        retrieval_path=["dense", "sparse", "graph"],
        relax_source_diversity=True,
    )

    default_first_source_count = sum(hit.document_id in first_source_ids for hit in default.hits)
    assert len(default.hits) == 4
    assert default_first_source_count == 2
    assert default.trace["source_diversity"]["max_chunks_per_canonical_source"] == 2
    assert len(relaxed.hits) == 3
    assert relaxed.trace["source_diversity"]["relaxed_for_single_selected_source_group"] is True
    store.close()


def test_smoke_live_documents_are_quarantined_from_open_corpus_but_remain_explicitly_probeable() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    smoke, _ = store.ingest_document(
        title="통합 검증용 고추냉이 메모",
        content="SMOKE-QUARANTINE-77 고추냉이 근권 온도와 관수 유량을 함께 확인한다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        version="smoke-live-v1",
        source_key="__smartfarm_smoke__:quarantine-77",
    )

    open_corpus = store.retrieve(
        query="SMOKE-QUARANTINE-77 고추냉이 근권 온도",
        farm_id="farm-wasabi-a",
        include_private=True,
        selected_document_ids=None,
        retrieval_path=["dense", "sparse", "graph"],
    )
    explicit = store.retrieve(
        query="SMOKE-QUARANTINE-77 고추냉이 근권 온도",
        farm_id="farm-wasabi-a",
        include_private=True,
        selected_document_ids={smoke["id"]},
        retrieval_path=["dense", "sparse", "graph"],
    )

    assert open_corpus.hits == []
    assert open_corpus.trace["candidate_count"] == 0
    assert explicit.hits[0].document_id == smoke["id"]
    assert smoke["is_smoke_artifact"] is True
    assert "source_key" not in smoke
    store.close()


def test_smoke_marker_requires_all_private_artifact_conditions() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())

    def ingest(
        title: str,
        *,
        scope: str = "private",
        source_kind: str = "private_knowledge",
        version: str = "smoke-live-v1",
        source_key: str = "__smartfarm_smoke__:run-1",
    ) -> dict[str, object]:
        document, _ = store.ingest_document(
            title=title,
            content=f"{title} 고추냉이 근권 검증 문서입니다.",
            scope=scope,  # type: ignore[arg-type]
            farm_id="farm-wasabi-a" if scope == "private" else None,
            source_kind=source_kind,
            version=version,
            source_key=source_key,
        )
        return document

    exact = ingest("정확한 smoke 문서")
    wrong_version = ingest("일반 버전 문서", version="v1")
    wrong_key = ingest("일반 내부 문서", source_key="private-run-1")
    empty_suffix = ingest("빈 smoke 식별자 문서", source_key="__smartfarm_smoke__:")
    public_document = ingest("공개 smoke 유사 문서", scope="public", source_kind="public_knowledge")

    assert exact["is_smoke_artifact"] is True
    assert all(
        document["is_smoke_artifact"] is False
        for document in (wrong_version, wrong_key, empty_suffix, public_document)
    )
    assert all("source_key" not in document for document in (exact, wrong_version, wrong_key, empty_suffix, public_document))
    store.close()


def test_qdrant_payload_and_query_apply_wasabi_profile_filter_before_search(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    calls: list[tuple[str, str, dict | None]] = []
    monkeypatch.setattr(store, "_ensure_qdrant", lambda: True)

    def fake_qdrant(method: str, path: str, payload: dict | None = None):
        calls.append((method, path, payload))
        if path.endswith("/points/query"):
            return {"result": {"points": []}}
        return {}

    monkeypatch.setattr(store, "_run_qdrant", fake_qdrant)
    document, _ = store.ingest_document(
        title="고추냉이 펄라이트 운영 지침",
        content=(
            "Reference corpus provenance\n"
            "source_id: official_wasabi_perlite_s1\n"
            "source: official_agronomy_kr\n"
            "crop: wasabi\n"
            "cultivation_system: perlite_substrate\n"
            "evidence_class: official_agronomy\n"
            "growth_stage: leaf_production\n\n"
            "고추냉이 잎 생산에서 근권 온도와 관수 상태를 확인한다."
        ),
        scope="public",
        source_kind="public_knowledge",
    )

    upsert = next(payload for method, path, payload in calls if method == "PUT" and "/points" in path)
    point_payload = upsert["points"][0]["payload"]
    assert point_payload["canonical_source_id"] == "reference:official_wasabi_perlite"
    assert point_payload["crop"] == "wasabi"
    assert point_payload["cultivation_system"] == "perlite_substrate"
    assert point_payload["evidence_class"] == "official_agronomy"
    assert point_payload["growth_stage"] == "leaf_production"

    calls.clear()
    store.retrieve(
        query="근권 온도",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={document["id"]},
        retrieval_path=["dense"],
        profile_filters={"crop": "wasabi", "cultivation_system": {"perlite_substrate"}},
    )
    query_payload = next(payload for method, path, payload in calls if method == "POST" and path.endswith("/points/query"))
    conditions = {condition["key"]: condition["match"]["any"] for condition in query_payload["filter"]["must"]}
    assert conditions["document_id"] == [document["id"]]
    assert conditions["crop"] == ["wasabi"]
    assert conditions["cultivation_system"] == ["perlite_substrate"]
    store.close()


def test_readiness_is_read_only(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", qdrant_url="http://qdrant.test", embedding_runtime=degraded_runtime())
    store.ingest_document(
        title="Wasabi note",
        content="Wasabi root-zone temperature note.",
        scope="public",
        source_kind="public_knowledge",
    )
    monkeypatch.setattr(store, "sync_qdrant_mirror", lambda: pytest.fail("readiness must not synchronize Qdrant"))
    monkeypatch.setattr(store, "sync_graph_mirror", lambda: pytest.fail("readiness must not synchronize FalkorDB"))
    calls: list[tuple[str, str]] = []

    def read_only_qdrant(method: str, path: str, payload=None):
        calls.append((method, path))
        return None

    monkeypatch.setattr(store, "_run_qdrant", read_only_qdrant)
    readiness = store.readiness()

    assert readiness["embedding"]["degraded"] is True
    assert calls and all(method == "GET" for method, _path in calls)
    store.close()


def test_metadata_update_uses_qdrant_payload_only_without_reembedding(monkeypatch) -> None:
    monkeypatch.delenv("QDRANT_URL", raising=False)
    monkeypatch.delenv("FALKORDB_URL", raising=False)
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="owned-qdrant-metadata.txt",
        content="QDRANT-METADATA-771 고추냉이 관수 자료입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
    )
    chunk = store.connection.execute(
        "SELECT id, embedding FROM chunks WHERE document_id=?", (document["id"],)
    ).fetchone()
    with store.connection:
        store.connection.execute(
            "UPDATE documents SET qdrant_vector_count=1, index_backend='qdrant' WHERE id=?",
            (document["id"],),
        )
    store.qdrant_url = "http://qdrant.test"
    calls: list[tuple[str, str, dict | None]] = []

    def fake_qdrant(method: str, path: str, payload=None):
        calls.append((method, path, payload))
        return {}

    monkeypatch.setattr(store, "_run_qdrant", fake_qdrant)
    monkeypatch.setattr(
        store.embedding,
        "embed_passages",
        lambda _texts: pytest.fail("metadata update must not regenerate embeddings"),
    )

    updated, job, _ = store.update_source_group_metadata(
        document["source_group_id"],
        "farm-wasabi-a",
        {"title": "Qdrant payload 수정 자료", "published_year": 2026},
    ) or ([], {}, "")

    payload_call = next(call for call in calls if call[0] == "POST")
    assert payload_call[1].endswith("/points/payload?wait=true")
    assert payload_call[2]["payload"]["title"] == "Qdrant payload 수정 자료"
    assert payload_call[2]["payload"]["source_group_id"] == document["source_group_id"]
    assert "vector" not in json.dumps(payload_call[2])
    assert payload_call[2]["points"]
    assert updated[0]["source_group_id"] == document["source_group_id"]
    assert job["details"]["embedding_recomputed"] is False
    assert store.connection.execute("SELECT embedding FROM chunks WHERE id=?", (chunk["id"],)).fetchone()[0] == chunk["embedding"]
    store.close()


def test_metadata_update_failure_compensates_mirrors_and_finishes_job(monkeypatch) -> None:
    monkeypatch.delenv("QDRANT_URL", raising=False)
    monkeypatch.delenv("FALKORDB_URL", raising=False)
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="owned-mirror-rollback.txt",
        content="MIRROR-ROLLBACK-771 고추냉이 관수 자료입니다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
    )
    with store.connection:
        store.connection.execute(
            "UPDATE documents SET qdrant_vector_count=1, index_backend='qdrant' WHERE id=?",
            (document["id"],),
        )
    store.qdrant_url = "http://qdrant.test"
    store.graph.url = "redis://falkor.test:6379"
    qdrant_calls: list[dict] = []
    graph_calls: list[list[dict]] = []

    def qdrant_metadata(_chunk_ids, payload):
        qdrant_calls.append(dict(payload))
        return True

    def graph_metadata(documents, _expected_chunks):
        graph_calls.append([dict(item) for item in documents])
        return len(graph_calls) > 1

    monkeypatch.setattr(store, "_qdrant_set_metadata", qdrant_metadata)
    monkeypatch.setattr(store.graph, "update_documents_metadata", graph_metadata)
    monkeypatch.setattr(
        store.embedding,
        "embed_passages",
        lambda _texts: pytest.fail("metadata update must not regenerate embeddings"),
    )

    with pytest.raises(KnowledgeMetadataUpdateError) as failure:
        store.update_source_group_metadata(
            document["source_group_id"], "farm-wasabi-a", {"title": "적용되면 안 되는 제목"}
        )

    stored = store.get_document(document["id"], "farm-wasabi-a")
    job = store.get_job(failure.value.job_id)
    running = store.connection.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]
    assert stored["title"] == document["title"]
    assert len(qdrant_calls) == 2
    assert qdrant_calls[0]["title"] == "적용되면 안 되는 제목"
    assert qdrant_calls[1]["title"] == document["title"]
    assert len(graph_calls) == 2
    assert job["status"] == "failed"
    assert job["details"]["rollback"] == {"falkordb": True, "qdrant": True}
    assert job["details"]["mirror_dirty"] is False
    assert running == 0
    store.close()


def test_metadata_update_response_failure_rolls_back_sqlite_and_finishes_job(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="owned-response-rollback.txt",
        content="RESPONSE-ROLLBACK-771 고추냉이 관수 자료입니다.",
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
    )
    original_document_record = store._document_record

    def fail_response(_row):
        raise RuntimeError("response_construction_failed")

    monkeypatch.setattr(store, "_document_record", fail_response)
    with pytest.raises(KnowledgeMetadataUpdateError) as failure:
        store.update_source_group_metadata(
            document["source_group_id"],
            "farm-wasabi-a",
            {"title": "커밋되면 안 되는 제목"},
        )
    monkeypatch.setattr(store, "_document_record", original_document_record)

    stored = store.get_document(document["id"], "farm-wasabi-a")
    job = store.get_job(failure.value.job_id)
    running = store.connection.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]
    assert stored["title"] == document["title"]
    assert job["status"] == "failed"
    assert job["details"]["failure_reason"] == "response_construction_failed"
    assert running == 0
    store.close()


def test_falkor_upsert_removes_chunks_missing_from_the_new_document_shape(monkeypatch) -> None:
    mirror = FalkorGraphMirror("redis://falkor.test:6379")
    queries: list[str] = []
    monkeypatch.setattr(mirror, "available", lambda: True)

    def record_query(cypher: str):
        queries.append(cypher)
        return [[0]]

    monkeypatch.setattr(mirror, "_query", record_query)
    document = {
        "id": "graph-shrink-document",
        "title": "Graph shrink source",
        "scope": "public",
        "farm_id": "farm-wasabi-a",
        "source_group_id": "source-group:graph-shrink",
        "version": "v2",
        "provenance_json": "{}",
    }
    chunks = [
        {"id": "graph-shrink:chunk-001", "text": "고추냉이 관수", "start_char": 0, "end_char": 8},
        {"id": "graph-shrink:chunk-002", "text": "고추냉이 냉각", "start_char": 9, "end_char": 17},
    ]
    assert mirror.upsert_document(document, chunks) == 2
    queries.clear()

    assert mirror.upsert_document(document, chunks[:1]) == 1
    assert "DETACH DELETE c" in queries[0]
    assert "graph-shrink:chunk-001" in queries[0]
    assert "graph-shrink:chunk-002" not in queries[0]


def test_falkor_metadata_update_uses_one_atomic_query(monkeypatch) -> None:
    mirror = FalkorGraphMirror("redis://falkor.test:6379")
    queries: list[str] = []
    monkeypatch.setattr(mirror, "available", lambda: True)

    def query(cypher: str):
        queries.append(cypher)
        return [[2, 3]]

    monkeypatch.setattr(mirror, "_query", query)
    documents = [
        {"id": "doc-1", "title": "통합 자료", "scope": "private", "farm_id": "farm-a", "source_group_id": "group-a"},
        {"id": "doc-2", "title": "통합 자료", "scope": "private", "farm_id": "farm-a", "source_group_id": "group-a"},
    ]

    assert mirror.update_documents_metadata(documents, expected_chunks=3) is True
    assert len(queries) == 1
    assert "source_group_id" in queries[0]
    assert "MENTIONS" not in queries[0]
    assert "MERGE" not in queries[0]


def test_explicit_sync_migrates_legacy_vector_dimensions_without_touching_readiness(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", qdrant_url="http://qdrant.test", embedding_runtime=degraded_runtime())
    document, _ = store.ingest_document(
        title="Legacy vector note",
        content="고추냉이 근권 온도 점검 기록",
        scope="public",
        source_kind="public_knowledge",
    )
    chunk_id = store.connection.execute(
        "SELECT id FROM chunks WHERE document_id=?",
        (document["id"],),
    ).fetchone()["id"]
    with store.connection:
        store.connection.execute("UPDATE chunks SET embedding=? WHERE id=?", (json.dumps([0.0] * 128), chunk_id))
        store.connection.execute(
            "UPDATE documents SET embedding_model='legacy-hash-v1', qdrant_vector_count=1, index_backend='qdrant' WHERE id=?",
            (document["id"],),
        )
    monkeypatch.setattr(store, "_ensure_qdrant", lambda: False)

    assert store.sync_qdrant_mirror() == 0
    migrated = json.loads(store.connection.execute("SELECT embedding FROM chunks WHERE id=?", (chunk_id,)).fetchone()[0])
    row = store.connection.execute(
        "SELECT embedding_model, qdrant_vector_count, index_backend FROM documents WHERE id=?",
        (document["id"],),
    ).fetchone()

    assert len(migrated) == 384
    assert row["embedding_model"] == "lexical-hash-v2"
    assert row["qdrant_vector_count"] == 0
    assert row["index_backend"] == "sqlite_fallback"
    store.close()


class ReadyTestEmbedding:
    vector_size = 4
    state = "ready"
    fallback_reason = None

    def __init__(self, provider: str | None = None, model: str | None = None) -> None:
        self.requested_provider = provider or "fastembed"
        self.model_name = model or "test-embedding-v2"

    @property
    def active_model(self) -> str:
        return self.model_name

    @property
    def collection_name(self) -> str:
        return f"test_{self.model_name.replace('/', '_')}"

    def embed_query(self, text: str) -> list[float]:
        return self._vector(text)

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    @staticmethod
    def _vector(text: str) -> list[float]:
        return [1.0, float("근권" in text), float("관수" in text), float(len(text) % 7) / 7]

    def status(self) -> dict[str, object]:
        return {
            "requested_provider": self.requested_provider,
            "provider": self.requested_provider,
            "model": self.model_name,
            "requested_model": self.model_name,
            "dimensions": self.vector_size,
            "state": self.state,
            "degraded": False,
            "fallback_reason": None,
            "collection": self.collection_name,
        }


def test_full_reindex_activates_staged_runtime_and_keeps_search_available(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _job = store.ingest_document(
        title="고추냉이 근권 점검",
        content="고추냉이 근권 온도와 관수 유량을 함께 점검한다.",
        scope="public",
        source_kind="public_knowledge",
    )
    monkeypatch.setattr("app.knowledge.EmbeddingRuntime", ReadyTestEmbedding)

    job = store.activate_embedding_and_reindex("fastembed", "test-embedding-v2")
    row = store.connection.execute(
        "SELECT embedding_model FROM documents WHERE id=?",
        (document["id"],),
    ).fetchone()
    result = store.retrieve(
        query="근권 온도",
        farm_id="farm-wasabi-a",
        include_private=False,
        selected_document_ids={document["id"]},
        retrieval_path=["dense"],
    )

    assert job["status"] == "completed"
    assert job["details"]["processed_documents"] == 1
    assert job["details"]["processed_chunks"] >= 1
    assert store.embedding.status()["model"] == "test-embedding-v2"
    assert row["embedding_model"] == "test-embedding-v2"
    assert result.hits and result.hits[0].document_id == document["id"]
    settings = store.runtime_settings("ai.embedding.active_")
    assert settings == {
        "ai.embedding.active_model": "test-embedding-v2",
        "ai.embedding.active_provider": "fastembed",
    }
    store.close()


def test_full_reindex_failure_preserves_previous_runtime_and_vectors(monkeypatch) -> None:
    class FailingEmbedding(ReadyTestEmbedding):
        def embed_passages(self, texts: list[str]) -> list[list[float]]:
            raise RuntimeError("candidate inference failed")

    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _job = store.ingest_document(
        title="보존할 지식",
        content="고추냉이 관수 기록을 보존한다.",
        scope="public",
        source_kind="public_knowledge",
    )
    previous_runtime = store.embedding
    previous_vector = store.connection.execute(
        "SELECT embedding FROM chunks WHERE document_id=?",
        (document["id"],),
    ).fetchone()["embedding"]
    monkeypatch.setattr("app.knowledge.EmbeddingRuntime", FailingEmbedding)

    with pytest.raises(EmbeddingReindexError) as captured:
        store.activate_embedding_and_reindex("fastembed", "broken-embedding")

    failed_job = store.get_job(captured.value.job_id)
    current_vector = store.connection.execute(
        "SELECT embedding FROM chunks WHERE document_id=?",
        (document["id"],),
    ).fetchone()["embedding"]
    assert failed_job and failed_job["status"] == "failed"
    assert store.embedding is previous_runtime
    assert current_vector == previous_vector
    assert store.runtime_settings("ai.embedding.active_") == {}
    store.close()


def test_full_reindex_recreates_a_stale_candidate_qdrant_collection(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    store.ingest_document(
        title="Qdrant 전환 지식",
        content="고추냉이 근권 온도 지식이다.",
        scope="public",
        source_kind="public_knowledge",
    )
    store.qdrant_url = "http://qdrant.test"
    monkeypatch.setattr("app.knowledge.EmbeddingRuntime", ReadyTestEmbedding)
    calls: list[tuple[str, str]] = []

    def fake_qdrant(method: str, path: str, payload=None):
        calls.append((method, path))
        return {"result": {}} if method == "GET" else {}

    monkeypatch.setattr(store, "_run_qdrant", fake_qdrant)
    job = store.activate_embedding_and_reindex("fastembed", "test-embedding-v2")

    candidate_path = "/collections/test_test-embedding-v2"
    assert ("DELETE", candidate_path) in calls
    assert calls.index(("DELETE", candidate_path)) < next(
        index for index, call in enumerate(calls) if call[0] == "PUT" and call[1].endswith("/points?wait=true")
    )
    assert job["details"]["stale_point_strategy"] == "fresh_candidate_collection"
    store.close()


def test_qdrant_results_ignore_points_not_in_current_sqlite_chunks(monkeypatch) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _job = store.ingest_document(
        title="현재 문서",
        content="고추냉이 근권 온도 현재 근거",
        scope="public",
        source_kind="public_knowledge",
    )
    allowed_rows = store._allowed_chunks("farm-wasabi-a", False, {document["id"]})
    allowed = {str(row["id"]): row for row in allowed_rows}
    current_chunk_id = next(iter(allowed))
    store.qdrant_url = "http://qdrant.test"
    monkeypatch.setattr(store, "_ensure_qdrant", lambda: True)
    monkeypatch.setattr(
        store,
        "_run_qdrant",
        lambda method, path, payload=None: {
            "result": {
                "points": [
                    {"score": 0.99, "payload": {"chunk_id": "deleted-document:chunk-001"}},
                    {"score": 0.50, "payload": {"chunk_id": current_chunk_id}},
                ]
            }
        },
    )

    scores = store._qdrant_dense_scores([1.0] * 384, allowed, {}, 5)

    assert scores == {current_chunk_id: 0.5}
    store.close()


def test_single_document_reindex_preserves_llm_summary_provenance() -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document, _job = store.ingest_document(
        title="요약 출처 보존",
        content="고추냉이 근권 온도를 점검한다.",
        scope="public",
        farm_id="farm-wasabi-a",
        source_kind="public_knowledge",
        summary="LLM이 생성한 공개 문서 요약입니다.",
        summary_provider="llmgateway",
    )

    reindexed = store.reindex_document(document["id"], "farm-wasabi-a")

    assert reindexed is not None
    refreshed, _job = reindexed
    assert refreshed["summary"] == "LLM이 생성한 공개 문서 요약입니다."
    assert refreshed["summary_provider"] == "llmgateway"
    store.close()


def test_seed_defaults_removes_only_retired_strawberry_seed(tmp_path) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    store.ingest_document(
        title="Retired seed",
        content="Legacy strawberry nutrient guidance.",
        scope="public",
        source_kind="public_knowledge",
        document_id="public:nutrient-ec-ph-checklist:v1",
    )
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "wasabi.md").write_text(
        "---\nid: public:wasabi:test:v1\ntitle: Wasabi test\nscope: public\nsource_kind: public_knowledge\n---\n\nWasabi evidence.",
        encoding="utf-8",
    )

    store.seed_defaults(str(corpus))
    ids = {document["id"] for document in store.list_documents("farm-wasabi-a")}

    assert "public:nutrient-ec-ph-checklist:v1" not in ids
    assert "public:wasabi:test:v1" in ids
    store.close()


def test_seed_defaults_repairs_old_chunks_that_expose_provenance(tmp_path) -> None:
    store = KnowledgeStore(":memory:", embedding_runtime=degraded_runtime())
    document_id = "private:farm-wasabi-a:clean-seed:v1"
    content = (
        "Reference corpus provenance\n"
        "crop: wasabi\n"
        "cultivation_system: perlite_substrate\n\n"
        "고추냉이 근권 온도와 관수 유량을 함께 확인한다."
    )
    store.ingest_document(
        title="Clean seed",
        content=content,
        scope="private",
        farm_id="farm-wasabi-a",
        source_kind="private_knowledge",
        document_id=document_id,
    )
    with store.connection:
        store.connection.execute(
            "UPDATE chunks SET text=? WHERE document_id=?",
            (content, document_id),
        )
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "clean-seed.md").write_text(
        "---\n"
        f"id: {document_id}\n"
        "title: Clean seed\n"
        "scope: private\n"
        "farm_id: farm-wasabi-a\n"
        "source_kind: private_knowledge\n"
        "crop: wasabi\n"
        "cultivation_system: perlite_substrate\n"
        "---\n\n"
        "고추냉이 근권 온도와 관수 유량을 함께 확인한다.",
        encoding="utf-8",
    )

    jobs = store.seed_defaults(str(corpus))
    indexed_text = store.connection.execute(
        "SELECT text FROM chunks WHERE document_id=?",
        (document_id,),
    ).fetchone()[0]

    assert len(jobs) == 1
    assert indexed_text == "고추냉이 근권 온도와 관수 유량을 함께 확인한다."
    assert "Reference corpus provenance" not in indexed_text
    store.close()


def test_sparse_retrieval_uses_display_metadata_without_polluting_chunk_text() -> None:
    rows = [
        {
            "id": "target-chunk",
            "text": "Warmer water increases soft rot incidence.",
            "display_title": "물와사비 고수온과 연부병 위험 자료",
            "summary": "고수온 노출과 연부병 위험을 다룬 공공기관 원문입니다.",
            "issuer": "일본 국립환경연구소",
            "document_type": "공공 적응 사례",
            "crop": "wasabi",
            "cultivation_system": "flowing_water",
            "evidence_class": "official_agronomy",
            "growth_stage": "rhizome_production",
        },
        {
            "id": "other-chunk",
            "text": "펄라이트 고설베드의 일반적인 양액 관리 사례입니다.",
            "display_title": "고설베드 운영 사례",
            "summary": "시설 운영 자료",
            "issuer": "농업기관",
            "document_type": "웹 문서",
            "crop": "wasabi",
            "cultivation_system": "perlite_substrate",
            "evidence_class": "official_agronomy",
            "growth_stage": "leaf_production",
        },
    ]

    scores = KnowledgeStore._sparse_scores("물와사비 고수온 연부병 위험", rows)  # type: ignore[arg-type]

    assert scores["target-chunk"] > scores.get("other-chunk", 0)
    assert rows[0]["text"] == "Warmer water increases soft rot incidence."


def test_image_index_boundary_requires_an_operator_reviewed_caption() -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"demo"
    assert extract_image_text(png, operator_caption="고추냉이 잎의 현장 관찰 사진") == "고추냉이 잎의 현장 관찰 사진"
    with pytest.raises(ImageTextExtractionError, match="OCR/vision extraction is not configured"):
        extract_image_text(png)
    with pytest.raises(ImageTextExtractionError, match="valid JPG and PNG"):
        extract_image_text(b"not-an-image", operator_caption="caption")
