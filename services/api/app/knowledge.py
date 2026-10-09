"""Small, local-first knowledge ingestion and retrieval runtime.

SQLite is the metadata source of truth and Qdrant is the vector mirror.  The
normal embedding path uses a local multilingual FastEmbed model.  If that model
cannot be loaded, retrieval remains available through an explicitly reported
lexical-hash fallback instead of silently presenting fallback vectors as neural
embeddings.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import socket
import sqlite3
from threading import RLock
from typing import Any, Iterable, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from uuid import uuid4

from .agent_state import (
    AGENT_RUN_STATUSES,
    AGENT_RUN_STEP_STATUSES,
    AgentControlContext,
    AgentRunRecord,
    AgentRunStatus,
    AgentRunStepRecord,
    AgentRunStepStatus,
)


Scope = Literal["public", "private", "synthetic_demo"]
RetrievalState = Literal["active", "paused", "needs_review"]
TOKEN_RE = re.compile(r"[A-Za-z]+|[0-9_]+|[가-힣]+")
EVIDENCE_TERM_RE = re.compile(r"[A-Za-z]{2,}|[가-힣]{2,}")
EVIDENCE_NUMBER_RE = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?(?:\s*[~\-–]\s*\d+(?:[.,]\d+)?)?")
EVIDENCE_CODE_RE = re.compile(
    r"(?i)(?<![\w])(?:ec|ph|co2|co₂)(?![\w])|\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b"
)
LEGACY_MARKER_RE = re.compile(r"^\[legacy:([^\]]+)\]\s*")
FILE_SUFFIX_RE = re.compile(r"\.(?:pdf|md|txt|csv)$", re.IGNORECASE)
SENTENCE_RE = re.compile(r"(?<=[.!?。])\s+|\n+")
VECTOR_SIZE = 384
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
FALLBACK_EMBEDDING_MODEL = "lexical-hash-v2"
COLLECTION_SCHEMA_VERSION = 2
PROFILE_FILTER_FIELDS = frozenset({"crop", "cultivation_system", "evidence_class", "growth_stage"})
LEGACY_RELEASE_VERSION = "legacy-release-v1"
QACT_RELEASE_SCHEMA_VERSION = "smartfarm-qact-release-v2"
QACT_CHANNELS = frozenset({"dense", "sparse", "graph"})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
WASABI_EBOOK_PAGE_RE = re.compile(r"(?:^|_)p(\d+)(?:_\d+)?$")
WASABI_EBOOK_FIRST_PAGE = 28
WASABI_EBOOK_LAST_PAGE = 43
_UNSET = object()

ANSWERABILITY_STOP_TERMS = frozenset(
    {
        "그리고",
        "그러나",
        "대한",
        "무엇",
        "어떻게",
        "얼마",
        "인가",
        "있는가",
        "알려줘",
        "설명해줘",
        "찾아줘",
        "근거",
        "자료",
        "please",
        "show",
        "what",
        "when",
        "where",
        "which",
    }
)
ANSWERABILITY_DOMAIN_TERMS = frozenset(
    {
        "고추냉이",
        "물와사비",
        "wasabi",
        "펄라이트",
        "고설베드",
        "수경",
        "양액",
        "관수",
        "배액",
        "근권",
        "수온",
        "온도",
        "습도",
        "산소",
        "연부병",
        "생육",
        "뿌리",
        "잎",
        "센서",
        "유량",
        "압력",
        "펌프",
        "환기",
        "천창",
        "측창",
        "팬",
        "배수",
        "샘물",
        "다다미이시",
        "ec",
        "ph",
        "co2",
        "co₂",
    }
)
SELECTED_SOURCE_CONTEXT_TERMS = frozenset(
    {
        "현재",
        "이전",
        "질문",
        "점검",
        "점검해",
        "공개",
        "내부",
        "남길",
        "동시",
        "동시에",
        "문맥",
        "요청",
        "요청한",
        "원격",
        "선택한",
        "자료",
        "문서",
        "문서를",
        "근거",
        "근거만",
        "근거만으로",
        "기준",
        "내용",
        "방법",
        "요약",
        "요약해줘",
        "새로",
        "로컬",
        "확인해",
        "답해",
        "답해줘",
        "주세요",
        "작업",
        "절차",
        "판단",
        "상태",
    }
)
SELECTED_SOURCE_SUMMARY_TERMS = frozenset(
    {
        "근거",
        "내용",
        "답해",
        "답해줘",
        "문서",
        "문서를",
        "자료",
        "확인해",
        "요약",
        "요약해줘",
    }
)


def _hash_embedding(text: str, *, size: int = VECTOR_SIZE) -> list[float]:
    """Return a deterministic degraded-mode vector with the active dimensions."""

    values = [0.0] * size
    for token, count in Counter(tokenize(text)).items():
        digest = sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % size
        sign = 1.0 if digest[4] % 2 else -1.0
        values[index] += sign * (1.0 + math.log1p(float(count)))
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values] if norm else values


class EmbeddingRuntime:
    """Lazy local multilingual embedding provider with an observable fallback."""

    def __init__(self, provider: str | None = None, model: str | None = None) -> None:
        self.requested_provider = (
            provider
            or os.getenv("RAG_EMBEDDING_PROVIDER", "").strip()
            or os.getenv("SMARTFARM_EMBEDDING_PROVIDER", "fastembed")
        ).strip().lower()
        self.model_name = (model or os.getenv("RAG_EMBEDDING_MODEL", "").strip() or EMBEDDING_MODEL).strip()
        self.vector_size = VECTOR_SIZE
        self.state = "uninitialized"
        self.fallback_reason: str | None = None
        self._model: Any | None = None

    def _activate(self) -> bool:
        if self.state == "ready":
            return True
        if self.state == "degraded":
            return False
        if self.requested_provider == "sentence_transformers":
            try:
                from .research_embedding import ResearchTextEmbedding
                self._model = ResearchTextEmbedding(self.model_name)
                self.vector_size = self._model.embedding_size
                self.state = "ready"
                return True
            except (ImportError, OSError, RuntimeError, TypeError, ValueError):
                self._model = None
                self.state = "degraded"
                self.fallback_reason = "research_embedding_model_unavailable"
                return False
        if self.requested_provider != "fastembed":
            self.state = "degraded"
            self.fallback_reason = "fastembed_provider_disabled"
            return False
        try:
            from fastembed import TextEmbedding

            cache_dir = os.getenv("FASTEMBED_CACHE_PATH", "").strip() or None
            local_only = os.getenv("FASTEMBED_LOCAL_FILES_ONLY", "").strip().lower() in {"1", "true", "yes"}
            model = TextEmbedding(
                model_name=self.model_name,
                cache_dir=cache_dir,
                local_files_only=local_only,
                lazy_load=False,
            )
            if int(model.embedding_size) != self.vector_size:
                raise ValueError("embedding_dimension_mismatch")
            self._model = model
            self.state = "ready"
            return True
        except (ImportError, OSError, RuntimeError, TypeError, ValueError):
            self._model = None
            self.state = "degraded"
            self.fallback_reason = "fastembed_model_unavailable"
            return False

    @staticmethod
    def _vectors(values: Iterable[Any], expected: int, count: int) -> list[list[float]]:
        vectors = [[float(item) for item in value] for value in values]
        if len(vectors) != count or any(len(vector) != expected for vector in vectors):
            raise ValueError("invalid_embedding_shape")
        return vectors

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        if self._activate() and self._model is not None:
            try:
                return self._vectors(self._model.passage_embed(texts), self.vector_size, len(texts))
            except (OSError, RuntimeError, TypeError, ValueError):
                self._model = None
                self.state = "degraded"
                self.fallback_reason = "fastembed_inference_failed"
        return [_hash_embedding(text, size=self.vector_size) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        if self._activate() and self._model is not None:
            try:
                return self._vectors(self._model.query_embed([text]), self.vector_size, 1)[0]
            except (OSError, RuntimeError, TypeError, ValueError):
                self._model = None
                self.state = "degraded"
                self.fallback_reason = "fastembed_inference_failed"
        return _hash_embedding(text, size=self.vector_size)

    @property
    def active_model(self) -> str:
        return self.model_name if self.state in {"uninitialized", "ready"} else FALLBACK_EMBEDDING_MODEL

    @property
    def collection_name(self) -> str:
        fingerprint = sha256(self.active_model.encode("utf-8")).hexdigest()[:10]
        return f"smartfarm_knowledge_v{COLLECTION_SCHEMA_VERSION}_{self.vector_size}_{fingerprint}"

    def status(self) -> dict[str, Any]:
        return {
            "requested_provider": self.requested_provider,
            "provider": "lexical_hash_fallback" if self.state == "degraded" else self.requested_provider,
            "model": self.active_model,
            "requested_model": self.model_name,
            "dimensions": self.vector_size,
            "state": self.state,
            "degraded": self.state == "degraded",
            "fallback_reason": self.fallback_reason,
            "collection": self.collection_name,
        }


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    document_id: str
    title: str
    text: str
    source_kind: str
    scope: str
    farm_id: str | None
    version: str
    ordinal: int
    score: float
    channels: list[str]
    issuer: str | None = None
    published_year: int | None = None
    document_type: str | None = None
    source_url: str | None = None
    summary: str | None = None
    source_locator: str | None = None
    crop: str | None = None
    cultivation_system: str | None = None
    evidence_class: str | None = None
    growth_stage: str | None = None
    canonical_source_id: str | None = None
    content_checksum: str | None = None
    provenance: dict[str, Any] | None = None


@dataclass(frozen=True)
class RetrievalResult:
    hits: list[RetrievedChunk]
    trace: dict[str, Any]


@dataclass(frozen=True)
class QactQuerySegment:
    segment_id: str
    match_any: tuple[str, ...]
    allowed_path: tuple[str, ...]
    channel_weights: dict[str, float]
    graph_reliability_threshold: float
    route_reason: str


@dataclass(frozen=True)
class QactReleaseProfile:
    state: Literal["valid", "missing", "expired", "invalid"]
    profile_id: str | None = None
    source_provenance: str | None = None
    checksum: str | None = None
    snapshot_hashes: dict[str, str] | None = None
    query_segments: tuple[QactQuerySegment, ...] = ()
    fallback_path: tuple[str, ...] = ("dense",)
    fallback_weights: dict[str, float] | None = None
    fallback_reason: str = "QACT release unavailable; dense-only safety fallback applied."
    failure_reason: str | None = None
    research_policy: dict[str, Any] | None = None

    def route(self, question: str) -> dict[str, Any]:
        if self.state != "valid":
            return {
                "mode": "dense_only_fallback",
                "qact_profile_id": self.profile_id,
                "qact_profile_state": self.state,
                "query_segment_id": None,
                "retrieval_path": list(self.fallback_path),
                "channel_weights": dict(self.fallback_weights or {"dense": 1.0}),
                "graph_reliability_threshold": 1.0,
                "route_reason": self.failure_reason or self.fallback_reason,
                "release_checksum": self.checksum,
                "snapshot_hashes": dict(self.snapshot_hashes or {}),
            }

        normalized = str(question or "").casefold()
        segment = next(
            (
                candidate
                for candidate in self.query_segments
                if not candidate.match_any or any(term.casefold() in normalized for term in candidate.match_any)
            ),
            None,
        )
        if segment is None:
            return QactReleaseProfile(
                state="invalid",
                profile_id=self.profile_id,
                checksum=self.checksum,
                snapshot_hashes=self.snapshot_hashes,
                failure_reason="QACT release has no matching or default query segment.",
            ).route(question)
        return {
            "mode": "qact",
            "qact_profile_id": self.profile_id,
            "qact_profile_state": "valid",
            "query_segment_id": segment.segment_id,
            "retrieval_path": list(segment.allowed_path),
            "channel_weights": dict(segment.channel_weights),
            "graph_reliability_threshold": segment.graph_reliability_threshold,
            "route_reason": segment.route_reason,
            "release_checksum": self.checksum,
            "snapshot_hashes": dict(self.snapshot_hashes or {}),
        }


def _qact_path_and_weights(raw: dict[str, Any]) -> tuple[tuple[str, ...], dict[str, float]]:
    path = tuple(str(item).strip().lower() for item in raw.get("allowed_path", []))
    if not path or path[0] != "dense" or len(path) != len(set(path)) or not set(path) <= QACT_CHANNELS:
        raise ValueError("QACT paths must be unique, supported, and start with dense.")
    raw_weights = raw.get("channel_weights")
    if not isinstance(raw_weights, dict) or set(raw_weights) != set(path):
        raise ValueError("QACT channel_weights must match allowed_path exactly.")
    weights = {channel: float(raw_weights[channel]) for channel in path}
    if any(not math.isfinite(value) or value <= 0 for value in weights.values()):
        raise ValueError("QACT channel weights must be finite and positive.")
    total = sum(weights.values())
    return path, {channel: value / total for channel, value in weights.items()}


def load_qact_release_profile(
    configured_path: str | None = None,
    expected_checksum: str | None = None,
    *,
    now: datetime | None = None,
) -> QactReleaseProfile:
    """Load a checksum-pinned, offline-evaluated QACT v2 release.

    The returned object is always routable: missing, expired, or invalid
    artifacts fail closed to the declared dense-only safety path.
    """

    path_value = (configured_path if configured_path is not None else os.getenv("QACT_PROFILE_PATH", "")).strip()
    if not path_value:
        return QactReleaseProfile(state="missing", failure_reason="QACT release is not configured.")
    artifact_path = Path(path_value)
    if not artifact_path.is_file():
        return QactReleaseProfile(state="missing", failure_reason="QACT release file was not found.")
    try:
        artifact_bytes = artifact_path.read_bytes()
        actual_checksum = sha256(artifact_bytes).hexdigest()
        checksum = (
            expected_checksum if expected_checksum is not None else os.getenv("QACT_PROFILE_SHA256", "")
        ).strip().lower()
        if not checksum or not SHA256_RE.fullmatch(checksum) or checksum != actual_checksum:
            return QactReleaseProfile(
                state="invalid",
                checksum=actual_checksum,
                failure_reason="QACT release checksum validation failed.",
            )
        artifact = json.loads(artifact_bytes)
        if artifact.get("schema_version") != QACT_RELEASE_SCHEMA_VERSION:
            raise ValueError("unsupported QACT release schema")
        profile_id = str(artifact["profile_id"]).strip()
        provenance = str(artifact["source_provenance"]).strip()
        if not profile_id or not provenance:
            raise ValueError("missing QACT release identity")
        expires_at = datetime.fromisoformat(str(artifact["expires_at"]).replace("Z", "+00:00"))
        if expires_at.tzinfo is None:
            raise ValueError("QACT release expiry must be timezone-aware")

        raw_hashes = artifact["snapshot_hashes"]
        if not isinstance(raw_hashes, dict) or set(raw_hashes) != {"corpus", "embedding", "graph"}:
            raise ValueError("QACT release snapshot hashes are incomplete")
        snapshot_hashes = {key: str(value).strip().lower() for key, value in raw_hashes.items()}
        if any(not SHA256_RE.fullmatch(value) for value in snapshot_hashes.values()):
            raise ValueError("QACT release snapshot hashes must be sha256 values")

        fallback = artifact["fallback"]
        if not isinstance(fallback, dict):
            raise ValueError("QACT fallback is missing")
        fallback_path, fallback_weights = _qact_path_and_weights(fallback)
        if fallback_path != ("dense",):
            raise ValueError("QACT safety fallback must be dense-only")
        fallback_reason = str(fallback.get("route_reason") or "Dense-only safety fallback.").strip()

        raw_segments = artifact["query_segments"]
        research_policy = artifact.get("research_policy")
        if research_policy is not None:
            from .research_retrieval import validate_research_policy
            validate_research_policy(research_policy)
        if not isinstance(raw_segments, list) or not raw_segments:
            raise ValueError("QACT release must declare query segments")
        segments: list[QactQuerySegment] = []
        segment_ids: set[str] = set()
        for raw_segment in raw_segments:
            if not isinstance(raw_segment, dict):
                raise ValueError("QACT query segment must be an object")
            segment_id = str(raw_segment["segment_id"]).strip()
            if not segment_id or segment_id in segment_ids:
                raise ValueError("QACT segment ids must be non-empty and unique")
            segment_ids.add(segment_id)
            match_any = tuple(str(item).strip() for item in raw_segment.get("match_any", []) if str(item).strip())
            allowed_path, weights = _qact_path_and_weights(raw_segment)
            threshold = float(raw_segment.get("graph_reliability_threshold", 1.0))
            if not math.isfinite(threshold) or not 0 <= threshold <= 1:
                raise ValueError("QACT graph reliability threshold must be in [0, 1]")
            if "graph" not in allowed_path and threshold != 1.0:
                raise ValueError("Non-graph QACT routes must use a threshold of 1.0")
            route_reason = str(raw_segment["route_reason"]).strip()
            if not route_reason:
                raise ValueError("QACT route reason is required")
            segments.append(
                QactQuerySegment(
                    segment_id=segment_id,
                    match_any=match_any,
                    allowed_path=allowed_path,
                    channel_weights=weights,
                    graph_reliability_threshold=threshold,
                    route_reason=route_reason,
                )
            )
        if segments[-1].match_any:
            raise ValueError("The final QACT query segment must be an explicit default route")

        profile = QactReleaseProfile(
            state="valid",
            profile_id=profile_id,
            source_provenance=provenance,
            checksum=actual_checksum,
            snapshot_hashes=snapshot_hashes,
            query_segments=tuple(segments),
            fallback_path=fallback_path,
            fallback_weights=fallback_weights,
            fallback_reason=fallback_reason,
            research_policy=research_policy,
        )
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        if expires_at <= current:
            return QactReleaseProfile(
                state="expired",
                profile_id=profile_id,
                source_provenance=provenance,
                checksum=actual_checksum,
                snapshot_hashes=snapshot_hashes,
                fallback_path=fallback_path,
                fallback_weights=fallback_weights,
                fallback_reason=fallback_reason,
                failure_reason="QACT release has expired; dense-only safety fallback applied.",
            )
        return profile
    except (OSError, ValueError, KeyError, TypeError, AttributeError, json.JSONDecodeError):
        return QactReleaseProfile(
            state="invalid",
            failure_reason="QACT release schema validation failed; dense-only safety fallback applied.",
        )


DEFAULT_SEED_DOCUMENTS: tuple[dict[str, str], ...] = (
    {
        "id": "public:facility-horticulture-checklist:v1",
        "title": "시설원예 환경·양액 점검 가이드",
        "scope": "public",
        "source_kind": "public_knowledge",
        "version": "v1",
        "content": (
            "시설원예에서 온도, 상대습도, CO₂, 일사량은 같은 시간 구간에서 함께 점검한다. "
            "경보가 발생하면 설비를 즉시 변경하기보다 센서 값, 환기 상태, 작업 이력을 먼저 확인한다."
        ),
    },
    {
        "id": "public:nutrient-ec-ph-checklist:v1",
        "title": "딸기 양액 EC·pH 점검 절차",
        "scope": "public",
        "source_kind": "public_knowledge",
        "version": "v1",
        "content": (
            "양액 EC 상승은 배액 EC, 관수량, 원수 EC, 생육 단계와 함께 해석한다. "
            "pH는 목표 범위와 최근 보정 이력을 확인하고, 급격한 설정 변경 전 승인 절차를 거친다."
        ),
    },
    {
        "id": "private:farm-strawberry-a:ec-operations-sop:v1",
        "title": "A동 EC 경보 대응 SOP",
        "scope": "private",
        "farm_id": "farm-strawberry-a",
        "source_kind": "private_knowledge",
        "version": "v1",
        "content": (
            "A동에서 EC 경보가 발생하면 배지 EC와 배액 EC를 15분 간격으로 재확인한다. "
            "관수 펌프나 양액 설정을 바꾸는 작업은 운영자가 요청 내용을 확인한 뒤 MCP를 통해 시뮬레이터에 적용한다."
        ),
    },
    {
        "id": "private:farm-strawberry-b:heat-operations-sop:v1",
        "title": "B동 고온 대응 작업 SOP",
        "scope": "private",
        "farm_id": "farm-strawberry-b",
        "source_kind": "private_knowledge",
        "version": "v1",
        "content": (
            "B동의 오후 고온 경보에서는 측창 개도와 순환팬 상태를 먼저 확인한다. "
            "변경 요청은 운영자 확인 뒤 MCP를 통해 시뮬레이터에 반영하며 실제 설비 제어는 수행하지 않는다."
        ),
    },
    {
        "id": "synthetic:greenhouse-scenario:v1",
        "title": "합성 온실 운영 시나리오",
        "scope": "synthetic_demo",
        "source_kind": "synthetic_demo",
        "version": "v1",
        "content": "이 문서는 실제 농장 자료와 분리된 교육용 합성 시나리오다. 경보 분석, 근거 확인, 승인형 제어 흐름을 시연한다.",
    },
)

RETIRED_SEED_DOCUMENT_IDS: tuple[str, ...] = (
    "public:facility-horticulture-checklist:v1",
    "public:nutrient-ec-ph-checklist:v1",
    "private:farm-strawberry-a:ec-operations-sop:v1",
    "private:farm-strawberry-b:heat-operations-sop:v1",
    "synthetic:greenhouse-scenario:v1",
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def tokenize(text: str) -> list[str]:
    return [token.lower() for token in TOKEN_RE.findall(str(text or "")) if token]


def _answerability_terms(text: str) -> set[str]:
    terms: set[str] = set()
    for raw_term in EVIDENCE_TERM_RE.findall(str(text or "").casefold()):
        term = raw_term
        if re.fullmatch(r"[가-힣]+", term):
            for _ in range(2):
                stripped = False
                for suffix in ("에서는", "으로", "에서", "에게", "까지", "부터", "처럼", "보다", "와", "과", "은", "는", "이", "가", "을", "를", "의", "에", "도", "만"):
                    if term.endswith(suffix) and len(term) >= len(suffix) + 2:
                        term = term[: -len(suffix)]
                        stripped = True
                        break
                if not stripped:
                    break
        if len(term) >= 2 and term not in ANSWERABILITY_STOP_TERMS:
            terms.add(term)
    return terms


def _answerability_anchors(pattern: re.Pattern[str], text: str) -> set[str]:
    return {
        re.sub(
            r"[\s,~–]",
            lambda match: "-" if match.group(0) in {"~", "–"} else "",
            value.casefold(),
        )
        for value in pattern.findall(str(text or ""))
    }


def cosine(left: list[float], right: list[float]) -> float:
    pairs = list(zip(left, right, strict=False))
    left_norm = math.sqrt(sum(a * a for a, _b in pairs))
    right_norm = math.sqrt(sum(b * b for _a, b in pairs))
    if not left_norm or not right_norm:
        return 0.0
    return sum(a * b for a, b in pairs) / (left_norm * right_norm)


def chunk_text(content: str, *, limit: int = 680) -> list[tuple[int, int, str]]:
    text = content.strip()
    if not text:
        return []
    chunks: list[tuple[int, int, str]] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + limit)
        if end < len(text):
            split_at = max(text.rfind("\n", start, end), text.rfind(". ", start, end), text.rfind(".\n", start, end))
            if split_at > start + limit // 3:
                end = split_at + 1
        value = text[start:end].strip()
        if value:
            left = start + len(text[start:end]) - len(text[start:end].lstrip())
            chunks.append((left, end, value))
        start = max(end, start + 1)
    return chunks


def _parse_front_matter(path: Path) -> dict[str, str] | None:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return None
    if not raw.startswith("---"):
        return {"title": path.stem, "content": raw}
    sections = raw.split("---", 2)
    if len(sections) != 3:
        return {"title": path.stem, "content": raw}
    metadata: dict[str, str] = {}
    for line in sections[1].strip().splitlines():
        key, separator, value = line.partition(":")
        if separator and key.strip():
            metadata[key.strip()] = value.strip().strip('"')
    body = sections[2].strip()
    provenance_keys = (
        ("url", "source_url"),
        ("kind", "document_type"),
        ("source", "source"),
        ("crop", "crop"),
        ("cultivation_system", "cultivation_system"),
        ("evidence_class", "evidence_class"),
        ("growth_stage", "growth_stage"),
    )
    provenance = [
        f"{target}: {metadata[source]}"
        for target, source in provenance_keys
        if metadata.get(source)
    ]
    metadata["content"] = (
        "Reference corpus provenance\n" + "\n".join(provenance) + "\n\n" + body
        if provenance
        else body
    )
    metadata.setdefault("title", path.stem)
    return metadata


def load_seed_documents(corpus_path: str | None = None) -> list[dict[str, str]]:
    configured = corpus_path or os.getenv("SMARTFARM_DEMO_CORPUS_PATH", "").strip() or os.getenv("DEMO_CORPUS_PATH", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates.append(Path("/app/data/demo-corpus"))
    source_path = Path(__file__).resolve()
    # The source checkout has ``services/api/app`` nesting, while the Docker
    # image copies the module to ``/app/app``.  Only derive a checkout-relative
    # corpus path when that nesting is actually present.
    if len(source_path.parents) > 3:
        candidates.append(source_path.parents[3] / "data" / "demo-corpus")
    for candidate in candidates:
        if not candidate.is_dir():
            continue
        loaded = [_parse_front_matter(path) for path in sorted(candidate.glob("*.md"))]
        documents = [item for item in loaded if item and item.get("content")]
        if documents:
            return documents
    return [dict(item) for item in DEFAULT_SEED_DOCUMENTS]


def _compact_text(value: str | None, *, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit].rstrip()


def _provenance_fields(content: str) -> dict[str, str]:
    """Read the small, trusted ingest header without mixing it into user copy."""

    if not content.startswith("Reference corpus provenance\n"):
        return {}
    header = content.split("\n\n", 1)[0]
    fields: dict[str, str] = {}
    for line in header.splitlines()[1:]:
        key, separator, value = line.partition(":")
        if separator and key.strip() and value.strip():
            fields[key.strip().lower()] = value.strip()
    return fields


def _provenance_bool(value: str | None) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "y"}


def _structured_document_provenance(
    *,
    content: str,
    canonical_source_id: str,
    version: str,
    content_checksum: str,
    source_locator: str | None,
) -> dict[str, Any]:
    fields = _provenance_fields(content)
    page_value = fields.get("page_number") or fields.get("page")
    try:
        page_number = int(page_value) if page_value is not None else None
    except ValueError:
        page_number = None
    derived_from = fields.get("derived_from_source_id") or fields.get("derived_from")
    region_locator = fields.get("region_locator") or fields.get("region")
    table_locator = fields.get("table_locator") or fields.get("table")
    derived_evidence = _provenance_bool(fields.get("derived_evidence")) or bool(derived_from)
    raw_timeseries = _provenance_bool(fields.get("raw_timeseries")) or fields.get(
        "content_role", ""
    ).casefold() in {"raw_timeseries", "raw_time_series", "telemetry_stream"}
    locator_verified = bool(source_locator or page_number is not None or region_locator or table_locator)
    if raw_timeseries:
        status = "raw_timeseries"
    elif derived_evidence and derived_from and locator_verified:
        status = "derived_with_source_locator"
    elif derived_evidence:
        status = "derived_unverified"
    else:
        status = "source_span"
    return {
        "canonical_source_id": canonical_source_id,
        "source_version": fields.get("source_version") or version,
        "content_sha256": content_checksum,
        "derived_evidence": derived_evidence,
        "derived_from_source_id": derived_from,
        "page_number": page_number,
        "region_locator": region_locator,
        "table_locator": table_locator,
        "source_locator": source_locator,
        "raw_timeseries": raw_timeseries,
        "provenance_status": status,
    }


def _raw_timeseries_reason(content: str, source_kind: str) -> str | None:
    fields = _provenance_fields(content)
    if source_kind.strip().casefold() in {"raw_timeseries", "telemetry_timeseries", "telemetry_stream"}:
        return "source_kind"
    if _provenance_bool(fields.get("raw_timeseries")) or fields.get("content_role", "").casefold() in {
        "raw_timeseries",
        "raw_time_series",
        "telemetry_stream",
    }:
        return "provenance_header"
    lines = [line.strip() for line in _profile_body(content).splitlines() if line.strip()]
    if len(lines) < 25:
        return None
    header = lines[0].casefold()
    has_time_column = any(
        token in header
        for token in ("timestamp", "sampled_at", "observed_at", "datetime", "측정시각", "관측시각")
    )
    has_metric_column = any(
        token in header
        for token in ("metric", "sensor", "value", "reading", "temperature", "humidity", "ec", "ph")
    )
    if has_time_column and has_metric_column and ("," in lines[0] or "\t" in lines[0]):
        return "tabular_timeseries_shape"
    return None


def _graph_span_provenance_verified(row: sqlite3.Row | dict[str, Any]) -> bool:
    values = dict(row)
    try:
        provenance = json.loads(str(values.get("provenance_json") or "{}"))
    except json.JSONDecodeError:
        return False
    if provenance.get("raw_timeseries") is True:
        return False
    if not all(
        (
            str(provenance.get("canonical_source_id") or "").strip(),
            str(provenance.get("source_version") or "").strip(),
            SHA256_RE.fullmatch(str(provenance.get("content_sha256") or "")),
        )
    ):
        return False
    try:
        if int(values.get("start_char", -1)) < 0 or int(values.get("end_char", -1)) <= int(
            values.get("start_char", -1)
        ):
            return False
    except (TypeError, ValueError):
        return False
    if provenance.get("derived_evidence") is True:
        return bool(
            provenance.get("derived_from_source_id")
            and (
                provenance.get("source_locator")
                or provenance.get("page_number") is not None
                or provenance.get("region_locator")
                or provenance.get("table_locator")
            )
        )
    return provenance.get("provenance_status") == "source_span"


def _profile_body(content: str) -> str:
    if content.startswith("Reference corpus provenance\n"):
        return content.split("\n\n", 1)[-1].strip()
    return content.strip()


def _sentence_fragments(content: str) -> list[str]:
    return [
        _compact_text(part, limit=220)
        for part in SENTENCE_RE.split(_profile_body(content))
        if len(_compact_text(part, limit=220)) >= 12
    ]


def _safe_source_url(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    parsed = urlparse(candidate)
    return candidate if parsed.scheme in {"http", "https"} and parsed.netloc else None


def _humanize_machine_label(value: str) -> str:
    label = FILE_SUFFIX_RE.sub("", value.strip())
    label = re.sub(r"\s*\[(?:p\.?|page)\s*\d+\]\s*", " ", label, flags=re.IGNORECASE)
    label = re.sub(r"[_-]+", " ", label)
    return _compact_text(label, limit=120)


def _reference_topic(content: str) -> str | None:
    body = _profile_body(content).lower()
    for keyword, label in (
        ("고추냉이", "고추냉이"),
        ("わさび", "고추냉이"),
        ("wasabi", "고추냉이"),
        ("딸기", "딸기"),
        ("strawberry", "딸기"),
        ("토마토", "토마토"),
        ("tomato", "토마토"),
        ("파프리카", "파프리카"),
        ("pepper", "파프리카"),
    ):
        if keyword in body:
            return label
    return None


def _reference_locator(source_key: str | None) -> str | None:
    value = str(source_key or "")
    page = re.search(r"(?:^|_)p(\d+)(?:_|$)", value, flags=re.IGNORECASE)
    if page:
        return f"{page.group(1)}쪽"
    section = re.search(r"(?:^|_)s(\d+)(?:_|$)", value, flags=re.IGNORECASE)
    return f"섹션 {section.group(1)}" if section else None


def _source_locator(*, title: str, source_key: str | None, provenance: dict[str, str]) -> str | None:
    for candidate in (source_key, provenance.get("source_id"), provenance.get("canonical_id")):
        locator = _reference_locator(candidate)
        if locator:
            return locator
        section = re.search(r"#section:(\d+)$", str(candidate or ""), flags=re.IGNORECASE)
        if section:
            return f"섹션 {section.group(1)}"
    page = re.search(r"\[(?:p\.?|page)\s*(\d+)\]", title, flags=re.IGNORECASE)
    if page:
        return f"{page.group(1)}쪽"
    section = re.search(r"\[(?:sec\.?|section)\s*(\d+)\]", title, flags=re.IGNORECASE)
    return f"섹션 {section.group(1)}" if section else None


def _content_checksum(content: str) -> str:
    body = _profile_body(content).replace("\r\n", "\n").replace("\r", "\n").strip()
    return sha256(body.encode("utf-8")).hexdigest()


def _normalized_source_url(value: str | None) -> str | None:
    safe = _safe_source_url(value)
    if not safe:
        return None
    parsed = urlparse(safe)
    query = urlencode(
        sorted(
            (key, item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
            if not key.lower().startswith("utm_")
        )
    )
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/") or "/", "", query, ""))


def _local_file_root_id(original_filename: str | None) -> str | None:
    filename = Path(str(original_filename or "").replace("\\", "/")).name
    normalized = re.sub(r"\s+", " ", filename).strip().casefold()
    return sha256(normalized.encode("utf-8")).hexdigest() if normalized else None


def _canonical_source_id(
    *,
    content: str,
    source_url: str | None,
    original_filename: str | None = None,
) -> str:
    """Group evidence segments under an original source without exposing importer keys."""

    provenance = _provenance_fields(content)
    source_id = provenance.get("canonical_id") or provenance.get("source_id")
    if source_id:
        parent = re.sub(r"#section:\d+$", "", source_id, flags=re.IGNORECASE)
        parent = re.sub(r"_(?:p\d+(?:_\d+)?|s\d+)$", "", parent, flags=re.IGNORECASE)
        return f"reference:{parent}"
    normalized_url = _normalized_source_url(source_url or provenance.get("url"))
    if normalized_url:
        return f"url:{normalized_url}"
    local_file_root = _local_file_root_id(original_filename)
    if local_file_root:
        return f"file:{local_file_root}"
    return f"content:{_content_checksum(content)}"


def _crop_code(content: str) -> str | None:
    topic = _reference_topic(content)
    return {"고추냉이": "wasabi", "딸기": "strawberry", "토마토": "tomato", "파프리카": "pepper"}.get(topic or "")


def _document_domain_metadata(*, content: str, scope: str, source_kind: str) -> dict[str, str | None]:
    provenance = _provenance_fields(content)
    body = _profile_body(content).casefold()
    crop = _compact_text(provenance.get("crop"), limit=40) or _crop_code(content)

    cultivation_system = _compact_text(provenance.get("cultivation_system"), limit=80)
    if not cultivation_system:
        if any(term in body for term in ("펄라이트", "perlite")):
            cultivation_system = "perlite_substrate"
        elif any(term in body for term in ("유수식", "流水", "water wasabi", "stream cultivation")):
            cultivation_system = "flowing_water"
        elif any(term in body for term in ("양액재배", "수경재배", "hydroponic", "nutrient solution")):
            cultivation_system = "hydroponic"

    growth_stage = _compact_text(provenance.get("growth_stage"), limit=80)
    if not growth_stage:
        if any(term in body for term in ("육묘", "묘 생산", "seedling", "plantlet")):
            growth_stage = "seedling"
        elif any(term in body for term in ("근경", "rhizome")):
            growth_stage = "rhizome_production"
        elif any(term in body for term in ("잎 생산", "엽채", "leaf production")):
            growth_stage = "leaf_production"

    source = provenance.get("source", "").casefold()
    host = (urlparse(provenance.get("url", "")).hostname or "").casefold()
    evidence_class = _compact_text(provenance.get("evidence_class"), limit=80)
    if not evidence_class:
        if scope == "synthetic_demo" or source_kind == "synthetic_demo":
            evidence_class = "simulated"
        elif scope == "private" or source_kind == "private_knowledge":
            evidence_class = "farm_sop"
        elif source.startswith("scholarly_") or host.endswith(("jstage.jst.go.jp", "ncbi.nlm.nih.gov", "frontiersin.org", "nature.com")):
            evidence_class = "peer_reviewed"
        elif source.startswith("official_") or host.endswith(("go.kr", "go.jp", "fao.org")):
            evidence_class = "official_agronomy"
        else:
            evidence_class = "public_reference"
    return {
        "crop": crop,
        "cultivation_system": cultivation_system or None,
        "evidence_class": evidence_class,
        "growth_stage": growth_stage or None,
    }


def _reference_identity(source_url: str | None, source: str) -> tuple[str | None, str]:
    """Return only a verified publisher label and a neutral fallback kind.

    Collection labels such as ``scholarly_focus_openalex`` describe how a
    document was acquired, not who published it.  The visible issuer is
    therefore derived from the original URL host when it is known.
    """

    host = (urlparse(source_url or "").hostname or "").lower().removeprefix("www.")
    if host.endswith("nongsaro.go.kr"):
        return "농촌진흥청 농사로", "재배 기술 자료"
    if host.endswith("rda.go.kr"):
        return "농촌진흥청", "공개 농업 자료"
    if host.endswith("repository.naro.go.jp"):
        return "일본 농업·식품산업기술종합연구기구 (NARO)", "공개 연구 자료"
    if host.endswith("maff.go.jp"):
        return "일본 농림수산성 (MAFF)", "공개 농업 자료"
    if host.endswith("pmc.ncbi.nlm.nih.gov"):
        return "PubMed Central", "학술 논문 자료"
    if host.endswith("frontiersin.org"):
        return "Frontiers", "학술 논문"
    if host.endswith("nature.com"):
        return "Nature Portfolio", "학술 논문"
    if host.endswith("powo.science.kew.org"):
        return "Kew Science · Plants of the World Online", "식물 분류 자료"
    if host.endswith("europepmc.org"):
        return "Europe PMC", "학술 논문 자료"
    if host.endswith("pref.shizuoka.jp"):
        return "시즈오카현 식문화정보센터", "공개 농업 자료"
    if host:
        return host, "공개 자료"
    if source.lower() == "wasabi":
        return "공개 농업 연구 아카이브", "공개 농업 자료"
    return None, "공개 자료"


def _reference_title_from_raw(raw_title: str) -> str | None:
    candidate = FILE_SUFFIX_RE.sub("", raw_title.strip())
    candidate = re.sub(r"\s*\[(?:sec\.?|section|p\.?|page)\s*\d+\]\s*$", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\s+-\s+PMC\s*$", "", candidate, flags=re.IGNORECASE)
    if "｜" in candidate:
        candidate = candidate.split("｜", 1)[0]
    elif " | " in candidate:
        leading, trailing = candidate.split(" | ", 1)
        candidate = trailing if leading.strip().lower() in {"frontiers", "nature"} else leading
    candidate = _compact_text(candidate, limit=160)
    normalized = candidate.lower()
    if not candidate or normalized in {"figure", "top page", "homepage", "상세보기"}:
        return None
    if normalized.startswith(("official_", "official ", "scholarly_", "taxonomy_", "상세보기", "トップページ")):
        return None
    return candidate


def _reference_public_id(source_url: str | None) -> str | None:
    parsed = urlparse(source_url or "")
    host = (parsed.hostname or "").lower()
    if host.endswith("pmc.ncbi.nlm.nih.gov"):
        match = re.search(r"PMC\d+", parsed.path, flags=re.IGNORECASE)
        return match.group(0).upper() if match else None
    return None


def _reference_display_title(*, raw_title: str, source: str, source_key: str | None, source_url: str | None, content: str) -> str:
    locator = _reference_locator(source_key)
    title = _reference_title_from_raw(raw_title)
    if title:
        return f"{title} · {locator}" if locator else title
    issuer, fallback_kind = _reference_identity(source_url, source)
    topic = _reference_topic(content)
    label = f"{topic} {fallback_kind}" if topic else f"{issuer or '공개'} {fallback_kind}"
    locator = locator or _reference_public_id(source_url)
    return f"{label} · {locator}" if locator else label


def document_profile(
    *,
    title: str,
    content: str,
    display_title: str | None = None,
    issuer: str | None = None,
    published_year: int | None = None,
    document_type: str | None = None,
    source_url: str | None = None,
    summary: str | None = None,
    summary_provider: str | None = None,
    source_key: str | None = None,
    original_filename: str | None = None,
) -> dict[str, Any]:
    """Create a retrieval-safe, user-facing document profile at ingest time.

    Embeddings remain based on the original content.  The profile is separate so
    a file name or importer marker never becomes a citation label.
    """

    provenance = _provenance_fields(content)
    legacy_match = LEGACY_MARKER_RE.match(title.strip())
    raw_title = LEGACY_MARKER_RE.sub("", title.strip())
    fragments = _sentence_fragments(content)
    resolved_source_key = _compact_text(source_key, limit=200) or (legacy_match.group(1) if legacy_match else None)
    inferred_source = provenance.get("source", "").strip().lower()
    resolved_source_url = _safe_source_url(source_url) or _safe_source_url(provenance.get("url"))
    provided_title = _compact_text(display_title, limit=200)
    if not provided_title and provenance and resolved_source_key:
        candidate = _reference_display_title(
            raw_title=raw_title,
            source=inferred_source,
            source_key=resolved_source_key,
            source_url=resolved_source_url,
            content=content,
        )
    else:
        candidate = provided_title or _humanize_machine_label(raw_title)
        filename_like = bool(FILE_SUFFIX_RE.search(raw_title) or "_" in raw_title or ("-" in raw_title and " " not in raw_title))
        if not candidate or (filename_like and not provided_title):
            candidate = fragments[0] if fragments else candidate
    clean_title = _compact_text(candidate, limit=160) or "업로드 지식 문서"

    verified_issuer, _ = _reference_identity(resolved_source_url, inferred_source)
    clean_issuer = _compact_text(issuer, limit=160) or verified_issuer or (
        _humanize_machine_label(provenance.get("source", "")) or None
    )
    kind = _compact_text(document_type, limit=80)
    if not kind:
        extension = Path(original_filename or raw_title).suffix.lower()
        kind = {".pdf": "PDF 문서", ".md": "Markdown 문서", ".txt": "텍스트 문서", ".csv": "CSV 데이터"}.get(extension, "")
    if not kind:
        kind = {"pdf": "PDF 문서", "html": "웹 문서", "txt": "텍스트 문서"}.get(provenance.get("kind", "").lower(), "지식 문서")
    clean_summary = _compact_text(summary, limit=500)
    provider = "extractive"
    if clean_summary:
        provider = summary_provider if summary_provider in {"extractive", "provided", "llmgateway"} else "provided"
    if not clean_summary:
        clean_summary = _compact_text(" ".join(fragments[:2]), limit=320) or "색인 가능한 본문에서 자동 요약을 만들지 못했습니다."
    return {
        "display_title": clean_title,
        "issuer": clean_issuer,
        "published_year": published_year,
        "document_type": kind,
        "source_url": resolved_source_url,
        "summary": clean_summary,
        "summary_provider": provider,
        "source_key": resolved_source_key,
        "source_locator": _source_locator(title=raw_title, source_key=resolved_source_key, provenance=provenance),
        "original_filename": _compact_text(original_filename, limit=255) or None,
    }


def _cypher_string(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


class FalkorGraphMirror:
    """Minimal RESP client for the local FalkorDB graph used by the demo.

    A dedicated Redis dependency would be excessive for one local graph.  The
    protocol implementation is deliberately small and only handles the simple
    command/result shapes issued below.
    """

    def __init__(self, url: str | None) -> None:
        self.url = (url or "").strip()
        self._ready: bool | None = None

    @staticmethod
    def _encode(parts: Iterable[str]) -> bytes:
        values = [str(part).encode("utf-8") for part in parts]
        return b"*" + str(len(values)).encode("ascii") + b"\r\n" + b"".join(
            b"$" + str(len(value)).encode("ascii") + b"\r\n" + value + b"\r\n" for value in values
        )

    @staticmethod
    def _readline(stream: Any) -> bytes:
        line = stream.readline()
        if not line or not line.endswith(b"\r\n"):
            raise OSError("Malformed Redis response")
        return line[:-2]

    @classmethod
    def _read_response(cls, stream: Any) -> Any:
        prefix = stream.read(1)
        if not prefix:
            raise OSError("Empty Redis response")
        line = cls._readline(stream)
        if prefix == b"+":
            return line.decode("utf-8", errors="replace")
        if prefix == b"-":
            raise OSError(line.decode("utf-8", errors="replace"))
        if prefix == b":":
            return int(line)
        if prefix == b"$":
            length = int(line)
            if length < 0:
                return None
            payload = stream.read(length)
            if stream.read(2) != b"\r\n":
                raise OSError("Malformed Redis bulk response")
            return payload.decode("utf-8", errors="replace")
        if prefix == b"*":
            count = int(line)
            return [cls._read_response(stream) for _ in range(max(0, count))]
        raise OSError("Unsupported Redis response")

    def _command(self, *parts: str) -> Any | None:
        parsed = urlparse(self.url)
        if parsed.scheme not in {"redis", "rediss"} or not parsed.hostname:
            return None
        try:
            with socket.create_connection((parsed.hostname, parsed.port or 6379), timeout=0.6) as client:
                client.settimeout(0.8)
                stream = client.makefile("rwb")
                password = parsed.password
                if password:
                    stream.write(self._encode(("AUTH", password)))
                    stream.flush()
                    self._read_response(stream)
                stream.write(self._encode(parts))
                stream.flush()
                return self._read_response(stream)
        except (OSError, ValueError):
            return None

    @staticmethod
    def _unwrap(value: Any) -> Any:
        if isinstance(value, list):
            if len(value) == 2 and isinstance(value[0], int):
                return FalkorGraphMirror._unwrap(value[1])
            return [FalkorGraphMirror._unwrap(item) for item in value]
        return value

    def _query(self, cypher: str) -> list[list[Any]] | None:
        raw = self._command("GRAPH.QUERY", "smartfarm_knowledge", cypher, "--compact")
        if not isinstance(raw, list) or len(raw) < 2:
            return None
        rows = self._unwrap(raw[1])
        return rows if isinstance(rows, list) else None

    def available(self) -> bool:
        if not self.url:
            self._ready = False
            return False
        if self._ready is True:
            return True
        result = self._command("GRAPH.LIST")
        self._ready = result is not None
        return self._ready

    def upsert_document(self, document: dict[str, Any], chunks: list[dict[str, Any]]) -> int:
        if not self.available():
            return 0
        document_id = _cypher_string(document["id"])
        scope = _cypher_string(document["scope"])
        farm_id = _cypher_string(document.get("farm_id") or "")
        title = _cypher_string(document["title"])
        source_group_id = _cypher_string(str(document.get("source_group_id") or ""))
        provenance_json = str(document.get("provenance_json") or "{}")
        try:
            provenance = json.loads(provenance_json)
        except json.JSONDecodeError:
            provenance = {}
        canonical_source_id = _cypher_string(str(provenance.get("canonical_source_id") or ""))
        source_version = _cypher_string(str(provenance.get("source_version") or document.get("version") or ""))
        content_sha256 = _cypher_string(str(provenance.get("content_sha256") or ""))
        current_chunk_ids = ", ".join(f"'{_cypher_string(str(chunk['id']))}'" for chunk in chunks)
        stale_cleanup = self._query(
            "MATCH (d:Document {id:'%s'})-[:HAS_CHUNK]->(c:Chunk) "
            "WHERE NOT c.id IN [%s] DETACH DELETE c RETURN count(c)"
            % (document_id, current_chunk_ids)
        )
        if stale_cleanup is None:
            self._ready = False
            return 0
        written = 0
        for chunk in chunks:
            relation_verified = _graph_span_provenance_verified(
                {
                    **chunk,
                    "provenance_json": provenance_json,
                }
            )
            terms = sorted(set(tokenize(chunk["text"])))[:64]
            terms_literal = ", ".join(f"'{_cypher_string(term)}'" for term in terms)
            cypher = (
                "MERGE (d:Document {id:'%s'}) "
                "SET d.title='%s', d.scope='%s', d.farm_id='%s', d.canonical_source_id='%s', "
                "d.source_group_id='%s', d.source_version='%s', d.content_sha256='%s' "
                "MERGE (c:Chunk {id:'%s'}) "
                "SET c.document_id='%s', c.scope='%s', c.farm_id='%s', c.text='%s', c.provenance_verified=%s "
                "MERGE (d)-[:HAS_CHUNK]->(c) "
                "RETURN c.id"
                % (
                    document_id,
                    title,
                    scope,
                    farm_id,
                    canonical_source_id,
                    source_group_id,
                    source_version,
                    content_sha256,
                    _cypher_string(chunk["id"]),
                    document_id,
                    scope,
                    farm_id,
                    _cypher_string(chunk["text"]),
                    "true" if relation_verified else "false",
                )
            )
            if self._query(cypher) is None:
                self._ready = False
                return written
            self._query(
                "MATCH (c:Chunk {id:'%s'})-[r:MENTIONS]->() DELETE r RETURN count(r)"
                % _cypher_string(chunk["id"])
            )
            # Keep the mirror complete for diagnostics and later provenance
            # repair, but retrieval admits these relations only through the
            # source-span gate in ``_graph_scores_with_gate``.
            if terms:
                links = (
                    "MATCH (c:Chunk {id:'%s'}) "
                    "UNWIND [%s] AS token "
                    "MERGE (t:Term {value:token}) "
                    "MERGE (c)-[:MENTIONS]->(t) "
                    "RETURN count(t)" % (_cypher_string(chunk["id"]), terms_literal)
                )
                if self._query(links) is None:
                    self._ready = False
                    return written
            written += 1
        return written

    def update_documents_metadata(self, documents: list[dict[str, Any]], expected_chunks: int) -> bool:
        if not documents or not self.available():
            return not documents
        items = ", ".join(
            "{id:'%s', title:'%s', scope:'%s', farm_id:'%s', source_group_id:'%s'}"
            % (
                _cypher_string(str(document["id"])),
                _cypher_string(str(document["title"])),
                _cypher_string(str(document["scope"])),
                _cypher_string(str(document.get("farm_id") or "")),
                _cypher_string(str(document["source_group_id"])),
            )
            for document in documents
        )
        rows = self._query(
            "UNWIND [%s] AS item "
            "MATCH (d:Document) WHERE d.id=item.id "
            "SET d.title=item.title, d.scope=item.scope, d.farm_id=item.farm_id, d.source_group_id=item.source_group_id "
            "WITH d, item MATCH (d)-[:HAS_CHUNK]->(c:Chunk) "
            "SET c.scope=item.scope, c.farm_id=item.farm_id "
            "RETURN count(DISTINCT d), count(DISTINCT c)" % items
        )
        try:
            return bool(
                rows
                and int(self._unwrap(rows[0][0])) == len(documents)
                and int(self._unwrap(rows[0][1])) == expected_chunks
            )
        except (IndexError, TypeError, ValueError):
            return False

    def delete_document(self, document_id: str) -> None:
        if not self.available():
            return
        identifier = _cypher_string(document_id)
        self._query("MATCH (c:Chunk {document_id:'%s'}) DETACH DELETE c" % identifier)
        self._query("MATCH (d:Document {id:'%s'}) DETACH DELETE d" % identifier)

    def search(self, query: str, allowed_chunk_ids: set[str], limit: int) -> dict[str, float] | None:
        if not self.available() or not allowed_chunk_ids:
            return None
        terms = sorted(set(tokenize(query)))[:12]
        if not terms:
            return {}
        terms_literal = ", ".join(f"'{_cypher_string(term)}'" for term in terms)
        rows = self._query(
            "MATCH (c:Chunk)-[:MENTIONS]->(t:Term) WHERE t.value IN [%s] "
            "RETURN c.id, count(t) AS score ORDER BY score DESC LIMIT %d" % (terms_literal, max(10, limit * 4))
        )
        if rows is None:
            return None
        scores: dict[str, float] = {}
        for row in rows:
            if not isinstance(row, list) or len(row) < 2:
                continue
            chunk_id = str(self._unwrap(row[0]))
            if chunk_id not in allowed_chunk_ids:
                continue
            try:
                scores[chunk_id] = float(self._unwrap(row[1])) / len(terms)
            except (TypeError, ValueError):
                continue
        return scores

    def counts(self) -> tuple[int, int] | None:
        if not self.available():
            return None
        nodes = self._query("MATCH (n) RETURN count(n)")
        edges = self._query("MATCH ()-[r]->() RETURN count(r)")
        try:
            node_count = int(self._unwrap(nodes[0][0])) if nodes and nodes[0] else 0
            edge_count = int(self._unwrap(edges[0][0])) if edges and edges[0] else 0
            return node_count, edge_count
        except (IndexError, TypeError, ValueError):
            return None


class EmbeddingReindexError(RuntimeError):
    def __init__(self, message: str, job_id: str) -> None:
        super().__init__(message)
        self.job_id = job_id


class KnowledgeMetadataUpdateError(RuntimeError):
    def __init__(self, message: str, job_id: str) -> None:
        super().__init__(message)
        self.job_id = job_id


class KnowledgeRevisionRestoreError(RuntimeError):
    def __init__(self, message: str, job_id: str) -> None:
        super().__init__(message)
        self.job_id = job_id


class KnowledgeStore:
    """SQLite metadata source of truth with a best-effort Qdrant vector mirror."""

    def __init__(
        self,
        database_path: str,
        *,
        qdrant_url: str | None = None,
        embedding_runtime: EmbeddingRuntime | None = None,
    ) -> None:
        self.database_path = database_path
        self.qdrant_url = (qdrant_url or os.getenv("QDRANT_URL", "")).strip().rstrip("/")
        self._lock = RLock()
        self._source_group_locks_guard = RLock()
        self._source_group_locks: dict[str, Any] = {}
        self._qdrant_ready: bool | None = None
        self._qdrant_ready_collection: str | None = None
        self.embedding = embedding_runtime or EmbeddingRuntime()
        self.graph = FalkorGraphMirror(os.getenv("FALKORDB_URL", ""))
        if database_path != ":memory:":
            Path(database_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self._create_schema()
        if embedding_runtime is None:
            active = self.runtime_settings("ai.embedding.active_")
            active_provider = active.get("ai.embedding.active_provider")
            active_model = active.get("ai.embedding.active_model")
            if active_provider and active_model:
                self.embedding = EmbeddingRuntime(provider=active_provider, model=active_model)

    def close(self) -> None:
        self.connection.close()

    def _source_group_mutation_lock(self, source_group_id: str) -> Any:
        with self._source_group_locks_guard:
            return self._source_group_locks.setdefault(source_group_id, RLock())

    def _create_schema(self) -> None:
        with self._lock, self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    display_title TEXT,
                    source_key TEXT,
                    issuer TEXT,
                    published_year INTEGER,
                    document_type TEXT,
                    source_url TEXT,
                    summary TEXT,
                    summary_provider TEXT,
                    original_filename TEXT,
                    canonical_source_id TEXT,
                    source_group_id TEXT,
                    content_checksum TEXT,
                    provenance_json TEXT NOT NULL DEFAULT '{}',
                    source_locator TEXT,
                    crop TEXT,
                    cultivation_system TEXT,
                    evidence_class TEXT,
                    growth_stage TEXT,
                    embedding_model TEXT,
                    scope TEXT NOT NULL,
                    farm_id TEXT,
                    source_kind TEXT NOT NULL,
                    version TEXT NOT NULL,
                    content TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    status TEXT NOT NULL,
                    retrieval_state TEXT NOT NULL DEFAULT 'active' CHECK (
                        retrieval_state IN ('active', 'paused', 'needs_review')
                    ),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    chunk_count INTEGER NOT NULL DEFAULT 0,
                    vector_count INTEGER NOT NULL DEFAULT 0,
                    qdrant_vector_count INTEGER NOT NULL DEFAULT 0,
                    graph_node_count INTEGER NOT NULL DEFAULT 0,
                    graph_edge_count INTEGER NOT NULL DEFAULT 0,
                    index_backend TEXT NOT NULL DEFAULT 'sqlite_fallback'
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES documents(id),
                    ordinal INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    start_char INTEGER NOT NULL,
                    end_char INTEGER NOT NULL,
                    embedding TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);
                CREATE TABLE IF NOT EXISTS chunk_terms (
                    chunk_id TEXT NOT NULL REFERENCES chunks(id),
                    term TEXT NOT NULL,
                    PRIMARY KEY (chunk_id, term)
                );
                CREATE INDEX IF NOT EXISTS chunk_terms_term_idx ON chunk_terms(term);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    document_id TEXT,
                    operation TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    error TEXT,
                    details TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_group_previous_revisions (
                    source_group_id TEXT PRIMARY KEY,
                    id TEXT NOT NULL,
                    farm_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    change_summary TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS telemetry_snapshots (
                    id TEXT PRIMARY KEY,
                    farm_id TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    data_origin TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS telemetry_snapshots_farm_idx ON telemetry_snapshots(farm_id, observed_at DESC);
                CREATE TABLE IF NOT EXISTS runtime_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS control_verifications (
                    farm_id TEXT NOT NULL,
                    proposal_id TEXT NOT NULL,
                    verification_payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (farm_id, proposal_id)
                );
                CREATE TABLE IF NOT EXISTS advisor_sessions (
                    id TEXT PRIMARY KEY,
                    farm_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS advisor_sessions_owner_idx
                    ON advisor_sessions(farm_id, owner_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS advisor_turns (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
                    client_turn_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    question TEXT NOT NULL,
                    request_payload TEXT NOT NULL,
                    response_payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(session_id, client_turn_id),
                    UNIQUE(session_id, ordinal)
                );
                CREATE INDEX IF NOT EXISTS advisor_turns_session_idx
                    ON advisor_turns(session_id, ordinal);
                CREATE TABLE IF NOT EXISTS agent_runs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
                    farm_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    user_goal TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('running', 'awaiting_approval', 'executing', 'verifying', 'completed', 'failed')
                    ),
                    current_target TEXT,
                    current_action TEXT,
                    current_value TEXT,
                    context_payload TEXT NOT NULL,
                    result_payload TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS agent_runs_session_idx
                    ON agent_runs(session_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS agent_run_steps (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                    ordinal INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
                    tool_name TEXT,
                    input_payload TEXT,
                    output_payload TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    UNIQUE(run_id, ordinal)
                );
                CREATE INDEX IF NOT EXISTS agent_run_steps_run_idx
                    ON agent_run_steps(run_id, ordinal);
                """
            )
            self._ensure_document_profile_columns()

    @staticmethod
    def _advisor_title(question: str, limit: int = 40) -> str:
        normalized = " ".join(question.split())
        if len(normalized) <= limit:
            return normalized
        return normalized[: limit - 1].rstrip() + "…"

    @classmethod
    def _advisor_preview(cls, response_payload: str | None, question: str | None, limit: int = 120) -> str | None:
        fallback = " ".join(str(question or "").split())
        try:
            answer = str(json.loads(str(response_payload))["answer"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            answer = fallback
        answer = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", answer)
        answer = re.sub(r"(?m)^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+|>\s*)", "", answer)
        answer = re.sub(r"[*_`~]", "", answer)
        normalized = " ".join(answer.split()) or fallback
        return cls._advisor_title(normalized, limit) if normalized else None

    def _advisor_turn_payload(self, row: sqlite3.Row) -> dict[str, Any]:
        try:
            request_payload = json.loads(str(row["request_payload"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            request_payload = {}
        if not isinstance(request_payload, dict):
            request_payload = {}
        selected_source_ids = request_payload.get("selected_source_ids")
        if not isinstance(selected_source_ids, list):
            selected_source_ids = []
        selected_zone_ids = request_payload.get("selected_zone_ids")
        if not isinstance(selected_zone_ids, list):
            selected_zone_ids = []
        source_visibility = "all" if request_payload.get("source_context_visibility") == "all" else "public"
        response = json.loads(str(row["response_payload"]))
        # Historical drafts can predate current execution limits. Keep their
        # original stored evidence intact, but do not revive an invalid action.
        legacy_draft = response.get("control_draft") if isinstance(response, dict) else None
        if isinstance(legacy_draft, dict) and len(legacy_draft.get("evidence_ids") or []) > 20:
            response["control_draft"] = None
            response["answer"] = str(response.get("answer") or "") + (
                "\n\n이전 형식의 조정안은 기록으로만 보관합니다. "
                "새 조정이 필요하면 현재 상태를 다시 확인해 주세요."
            )
        context_patch = response.get("context_patch") if isinstance(response, dict) else None
        if isinstance(context_patch, dict) and context_patch.get("error") is None:
            if context_patch.get("operation") != "search" and isinstance(context_patch.get("source_group_ids"), list):
                selected_source_ids = context_patch["source_group_ids"]
            if context_patch.get("visibility") in {"public", "all"}:
                source_visibility = context_patch["visibility"]
        stored_agent = response.get("agent_run") if isinstance(response, dict) else None
        run_id = stored_agent.get("run_id") if isinstance(stored_agent, dict) else None
        if isinstance(run_id, str):
            current_run = self.get_agent_run(run_id)
            if current_run is not None:
                response["agent_run"] = {
                    "run_id": current_run["id"],
                    "status": current_run["status"],
                    "goal": current_run["user_goal"],
                    "current_target": current_run["current_target"],
                    "steps": [
                        {
                            "sequence": step["sequence"],
                            "kind": step["kind"],
                            "status": step["status"],
                            "label": (step["output"] or {}).get("label") or step["kind"],
                            "tool_name": step["tool_name"],
                            "detail": (step["output"] or {}).get("detail"),
                        }
                        for step in current_run["steps"]
                    ],
                }
        return {
            "id": str(row["client_turn_id"]),
            "client_turn_id": str(row["client_turn_id"]),
            "question": str(row["question"]),
            "query_context": {
                "bed_id": request_payload.get("bed_id"),
                "tier": request_payload.get("tier"),
                "cycle_id": request_payload.get("cycle_id"),
                "video_analysis_id": request_payload.get("video_analysis_id"),
                "selected_source_ids": [item for item in selected_source_ids if isinstance(item, str)],
                "source_selection_mode": (
                    "explicit" if request_payload.get("source_selection_mode") == "explicit" else "automatic"
                ),
                "include_simulation_context": request_payload.get("include_simulation_context") is True,
                "selected_zone_ids": [item for item in selected_zone_ids if isinstance(item, str)],
                "zone_scope_mode": "focused" if request_payload.get("zone_scope_mode") == "focused" else "all",
                "source_visibility": source_visibility,
            },
            "response": response,
            "created_at": str(row["created_at"]),
            "request_payload": request_payload,
        }

    def create_advisor_session(
        self,
        farm_id: str,
        owner_id: str,
        title: str | None = None,
        *,
        reuse_title: bool = False,
    ) -> dict[str, Any]:
        session_id = f"advisor-session-{uuid4().hex}"
        now = datetime.now(timezone.utc).isoformat()
        normalized_title = " ".join((title or "새 대화").split()) or "새 대화"
        existing_id: str | None = None
        with self._lock, self.connection:
            if reuse_title:
                existing = self.connection.execute(
                    """
                    SELECT id FROM advisor_sessions
                    WHERE farm_id=? AND owner_id=? AND title=?
                    ORDER BY updated_at DESC LIMIT 1
                    """,
                    (farm_id, owner_id, normalized_title),
                ).fetchone()
                existing_id = str(existing["id"]) if existing is not None else None
            if existing_id is None:
                self.connection.execute(
                    """
                    INSERT INTO advisor_sessions (id, farm_id, owner_id, title, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (session_id, farm_id, owner_id, normalized_title, now, now),
                )
        if existing_id is not None:
            existing_session = self.get_advisor_session(existing_id, farm_id, owner_id)
            if existing_session is not None:
                return existing_session
        return {
            "id": session_id,
            "farm_id": farm_id,
            "title": normalized_title,
            "preview": None,
            "turn_count": 0,
            "created_at": now,
            "updated_at": now,
            "turns": [],
        }

    def list_advisor_sessions(self, farm_id: str, owner_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                """
                SELECT s.id, s.farm_id, s.title, s.created_at, s.updated_at,
                    COUNT(t.id) AS turn_count,
                    (
                        SELECT latest.response_payload FROM advisor_turns latest
                        WHERE latest.session_id=s.id
                        ORDER BY latest.ordinal DESC LIMIT 1
                    ) AS preview_response,
                    (
                        SELECT latest.question FROM advisor_turns latest
                        WHERE latest.session_id=s.id
                        ORDER BY latest.ordinal DESC LIMIT 1
                    ) AS preview_question
                FROM advisor_sessions s
                LEFT JOIN advisor_turns t ON t.session_id=s.id
                WHERE s.farm_id=? AND s.owner_id=?
                GROUP BY s.id
                ORDER BY s.updated_at DESC, s.id DESC
                """,
                (farm_id, owner_id),
            ).fetchall()
        return [
            {
                "id": str(row["id"]),
                "farm_id": str(row["farm_id"]),
                "title": str(row["title"]),
                "preview": self._advisor_preview(row["preview_response"], row["preview_question"]),
                "turn_count": int(row["turn_count"]),
                "created_at": str(row["created_at"]),
                "updated_at": str(row["updated_at"]),
            }
            for row in rows
        ]

    def get_advisor_session(self, session_id: str, farm_id: str, owner_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self.connection.execute(
                """
                SELECT id, farm_id, title, created_at, updated_at
                FROM advisor_sessions WHERE id=? AND farm_id=? AND owner_id=?
                """,
                (session_id, farm_id, owner_id),
            ).fetchone()
            if session is None:
                return None
            turns = self.connection.execute(
                "SELECT * FROM advisor_turns WHERE session_id=? ORDER BY ordinal",
                (session_id,),
            ).fetchall()
        return {
            "id": str(session["id"]),
            "farm_id": str(session["farm_id"]),
            "title": str(session["title"]),
            "preview": self._advisor_preview(
                turns[-1]["response_payload"] if turns else None,
                turns[-1]["question"] if turns else None,
            ),
            "turn_count": len(turns),
            "created_at": str(session["created_at"]),
            "updated_at": str(session["updated_at"]),
            "turns": [self._advisor_turn_payload(row) for row in turns],
        }

    def rename_advisor_session(
        self,
        session_id: str,
        farm_id: str,
        owner_id: str,
        title: str,
    ) -> dict[str, Any] | None:
        normalized_title = " ".join(title.split())
        if not normalized_title:
            raise ValueError("Advisor session title cannot be blank")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self.connection:
            cursor = self.connection.execute(
                """
                UPDATE advisor_sessions SET title=?, updated_at=?
                WHERE id=? AND farm_id=? AND owner_id=?
                """,
                (normalized_title, now, session_id, farm_id, owner_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get_advisor_session(session_id, farm_id, owner_id)

    def delete_advisor_session(self, session_id: str, farm_id: str, owner_id: str) -> bool:
        with self._lock, self.connection:
            session = self.connection.execute(
                "SELECT id FROM advisor_sessions WHERE id=? AND farm_id=? AND owner_id=?",
                (session_id, farm_id, owner_id),
            ).fetchone()
            if session is None:
                return False
            self.connection.execute(
                "DELETE FROM agent_run_steps WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id=?)",
                (session_id,),
            )
            self.connection.execute("DELETE FROM agent_runs WHERE session_id=?", (session_id,))
            self.connection.execute("DELETE FROM advisor_turns WHERE session_id=?", (session_id,))
            self.connection.execute("DELETE FROM advisor_sessions WHERE id=?", (session_id,))
        return True

    def get_advisor_turn(
        self,
        session_id: str,
        client_turn_id: str,
        farm_id: str,
        owner_id: str,
    ) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute(
                """
                SELECT t.* FROM advisor_turns t
                JOIN advisor_sessions s ON s.id=t.session_id
                WHERE t.session_id=? AND t.client_turn_id=? AND s.farm_id=? AND s.owner_id=?
                """,
                (session_id, client_turn_id, farm_id, owner_id),
            ).fetchone()
        return self._advisor_turn_payload(row) if row is not None else None

    def advisor_history(
        self,
        session_id: str,
        farm_id: str,
        owner_id: str,
        limit: int = 6,
    ) -> list[tuple[str, str]]:
        if limit <= 0:
            return []
        with self._lock:
            rows = self.connection.execute(
                """
                SELECT t.question, t.response_payload FROM advisor_turns t
                JOIN advisor_sessions s ON s.id=t.session_id
                WHERE t.session_id=? AND s.farm_id=? AND s.owner_id=?
                ORDER BY t.ordinal DESC
                """,
                (session_id, farm_id, owner_id),
            ).fetchall()
        history: list[tuple[str, str]] = []
        for row in rows:
            try:
                response = json.loads(str(row["response_payload"]))
                execution = response["execution"]
                if not isinstance(execution, dict) or execution.get("remote_llm_used") is not True or execution.get(
                    "privacy_route"
                ) not in {
                    "public_only_remote",
                    "simulation_and_public_remote",
                }:
                    continue
                answer = str(response["answer"])
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
            history.append((str(row["question"]), answer))
            if len(history) == limit:
                break
        history.reverse()
        return history

    def append_advisor_turn(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        farm_id: str,
        owner_id: str,
        question: str,
        request_payload: dict[str, Any],
        response_payload: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, bool]:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self.connection:
            session = self.connection.execute(
                """
                SELECT id, title FROM advisor_sessions
                WHERE id=? AND farm_id=? AND owner_id=?
                """,
                (session_id, farm_id, owner_id),
            ).fetchone()
            if session is None:
                return None, False
            existing = self.connection.execute(
                "SELECT * FROM advisor_turns WHERE session_id=? AND client_turn_id=?",
                (session_id, client_turn_id),
            ).fetchone()
            if existing is not None:
                return self._advisor_turn_payload(existing), False
            ordinal = int(
                self.connection.execute(
                    "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM advisor_turns WHERE session_id=?",
                    (session_id,),
                ).fetchone()[0]
            )
            turn_id = f"advisor-turn-{uuid4().hex}"
            self.connection.execute(
                """
                INSERT INTO advisor_turns (
                    id, session_id, client_turn_id, ordinal, question,
                    request_payload, response_payload, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    turn_id,
                    session_id,
                    client_turn_id,
                    ordinal,
                    question,
                    json.dumps(request_payload, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(response_payload, ensure_ascii=False, separators=(",", ":")),
                    now,
                ),
            )
            next_title = str(session["title"])
            if ordinal == 1 and next_title == "새 대화":
                next_title = self._advisor_title(question)
            self.connection.execute(
                "UPDATE advisor_sessions SET title=?, updated_at=? WHERE id=?",
                (next_title, now, session_id),
            )
            stored = self.connection.execute("SELECT * FROM advisor_turns WHERE id=?", (turn_id,)).fetchone()
        return self._advisor_turn_payload(stored), True

    @staticmethod
    def _agent_json_object(value: str | None) -> dict[str, Any] | None:
        if value is None:
            return None
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        return decoded if isinstance(decoded, dict) else None

    @staticmethod
    def _agent_value(value: str | None) -> Any:
        if value is None:
            return None
        try:
            return json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return value

    @classmethod
    def _agent_step_payload(cls, row: sqlite3.Row) -> AgentRunStepRecord:
        return {
            "id": str(row["id"]),
            "run_id": str(row["run_id"]),
            "sequence": int(row["ordinal"]),
            "kind": str(row["kind"]),
            "status": str(row["status"]),  # type: ignore[typeddict-item]
            "tool_name": str(row["tool_name"]) if row["tool_name"] is not None else None,
            "input": cls._agent_json_object(row["input_payload"]),
            "output": cls._agent_json_object(row["output_payload"]),
            "error": str(row["error"]) if row["error"] is not None else None,
            "created_at": str(row["created_at"]),
            "completed_at": str(row["completed_at"]) if row["completed_at"] is not None else None,
        }

    @classmethod
    def _agent_run_payload(
        cls,
        row: sqlite3.Row,
        steps: list[sqlite3.Row],
    ) -> AgentRunRecord:
        return {
            "id": str(row["id"]),
            "session_id": str(row["session_id"]),
            "farm_id": str(row["farm_id"]),
            "owner_id": str(row["owner_id"]),
            "user_goal": str(row["user_goal"]),
            "status": str(row["status"]),  # type: ignore[typeddict-item]
            "current_target": str(row["current_target"]) if row["current_target"] is not None else None,
            "current_action": str(row["current_action"]) if row["current_action"] is not None else None,
            "current_value": cls._agent_value(row["current_value"]),
            "context": cls._agent_json_object(row["context_payload"]) or {},
            "result": cls._agent_json_object(row["result_payload"]),
            "error": str(row["error"]) if row["error"] is not None else None,
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
            "completed_at": str(row["completed_at"]) if row["completed_at"] is not None else None,
            "steps": [cls._agent_step_payload(step) for step in steps],
        }

    @staticmethod
    def _validate_agent_run_status(status: str) -> None:
        if status not in AGENT_RUN_STATUSES:
            raise ValueError(f"Unsupported agent run status: {status}")

    @staticmethod
    def _validate_agent_step_status(status: str) -> None:
        if status not in AGENT_RUN_STEP_STATUSES:
            raise ValueError(f"Unsupported agent run step status: {status}")

    def create_agent_run(
        self,
        session_id: str,
        farm_id: str,
        owner_id: str,
        user_goal: str,
        *,
        run_id: str | None = None,
        status: AgentRunStatus = "running",
        current_target: str | None = None,
        current_action: str | None = None,
        current_value: Any = None,
        context: dict[str, Any] | None = None,
    ) -> AgentRunRecord | None:
        """Create one bounded agent run inside an owned advisor session."""

        self._validate_agent_run_status(status)
        normalized_goal = " ".join(user_goal.split())
        if not normalized_goal:
            raise ValueError("Agent run goal cannot be blank")
        candidate_id = (run_id or f"agent-run-{uuid4().hex}").strip()
        if not candidate_id:
            raise ValueError("Agent run id cannot be blank")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self.connection:
            session = self.connection.execute(
                "SELECT id FROM advisor_sessions WHERE id=? AND farm_id=? AND owner_id=?",
                (session_id, farm_id, owner_id),
            ).fetchone()
            if session is None:
                return None
            self.connection.execute(
                """
                INSERT INTO agent_runs (
                    id, session_id, farm_id, owner_id, user_goal, status,
                    current_target, current_action, current_value, context_payload,
                    result_payload, error, created_at, updated_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
                """,
                (
                    candidate_id,
                    session_id,
                    farm_id,
                    owner_id,
                    normalized_goal,
                    status,
                    current_target,
                    current_action,
                    json.dumps(current_value, ensure_ascii=False, separators=(",", ":"))
                    if current_value is not None
                    else None,
                    json.dumps(context or {}, ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                    now if status in {"completed", "failed"} else None,
                ),
            )
        return self.get_agent_run(candidate_id, farm_id=farm_id, owner_id=owner_id)

    def get_agent_run(
        self,
        run_id: str,
        *,
        farm_id: str | None = None,
        owner_id: str | None = None,
    ) -> AgentRunRecord | None:
        clauses = ["id=?"]
        parameters: list[str] = [run_id]
        if farm_id is not None:
            clauses.append("farm_id=?")
            parameters.append(farm_id)
        if owner_id is not None:
            clauses.append("owner_id=?")
            parameters.append(owner_id)
        with self._lock:
            row = self.connection.execute(
                f"SELECT * FROM agent_runs WHERE {' AND '.join(clauses)}",
                tuple(parameters),
            ).fetchone()
            if row is None:
                return None
            steps = self.connection.execute(
                "SELECT * FROM agent_run_steps WHERE run_id=? ORDER BY ordinal",
                (run_id,),
            ).fetchall()
        return self._agent_run_payload(row, list(steps))

    def update_agent_run(
        self,
        run_id: str,
        *,
        farm_id: str | None = None,
        owner_id: str | None = None,
        status: AgentRunStatus | object = _UNSET,
        current_target: str | None | object = _UNSET,
        current_action: str | None | object = _UNSET,
        current_value: Any = _UNSET,
        context: dict[str, Any] | object = _UNSET,
        result: dict[str, Any] | None | object = _UNSET,
        error: str | None | object = _UNSET,
    ) -> AgentRunRecord | None:
        """Update explicitly supplied fields and return the complete run."""

        if status is not _UNSET:
            self._validate_agent_run_status(str(status))
        clauses = ["id=?"]
        query_parameters: list[str] = [run_id]
        if farm_id is not None:
            clauses.append("farm_id=?")
            query_parameters.append(farm_id)
        if owner_id is not None:
            clauses.append("owner_id=?")
            query_parameters.append(owner_id)
        with self._lock, self.connection:
            existing = self.connection.execute(
                f"SELECT id FROM agent_runs WHERE {' AND '.join(clauses)}",
                tuple(query_parameters),
            ).fetchone()
            if existing is None:
                return None
            assignments: list[str] = []
            values: list[Any] = []
            for column, value in (
                ("status", status),
                ("current_target", current_target),
                ("current_action", current_action),
                ("error", error),
            ):
                if value is not _UNSET:
                    assignments.append(f"{column}=?")
                    values.append(value)
            if current_value is not _UNSET:
                assignments.append("current_value=?")
                values.append(
                    json.dumps(current_value, ensure_ascii=False, separators=(",", ":"))
                    if current_value is not None
                    else None
                )
            if context is not _UNSET:
                assignments.append("context_payload=?")
                values.append(json.dumps(context, ensure_ascii=False, separators=(",", ":")))
            if result is not _UNSET:
                assignments.append("result_payload=?")
                values.append(
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")) if result is not None else None
                )
            now = datetime.now(timezone.utc).isoformat()
            if status is not _UNSET:
                assignments.append("completed_at=?")
                values.append(now if status in {"completed", "failed"} else None)
            assignments.append("updated_at=?")
            values.append(now)
            values.append(run_id)
            self.connection.execute(
                f"UPDATE agent_runs SET {', '.join(assignments)} WHERE id=?",
                tuple(values),
            )
        return self.get_agent_run(run_id, farm_id=farm_id, owner_id=owner_id)

    def append_agent_run_step(
        self,
        run_id: str,
        kind: str,
        status: AgentRunStepStatus = "completed",
        *,
        farm_id: str | None = None,
        tool_name: str | None = None,
        input_payload: dict[str, Any] | None = None,
        output_payload: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> AgentRunStepRecord | None:
        """Append an ordered observation or action to an existing run."""

        self._validate_agent_step_status(status)
        normalized_kind = " ".join(kind.split())
        if not normalized_kind:
            raise ValueError("Agent run step kind cannot be blank")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self.connection:
            run = self.connection.execute(
                "SELECT id FROM agent_runs WHERE id=?" + (" AND farm_id=?" if farm_id is not None else ""),
                (run_id, farm_id) if farm_id is not None else (run_id,),
            ).fetchone()
            if run is None:
                return None
            sequence = int(
                self.connection.execute(
                    "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM agent_run_steps WHERE run_id=?",
                    (run_id,),
                ).fetchone()[0]
            )
            step_id = f"agent-step-{uuid4().hex}"
            self.connection.execute(
                """
                INSERT INTO agent_run_steps (
                    id, run_id, ordinal, kind, status, tool_name,
                    input_payload, output_payload, error, created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    step_id,
                    run_id,
                    sequence,
                    normalized_kind,
                    status,
                    tool_name,
                    json.dumps(input_payload, ensure_ascii=False, separators=(",", ":"))
                    if input_payload is not None
                    else None,
                    json.dumps(output_payload, ensure_ascii=False, separators=(",", ":"))
                    if output_payload is not None
                    else None,
                    error,
                    now,
                    now if status in {"completed", "failed"} else None,
                ),
            )
            self.connection.execute("UPDATE agent_runs SET updated_at=? WHERE id=?", (now, run_id))
            stored = self.connection.execute("SELECT * FROM agent_run_steps WHERE id=?", (step_id,)).fetchone()
        return self._agent_step_payload(stored) if stored is not None else None

    def finish_latest_agent_run_step(
        self,
        run_id: str,
        kind: str,
        status: AgentRunStepStatus,
        *,
        farm_id: str | None = None,
        tool_name: str | None = None,
        output_payload: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> AgentRunStepRecord | None:
        """Finish the newest running step without leaving stale progress behind."""

        self._validate_agent_step_status(status)
        if status == "running":
            raise ValueError("A finished agent run step cannot remain running")
        normalized_kind = " ".join(kind.split())
        if not normalized_kind:
            raise ValueError("Agent run step kind cannot be blank")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self.connection:
            parameters: list[str] = [run_id, normalized_kind]
            farm_clause = ""
            if farm_id is not None:
                farm_clause = "AND agent_runs.farm_id=?"
                parameters.append(farm_id)
            row = self.connection.execute(
                f"""
                SELECT agent_run_steps.id
                FROM agent_run_steps
                JOIN agent_runs ON agent_runs.id=agent_run_steps.run_id
                WHERE agent_run_steps.run_id=? AND agent_run_steps.kind=?
                    AND agent_run_steps.status='running' {farm_clause}
                ORDER BY agent_run_steps.ordinal DESC
                LIMIT 1
                """,
                tuple(parameters),
            ).fetchone()
            if row is None:
                return None
            self.connection.execute(
                """
                UPDATE agent_run_steps
                SET status=?, tool_name=COALESCE(?, tool_name), output_payload=?, error=?, completed_at=?
                WHERE id=?
                """,
                (
                    status,
                    tool_name,
                    json.dumps(output_payload, ensure_ascii=False, separators=(",", ":"))
                    if output_payload is not None
                    else None,
                    error,
                    now,
                    row["id"],
                ),
            )
            self.connection.execute("UPDATE agent_runs SET updated_at=? WHERE id=?", (now, run_id))
            stored = self.connection.execute(
                "SELECT * FROM agent_run_steps WHERE id=?",
                (row["id"],),
            ).fetchone()
        return self._agent_step_payload(stored) if stored is not None else None

    def get_latest_agent_context(
        self,
        session_id: str,
        farm_id: str,
        owner_id: str,
    ) -> AgentControlContext | None:
        """Return the newest structured control target for a conversation."""

        with self._lock:
            row = self.connection.execute(
                """
                SELECT id, current_target, current_action, current_value, updated_at
                FROM agent_runs
                WHERE session_id=? AND farm_id=? AND owner_id=?
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                (session_id, farm_id, owner_id),
            ).fetchone()
        if row is None or row["current_target"] is None:
            return None
        return {
            "run_id": str(row["id"]),
            "target": str(row["current_target"]),
            "action": str(row["current_action"]) if row["current_action"] is not None else None,
            "value": self._agent_value(row["current_value"]),
            "updated_at": str(row["updated_at"]),
        }

    def decline_advisor_control_draft(
        self,
        run_id: str,
        farm_id: str,
        owner_id: str,
    ) -> bool:
        """Remove one declined draft from an owned conversation without deleting its answer."""

        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self.connection:
            rows = self.connection.execute(
                """
                SELECT t.id, t.session_id, t.response_payload
                FROM advisor_turns t
                JOIN advisor_sessions s ON s.id=t.session_id
                WHERE s.farm_id=? AND s.owner_id=?
                ORDER BY t.ordinal DESC
                """,
                (farm_id, owner_id),
            ).fetchall()
            for row in rows:
                try:
                    response = json.loads(str(row["response_payload"]))
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                draft = response.get("control_draft") if isinstance(response, dict) else None
                if not isinstance(draft, dict) or draft.get("advisor_run_id") != run_id:
                    continue
                response["control_draft"] = None
                self.connection.execute(
                    "UPDATE advisor_turns SET response_payload=? WHERE id=?",
                    (json.dumps(response, ensure_ascii=False, separators=(",", ":")), str(row["id"])),
                )
                self.connection.execute(
                    "UPDATE advisor_sessions SET updated_at=? WHERE id=?",
                    (now, str(row["session_id"])),
                )
                return True
        return False

    def runtime_settings(self, prefix: str = "ai.") -> dict[str, str]:
        """Read small local runtime overrides without exposing them by default."""

        with self._lock:
            rows = self.connection.execute(
                "SELECT key, value FROM runtime_settings WHERE key LIKE ? ORDER BY key",
                (f"{prefix}%",),
            ).fetchall()
        return {str(row["key"]): str(row["value"]) for row in rows}

    def get_control_verification(self, farm_id: str, proposal_id: str) -> dict[str, Any] | None:
        """Return the durable post-control observation for one farm proposal."""

        with self._lock:
            row = self.connection.execute(
                """
                SELECT verification_payload FROM control_verifications
                WHERE farm_id=? AND proposal_id=?
                """,
                (farm_id, proposal_id),
            ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(str(row["verification_payload"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def store_control_verification(
        self,
        farm_id: str,
        proposal_id: str,
        verification: dict[str, Any],
    ) -> None:
        """Persist the authoritative observation without depending on chat sessions."""

        now = utc_now_iso()
        payload = json.dumps(verification, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self.connection:
            self.connection.execute(
                """
                INSERT INTO control_verifications (
                    farm_id, proposal_id, verification_payload, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(farm_id, proposal_id) DO UPDATE SET
                    verification_payload=excluded.verification_payload,
                    updated_at=excluded.updated_at
                """,
                (farm_id, proposal_id, payload, now, now),
            )

    def update_runtime_settings(self, values: dict[str, str | None]) -> None:
        now = utc_now_iso()
        with self._lock, self.connection:
            for key, value in values.items():
                if not key.startswith(("ai.", "farm.location.")):
                    raise ValueError("Only AI and farm location runtime settings may be stored here")
                if value is None:
                    self.connection.execute("DELETE FROM runtime_settings WHERE key=?", (key,))
                else:
                    self.connection.execute(
                        """
                        INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                        """,
                        (key, value, now),
                    )

    def reset_runtime_settings(self, prefix: str = "ai.") -> int:
        with self._lock, self.connection:
            cursor = self.connection.execute(
                """
                DELETE FROM runtime_settings
                WHERE key LIKE ? AND key NOT IN ('ai.embedding.active_provider', 'ai.embedding.active_model')
                """,
                (f"{prefix}%",),
            )
        return max(0, int(cursor.rowcount))

    def _ensure_document_profile_columns(self) -> None:
        existing = {str(row["name"]) for row in self.connection.execute("PRAGMA table_info(documents)").fetchall()}
        additions = {
            "display_title": "TEXT",
            "source_key": "TEXT",
            "issuer": "TEXT",
            "published_year": "INTEGER",
            "document_type": "TEXT",
            "source_url": "TEXT",
            "summary": "TEXT",
            "summary_provider": "TEXT",
            "original_filename": "TEXT",
            "canonical_source_id": "TEXT",
            "source_group_id": "TEXT",
            "content_checksum": "TEXT",
            "provenance_json": "TEXT NOT NULL DEFAULT '{}'",
            "source_locator": "TEXT",
            "crop": "TEXT",
            "cultivation_system": "TEXT",
            "evidence_class": "TEXT",
            "growth_stage": "TEXT",
            "embedding_model": "TEXT",
            "retrieval_state": "TEXT NOT NULL DEFAULT 'active'",
        }
        for column, definition in additions.items():
            if column not in existing:
                self.connection.execute(f"ALTER TABLE documents ADD COLUMN {column} {definition}")
        self.connection.execute(
            "UPDATE documents SET retrieval_state='active' "
            "WHERE retrieval_state IS NULL OR retrieval_state NOT IN ('active', 'paused', 'needs_review')"
        )
        rows = self.connection.execute("SELECT * FROM documents").fetchall()
        for row in rows:
            is_imported_reference = bool(_provenance_fields(str(row["content"]))) and row["source_kind"] == "public_knowledge"
            is_legacy_import = is_imported_reference and (
                str(row["version"]) == "legacy-release-v1"
                or str(row["title"]).startswith("[legacy:")
            )
            profile = document_profile(
                title=str(row["title"]),
                content=str(row["content"]),
                # Only old importer rows need a one-time safe profile.  Curated
                # records already carry operator-reviewed labels and must not
                # be replaced by a weaker heuristic on every restart.
                display_title=None if is_legacy_import else row["display_title"],
                issuer=None if is_legacy_import else row["issuer"],
                published_year=row["published_year"],
                document_type=row["document_type"],
                source_url=row["source_url"],
                summary=row["summary"],
                source_key=row["source_key"],
                original_filename=row["original_filename"],
            )
            domain = _document_domain_metadata(
                content=str(row["content"]),
                scope=str(row["scope"]),
                source_kind=str(row["source_kind"]),
            )
            derived_canonical_source_id = _canonical_source_id(
                content=str(row["content"]),
                source_url=profile["source_url"],
                original_filename=profile["original_filename"],
            )
            stored_canonical_source_id = str(row["canonical_source_id"] or "")
            migrate_local_file_identity = bool(
                stored_canonical_source_id.startswith("content:")
                and derived_canonical_source_id.startswith("file:")
            )
            canonical_source_id = (
                derived_canonical_source_id
                if migrate_local_file_identity or not stored_canonical_source_id
                else stored_canonical_source_id
            )
            source_group_identity = canonical_source_id or f"document:{row['id']}"
            owner_component = f"owner:{row['farm_id']}:" if row["farm_id"] else ""
            source_group_id = (
                f"source-group:{row['scope']}:{owner_component}{source_group_identity}"
                if migrate_local_file_identity
                else str(row["source_group_id"] or "")
                or f"source-group:{row['scope']}:{source_group_identity}"
            )
            content_checksum = _content_checksum(str(row["content"]))
            provenance = _structured_document_provenance(
                content=str(row["content"]),
                canonical_source_id=canonical_source_id,
                version=str(row["version"]),
                content_checksum=content_checksum,
                source_locator=profile["source_locator"],
            )
            self.connection.execute(
                """
                UPDATE documents SET display_title=?, source_key=?, issuer=?, published_year=?, document_type=?, source_url=?,
                    summary=?, summary_provider=?, original_filename=?, canonical_source_id=?, source_group_id=?, content_checksum=?,
                    provenance_json=?, source_locator=?, crop=?, cultivation_system=?, evidence_class=?, growth_stage=?,
                    qdrant_vector_count=CASE WHEN embedding_model IS NULL THEN 0 ELSE qdrant_vector_count END,
                    index_backend=CASE WHEN embedding_model IS NULL THEN 'sqlite_fallback' ELSE index_backend END,
                    embedding_model=COALESCE(embedding_model, 'legacy-hash-v1') WHERE id=?
                """,
                (
                    profile["display_title"], profile["source_key"], profile["issuer"], profile["published_year"],
                    profile["document_type"], profile["source_url"], profile["summary"], profile["summary_provider"],
                    profile["original_filename"], canonical_source_id, source_group_id, content_checksum,
                    json.dumps(provenance, ensure_ascii=False, sort_keys=True),
                    profile["source_locator"], domain["crop"], domain["cultivation_system"], domain["evidence_class"],
                    domain["growth_stage"], row["id"],
                ),
            )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS documents_canonical_source_idx ON documents(canonical_source_id, source_locator)"
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS documents_source_group_idx ON documents(source_group_id, farm_id, status)"
        )
        self.connection.execute("CREATE INDEX IF NOT EXISTS documents_content_checksum_idx ON documents(content_checksum)")

    def _run_qdrant(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any] | None:
        if not self.qdrant_url:
            return None
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"{self.qdrant_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"} if body else {},
            method=method,
        )
        try:
            with urlopen(request, timeout=1.5) as response:  # noqa: S310 - operator-configured local Qdrant endpoint.
                text = response.read().decode("utf-8")
                return json.loads(text) if text else {}
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError):
            return None

    def _ensure_qdrant(self) -> bool:
        collection_name = self.embedding.collection_name
        if self._qdrant_ready is True and self._qdrant_ready_collection == collection_name:
            return True
        if not self.qdrant_url:
            self._qdrant_ready = False
            return False
        existing = self._run_qdrant("GET", f"/collections/{collection_name}")
        if existing is not None and self._qdrant_collection_matches(existing):
            self._qdrant_ready = True
            self._qdrant_ready_collection = collection_name
            return True
        created = self._run_qdrant(
            "PUT",
            f"/collections/{collection_name}",
            {"vectors": {"size": self.embedding.vector_size, "distance": "Cosine"}},
        )
        self._qdrant_ready = created is not None
        self._qdrant_ready_collection = collection_name if self._qdrant_ready else None
        return self._qdrant_ready

    def _qdrant_collection_matches(self, response: dict[str, Any]) -> bool:
        vectors = (((response.get("result") or {}).get("config") or {}).get("params") or {}).get("vectors")
        if not isinstance(vectors, dict):
            # Test doubles and older Qdrant responses may omit config details.
            return True
        try:
            return int(vectors.get("size")) == self.embedding.vector_size
        except (TypeError, ValueError):
            return False

    def _qdrant_collection_available(self) -> bool:
        """Read the active collection state without creating or synchronizing it."""

        if not self.qdrant_url:
            return False
        response = self._run_qdrant("GET", f"/collections/{self.embedding.collection_name}")
        return response is not None and self._qdrant_collection_matches(response)

    @staticmethod
    def _point_id(chunk_id: str) -> int:
        return int(sha256(chunk_id.encode("utf-8")).hexdigest()[:15], 16)

    def _qdrant_upsert(self, document: dict[str, Any], chunks: list[dict[str, Any]]) -> int:
        if not self._ensure_qdrant() or not chunks:
            return 0
        points = []
        for chunk in chunks:
            points.append(
                {
                    "id": self._point_id(chunk["id"]),
                    "vector": chunk["embedding"],
                    "payload": {
                        "chunk_id": chunk["id"],
                        "document_id": document["id"],
                        "title": document["title"],
                        "scope": document["scope"],
                        "farm_id": document.get("farm_id"),
                        "source_kind": document["source_kind"],
                        "version": document["version"],
                        "source_group_id": document.get("source_group_id"),
                        "canonical_source_id": document.get("canonical_source_id"),
                        "content_checksum": document.get("content_checksum"),
                        "provenance": json.loads(str(document.get("provenance_json") or "{}")),
                        "crop": document.get("crop"),
                        "cultivation_system": document.get("cultivation_system"),
                        "evidence_class": document.get("evidence_class"),
                        "growth_stage": document.get("growth_stage"),
                        "source_locator": document.get("source_locator"),
                        "issuer": document.get("issuer"),
                        "published_year": document.get("published_year"),
                        "source_url": document.get("source_url"),
                        "ordinal": chunk["ordinal"],
                        "text": chunk["text"],
                    },
                }
            )
        result = self._run_qdrant(
            "PUT",
            f"/collections/{self.embedding.collection_name}/points?wait=true",
            {"points": points},
        )
        return len(chunks) if result is not None else 0

    def _prepare_qdrant_for_embedding(self, embedding: EmbeddingRuntime, *, reset_existing: bool) -> bool:
        """Prepare a candidate collection without changing the active runtime cache."""

        if not self.qdrant_url:
            return False
        existing = self._run_qdrant("GET", f"/collections/{embedding.collection_name}")
        if existing is not None and reset_existing:
            if self._run_qdrant("DELETE", f"/collections/{embedding.collection_name}") is None:
                return False
            existing = None
        if existing is not None:
            vectors = (((existing.get("result") or {}).get("config") or {}).get("params") or {}).get("vectors")
            if not isinstance(vectors, dict) or int(vectors.get("size", embedding.vector_size)) == embedding.vector_size:
                return True
        created = self._run_qdrant(
            "PUT",
            f"/collections/{embedding.collection_name}",
            {"vectors": {"size": embedding.vector_size, "distance": "Cosine"}},
        )
        return created is not None

    def _qdrant_upsert_for_embedding(
        self,
        embedding: EmbeddingRuntime,
        document: sqlite3.Row,
        chunks: list[dict[str, Any]],
    ) -> int:
        points = [
            {
                "id": self._point_id(str(chunk["id"])),
                "vector": chunk["embedding"],
                "payload": {
                    "chunk_id": chunk["id"],
                    "document_id": document["id"],
                    "title": document["display_title"] or document["title"],
                    "scope": document["scope"],
                    "farm_id": document["farm_id"],
                    "source_kind": document["source_kind"],
                    "version": document["version"],
                    "source_group_id": document["source_group_id"],
                    "canonical_source_id": document["canonical_source_id"],
                    "content_checksum": document["content_checksum"],
                    "provenance": json.loads(str(document["provenance_json"] or "{}")),
                    "crop": document["crop"],
                    "cultivation_system": document["cultivation_system"],
                    "evidence_class": document["evidence_class"],
                    "growth_stage": document["growth_stage"],
                    "source_locator": document["source_locator"],
                    "issuer": document["issuer"],
                    "published_year": document["published_year"],
                    "source_url": document["source_url"],
                    "ordinal": chunk["ordinal"],
                    "text": chunk["text"],
                },
            }
            for chunk in chunks
        ]
        if not points:
            return 0
        result = self._run_qdrant(
            "PUT",
            f"/collections/{embedding.collection_name}/points?wait=true",
            {"points": points},
        )
        return len(points) if result is not None else 0

    def _qdrant_set_metadata(self, chunk_ids: list[str], metadata: dict[str, Any]) -> bool:
        if not chunk_ids:
            return True
        if not self._qdrant_collection_available():
            return False
        result = self._run_qdrant(
            "POST",
            f"/collections/{self.embedding.collection_name}/points/payload?wait=true",
            {
                "payload": metadata,
                "points": [self._point_id(chunk_id) for chunk_id in chunk_ids],
            },
        )
        return result is not None

    def _qdrant_delete(self, chunk_ids: Iterable[str]) -> None:
        ids = [self._point_id(chunk_id) for chunk_id in chunk_ids]
        if ids and self._ensure_qdrant():
            self._run_qdrant(
                "POST",
                f"/collections/{self.embedding.collection_name}/points/delete?wait=true",
                {"points": ids},
            )

    @staticmethod
    def _source_visible(row: sqlite3.Row | dict[str, Any], farm_id: str, include_private: bool) -> bool:
        scope = str(row["scope"])
        return scope in {"public", "synthetic_demo"} or (include_private and scope == "private" and row["farm_id"] == farm_id)

    @staticmethod
    def _eligible_for_default_rag(row: sqlite3.Row | dict[str, Any]) -> bool:
        """Keep known low-quality legacy imports out of operator RAG surfaces.

        The source rows and indexes remain intact for audit or later curation.
        Current uploads, farm-private knowledge, and synthetic policy documents
        are not judged by this migration-specific gate.
        """

        title = str(row["title"] or "")
        version = str(row["version"] or "")
        if version == "verify-v1" and title.strip().casefold().startswith("e2e "):
            return False
        if str(row["scope"]) != "public" or str(row["source_kind"]) != "public_knowledge":
            return True
        if version != LEGACY_RELEASE_VERSION and not title.startswith("[legacy:"):
            return True

        source_url = str(row["source_url"] or "")
        normalized_source_url = source_url.casefold()
        parsed_url = urlparse(source_url)
        host = (parsed_url.hostname or "").casefold()
        path = parsed_url.path.casefold()
        if host == "izu-wasavc.city.izu.shizuoka.jp":
            return False
        if host.endswith("maff.go.jp") and "/policies/market/k_ryouri/" in path:
            return False

        source_key = str(row["source_key"] or "")
        if host.endswith("nongsaro.go.kr") and "ebookcode=57" in normalized_source_url:
            page_match = WASABI_EBOOK_PAGE_RE.search(source_key)
            return bool(
                page_match
                and WASABI_EBOOK_FIRST_PAGE <= int(page_match.group(1)) <= WASABI_EBOOK_LAST_PAGE
            )
        if host.endswith("nongsaro.go.kr") and "cropebookfileviewlayer.ps" in path:
            return False

        return str(row["crop"] or "").casefold() == "wasabi"

    @staticmethod
    def _eligible_for_default_retrieval(
        row: sqlite3.Row | dict[str, Any], selected_document_ids: set[str] | None
    ) -> bool:
        """Keep live-smoke fixtures out of open-corpus retrieval while allowing their explicit probe."""

        return KnowledgeStore._eligible_for_default_rag(row) and (
            selected_document_ids is not None or str(row["version"] or "") != "smoke-live-v1"
        )

    def _document_record(self, row: sqlite3.Row) -> dict[str, Any]:
        source_key = str(row["source_key"] or "")
        smoke_source_prefix = "__smartfarm_smoke__:"
        try:
            provenance = json.loads(str(row["provenance_json"] or "{}"))
        except json.JSONDecodeError:
            provenance = {}
        return {
            "id": row["id"],
            "source_group_id": row["source_group_id"],
            "title": row["display_title"] or row["title"],
            "scope": row["scope"],
            "farm_id": row["farm_id"],
            "source_kind": row["source_kind"],
            "version": row["version"],
            "sha256": row["sha256"],
            "status": row["status"],
            "retrieval_state": row["retrieval_state"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "chunk_count": int(row["chunk_count"]),
            "vector_count": int(row["vector_count"]),
            "qdrant_vector_count": int(row["qdrant_vector_count"]),
            "graph_node_count": int(row["graph_node_count"]),
            "graph_edge_count": int(row["graph_edge_count"]),
            "index_backend": row["index_backend"],
            "summary": row["summary"] or "색인 가능한 본문에서 자동 요약을 만들지 못했습니다.",
            "issuer": row["issuer"],
            "published_year": row["published_year"],
            "document_type": row["document_type"],
            "source_url": row["source_url"],
            "summary_provider": row["summary_provider"] or "extractive",
            "canonical_source_id": row["canonical_source_id"],
            "provenance": provenance,
            "source_locator": row["source_locator"],
            "crop": row["crop"],
            "cultivation_system": row["cultivation_system"],
            "evidence_class": row["evidence_class"],
            "growth_stage": row["growth_stage"],
            "embedding_model": row["embedding_model"],
            # The legacy importer key remains private.  Canonical source and
            # content identities handle idempotency without exposing that key.
            "is_research_archive": bool(
                row["source_kind"] == "public_knowledge"
                and (
                    str(row["version"]) == "legacy-release-v1"
                    or str(row["title"]).startswith("[legacy:")
                    or (row["source_key"] and str(row["version"]) == "v1")
                )
            ),
            "is_smoke_artifact": bool(
                row["scope"] == "private"
                and row["source_kind"] == "private_knowledge"
                and str(row["version"]) == "smoke-live-v1"
                and source_key.startswith(smoke_source_prefix)
                and len(source_key) > len(smoke_source_prefix)
            ),
        }

    def _new_job(self, document_id: str | None, operation: str) -> str:
        job_id = f"job-{uuid4().hex[:12]}"
        with self._lock, self.connection:
            self.connection.execute(
                "INSERT INTO jobs (id, document_id, operation, status, created_at, details) VALUES (?, ?, ?, 'running', ?, '{}')",
                (job_id, document_id, operation, utc_now_iso()),
            )
        return job_id

    def _finish_job(self, job_id: str, *, details: dict[str, Any], error: str | None = None) -> None:
        with self._lock, self.connection:
            self.connection.execute(
                "UPDATE jobs SET status=?, completed_at=?, error=?, details=? WHERE id=?",
                ("failed" if error else "completed", utc_now_iso(), error, json.dumps(details, ensure_ascii=False), job_id),
            )

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "document_id": row["document_id"],
            "operation": row["operation"],
            "status": row["status"],
            "created_at": row["created_at"],
            "completed_at": row["completed_at"],
            "error": row["error"],
            "details": json.loads(row["details"]),
        }

    @staticmethod
    def _revision_document(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        values = dict(row)
        return {
            field: values.get(field)
            for field in (
                "id",
                "title",
                "display_title",
                "source_key",
                "issuer",
                "published_year",
                "document_type",
                "source_url",
                "summary",
                "summary_provider",
                "original_filename",
                "canonical_source_id",
                "source_group_id",
                "scope",
                "farm_id",
                "source_kind",
                "version",
                "content",
                "retrieval_state",
            )
        }

    def _source_group_snapshot(
        self,
        source_group_id: str,
        farm_id: str,
        rows: list[sqlite3.Row] | None = None,
    ) -> dict[str, Any]:
        if rows is None:
            rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
        if any(row["farm_id"] != farm_id for row in rows):
            raise PermissionError("Only knowledge owned by the current farm can be revised")
        states = {str(row["retrieval_state"]) for row in rows}
        if len(states) > 1:
            raise ValueError("source group has inconsistent retrieval state")
        return {
            "schema_version": "source-group-previous-revision-v1",
            "source_group_id": source_group_id,
            "farm_id": farm_id,
            "documents": [self._revision_document(row) for row in rows],
        }

    def _replace_previous_source_group_revision(
        self,
        snapshot: dict[str, Any],
        change_summary: str,
    ) -> tuple[str, str]:
        revision_id = f"revision-{uuid4().hex[:12]}"
        created_at = utc_now_iso()
        self.connection.execute(
            """
            INSERT INTO source_group_previous_revisions (
                source_group_id, id, farm_id, created_at, change_summary, snapshot_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_group_id) DO UPDATE SET
                id=excluded.id, farm_id=excluded.farm_id, created_at=excluded.created_at,
                change_summary=excluded.change_summary, snapshot_json=excluded.snapshot_json
            """,
            (
                snapshot["source_group_id"],
                revision_id,
                snapshot["farm_id"],
                created_at,
                change_summary,
                json.dumps(snapshot, ensure_ascii=False, sort_keys=True),
            ),
        )
        return revision_id, created_at

    def _restore_previous_source_group_revision_row(self, revision: dict[str, Any]) -> None:
        self.connection.execute(
            """
            INSERT INTO source_group_previous_revisions (
                source_group_id, id, farm_id, created_at, change_summary, snapshot_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_group_id) DO UPDATE SET
                id=excluded.id, farm_id=excluded.farm_id, created_at=excluded.created_at,
                change_summary=excluded.change_summary, snapshot_json=excluded.snapshot_json
            """,
            (
                revision["source_group_id"],
                revision["id"],
                revision["farm_id"],
                revision["created_at"],
                revision["change_summary"],
                revision["snapshot_json"],
            ),
        )

    @staticmethod
    def _previous_revision_summary(row: sqlite3.Row) -> dict[str, Any]:
        snapshot = json.loads(str(row["snapshot_json"]))
        documents = list(snapshot.get("documents") or [])
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "document_count": len(documents),
            "versions": sorted({str(document.get("version") or "") for document in documents if document.get("version")}),
            "change_summary": row["change_summary"],
        }

    def get_source_group_revision(
        self,
        source_group_id: str,
        farm_id: str,
    ) -> tuple[bool, dict[str, Any] | None]:
        with self._lock:
            group_rows = self.connection.execute(
                "SELECT farm_id FROM documents WHERE source_group_id=?",
                (source_group_id,),
            ).fetchall()
            revision = self.connection.execute(
                "SELECT * FROM source_group_previous_revisions WHERE source_group_id=?",
                (source_group_id,),
            ).fetchone()
        if not group_rows and revision is None:
            return False, None
        if any(row["farm_id"] != farm_id for row in group_rows) or (
            revision is not None and revision["farm_id"] != farm_id
        ):
            raise PermissionError("Only knowledge owned by the current farm can be revised")
        return True, self._previous_revision_summary(revision) if revision is not None else None

    def list_recoverable_source_groups(self, farm_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                """
                SELECT r.*,
                    (SELECT COUNT(*) FROM documents d
                     WHERE d.source_group_id=r.source_group_id AND d.status='ready') AS ready_count
                FROM source_group_previous_revisions r
                WHERE r.farm_id=?
                ORDER BY r.created_at DESC, r.source_group_id
                """,
                (farm_id,),
            ).fetchall()
        recoverable: list[dict[str, Any]] = []
        for row in rows:
            if int(row["ready_count"] or 0) != 0:
                continue
            try:
                snapshot = json.loads(str(row["snapshot_json"]))
                documents = list(snapshot.get("documents") or [])
            except (AttributeError, TypeError, json.JSONDecodeError):
                continue
            if not documents:
                continue
            if all(
                document.get("scope") == "private"
                and document.get("source_kind") == "private_knowledge"
                and document.get("version") == "smoke-live-v1"
                and str(document.get("source_key") or "").startswith("__smartfarm_smoke__:")
                for document in documents
            ):
                continue
            first = documents[0]
            title = str(first.get("display_title") or first.get("title") or "복원 가능한 자료")
            recoverable.append(
                {
                    "source_group_id": row["source_group_id"],
                    "title": title,
                    "previous_revision": self._previous_revision_summary(row),
                }
            )
        return recoverable

    def _delete_document_without_revision(self, document_id: str) -> None:
        with self._lock:
            row = self.connection.execute(
                "SELECT * FROM documents WHERE id=? AND status='ready'",
                (document_id,),
            ).fetchone()
            if row is None:
                return
            chunk_ids = self._chunks_for_document(document_id)
            self._qdrant_delete(chunk_ids)
            self.graph.delete_document(document_id)
            with self.connection:
                self.connection.execute(
                    "DELETE FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)",
                    (document_id,),
                )
                self.connection.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
                self.connection.execute(
                    """
                    UPDATE documents SET status='deleted', updated_at=?, chunk_count=0, vector_count=0,
                        qdrant_vector_count=0, graph_node_count=0, graph_edge_count=0 WHERE id=?
                    """,
                    (utc_now_iso(), document_id),
                )

    def _apply_source_group_snapshot(
        self,
        source_group_id: str,
        farm_id: str,
        snapshot: dict[str, Any],
        *,
        operation: str,
    ) -> list[dict[str, Any]]:
        if (
            snapshot.get("schema_version") != "source-group-previous-revision-v1"
            or snapshot.get("source_group_id") != source_group_id
            or snapshot.get("farm_id") != farm_id
        ):
            raise ValueError("source group revision snapshot is invalid")
        raw_documents = snapshot.get("documents")
        if not isinstance(raw_documents, list):
            raise ValueError("source group revision documents are invalid")
        target_ids: set[str] = set()
        target_states: set[str] = set()
        for raw_document in raw_documents:
            if not isinstance(raw_document, dict):
                raise ValueError("source group revision document is invalid")
            document_id = str(raw_document.get("id") or "")
            state = str(raw_document.get("retrieval_state") or "")
            if (
                not document_id
                or raw_document.get("source_group_id") != source_group_id
                or raw_document.get("farm_id") != farm_id
                or state not in {"active", "paused", "needs_review"}
            ):
                raise ValueError("source group revision document identity is invalid")
            target_ids.add(document_id)
            target_states.add(state)
        if len(target_ids) != len(raw_documents) or len(target_states) > 1:
            raise ValueError("source group revision membership is invalid")

        for raw_document in sorted(raw_documents, key=lambda item: str(item["id"])):
            document_id = str(raw_document["id"])
            try:
                restored, _member_job = self._ingest_document(
                    title=str(raw_document["title"]),
                    content=str(raw_document["content"]),
                    scope=str(raw_document["scope"]),  # type: ignore[arg-type]
                    farm_id=farm_id,
                    source_kind=str(raw_document["source_kind"]),
                    version=str(raw_document["version"]),
                    document_id=document_id,
                    operation=operation,
                    display_title=raw_document.get("display_title"),
                    issuer=raw_document.get("issuer"),
                    published_year=raw_document.get("published_year"),
                    document_type=raw_document.get("document_type"),
                    source_url=raw_document.get("source_url"),
                    summary=raw_document.get("summary"),
                    summary_provider=raw_document.get("summary_provider"),
                    source_key=raw_document.get("source_key"),
                    original_filename=raw_document.get("original_filename"),
                    retrieval_state=str(raw_document["retrieval_state"]),  # type: ignore[arg-type]
                )
            except Exception as error:
                with self._lock:
                    running_jobs = self.connection.execute(
                        "SELECT id FROM jobs WHERE document_id=? AND operation=? AND status='running'",
                        (document_id, operation),
                    ).fetchall()
                for running_job in running_jobs:
                    self._finish_job(
                        str(running_job["id"]),
                        details={
                            "result_kind": "failed",
                            "failure_stage": "revision_member_restore",
                            "source_group_id": source_group_id,
                            "document_id": document_id,
                            "reason": str(error),
                        },
                        error="Source group revision member restore failed.",
                    )
                raise
            if restored["source_group_id"] != source_group_id:
                raise ValueError("source group revision restored into a different group")

        with self._lock:
            current_rows = self.connection.execute(
                "SELECT id FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
        for document_id in sorted({str(row["id"]) for row in current_rows} - target_ids):
            self._delete_document_without_revision(document_id)
        with self._lock:
            restored_rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
        if {str(row["id"]) for row in restored_rows} != target_ids:
            raise RuntimeError("source group revision membership verification failed")
        return [self._document_record(row) for row in restored_rows]

    def restore_previous_source_group_revision(
        self,
        source_group_id: str,
        farm_id: str,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
        with self._source_group_mutation_lock(source_group_id):
            return self._restore_previous_source_group_revision(source_group_id, farm_id)

    def _restore_previous_source_group_revision(
        self,
        source_group_id: str,
        farm_id: str,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
        found, previous_summary = self.get_source_group_revision(source_group_id, farm_id)
        if not found:
            return None
        if previous_summary is None:
            raise ValueError("No previous source group revision is available.")
        with self._lock:
            revision = self.connection.execute(
                "SELECT * FROM source_group_previous_revisions WHERE source_group_id=?",
                (source_group_id,),
            ).fetchone()
            current_rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
            current_snapshot = self._source_group_snapshot(source_group_id, farm_id, current_rows)
        if revision is None:
            raise ValueError("No previous source group revision is available.")
        original_revision = dict(revision)
        document_id = next(
            (
                str(row["id"])
                for row in current_rows
            ),
            None,
        )
        job_id = self._new_job(document_id, "revision_restore_group")
        details: dict[str, Any] = {
            "source_group_id": source_group_id,
            "previous_revision_id": revision["id"],
            "restored_documents": 0,
            "rollback_succeeded": None,
        }
        revision_swapped = False
        try:
            previous_snapshot = json.loads(str(revision["snapshot_json"]))
            if document_id is None:
                previous_documents = list(previous_snapshot.get("documents") or [])
                if previous_documents:
                    document_id = str(previous_documents[0].get("id") or "") or None
            restored = self._apply_source_group_snapshot(
                source_group_id,
                farm_id,
                previous_snapshot,
                operation="revision_restore_member",
            )
            with self._lock, self.connection:
                swapped_revision_id, _created_at = self._replace_previous_source_group_revision(
                    current_snapshot,
                    "복원 직전 상태",
                )
            revision_swapped = True
            details.update(
                {
                    "restored_documents": len(restored),
                    "swapped_revision_id": swapped_revision_id,
                    "retrieval_state": restored[0]["retrieval_state"] if restored else None,
                }
            )
            self._finish_job(job_id, details=details)
            return restored, self.get_job(job_id) or {}
        except Exception as error:
            rollback_error: str | None = None
            revision_rollback_error: str | None = None
            try:
                self._apply_source_group_snapshot(
                    source_group_id,
                    farm_id,
                    current_snapshot,
                    operation="revision_rollback_member",
                )
                details["rollback_succeeded"] = True
            except Exception as rollback_failure:
                details["rollback_succeeded"] = False
                rollback_error = str(rollback_failure)
            if revision_swapped:
                try:
                    with self._lock, self.connection:
                        self._restore_previous_source_group_revision_row(original_revision)
                    details["revision_rollback_succeeded"] = True
                except Exception as revision_rollback_failure:
                    details["revision_rollback_succeeded"] = False
                    revision_rollback_error = str(revision_rollback_failure)
            details["failure_reason"] = str(error)
            if rollback_error is not None:
                details["rollback_failure_reason"] = rollback_error
            if revision_rollback_error is not None:
                details["revision_rollback_failure_reason"] = revision_rollback_error
            self._finish_job(job_id, details=details, error="Source group revision restore failed.")
            raise KnowledgeRevisionRestoreError(
                "Source group revision restore failed; partial success was not accepted.",
                job_id,
            ) from error

    def list_documents(self, farm_id: str, *, include_deleted: bool = False, query: str | None = None) -> list[dict[str, Any]]:
        status_condition = "" if include_deleted else " AND status='ready'"
        with self._lock:
            rows = self.connection.execute(
                "SELECT * FROM documents WHERE (scope IN ('public', 'synthetic_demo') OR (scope='private' AND farm_id=?))"
                + status_condition
                + " ORDER BY updated_at DESC, title ASC",
                (farm_id,),
            ).fetchall()
        documents = [self._document_record(row) for row in rows if self._eligible_for_default_rag(row)]
        needle = str(query or "").strip().casefold()
        if not needle:
            return documents
        return [
            document
            for document in documents
            if needle in " ".join(
                str(document.get(field) or "")
                for field in ("title", "issuer", "document_type", "summary", "scope")
            ).casefold()
        ]

    def get_document(self, document_id: str, farm_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
            if not row or row["status"] != "ready" or not self._source_visible(row, farm_id, True):
                return None
            chunks = self.connection.execute(
                "SELECT id, ordinal, text, start_char, end_char FROM chunks WHERE document_id=? ORDER BY ordinal", (document_id,)
            ).fetchall()
        result = self._document_record(row)
        result["chunks"] = [
            {
                "id": chunk["id"],
                "ordinal": int(chunk["ordinal"]),
                "text": chunk["text"],
                "location": {"start_char": int(chunk["start_char"]), "end_char": int(chunk["end_char"])},
            }
            for chunk in chunks
        ]
        return result

    def _chunks_for_document(self, document_id: str) -> list[str]:
        rows = self.connection.execute("SELECT id FROM chunks WHERE document_id=?", (document_id,)).fetchall()
        return [str(row["id"]) for row in rows]

    def _document_for_identity(
        self,
        *,
        scope: Scope,
        farm_id: str | None,
        canonical_source_id: str,
        source_locator: str | None,
        content_checksum: str,
    ) -> sqlite3.Row | None:
        tenant = farm_id or ""
        with self._lock:
            if canonical_source_id.startswith("content:"):
                return self.connection.execute(
                    """
                    SELECT * FROM documents
                    WHERE scope=? AND COALESCE(farm_id, '')=? AND content_checksum=?
                    ORDER BY status='ready' DESC, updated_at DESC LIMIT 1
                    """,
                    (scope, tenant, content_checksum),
                ).fetchone()
            return self.connection.execute(
                """
                SELECT * FROM documents
                WHERE scope=? AND COALESCE(farm_id, '')=? AND canonical_source_id=?
                    AND COALESCE(source_locator, '')=COALESCE(?, '')
                ORDER BY status='ready' DESC, updated_at DESC LIMIT 1
                """,
                (scope, tenant, canonical_source_id, source_locator),
            ).fetchone()

    def _ingest_source_group_id(
        self,
        *,
        title: str,
        content: str,
        scope: Scope,
        farm_id: str | None,
        document_id: str | None,
        source_url: str | None,
        source_key: str | None,
        original_filename: str | None,
    ) -> str:
        if document_id is not None:
            with self._lock:
                existing_document = self.connection.execute(
                    "SELECT source_group_id FROM documents WHERE id=?",
                    (document_id,),
                ).fetchone()
            if existing_document is not None and existing_document["source_group_id"]:
                return str(existing_document["source_group_id"])
        normalized_content = content.strip()
        provenance = _provenance_fields(normalized_content)
        persisted_original_filename = _compact_text(original_filename, limit=255) or None
        resolved_source_key = _compact_text(source_key, limit=200) or None
        canonical_source_id = _canonical_source_id(
            content=normalized_content,
            source_url=source_url,
            original_filename=persisted_original_filename,
        )
        source_locator = _source_locator(
            title=LEGACY_MARKER_RE.sub("", title.strip()),
            source_key=resolved_source_key,
            provenance=provenance,
        )
        existing_identity = self._document_for_identity(
            scope=scope,
            farm_id=farm_id,
            canonical_source_id=canonical_source_id,
            source_locator=source_locator,
            content_checksum=_content_checksum(normalized_content),
        )
        if existing_identity is not None and existing_identity["source_group_id"]:
            return str(existing_identity["source_group_id"])
        owner_component = f"owner:{farm_id}:" if farm_id else ""
        return f"source-group:{scope}:{owner_component}{canonical_source_id}"

    def ingest_document(
        self,
        *,
        title: str,
        content: str,
        scope: Scope,
        source_kind: str,
        version: str = "v1",
        farm_id: str | None = None,
        document_id: str | None = None,
        operation: str = "ingest",
        display_title: str | None = None,
        issuer: str | None = None,
        published_year: int | None = None,
        document_type: str | None = None,
        source_url: str | None = None,
        summary: str | None = None,
        summary_provider: str | None = None,
        source_key: str | None = None,
        original_filename: str | None = None,
        retrieval_state: RetrievalState = "active",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        source_group_id = self._ingest_source_group_id(
            title=title,
            content=content,
            scope=scope,
            farm_id=farm_id,
            document_id=document_id,
            source_url=source_url,
            source_key=source_key,
            original_filename=original_filename,
        )
        while True:
            with self._source_group_mutation_lock(source_group_id):
                actual_source_group_id = self._ingest_source_group_id(
                    title=title,
                    content=content,
                    scope=scope,
                    farm_id=farm_id,
                    document_id=document_id,
                    source_url=source_url,
                    source_key=source_key,
                    original_filename=original_filename,
                )
                if actual_source_group_id != source_group_id:
                    source_group_id = actual_source_group_id
                    continue
                return self._ingest_document(
                    title=title,
                    content=content,
                    scope=scope,
                    source_kind=source_kind,
                    version=version,
                    farm_id=farm_id,
                    document_id=document_id,
                    operation=operation,
                    display_title=display_title,
                    issuer=issuer,
                    published_year=published_year,
                    document_type=document_type,
                    source_url=source_url,
                    summary=summary,
                    summary_provider=summary_provider,
                    source_key=source_key,
                    original_filename=original_filename,
                    retrieval_state=retrieval_state,
                )

    def _ingest_document(
        self,
        *,
        title: str,
        content: str,
        scope: Scope,
        source_kind: str,
        version: str = "v1",
        farm_id: str | None = None,
        document_id: str | None = None,
        operation: str = "ingest",
        display_title: str | None = None,
        issuer: str | None = None,
        published_year: int | None = None,
        document_type: str | None = None,
        source_url: str | None = None,
        summary: str | None = None,
        summary_provider: str | None = None,
        source_key: str | None = None,
        original_filename: str | None = None,
        retrieval_state: RetrievalState = "active",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if scope == "private" and not farm_id:
            raise ValueError("private knowledge requires a farm_id")
        content = content.strip()
        normalized_version = version.strip() or "v1"
        if not content:
            raise ValueError("document content cannot be empty")
        if retrieval_state not in {"active", "paused", "needs_review"}:
            raise ValueError("retrieval_state must be active, paused, or needs_review")
        raw_timeseries_reason = _raw_timeseries_reason(content, source_kind)
        if raw_timeseries_reason:
            raise ValueError(
                "Raw telemetry timeseries are not embedded as knowledge documents; "
                f"store the stream through telemetry ingestion and index a reviewed episode summary instead ({raw_timeseries_reason})."
            )
        # Provenance is stored as structured document metadata.  Keep that
        # machine header out of the searchable evidence snippets shown to
        # operators so citations begin with the source's actual content.
        indexable_content = _profile_body(content)
        parts = chunk_text(indexable_content)
        if not parts:
            raise ValueError("No indexable content was found.")
        profile = document_profile(
            title=title,
            content=content,
            display_title=display_title,
            issuer=issuer,
            published_year=published_year,
            document_type=document_type,
            source_url=source_url,
            summary=summary,
            summary_provider=summary_provider,
            source_key=source_key,
            original_filename=original_filename,
        )
        domain = _document_domain_metadata(content=content, scope=scope, source_kind=source_kind)
        content_checksum = _content_checksum(content)
        canonical_source_id = _canonical_source_id(
            content=content,
            source_url=profile["source_url"],
            original_filename=profile["original_filename"],
        )
        provenance = _structured_document_provenance(
            content=content,
            canonical_source_id=canonical_source_id,
            version=normalized_version,
            content_checksum=content_checksum,
            source_locator=profile["source_locator"],
        )
        provenance_json = json.dumps(provenance, ensure_ascii=False, sort_keys=True)
        existing_identity = None
        existing_document = None
        if document_id is None:
            existing_identity = self._document_for_identity(
                scope=scope,
                farm_id=farm_id,
                canonical_source_id=canonical_source_id,
                source_locator=profile["source_locator"],
                content_checksum=content_checksum,
            )
            if existing_identity is not None:
                document_id = str(existing_identity["id"])
                existing_document = existing_identity
            else:
                identity = "|".join(
                    (scope, farm_id or "", canonical_source_id, profile["source_locator"] or "")
                )
                document_id = f"document-{sha256(identity.encode('utf-8')).hexdigest()[:16]}"
        else:
            with self._lock:
                existing_document = self.connection.execute(
                    "SELECT * FROM documents WHERE id=?", (document_id,)
                ).fetchone()
        source_group_identity = canonical_source_id or f"document:{document_id}"
        owner_component = f"owner:{farm_id}:" if farm_id else ""
        source_group_id = (
            str(existing_document["source_group_id"])
            if existing_document is not None and existing_document["source_group_id"]
            else f"source-group:{scope}:{owner_component}{source_group_identity}"
        )
        target_retrieval_state: RetrievalState = retrieval_state
        if operation == "reindex" and existing_document is not None:
            target_retrieval_state = str(existing_document["retrieval_state"])  # type: ignore[assignment]
        job_id = self._new_job(document_id, operation)
        identity_document = existing_identity or existing_document
        metadata_matches = bool(
            identity_document is not None
            and (
                not str(display_title or "").strip()
                or str(identity_document["display_title"] or "") == str(profile["display_title"] or "")
            )
            and str(identity_document["issuer"] or "") == str(profile["issuer"] or "")
            and identity_document["published_year"] == profile["published_year"]
            and str(identity_document["document_type"] or "") == str(profile["document_type"] or "")
            and str(identity_document["source_url"] or "") == str(profile["source_url"] or "")
            and str(identity_document["summary"] or "") == str(profile["summary"] or "")
            and str(identity_document["source_locator"] or "") == str(profile["source_locator"] or "")
            and str(identity_document["provenance_json"] or "{}") == provenance_json
            and str(identity_document["crop"] or "") == str(domain["crop"] or "")
            and str(identity_document["cultivation_system"] or "") == str(domain["cultivation_system"] or "")
            and str(identity_document["evidence_class"] or "") == str(domain["evidence_class"] or "")
            and str(identity_document["growth_stage"] or "") == str(domain["growth_stage"] or "")
            and str(identity_document["source_kind"] or "") == str(source_kind.strip() or "public_knowledge")
        )
        if (
            identity_document is not None
            and identity_document["status"] == "ready"
            and identity_document["content_checksum"] == content_checksum
            and identity_document["version"] == normalized_version
            and metadata_matches
            and operation in {"ingest", "seed", "upload"}
        ):
            details = {
                "result_kind": "reused",
                "idempotent_reuse": True,
                "canonical_source_id": canonical_source_id,
                "source_group_id": source_group_id,
                "content_checksum": content_checksum,
                "provenance": provenance,
                "chunk_count": int(identity_document["chunk_count"]),
                "vector_count": int(identity_document["vector_count"]),
                "qdrant_vector_count": int(identity_document["qdrant_vector_count"]),
                "index_backend": identity_document["index_backend"],
                "embedding": self.embedding.status(),
            }
            self._finish_job(job_id, details=details)
            return self._document_record(identity_document), self.get_job(job_id) or {}

        now = utc_now_iso()
        try:
            vectors = self.embedding.embed_passages([value for _start, _end, value in parts])
        except Exception:
            self._finish_job(
                job_id,
                details={
                    "result_kind": "failed",
                    "failure_stage": "embedding",
                    "source_group_id": source_group_id,
                    "document_id": document_id,
                },
                error="Knowledge indexing failed.",
            )
            raise
        records = [
            {
                "id": f"{document_id}:chunk-{index:03d}",
                "ordinal": index,
                "text": value,
                "start_char": start,
                "end_char": end,
                "embedding": vector,
            }
            for index, ((start, end, value), vector) in enumerate(zip(parts, vectors, strict=True), start=1)
        ]
        document = {
            "id": document_id,
            "title": title.strip() or document_id,
            "scope": scope,
            "farm_id": farm_id,
            "source_kind": source_kind.strip() or "public_knowledge",
            "version": normalized_version,
            "content": content,
            "sha256": sha256(content.encode("utf-8")).hexdigest(),
            "content_checksum": content_checksum,
            "canonical_source_id": canonical_source_id,
            "source_group_id": source_group_id,
            "provenance_json": provenance_json,
            "embedding_model": self.embedding.active_model,
            "retrieval_state": target_retrieval_state,
            **profile,
            **domain,
        }
        pending_revision: tuple[dict[str, Any], str] | None = None
        if operation in {"ingest", "upload"} and farm_id is not None:
            with self._lock:
                current_group_rows = self.connection.execute(
                    "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                    (source_group_id,),
                ).fetchall()
            current_group_ids = {str(row["id"]) for row in current_group_rows}
            content_changed = bool(
                existing_document is not None
                and existing_document["status"] == "ready"
                and str(existing_document["content_checksum"] or "") != content_checksum
            )
            membership_changed = document_id not in current_group_ids and bool(
                current_group_rows or existing_document is not None
            )
            if content_changed or membership_changed:
                pending_revision = (
                    self._source_group_snapshot(source_group_id, farm_id, current_group_rows),
                    "자료 내용 변경 전 상태" if content_changed else "자료 구성 변경 전 상태",
                )
        with self._lock:
            old_chunk_ids = self._chunks_for_document(document_id)
            self._qdrant_delete(old_chunk_ids)
            with self.connection:
                if pending_revision is not None:
                    self._replace_previous_source_group_revision(*pending_revision)
                self.connection.execute(
                    "UPDATE documents SET retrieval_state=?, updated_at=? "
                    "WHERE source_group_id=? AND status='ready'",
                    (target_retrieval_state, now, source_group_id),
                )
                self.connection.execute("DELETE FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)", (document_id,))
                self.connection.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
                self.connection.execute(
                    """
                    INSERT INTO documents (
                        id, title, display_title, source_key, issuer, published_year, document_type, source_url, summary,
                        summary_provider, original_filename, canonical_source_id, source_group_id, content_checksum, provenance_json, source_locator,
                        crop, cultivation_system, evidence_class, growth_stage, embedding_model,
                        scope, farm_id, source_kind, version, content, sha256, status, retrieval_state, created_at, updated_at,
                        chunk_count, vector_count, qdrant_vector_count, graph_node_count, graph_edge_count, index_backend
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, 0, 0, 0, 0, 0, 'sqlite_fallback')
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title, display_title=excluded.display_title, source_key=excluded.source_key,
                        issuer=excluded.issuer, published_year=excluded.published_year, document_type=excluded.document_type,
                        source_url=excluded.source_url, summary=excluded.summary, summary_provider=excluded.summary_provider,
                        original_filename=excluded.original_filename, canonical_source_id=excluded.canonical_source_id,
                        content_checksum=excluded.content_checksum, provenance_json=excluded.provenance_json,
                        source_locator=excluded.source_locator, crop=excluded.crop,
                        cultivation_system=excluded.cultivation_system, evidence_class=excluded.evidence_class,
                        growth_stage=excluded.growth_stage, embedding_model=excluded.embedding_model,
                        scope=excluded.scope, farm_id=excluded.farm_id,
                        source_kind=excluded.source_kind, version=excluded.version, content=excluded.content, sha256=excluded.sha256,
                        status='indexing', retrieval_state=excluded.retrieval_state,
                        updated_at=excluded.updated_at
                    """,
                    (
                        document_id,
                        document["title"],
                        document["display_title"],
                        document["source_key"],
                        document["issuer"],
                        document["published_year"],
                        document["document_type"],
                        document["source_url"],
                        document["summary"],
                        document["summary_provider"],
                        document["original_filename"],
                        document["canonical_source_id"],
                        document["source_group_id"],
                        document["content_checksum"],
                        document["provenance_json"],
                        document["source_locator"],
                        document["crop"],
                        document["cultivation_system"],
                        document["evidence_class"],
                        document["growth_stage"],
                        document["embedding_model"],
                        scope,
                        farm_id,
                        document["source_kind"],
                        document["version"],
                        content,
                        document["sha256"],
                        document["retrieval_state"],
                        now,
                        now,
                    ),
                )
                for record in records:
                    self.connection.execute(
                        "INSERT INTO chunks (id, document_id, ordinal, text, start_char, end_char, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            record["id"],
                            document_id,
                            record["ordinal"],
                            record["text"],
                            record["start_char"],
                            record["end_char"],
                            json.dumps(record["embedding"]),
                        ),
                    )
                    self.connection.executemany(
                        "INSERT OR IGNORE INTO chunk_terms (chunk_id, term) VALUES (?, ?)",
                        [(record["id"], token) for token in set(tokenize(record["text"]))],
                    )
        mirror_document = {**document, "title": document["display_title"]}
        qdrant_count = self._qdrant_upsert(mirror_document, records)
        falkor_count = self.graph.upsert_document(mirror_document, records)
        with self._lock, self.connection:
            edge_count = int(
                self.connection.execute(
                    "SELECT COUNT(*) FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)", (document_id,)
                ).fetchone()[0]
            )
            term_count = int(
                self.connection.execute(
                    "SELECT COUNT(DISTINCT term) FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)", (document_id,)
                ).fetchone()[0]
            )
            backend = "qdrant" if qdrant_count == len(records) else "sqlite_fallback"
            self.connection.execute(
                """
                UPDATE documents SET status='ready', updated_at=?, chunk_count=?, vector_count=?, qdrant_vector_count=?,
                    graph_node_count=?, graph_edge_count=?, index_backend=? WHERE id=?
                """,
                (utc_now_iso(), len(records), len(records), qdrant_count, len(records) + term_count, edge_count, backend, document_id),
            )
            row = self.connection.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        details = {
            "result_kind": "updated" if existing_document is not None else "created",
            "chunk_count": len(records),
            "vector_count": len(records),
            "qdrant_vector_count": qdrant_count,
            "graph_edge_count": edge_count,
            "falkordb_mirrored_chunks": falkor_count,
            "graph_backend": "falkordb" if falkor_count == len(records) else "sqlite_chunk_term_graph",
            "index_backend": "qdrant" if qdrant_count == len(records) else "sqlite_fallback",
            "canonical_source_id": canonical_source_id,
            "content_checksum": content_checksum,
            "provenance": provenance,
            "embedding": self.embedding.status(),
        }
        self._finish_job(job_id, details=details)
        return self._document_record(row), self.get_job(job_id) or {}

    def _retire_obsolete_seed_documents(self) -> int:
        """Remove only product-owned strawberry demo seeds from persistent stores."""

        placeholders = ",".join("?" for _ in RETIRED_SEED_DOCUMENT_IDS)
        with self._lock, self.connection:
            existing = self.connection.execute(
                f"SELECT id FROM documents WHERE id IN ({placeholders})",
                RETIRED_SEED_DOCUMENT_IDS,
            ).fetchall()
            if not existing:
                return 0
            self.connection.execute(
                f"DELETE FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN ({placeholders}))",
                RETIRED_SEED_DOCUMENT_IDS,
            )
            self.connection.execute(
                f"DELETE FROM chunks WHERE document_id IN ({placeholders})",
                RETIRED_SEED_DOCUMENT_IDS,
            )
            self.connection.execute(
                f"DELETE FROM documents WHERE id IN ({placeholders})",
                RETIRED_SEED_DOCUMENT_IDS,
            )
        for row in existing:
            self.graph.delete_document(str(row["id"]))
        return len(existing)

    def seed_defaults(self, corpus_path: str | None = None) -> list[dict[str, Any]]:
        self._retire_obsolete_seed_documents()
        jobs: list[dict[str, Any]] = []
        for source in load_seed_documents(corpus_path):
            document_id = source.get("id") or f"seed-{uuid4().hex[:12]}"
            with self._lock:
                existing = self.connection.execute("SELECT id FROM documents WHERE id=?", (document_id,)).fetchone()
                stale_provenance_chunk = self.connection.execute(
                    "SELECT 1 FROM chunks WHERE document_id=? AND text LIKE 'Reference corpus provenance%' LIMIT 1",
                    (document_id,),
                ).fetchone() if existing else None
            if existing and not stale_provenance_chunk:
                continue
            _, job = self.ingest_document(
                title=source.get("title", document_id),
                content=source["content"],
                scope=str(source.get("scope", "public")),  # type: ignore[arg-type]
                farm_id=source.get("farm_id") or None,
                source_kind=source.get("source_kind", "public_knowledge"),
                version=source.get("version", "v1"),
                document_id=document_id,
                operation="seed_repair" if existing else "seed",
                display_title=source.get("display_title"),
                issuer=source.get("issuer"),
                published_year=int(source["published_year"]) if str(source.get("published_year", "")).isdigit() else None,
                document_type=source.get("document_type"),
                source_url=source.get("source_url"),
                summary=source.get("summary"),
                source_key=source.get("source_key"),
                original_filename=source.get("original_filename"),
            )
            jobs.append(job)
        # Startup seeding is an explicit mutation boundary.  Keep mirrors and
        # legacy vector dimensions current here rather than during readiness GET.
        self.sync_qdrant_mirror()
        self.sync_graph_mirror()
        return jobs

    def reindex_document(self, document_id: str, farm_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        with self._lock:
            row = self.connection.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row or row["status"] != "ready" or not self._source_visible(row, farm_id, True):
            return None
        if row["farm_id"] != farm_id:
            raise PermissionError("Only knowledge owned by the current farm can be reindexed")
        return self.ingest_document(
            title=row["title"],
            content=row["content"],
            scope=row["scope"],
            farm_id=row["farm_id"],
            source_kind=row["source_kind"],
            version=row["version"],
            document_id=document_id,
            operation="reindex",
            display_title=row["display_title"],
            issuer=row["issuer"],
            published_year=row["published_year"],
            document_type=row["document_type"],
            source_url=row["source_url"],
            summary=row["summary"],
            summary_provider=row["summary_provider"],
            source_key=row["source_key"],
            original_filename=row["original_filename"],
            retrieval_state=row["retrieval_state"],
        )

    @staticmethod
    def _mirror_metadata(document: dict[str, Any]) -> dict[str, Any]:
        return {
            "title": document["display_title"] or document["title"],
            "issuer": document["issuer"],
            "published_year": document["published_year"],
            "source_url": document["source_url"],
            "scope": document["scope"],
            "farm_id": document["farm_id"],
            "source_kind": document["source_kind"],
            "source_group_id": document["source_group_id"],
        }

    def update_source_group_metadata(
        self,
        source_group_id: str,
        farm_id: str,
        changes: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any], str] | None:
        with self._source_group_mutation_lock(source_group_id):
            return self._update_source_group_metadata(source_group_id, farm_id, changes)

    def _update_source_group_metadata(
        self,
        source_group_id: str,
        farm_id: str,
        changes: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any], str] | None:
        with self._lock:
            rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
            if not rows:
                return None
            if any(row["farm_id"] != farm_id for row in rows):
                raise PermissionError("Only knowledge owned by the current farm can be edited")

            previous_scopes = {str(row["scope"]) for row in rows}
            if len(previous_scopes) != 1:
                raise ValueError("source group has inconsistent visibility metadata")
            previous_scope = next(iter(previous_scopes))
            target_scope = str(changes.get("scope", previous_scope))
            if previous_scope == "synthetic_demo" and target_scope != previous_scope:
                raise ValueError("synthetic_demo knowledge scope cannot be changed to public or private")
            source_url = changes.get("source_url")
            if source_url is not None and _safe_source_url(str(source_url)) is None:
                raise ValueError("source_url must be an absolute http or https URL")

            document_ids = [str(row["id"]) for row in rows]
            placeholders = ",".join("?" for _ in document_ids)
            chunk_rows = self.connection.execute(
                f"SELECT id, document_id FROM chunks WHERE document_id IN ({placeholders}) ORDER BY document_id, ordinal",
                document_ids,
            ).fetchall()
            chunk_ids_by_document: dict[str, list[str]] = {document_id: [] for document_id in document_ids}
            for chunk in chunk_rows:
                chunk_ids_by_document[str(chunk["document_id"])].append(str(chunk["id"]))

            old_documents = [dict(row) for row in rows]
            new_documents: list[dict[str, Any]] = []
            now = utc_now_iso()
            for row in old_documents:
                updated = dict(row)
                if "title" in changes:
                    updated["display_title"] = changes["title"]
                for field in ("issuer", "published_year", "source_url"):
                    if field in changes:
                        updated[field] = changes[field]
                updated["scope"] = target_scope
                if target_scope != previous_scope:
                    updated["source_kind"] = "private_knowledge" if target_scope == "private" else "public_knowledge"
                updated["updated_at"] = now
                new_documents.append(updated)

            job_id = self._new_job(document_ids[0], "metadata_update_group")
            qdrant_document_ids = {
                str(row["id"]) for row in rows if int(row["qdrant_vector_count"] or 0) > 0
            }
            qdrant_chunk_ids = [
                chunk_id
                for document_id in document_ids
                if document_id in qdrant_document_ids
                for chunk_id in chunk_ids_by_document[document_id]
            ]
            qdrant_payload = {"source_group_id": source_group_id}
            if "title" in changes:
                qdrant_payload["title"] = changes["title"]
            for field in ("issuer", "published_year", "source_url"):
                if field in changes:
                    qdrant_payload[field] = changes[field]
            if "scope" in changes:
                qdrant_payload.update(
                    {
                        "scope": target_scope,
                        "farm_id": farm_id,
                        "source_kind": "private_knowledge" if target_scope == "private" else "public_knowledge",
                    }
                )
            graph_required = bool(self.graph.url and ({"title", "scope"} & changes.keys()))
            details: dict[str, Any] = {
                "source_group_id": source_group_id,
                "document_ids": document_ids,
                "changed_fields": sorted(changes),
                "embedding_recomputed": False,
                "qdrant_payload_points": len(qdrant_chunk_ids),
                "graph_metadata_documents": len(new_documents) if graph_required else 0,
            }
            qdrant_attempted = False
            graph_attempted = False
            try:
                if qdrant_chunk_ids:
                    qdrant_attempted = True
                    if not self._qdrant_set_metadata(qdrant_chunk_ids, qdrant_payload):
                        raise RuntimeError("qdrant_metadata_update_failed")
                if graph_required:
                    graph_attempted = True
                    graph_documents = [
                        {**document, "title": document["display_title"] or document["title"]}
                        for document in new_documents
                    ]
                    if not self.graph.update_documents_metadata(graph_documents, len(chunk_rows)):
                        raise RuntimeError("falkordb_metadata_update_failed")
                details["updated_documents"] = len(new_documents)
                completed_at = utc_now_iso()
                details_json = json.dumps(details, ensure_ascii=False)
                with self.connection:
                    self.connection.executemany(
                        """
                        UPDATE documents SET display_title=?, issuer=?, published_year=?, source_url=?, scope=?,
                            source_kind=?, updated_at=? WHERE id=?
                        """,
                        [
                            (
                                document["display_title"],
                                document["issuer"],
                                document["published_year"],
                                document["source_url"],
                                document["scope"],
                                document["source_kind"],
                                document["updated_at"],
                                document["id"],
                            )
                            for document in new_documents
                        ],
                    )
                    updated_rows = self.connection.execute(
                        f"SELECT * FROM documents WHERE id IN ({placeholders}) ORDER BY id", document_ids
                    ).fetchall()
                    updated_records = [self._document_record(row) for row in updated_rows]
                    self.connection.execute(
                        "UPDATE jobs SET status='completed', completed_at=?, error=NULL, details=? WHERE id=?",
                        (completed_at, details_json, job_id),
                    )
                    job_row = self.connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
                    if job_row is None:
                        raise RuntimeError("metadata_update_job_missing")
                    completed_job = {
                        "id": job_row["id"],
                        "document_id": job_row["document_id"],
                        "operation": job_row["operation"],
                        "status": job_row["status"],
                        "created_at": job_row["created_at"],
                        "completed_at": job_row["completed_at"],
                        "error": job_row["error"],
                        "details": json.loads(job_row["details"]),
                    }
                return updated_records, completed_job, previous_scope
            except Exception as error:
                rollback: dict[str, bool] = {}
                if graph_attempted:
                    rollback["falkordb"] = self.graph.update_documents_metadata(
                        [
                            {**document, "title": document["display_title"] or document["title"]}
                            for document in old_documents
                        ],
                        len(chunk_rows),
                    )
                if qdrant_attempted:
                    rollback["qdrant"] = all(
                        self._qdrant_set_metadata(
                            chunk_ids_by_document[str(document["id"])],
                            self._mirror_metadata(document),
                        )
                        for document in old_documents
                        if str(document["id"]) in qdrant_document_ids
                    )
                details["rollback"] = rollback
                details["mirror_dirty"] = any(not restored for restored in rollback.values())
                details["failure_reason"] = str(error)
                self._finish_job(job_id, details=details, error="Knowledge metadata update failed.")
                raise KnowledgeMetadataUpdateError("Knowledge metadata update failed; previous metadata was preserved.", job_id) from error

    def update_source_group_retrieval_state(
        self,
        source_group_id: str,
        farm_id: str,
        retrieval_state: RetrievalState,
    ) -> tuple[list[dict[str, Any]], dict[str, Any], RetrievalState] | None:
        with self._source_group_mutation_lock(source_group_id):
            return self._update_source_group_retrieval_state(
                source_group_id,
                farm_id,
                retrieval_state,
            )

    def _update_source_group_retrieval_state(
        self,
        source_group_id: str,
        farm_id: str,
        retrieval_state: RetrievalState,
    ) -> tuple[list[dict[str, Any]], dict[str, Any], RetrievalState] | None:
        if retrieval_state not in {"active", "paused", "needs_review"}:
            raise ValueError("retrieval_state must be active, paused, or needs_review")
        with self._lock:
            rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
            if not rows:
                return None
            if any(row["farm_id"] != farm_id for row in rows):
                raise PermissionError("Only knowledge owned by the current farm can be updated")
            previous_states = {str(row["retrieval_state"]) for row in rows}
            if len(previous_states) != 1:
                raise ValueError("source group has inconsistent retrieval state")
            previous_state: RetrievalState = previous_states.pop()  # type: ignore[assignment]
            document_ids = [str(row["id"]) for row in rows]
            job_id = self._new_job(document_ids[0], "retrieval_state_update_group")
            now = utc_now_iso()
            details = {
                "source_group_id": source_group_id,
                "document_ids": document_ids,
                "previous_retrieval_state": previous_state,
                "retrieval_state": retrieval_state,
                "embedding_recomputed": False,
                "mirrors_rebuilt": False,
            }
            with self.connection:
                self.connection.execute(
                    "UPDATE documents SET retrieval_state=?, updated_at=? "
                    "WHERE source_group_id=? AND status='ready'",
                    (retrieval_state, now, source_group_id),
                )
            self._finish_job(job_id, details=details)
            updated_rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (source_group_id,),
            ).fetchall()
        return [self._document_record(row) for row in updated_rows], self.get_job(job_id) or {}, previous_state

    def activate_embedding_and_reindex(self, provider: str, model: str) -> dict[str, Any]:
        """Atomically activate a staged embedding runtime after full reindex.

        Candidate vectors and the candidate Qdrant collection are prepared
        before SQLite or the active runtime changes.  Therefore a model load,
        inference, or mirror failure leaves the previous searchable index in
        place.  Document text and metadata are never rewritten here.
        """

        job_id = self._new_job(None, "reindex_all")
        previous_embedding = self.embedding
        previous_status = previous_embedding.status()
        activated = False
        requested = {"provider": provider.strip().lower(), "model": model.strip()}
        details: dict[str, Any] = {
            "requested_embedding": requested,
            "previous_embedding": previous_status,
            "processed_documents": 0,
            "processed_chunks": 0,
            "qdrant_vectors": 0,
            "previous_index_preserved_on_failure": True,
        }
        try:
            candidate = EmbeddingRuntime(provider=requested["provider"], model=requested["model"])
            candidate.embed_query("고추냉이 지식 인덱스 전환 검증")
            candidate_status = candidate.status()
            if (
                candidate_status["state"] != "ready"
                or candidate_status["provider"] != requested["provider"]
                or candidate_status["model"] != requested["model"]
            ):
                raise ValueError("requested_embedding_runtime_unavailable")

            with self._lock:
                documents = self.connection.execute(
                    "SELECT * FROM documents WHERE status<>'deleted' ORDER BY id"
                ).fetchall()
                document_chunks = {
                    str(row["id"]): self.connection.execute(
                        "SELECT * FROM chunks WHERE document_id=? ORDER BY ordinal",
                        (row["id"],),
                    ).fetchall()
                    for row in documents
                }

            prepared: list[tuple[sqlite3.Row, list[dict[str, Any]]]] = []
            for document in documents:
                chunks = document_chunks[str(document["id"])]
                if not chunks:
                    raise ValueError(f"document_without_indexable_chunks:{document['id']}")
                vectors = candidate.embed_passages([str(chunk["text"]) for chunk in chunks])
                prepared.append(
                    (
                        document,
                        [
                            {
                                "id": str(chunk["id"]),
                                "ordinal": int(chunk["ordinal"]),
                                "text": str(chunk["text"]),
                                "embedding": vector,
                            }
                            for chunk, vector in zip(chunks, vectors, strict=True)
                        ],
                    )
                )

            qdrant_counts: dict[str, int] = {str(document["id"]): 0 for document, _records in prepared}
            if self.qdrant_url:
                if not self._prepare_qdrant_for_embedding(
                    candidate,
                    reset_existing=candidate.collection_name != previous_embedding.collection_name,
                ):
                    raise RuntimeError("candidate_qdrant_collection_unavailable")
                for document, records in prepared:
                    mirrored = self._qdrant_upsert_for_embedding(candidate, document, records)
                    if mirrored != len(records):
                        raise RuntimeError(f"candidate_qdrant_upsert_failed:{document['id']}")
                    qdrant_counts[str(document["id"])] = mirrored

            now = utc_now_iso()
            with self._lock:
                with self.connection:
                    for document, records in prepared:
                        for record in records:
                            self.connection.execute(
                                "UPDATE chunks SET embedding=? WHERE id=?",
                                (json.dumps(record["embedding"]), record["id"]),
                            )
                        qdrant_count = qdrant_counts[str(document["id"])]
                        self.connection.execute(
                            """
                            UPDATE documents SET embedding_model=?, vector_count=?, qdrant_vector_count=?,
                                index_backend=?, status='ready', updated_at=? WHERE id=?
                            """,
                            (
                                candidate.active_model,
                                len(records),
                                qdrant_count,
                                "qdrant" if qdrant_count == len(records) else "sqlite_fallback",
                                now,
                                document["id"],
                            ),
                        )
                    self.connection.executemany(
                        """
                        INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                        """,
                        (
                            ("ai.embedding.active_provider", requested["provider"], now),
                            ("ai.embedding.active_model", requested["model"], now),
                        ),
                    )
                self.embedding = candidate
                self._qdrant_ready = bool(self.qdrant_url)
                self._qdrant_ready_collection = candidate.collection_name if self.qdrant_url else None
                activated = True

            processed_chunks = sum(len(records) for _document, records in prepared)
            details.update(
                {
                    "processed_documents": len(prepared),
                    "processed_chunks": processed_chunks,
                    "qdrant_vectors": sum(qdrant_counts.values()),
                    "active_embedding": candidate.status(),
                    "qdrant_collection": candidate.collection_name if self.qdrant_url else None,
                    "stale_point_strategy": (
                        "fresh_candidate_collection"
                        if self.qdrant_url and candidate.collection_name != previous_embedding.collection_name
                        else "current_sqlite_chunk_filter"
                    ),
                    "graph_search_preserved": True,
                }
            )
            self._finish_job(job_id, details=details)
            return self.get_job(job_id) or {}
        except Exception as error:
            if activated:
                raise
            self.embedding = previous_embedding
            details["failure_reason"] = str(error)
            details["active_embedding"] = previous_status
            self._finish_job(job_id, details=details, error="Embedding activation and full reindex failed.")
            raise EmbeddingReindexError(
                "Embedding activation failed; the previous runtime and index remain active.",
                job_id,
            ) from error

    def delete_document(self, document_id: str, farm_id: str) -> bool:
        with self._lock:
            row = self.connection.execute(
                "SELECT source_group_id FROM documents WHERE id=? AND status='ready'",
                (document_id,),
            ).fetchone()
        if row is None or not row["source_group_id"]:
            return False
        with self._source_group_mutation_lock(str(row["source_group_id"])):
            return self._delete_document(document_id, farm_id)

    def _delete_document(self, document_id: str, farm_id: str) -> bool:
        with self._lock:
            row = self.connection.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
            if not row or row["status"] != "ready" or not self._source_visible(row, farm_id, True):
                return False
            if row["farm_id"] != farm_id:
                raise PermissionError("Only knowledge owned by the current farm can be deleted")
            group_rows = self.connection.execute(
                "SELECT * FROM documents WHERE source_group_id=? AND status='ready' ORDER BY id",
                (row["source_group_id"],),
            ).fetchall()
            previous_snapshot = self._source_group_snapshot(
                str(row["source_group_id"]), farm_id, group_rows
            )
            chunk_ids = self._chunks_for_document(document_id)
            self._qdrant_delete(chunk_ids)
            self.graph.delete_document(document_id)
            with self.connection:
                self._replace_previous_source_group_revision(previous_snapshot, "자료 삭제 전 상태")
                self.connection.execute("DELETE FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)", (document_id,))
                self.connection.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
                self.connection.execute(
                    "UPDATE documents SET status='deleted', updated_at=?, chunk_count=0, vector_count=0, qdrant_vector_count=0, graph_node_count=0, graph_edge_count=0 WHERE id=?",
                    (utc_now_iso(), document_id),
                )
        return True

    def _allowed_chunks(
        self,
        farm_id: str,
        include_private: bool,
        selected_document_ids: set[str] | None,
    ) -> list[sqlite3.Row]:
        with self._lock:
            rows = self.connection.execute(
                """
                SELECT c.*, d.title, d.title AS raw_title, d.display_title, d.source_key, d.issuer,
                    d.published_year, d.document_type, d.source_url, d.summary, d.scope, d.farm_id, d.source_kind, d.version,
                    d.canonical_source_id, d.content_checksum, d.provenance_json, d.source_locator, d.crop, d.cultivation_system,
                    d.evidence_class, d.growth_stage, d.embedding_model, d.source_group_id
                FROM chunks c JOIN documents d ON d.id=c.document_id
                WHERE d.status='ready' AND d.retrieval_state='active'
                ORDER BY c.document_id, c.ordinal
                """
            ).fetchall()
        return [
            row
            for row in rows
            if self._source_visible(row, farm_id, include_private)
            and self._eligible_for_default_retrieval(row, selected_document_ids)
            and (selected_document_ids is None or row["document_id"] in selected_document_ids)
        ]

    @staticmethod
    def _normalize_profile_filters(
        profile_filters: dict[str, str | set[str] | list[str] | tuple[str, ...]] | None,
    ) -> dict[str, set[str]]:
        return {
            key: ({str(value)} if isinstance(value, str) else {str(item) for item in value})
            for key, value in (profile_filters or {}).items()
            if key in PROFILE_FILTER_FIELDS
        }

    @staticmethod
    def _qdrant_filter(
        allowed: dict[str, sqlite3.Row],
        profile_filters: dict[str, set[str]],
    ) -> dict[str, Any] | None:
        document_ids = sorted({str(row["document_id"]) for row in allowed.values()})
        if not document_ids:
            return None
        must: list[dict[str, Any]] = [{"key": "document_id", "match": {"any": document_ids}}]
        for field, values in sorted(profile_filters.items()):
            if values:
                must.append({"key": field, "match": {"any": sorted(values)}})
        return {"must": must}

    def _qdrant_dense_scores(
        self,
        query_vector: list[float],
        allowed: dict[str, sqlite3.Row],
        profile_filters: dict[str, set[str]],
        limit: int,
    ) -> dict[str, float] | None:
        query_filter = self._qdrant_filter(allowed, profile_filters)
        if query_filter is None:
            return {}
        if not self._ensure_qdrant():
            return None
        payload = {
            "query": query_vector,
            "filter": query_filter,
            "limit": max(limit * 4, 20),
            "with_payload": True,
        }
        collection_name = self.embedding.collection_name
        response = self._run_qdrant("POST", f"/collections/{collection_name}/points/query", payload)
        if response is None:
            response = self._run_qdrant(
                "POST",
                f"/collections/{collection_name}/points/search",
                {
                    "vector": query_vector,
                    "filter": query_filter,
                    "limit": payload["limit"],
                    "with_payload": True,
                },
            )
        if response is None:
            return None
        result = response.get("result")
        raw_points = result.get("points", []) if isinstance(result, dict) else result if isinstance(result, list) else []
        scores: dict[str, float] = {}
        for point in raw_points:
            payload_item = point.get("payload") or {}
            chunk_id = str(payload_item.get("chunk_id") or "")
            if chunk_id in allowed:
                scores[chunk_id] = float(point.get("score") or 0.0)
        return scores

    def _local_dense_scores(
        self,
        query: str,
        query_vector: list[float],
        allowed: dict[str, sqlite3.Row],
    ) -> dict[str, float]:
        active_model = self.embedding.active_model
        scores: dict[str, float] = {}
        stale: list[tuple[str, sqlite3.Row]] = []
        for chunk_id, row in allowed.items():
            stored = json.loads(row["embedding"])
            if row["embedding_model"] == active_model and len(stored) == self.embedding.vector_size:
                scores[chunk_id] = cosine(query_vector, stored)
            else:
                stale.append((chunk_id, row))
        if stale:
            fresh = self.embedding.embed_passages([str(row["text"]) for _chunk_id, row in stale])
            if self.embedding.active_model != active_model:
                query_vector = self.embedding.embed_query(query)
            scores.update(
                {
                    chunk_id: cosine(query_vector, vector)
                    for (chunk_id, _row), vector in zip(stale, fresh, strict=True)
                }
            )
        return scores

    @staticmethod
    def _sparse_scores(query: str, allowed: Iterable[sqlite3.Row]) -> dict[str, float]:
        query_tokens = set(tokenize(query))
        if not query_tokens:
            return {}
        scores: dict[str, float] = {}
        for row in allowed:
            searchable = " ".join(
                str(row[field] or "")
                for field in (
                    "text",
                    "display_title",
                    "summary",
                    "issuer",
                    "document_type",
                    "crop",
                    "cultivation_system",
                    "evidence_class",
                    "growth_stage",
                )
            )
            document_tokens = set(tokenize(searchable))
            overlap = len(query_tokens & document_tokens)
            if overlap:
                scores[str(row["id"])] = overlap / len(query_tokens)
        return scores

    def _graph_scores(self, query: str, allowed: Iterable[sqlite3.Row]) -> tuple[dict[str, float], str]:
        """Use FalkorDB graph traversal, with SQLite Chunk -> Term fallback."""

        query_tokens = set(tokenize(query))
        allowed_map = {str(row["id"]): row for row in allowed}
        if not query_tokens or not allowed_map:
            return {}, "sqlite_chunk_term_graph"
        falkor_scores = self.graph.search(query, set(allowed_map), limit=12)
        if falkor_scores is not None:
            return falkor_scores, "falkordb"
        placeholders = ",".join("?" for _ in query_tokens)
        with self._lock:
            rows = self.connection.execute(
                f"SELECT chunk_id, COUNT(*) AS count FROM chunk_terms WHERE term IN ({placeholders}) GROUP BY chunk_id", tuple(query_tokens)
            ).fetchall()
        return (
            {
                str(row["chunk_id"]): float(row["count"]) / len(query_tokens)
                for row in rows
                if str(row["chunk_id"]) in allowed_map
            },
            "sqlite_chunk_term_graph",
        )

    def _graph_scores_with_gate(
        self,
        query: str,
        allowed: list[sqlite3.Row],
        dense_scores: dict[str, float],
        threshold: float,
    ) -> tuple[dict[str, float], str, dict[str, Any]]:
        raw_scores, backend = self._graph_scores(query, allowed)
        allowed_map = {str(row["id"]): row for row in allowed}
        verified_scores = {
            chunk_id: score
            for chunk_id, score in raw_scores.items()
            if (row := allowed_map.get(chunk_id)) is not None and _graph_span_provenance_verified(row)
        }
        provenance_coverage = len(verified_scores) / len(raw_scores) if raw_scores else 0.0
        lexical_strength = max(verified_scores.values(), default=0.0)
        graph_top = {
            chunk_id
            for chunk_id, _score in sorted(verified_scores.items(), key=lambda item: item[1], reverse=True)[:5]
        }
        dense_top = {
            chunk_id
            for chunk_id, _score in sorted(dense_scores.items(), key=lambda item: item[1], reverse=True)[:10]
        }
        dense_agreement = len(graph_top & dense_top) / len(graph_top) if graph_top else 0.0
        reliability = min(
            1.0,
            0.5 * provenance_coverage + 0.3 * max(0.0, min(1.0, lexical_strength)) + 0.2 * dense_agreement,
        )
        enabled = bool(verified_scores) and reliability >= threshold
        if not raw_scores:
            reason = "no_graph_candidates"
        elif not verified_scores:
            reason = "no_source_span_verified_graph_relation"
        elif not enabled:
            reason = "graph_harm_reliability_below_threshold"
        else:
            reason = "source_span_verified_graph_relation_passed"
        return (
            verified_scores if enabled else {},
            backend,
            {
                "considered": True,
                "enabled": enabled,
                "reason": reason,
                "threshold": round(float(threshold), 4),
                "reliability": round(reliability, 4),
                "raw_candidate_count": len(raw_scores),
                "verified_candidate_count": len(verified_scores),
                "provenance_coverage": round(provenance_coverage, 4),
                "lexical_strength": round(float(lexical_strength), 4),
                "dense_agreement": round(dense_agreement, 4),
                "harm_suppressed": bool(raw_scores) and not enabled,
            },
        )

    @staticmethod
    def _fuse(
        scores_by_channel: dict[str, dict[str, float]],
        limit: int,
        channel_weights: dict[str, float] | None = None,
    ) -> tuple[list[tuple[str, float]], dict[str, list[str]], dict[str, float]]:
        active = [channel for channel, scores in scores_by_channel.items() if scores]
        if not active:
            return [], {}, {}
        defaults = {"dense": 0.50, "sparse": 0.28, "graph": 0.22}
        requested = channel_weights or defaults
        selected = {
            channel: float(requested.get(channel, defaults[channel]))
            for channel in active
            if math.isfinite(float(requested.get(channel, defaults[channel])))
            and float(requested.get(channel, defaults[channel])) > 0
        }
        if not selected:
            return [], {}, {}
        total = sum(selected.values())
        weights = {channel: value / total for channel, value in selected.items()}
        accumulated: dict[str, float] = defaultdict(float)
        channels: dict[str, list[str]] = defaultdict(list)
        for channel in selected:
            for rank, (chunk_id, _score) in enumerate(sorted(scores_by_channel[channel].items(), key=lambda item: item[1], reverse=True), start=1):
                accumulated[chunk_id] += weights[channel] / (60 + rank)
                channels[chunk_id].append(channel)
        ranked = sorted(accumulated.items(), key=lambda item: item[1], reverse=True)[:limit]
        return ranked, dict(channels), weights

    @staticmethod
    def _answerability(
        query: str,
        ranked: list[tuple[str, float]],
        allowed: dict[str, sqlite3.Row],
        dense_scores: dict[str, float],
        explicit_single_source_selection: bool,
    ) -> dict[str, Any]:
        query_terms = _answerability_terms(query)
        query_numbers = _answerability_anchors(EVIDENCE_NUMBER_RE, query)
        query_codes = _answerability_anchors(EVIDENCE_CODE_RE, query)
        query_domains = {
            term for term in ANSWERABILITY_DOMAIN_TERMS if term in str(query or "").casefold()
        }
        best: dict[str, Any] = {
            "chunk_id": None,
            "lexical_overlap_count": 0,
            "lexical_overlap_ratio": 0.0,
            "matched_terms": [],
            "domain_overlap_count": 0,
            "numeric_overlap": [],
            "code_overlap": [],
            "dense_score": 0.0,
        }
        best_strength = (-1, -1, -1, float("-inf"))
        candidate_signals: list[dict[str, Any]] = []
        for chunk_id, _score in ranked:
            row = allowed.get(chunk_id)
            if row is None:
                continue
            searchable = " ".join(
                str(row[field] or "")
                for field in (
                    "text",
                    "display_title",
                    "summary",
                    "issuer",
                    "document_type",
                    "crop",
                    "cultivation_system",
                    "evidence_class",
                    "growth_stage",
                )
            ).casefold()
            evidence_terms = _answerability_terms(searchable)
            matched_terms = sorted(
                term
                for term in query_terms
                if term in evidence_terms or (len(term) >= 3 and term in searchable)
            )
            matched_domains = sorted(term for term in query_domains if term in searchable)
            numeric_overlap = sorted(query_numbers & _answerability_anchors(EVIDENCE_NUMBER_RE, searchable))
            code_overlap = sorted(query_codes & _answerability_anchors(EVIDENCE_CODE_RE, searchable))
            dense_score = float(dense_scores.get(chunk_id, 0.0))
            signals = {
                "chunk_id": chunk_id,
                "lexical_overlap_count": len(matched_terms),
                "lexical_overlap_ratio": round(len(matched_terms) / max(len(query_terms), 1), 4),
                "matched_terms": matched_terms,
                "domain_overlap_count": len(matched_domains),
                "numeric_overlap": numeric_overlap,
                "code_overlap": code_overlap,
                "dense_score": round(dense_score, 4),
            }
            candidate_signals.append(signals)
            strength = (
                len(numeric_overlap) + len(code_overlap),
                dense_score,
                len(matched_domains),
                len(matched_terms),
            )
            if strength > best_strength:
                best_strength = strength
                best = signals

        query_domain_terms = {
            term
            for domain_term in query_domains
            for term in _answerability_terms(domain_term)
        }
        anchor_subject_terms = query_terms - SELECTED_SOURCE_CONTEXT_TERMS - query_domain_terms

        def assess(signals: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
            anchor_overlap = bool(signals["numeric_overlap"] or signals["code_overlap"])
            anchor_alignment_required = bool(query_numbers or query_codes)
            anchor_alignment_satisfied = not anchor_alignment_required or anchor_overlap
            overlap_ratio = float(signals["lexical_overlap_ratio"])
            matched_anchor_subject_terms = anchor_subject_terms & set(signals["matched_terms"])
            anchor_subject_overlap_ratio = (
                len(matched_anchor_subject_terms) / len(anchor_subject_terms)
                if anchor_subject_terms
                else 1.0
            )
            anchor_semantic_alignment = (
                signals["dense_score"] >= 0.5 and signals["domain_overlap_count"] >= 2
            )
            anchor_subject_alignment_satisfied = (
                not anchor_subject_terms
                or anchor_subject_overlap_ratio >= 0.5
                or anchor_semantic_alignment
            )
            anchor_supported = anchor_overlap and (
                signals["domain_overlap_count"] >= 1 or signals["lexical_overlap_count"] >= 1
            ) and anchor_subject_alignment_satisfied
            lexical_supported = (
                anchor_alignment_satisfied
                and signals["lexical_overlap_count"] >= min(3, max(2, len(query_terms)))
            )
            domain_supported = (
                anchor_alignment_satisfied
                and signals["domain_overlap_count"] >= 2
                and signals["lexical_overlap_count"] >= 2
                and overlap_ratio >= 0.35
            )
            dense_supported = (
                anchor_alignment_satisfied
                and signals["dense_score"] >= 0.18
                and signals["domain_overlap_count"] >= 1
                and signals["lexical_overlap_count"] >= 2
                and overlap_ratio >= 0.35
            )
            source_context_only = (
                bool(query_terms & SELECTED_SOURCE_SUMMARY_TERMS)
                and not (query_terms - SELECTED_SOURCE_CONTEXT_TERMS)
            )
            subject_terms = query_terms - SELECTED_SOURCE_CONTEXT_TERMS
            subject_terms_supported = bool(subject_terms) and subject_terms <= set(signals["matched_terms"])
            normal_rules = [
                name
                for name, matched in (
                    ("numeric_or_code_anchor", anchor_supported),
                    ("lexical_overlap", lexical_supported),
                    ("domain_overlap", domain_supported),
                    ("dense_plus_lexical_domain", dense_supported),
                )
                if matched
            ]
            selected_source_rules = [
                name
                for name, matched in (
                    ("explicit_selected_source_context", source_context_only),
                    ("explicit_selected_source_subject_overlap", subject_terms_supported),
                    ("explicit_selected_source_anchor", anchor_supported),
                    ("lexical_overlap", lexical_supported),
                    ("domain_overlap", domain_supported),
                )
                if matched
            ]
            return (
                selected_source_rules if explicit_single_source_selection else normal_rules,
                {
                    "lexical_term_count": len(query_terms),
                    "domain_terms": sorted(query_domains),
                    "numeric_anchors": sorted(query_numbers),
                    "code_anchors": sorted(query_codes),
                    "anchor_alignment_required": anchor_alignment_required,
                    "anchor_alignment_satisfied": anchor_alignment_satisfied,
                    "anchor_subject_terms": sorted(anchor_subject_terms),
                    "matched_anchor_subject_terms": sorted(matched_anchor_subject_terms),
                    "anchor_subject_overlap_ratio": round(anchor_subject_overlap_ratio, 4),
                    "anchor_semantic_alignment": anchor_semantic_alignment,
                    "anchor_subject_alignment_satisfied": anchor_subject_alignment_satisfied,
                    "explicit_single_source_selection": explicit_single_source_selection,
                },
            )

        matched_rules, query_signals = assess(best)
        if not matched_rules:
            for candidate in candidate_signals:
                candidate_rules, candidate_query_signals = assess(candidate)
                if candidate_rules:
                    best = candidate
                    matched_rules = candidate_rules
                    query_signals = candidate_query_signals
                    break
        answerable = bool(ranked) and bool(matched_rules)
        return {
            "is_answerable": answerable,
            "decision": "answerable" if answerable else "insufficient_evidence",
            "reason": matched_rules[0] if matched_rules else "no_supported_query_evidence_alignment",
            "matched_rules": matched_rules,
            "signals": best,
            "query_signals": query_signals,
        }

    @staticmethod
    def _diverse_ranked(
        ranked: list[tuple[str, float]],
        allowed: dict[str, sqlite3.Row],
        limit: int,
        relax_source_diversity: bool,
        preferred_chunk_id: str | None = None,
    ) -> list[tuple[str, float]]:
        selected: list[tuple[str, float]] = []
        source_counts: Counter[str] = Counter()
        preferred = next((item for item in ranked if item[0] == preferred_chunk_id), None)
        ordered = ([preferred] if preferred is not None else []) + [
            item for item in ranked if preferred is None or item[0] != preferred[0]
        ]
        for item in ordered:
            row = allowed.get(item[0])
            if row is None:
                continue
            canonical_source = str(row["canonical_source_id"] or f"document:{row['document_id']}")
            if not relax_source_diversity and source_counts[canonical_source] >= 2:
                continue
            selected.append(item)
            source_counts[canonical_source] += 1
            if len(selected) >= limit:
                break
        return selected

    def retrieve(
        self,
        *,
        query: str,
        farm_id: str,
        include_private: bool,
        selected_document_ids: set[str] | None,
        retrieval_path: list[str],
        channel_weights: dict[str, float] | None = None,
        graph_reliability_threshold: float = 0.0,
        profile_filters: dict[str, str | set[str] | list[str] | tuple[str, ...]] | None = None,
        limit: int = 5,
        relax_source_diversity: bool = False,
        explicit_single_source_selection: bool = False,
    ) -> RetrievalResult:
        allowed_rows = self._allowed_chunks(farm_id, include_private, selected_document_ids)
        normalized_filters = self._normalize_profile_filters(profile_filters)
        if normalized_filters:
            allowed_rows = [
                row
                for row in allowed_rows
                if all(str(row[field] or "") in values for field, values in normalized_filters.items())
            ]
        allowed = {str(row["id"]): row for row in allowed_rows}
        query_vector = self.embedding.embed_query(query)
        research_trace: dict[str, Any] | None = None
        research_profile = load_qact_release_profile()
        if research_profile.state == "valid" and research_profile.research_policy:
            from .research_retrieval import snapshot_hashes
            actual = snapshot_hashes(self)
            if actual != research_profile.snapshot_hashes:
                retrieval_path, channel_weights = ["dense"], {"dense": 1.0}
                research_trace = {"state": "snapshot_mismatch", "actual_snapshot_hashes": actual,
                    "reason": "Research calibration snapshot differs from the active index; Dense-only fallback."}
            else:
                candidate = research_profile.route(query)
                retrieval_path = candidate["retrieval_path"]
                channel_weights = candidate["channel_weights"]
                graph_reliability_threshold = candidate["graph_reliability_threshold"]
                research_trace = {"state": "valid", "release_checksum": research_profile.checksum,
                    "quality_acceptance": research_profile.research_policy.get("quality_acceptance"),
                    "diagnostics_only": research_profile.research_policy.get("quality_acceptance") is False}
        qdrant_scores = self._qdrant_dense_scores(query_vector, allowed, normalized_filters, limit)
        if not qdrant_scores:
            dense_scores = self._local_dense_scores(query, query_vector, allowed)
            backend = "sqlite_fallback" if qdrant_scores is None else "qdrant_empty_sqlite_fallback"
        else:
            dense_scores = qdrant_scores
            backend = "qdrant"
        scores_by_channel: dict[str, dict[str, float]] = {"dense": dense_scores}
        if "sparse" in retrieval_path:
            scores_by_channel["sparse"] = self._sparse_scores(query, allowed_rows)
        graph_backend: str | None = None
        graph_gate: dict[str, Any] = {
            "considered": False,
            "enabled": False,
            "reason": "graph_not_requested",
            "threshold": round(float(graph_reliability_threshold), 4),
            "harm_suppressed": False,
        }
        if "graph" in retrieval_path:
            graph_scores, graph_backend, graph_gate = self._graph_scores_with_gate(
                query,
                allowed_rows,
                dense_scores,
                graph_reliability_threshold,
            )
            if graph_scores:
                scores_by_channel["graph"] = graph_scores
        if research_trace and research_trace["state"] == "valid":
            from .research_retrieval_algorithm import dense_first_adaptive_route
            policy = research_profile.research_policy or {}
            decision = dense_first_adaptive_route(
                weights=channel_weights,
                graph_rank=list(scores_by_channel.get("graph", {})),
                graph_threshold=policy["graph_weight_threshold"],
                sparse_fallback_min=policy["sparse_fallback_min"],
            )
            research_trace["decision"] = decision
            research_trace["reason"] = decision["fallback_reason"] or "source_backed_adaptive_fusion"
            if not decision["graph_active"]:
                scores_by_channel.pop("graph", None)
                graph_gate.update(enabled=False, reason=decision["fallback_reason"])
            if decision["selected_mode"] == "dense_only":
                scores_by_channel.pop("sparse", None)
            elif decision["selected_mode"] == "dense_sparse":
                # The research runner calls its unweighted two-channel RRF
                # branch here, not the structural weighted-fusion branch.
                channel_weights = {"dense": 0.5, "sparse": 0.5}
        ranked_candidates, channels, weights = self._fuse(
            scores_by_channel,
            max(limit * 4, 20),
            channel_weights,
        )
        answerability = self._answerability(
            query,
            ranked_candidates,
            allowed,
            dense_scores,
            explicit_single_source_selection,
        )
        ranked = (
            self._diverse_ranked(
                ranked_candidates,
                allowed,
                limit,
                relax_source_diversity,
                str(answerability["signals"].get("chunk_id") or "") or None,
            )
            if answerability["is_answerable"]
            else []
        )
        hits = [
            RetrievedChunk(
                chunk_id=chunk_id,
                document_id=str(row["document_id"]),
                title=str(row["display_title"] or row["raw_title"]),
                text=str(row["text"]),
                source_kind=str(row["source_kind"]),
                scope=str(row["scope"]),
                farm_id=str(row["farm_id"]) if row["farm_id"] else None,
                version=str(row["version"]),
                ordinal=int(row["ordinal"]),
                score=round(float(score), 6),
                channels=channels.get(chunk_id, []),
                issuer=str(row["issuer"]) if row["issuer"] else None,
                published_year=int(row["published_year"]) if row["published_year"] is not None else None,
                document_type=str(row["document_type"]) if row["document_type"] else None,
                source_url=str(row["source_url"]) if row["source_url"] else None,
                summary=str(row["summary"]) if row["summary"] else None,
                source_locator=str(row["source_locator"]) if row["source_locator"] else None,
                crop=str(row["crop"]) if row["crop"] else None,
                cultivation_system=str(row["cultivation_system"]) if row["cultivation_system"] else None,
                evidence_class=str(row["evidence_class"]) if row["evidence_class"] else None,
                growth_stage=str(row["growth_stage"]) if row["growth_stage"] else None,
                canonical_source_id=(
                    str(row["canonical_source_id"]) if row["canonical_source_id"] else None
                ),
                content_checksum=str(row["content_checksum"]) if row["content_checksum"] else None,
                provenance=json.loads(str(row["provenance_json"] or "{}")),
            )
            for chunk_id, score in ranked
            if (row := allowed.get(chunk_id)) is not None
        ]
        return RetrievalResult(
            hits=hits,
            trace={
                "run_id": f"retrieval-{uuid4().hex[:12]}",
                "backend": backend,
                "candidate_count": len(allowed_rows),
                "returned_count": len(hits),
                "answerable": answerability["is_answerable"],
                "answerability_reason": answerability["reason"],
                "answerability_signals": answerability["signals"],
                "answerability": answerability,
                "source_diversity": {
                    "max_chunks_per_canonical_source": None if relax_source_diversity else 2,
                    "relaxed_for_single_selected_source_group": relax_source_diversity,
                },
                "query_scope": "public_only" if not include_private else f"public_plus_{farm_id}",
                "channels": {channel: len(scores) for channel, scores in scores_by_channel.items()},
                "fusion": {"algorithm": "weighted_rrf", "weights": weights, "rrf_k": 60},
                "graph_backend": graph_backend,
                "graph_gate": graph_gate,
                "research_policy": research_trace,
                "profile_filters": {key: sorted(values) for key, values in normalized_filters.items()},
                "embedding": self.embedding.status(),
            },
        )

    def active_source_groups(
        self,
        farm_id: str,
        *,
        visibility: str = "public",
    ) -> list[dict[str, Any]]:
        documents = [
            document
            for document in self.list_documents(farm_id)
            if document["retrieval_state"] == "active"
            and (
                document["scope"] == "public"
                or (
                    visibility == "all"
                    and document["scope"] == "private"
                    and document["farm_id"] == farm_id
                )
            )
        ]
        grouped: dict[str, dict[str, Any]] = {}
        for document in documents:
            source_group_id = str(document["source_group_id"])
            item = grouped.setdefault(
                source_group_id,
                {
                    "source_group_id": source_group_id,
                    "title": str(document["title"]),
                    "visibility": "private" if document["scope"] == "private" else "public",
                    "document_count": 0,
                },
            )
            item["document_count"] = int(item["document_count"]) + 1
        return sorted(grouped.values(), key=lambda item: str(item["title"]))

    def search_source_groups(
        self,
        query: str,
        farm_id: str,
        *,
        limit: int | None = None,
        visibility: str = "public",
    ) -> list[dict[str, Any]]:
        """Search active visible sources and collapse chunk matches to their original source root."""

        normalized_query = " ".join(str(query or "").split())
        if not normalized_query:
            return []
        source_groups = self.active_source_groups(farm_id, visibility=visibility)
        allowed_source_group_ids = {str(item["source_group_id"]) for item in source_groups}
        documents = [
            document
            for document in self.list_documents(farm_id)
            if str(document["source_group_id"]) in allowed_source_group_ids
        ]
        if not documents:
            return []
        document_ids = {str(document["id"]) for document in documents}
        allowed_rows = self._allowed_chunks(farm_id, visibility == "all", document_ids)
        allowed = {str(row["id"]): row for row in allowed_rows}
        if not allowed:
            return []

        result_limit = min(limit, len(allowed)) if limit is not None else len(allowed)
        query_vector = self.embedding.embed_query(normalized_query)
        dense_scores = self._qdrant_dense_scores(query_vector, allowed, {}, result_limit)
        if not dense_scores:
            dense_scores = self._local_dense_scores(normalized_query, query_vector, allowed)
        sparse_scores = self._sparse_scores(normalized_query, allowed_rows)
        ranked, channels, _weights = self._fuse(
            {"dense": dense_scores, "sparse": sparse_scores},
            max(len(allowed), result_limit * 4),
        )

        documents_by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for document in documents:
            documents_by_group[str(document["source_group_id"])].append(document)
        query_tokens = set(tokenize(normalized_query))
        grouped: dict[str, dict[str, Any]] = {}
        for chunk_id, _fused_score in ranked:
            row = allowed.get(chunk_id)
            if row is None:
                continue
            dense_score = max(0.0, min(1.0, float(dense_scores.get(chunk_id, 0.0))))
            sparse_score = max(0.0, min(1.0, float(sparse_scores.get(chunk_id, 0.0))))
            title_tokens = set(tokenize(str(row["display_title"] or row["raw_title"] or "")))
            metadata_tokens = set(
                tokenize(
                    " ".join(
                        str(row[field] or "")
                        for field in (
                            "summary",
                            "issuer",
                            "document_type",
                            "crop",
                            "cultivation_system",
                            "evidence_class",
                            "growth_stage",
                        )
                    )
                )
            )
            title_match = bool(query_tokens & title_tokens)
            metadata_match = bool(query_tokens & metadata_tokens)
            semantic_match = dense_score >= 0.35
            if sparse_score <= 0.0 and not title_match and not metadata_match and not semantic_match:
                continue
            score = min(
                1.0,
                0.55 * dense_score
                + 0.30 * sparse_score
                + (0.10 if title_match else 0.0)
                + (0.05 if metadata_match else 0.0),
            )
            source_group_id = str(row["source_group_id"])
            item = grouped.setdefault(
                source_group_id,
                {
                    "source_group_id": source_group_id,
                    "title": str(row["display_title"] or row["raw_title"]),
                    "visibility": "private" if row["scope"] == "private" else "public",
                    "score": 0.0,
                    "match_reasons": set(),
                    "document_count": len(documents_by_group.get(source_group_id, [])),
                },
            )
            item["score"] = max(float(item["score"]), score)
            if title_match:
                item["match_reasons"].add("title")
            if metadata_match:
                item["match_reasons"].add("metadata")
            if sparse_score > 0.0 or "sparse" in channels.get(chunk_id, []):
                item["match_reasons"].add("token")
            if semantic_match or "dense" in channels.get(chunk_id, []):
                item["match_reasons"].add("semantic")

        reason_order = ("title", "metadata", "token", "semantic")
        results = [
            {
                **item,
                "score": round(float(item["score"]), 4),
                "match_reasons": [reason for reason in reason_order if reason in item["match_reasons"]],
            }
            for item in grouped.values()
        ]
        ordered = sorted(results, key=lambda item: (-float(item["score"]), str(item["title"])))
        return ordered[:limit] if limit is not None else ordered

    def validate_active_source_group_ids(
        self,
        source_group_ids: list[str],
        farm_id: str,
        *,
        visibility: str = "public",
    ) -> tuple[list[str], list[str]]:
        allowed = {
            str(item["source_group_id"])
            for item in self.active_source_groups(farm_id, visibility=visibility)
        }
        valid: list[str] = []
        ignored: list[str] = []
        for source_group_id in dict.fromkeys(source_group_ids):
            (valid if source_group_id in allowed else ignored).append(source_group_id)
        return valid, ignored

    def resolve_selected_document_ids(
        self,
        source_ids: list[str],
        farm_id: str,
        *,
        allow_implicit_all: bool = True,
        visibility: Literal["public", "all"] = "all",
    ) -> tuple[set[str] | None, list[str], bool]:
        """Resolve document selections without allowing a caller to name another farm's source."""

        if not source_ids:
            return (None, [], visibility == "all") if allow_implicit_all else (set(), [], False)
        visible_documents = [
            document
            for document in self.list_documents(farm_id)
            if document["retrieval_state"] == "active"
            and (document["scope"] == "public" or visibility == "all")
        ]
        documents = {document["id"]: document for document in visible_documents}
        source_groups: dict[str, list[str]] = {}
        for document in visible_documents:
            source_groups.setdefault(str(document["source_group_id"]), []).append(str(document["id"]))
        selected: set[str] = set()
        ignored: list[str] = []
        include_private = False
        for source_id in source_ids:
            document = documents.get(source_id)
            grouped_document_ids = source_groups.get(source_id)
            if document:
                selected.add(source_id)
                include_private = include_private or document["scope"] == "private"
                continue
            if grouped_document_ids:
                selected.update(grouped_document_ids)
                include_private = include_private or any(
                    documents[document_id]["scope"] == "private" for document_id in grouped_document_ids
                )
                continue
            ignored.append(source_id)
        return selected, ignored, include_private

    def record_telemetry(self, farm_id: str, observed_at: str, data_origin: str, payload: dict[str, Any]) -> None:
        with self._lock, self.connection:
            self.connection.execute(
                "INSERT INTO telemetry_snapshots (id, farm_id, observed_at, data_origin, payload) VALUES (?, ?, ?, ?, ?)",
                (f"telemetry-{uuid4().hex[:12]}", farm_id, observed_at, data_origin, json.dumps(payload, ensure_ascii=False, default=str)),
            )

    def sync_qdrant_mirror(self) -> int:
        """Explicitly migrate stored vectors and synchronize the active collection."""

        with self._lock:
            documents = self.connection.execute("SELECT * FROM documents WHERE status='ready'").fetchall()
        if documents and self.embedding.state == "uninitialized":
            self.embedding.embed_query("고추냉이 지식 인덱스")
        prepared: list[tuple[sqlite3.Row, list[dict[str, Any]]]] = []
        for row in documents:
            with self._lock:
                chunks = self.connection.execute("SELECT * FROM chunks WHERE document_id=? ORDER BY ordinal", (row["id"],)).fetchall()
            stored_vectors = [json.loads(chunk["embedding"]) for chunk in chunks]
            requires_migration = row["embedding_model"] != self.embedding.active_model or any(
                len(vector) != self.embedding.vector_size for vector in stored_vectors
            )
            if requires_migration:
                stored_vectors = self.embedding.embed_passages([str(chunk["text"]) for chunk in chunks])
                with self._lock, self.connection:
                    for chunk, vector in zip(chunks, stored_vectors, strict=True):
                        self.connection.execute(
                            "UPDATE chunks SET embedding=? WHERE id=?",
                            (json.dumps(vector), chunk["id"]),
                        )
                    self.connection.execute(
                        """
                        UPDATE documents SET embedding_model=?, qdrant_vector_count=0,
                            index_backend='sqlite_fallback', updated_at=? WHERE id=?
                        """,
                        (self.embedding.active_model, utc_now_iso(), row["id"]),
                    )
            records = [
                {
                    "id": chunk["id"],
                    "ordinal": int(chunk["ordinal"]),
                    "text": chunk["text"],
                    "embedding": vector,
                }
                for chunk, vector in zip(chunks, stored_vectors, strict=True)
            ]
            prepared.append((row, records))

        if not self._ensure_qdrant():
            return 0
        synchronized = 0
        for row, records in prepared:
            document = {
                "id": row["id"],
                "title": row["display_title"] or row["title"],
                "scope": row["scope"],
                "farm_id": row["farm_id"],
                "source_kind": row["source_kind"],
                "version": row["version"],
                "source_group_id": row["source_group_id"],
                "canonical_source_id": row["canonical_source_id"],
                "content_checksum": row["content_checksum"],
                "provenance_json": row["provenance_json"],
                "source_locator": row["source_locator"],
                "crop": row["crop"],
                "cultivation_system": row["cultivation_system"],
                "evidence_class": row["evidence_class"],
                "growth_stage": row["growth_stage"],
                "issuer": row["issuer"],
                "published_year": row["published_year"],
                "source_url": row["source_url"],
            }
            count = self._qdrant_upsert(document, records)
            if count == len(records):
                synchronized += count
                with self._lock, self.connection:
                    self.connection.execute(
                        "UPDATE documents SET qdrant_vector_count=?, index_backend='qdrant', updated_at=? WHERE id=?",
                        (count, utc_now_iso(), row["id"]),
                    )
        return synchronized

    def sync_graph_mirror(self) -> int:
        """Populate FalkorDB when it becomes available after the API seed step."""

        if not self.graph.available():
            return 0
        with self._lock:
            documents = self.connection.execute("SELECT * FROM documents WHERE status='ready'").fetchall()
        synchronized = 0
        for row in documents:
            with self._lock:
                chunks = self.connection.execute("SELECT * FROM chunks WHERE document_id=? ORDER BY ordinal", (row["id"],)).fetchall()
            records = [
                {
                    "id": chunk["id"],
                    "ordinal": int(chunk["ordinal"]),
                    "text": chunk["text"],
                    "start_char": int(chunk["start_char"]),
                    "end_char": int(chunk["end_char"]),
                }
                for chunk in chunks
            ]
            document = {
                "id": row["id"],
                "title": row["display_title"] or row["title"],
                "scope": row["scope"],
                "farm_id": row["farm_id"],
                "source_kind": row["source_kind"],
                "version": row["version"],
                "source_group_id": row["source_group_id"],
                "provenance_json": row["provenance_json"],
            }
            synchronized += self.graph.upsert_document(document, records)
        return synchronized

    def readiness(self) -> dict[str, Any]:
        with self._lock:
            ready_rows = self.connection.execute("SELECT * FROM documents WHERE status='ready'").fetchall()
            eligible_rows = [
                row
                for row in ready_rows
                if row["retrieval_state"] == "active" and self._eligible_for_default_rag(row)
            ]
            eligible_ids = [str(row["id"]) for row in eligible_rows]
            placeholders = ",".join("?" for _ in eligible_ids)
            total_chunks = (
                int(
                    self.connection.execute(
                        f"SELECT COUNT(*) FROM chunks WHERE document_id IN ({placeholders})",
                        eligible_ids,
                    ).fetchone()[0]
                )
                if eligible_ids
                else 0
            )
        total_documents = len(eligible_rows)
        qdrant_vectors = sum(int(row["qdrant_vector_count"]) for row in eligible_rows)
        graph_nodes = sum(int(row["graph_node_count"]) for row in eligible_rows)
        graph_edges = sum(int(row["graph_edge_count"]) for row in eligible_rows)
        migration_pending = sum(
            str(row["embedding_model"] or "") != self.embedding.active_model for row in eligible_rows
        )
        qdrant_ready = self._qdrant_collection_available()
        graph_counts = self.graph.counts()
        graph_backend = "falkordb" if graph_counts is not None else "sqlite_chunk_term_graph"
        return {
            "status": "ready" if total_documents else "empty",
            "documents": total_documents,
            "chunks": total_chunks,
            "vectors": total_chunks,
            "qdrant_vectors": qdrant_vectors,
            "graph_nodes": graph_nodes,
            "graph_edges": graph_edges,
            "graph_backend": graph_backend,
            "sqlite_graph_nodes": graph_nodes,
            "sqlite_graph_edges": graph_edges,
            "backend": "qdrant" if qdrant_ready else "sqlite_fallback",
            "seeded": total_documents > 0,
            "embedding": self.embedding.status(),
            "embedding_migration_pending_documents": migration_pending,
        }
