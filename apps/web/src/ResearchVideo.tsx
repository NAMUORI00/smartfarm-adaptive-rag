import { useEffect } from 'react';
import type { FarmId } from './types';
import { AuthenticatedMedia } from './AuthenticatedMedia';
import { analyzeResearchVideo, getResearchVideoCatalog } from './video-api';
import type { ResearchVideoCatalog, ResearchVideoAnalysis } from './video-api';
import { useVideoSession, useVideoValue } from './video-context';
import type { VideoRequest } from './video-session';

export function ResearchVideo({ farmId, cameraIds }: { farmId: FarmId; cameraIds?: string[] }) {
  const session = useVideoSession();
  const analysisKey = cameraIds ? `research.linked.${[...cameraIds].sort().join(',')}` : 'research.analysis';
  const [catalogState] = useVideoValue<VideoRequest<ResearchVideoCatalog>>('research.catalog', { status: 'idle' });
  const [analysis] = useVideoValue<VideoRequest<ResearchVideoAnalysis>>(analysisKey, { status: 'idle' });
  const [selectedId, setId] = useVideoValue('research.selected', '');
  const original = catalogState.value;
  const catalog = original && cameraIds ? { ...original, evidence_sets: original.evidence_sets.filter(s => s.camera_ids.length > 0 && s.camera_ids.every(id => cameraIds.includes(id))) } : original;
  const id = catalog?.evidence_sets.some(s => s.id === selectedId) ? selectedId : catalog?.evidence_sets[0]?.id || '';
  const result = analysis.value, busy = analysis.status === 'loading';
  const canAnalyze = catalog?.inference_ready ?? catalog?.ready ?? false;
  const error = analysis.error || catalogState.error;
  useEffect(() => { void session.run('research.catalog', signal => getResearchVideoCatalog(farmId, signal)); }, [farmId, session]);
  const sample = catalog?.evidence_sets.find(s => s.id === id);
  function analyze() {
    if (sample && canAnalyze) void session.run(analysisKey, signal => analyzeResearchVideo(farmId, sample, signal), true);
  }
  return (
    <section className="farm-research-video">
      <h3>영상 관제 확인</h3>
      {catalogState.status === 'loading' && <p role="status">영상 연결 확인 중…</p>}
      <button disabled={busy || catalogState.status === 'loading'} onClick={() => { session.cancel(analysisKey); void session.run('research.catalog', signal => getResearchVideoCatalog(farmId, signal), true); }}>연결 다시 확인</button>
      {catalog && !catalog.ready && (
        <p role="status">
          {canAnalyze ? '영상을 분석하고 근거 화면을 확인할 수 있습니다. 답변 공개 기준은 확인 중이며, 기준이 확인되기 전에는 결론을 표시하지 않습니다.' : '영상 판단 연결을 확인하고 있습니다. 확인되지 않은 결과는 표시하지 않습니다.'}
        </p>
      )}
      {sample && (
        <>
          <label>
            확인할 영상
            <select
              value={id}
              disabled={busy}
              onChange={(e) => {
                setId(e.target.value);
                session.cancel(analysisKey);
              }}
            >
              {catalog?.evidence_sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <p>
            {sample.source_label} · {sample.recorded_at ?? "촬영 시각 미확인"}
          </p>
          <p>
            <b>확인할 질문</b>
            <br />
            {sample.question}
          </p>
          <button
            className="farm-primary"
            disabled={busy || !canAnalyze}
            onClick={() => void analyze()}
          >
            {busy ? "영상 근거를 확인하고 있습니다…" : "영상에서 확인하기"}
          </button>
        </>
      )}
      {catalog && !catalog.evidence_sets.length && (
        <p>등록된 연구 영상이 없습니다.</p>
      )}
      {result && (
        <article aria-live="polite">
          <h3>
            {result.release_hold_reason || result.stages.release?.hold_reason === 'policy_not_validated' || result.stages.release?.hold_reason === 'confidence_below_threshold'
              ? "답변 공개를 보류했습니다"
              : result.decision === "answer"
              ? "영상 확인 결과"
              : result.decision === "abstain"
                ? "화면만으로 확인하기 어렵습니다"
                : "영상 확인을 완료하지 못했습니다"}
          </h3>
          <p>{result.answer}</p>
          {result.frame_urls.map((path, index) => (
            <figure key={path}>
              <figcaption>{index === 0 ? '선택된 카메라의 전체 화면' : '판단에 사용한 확대 영역'}</figcaption>
              <AuthenticatedMedia farmId={farmId} path={path} image />
            </figure>
          ))}
          <details>
            <summary>판단 과정</summary>
            <p>모델 처리: {result.decision === 'unavailable' ? '확인 실패' : '완료'}</p>
            <p>모델 판단: {result.stages.answer?.decision === 'answer' ? '응답 생성' : result.stages.answer?.decision === 'abstain' ? '근거 부족으로 판단 보류' : '미확인'}</p>
            <p>답변 공개: {result.stages.release?.released ? '공개' : '보류'}</p>
            <small>선택 시점: {result.stages.selection?.view_id ?? '미확인'} · 정책: {result.stages.release?.policy_version ?? '미확인'}</small>
          </details>
        </article>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>연결 상세</summary>
        <p>
          공개 연구 영상의 고정 질문으로 연구 모델 연결을 확인합니다. 농장 영상
          판단과 구분합니다.
        </p>
        {catalog?.reasons.map((r, i) => (
          <p key={i}>{r}</p>
        ))}
      </details>
    </section>
  );
}
