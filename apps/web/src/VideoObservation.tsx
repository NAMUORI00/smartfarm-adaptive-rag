import { AuthenticatedMedia } from './AuthenticatedMedia'
import { useEffect, useRef } from 'react'
import { useVideoSession, useVideoValue } from './video-context'
import type { VideoRequest } from './video-session'
import type { FarmId } from './types'
import { analyzeVideo, getVideoCatalog } from './video-api'
import type { VideoAnalysis, VideoCatalog } from './video-api'
import { videoSegment } from './video-segment'
import { patrolChecks, patrolBoundary } from './video-patrol'
import './VideoObservation.css'

export function VideoObservation({ farmId }: { farmId: FarmId }) {
  const session = useVideoSession()
  const [catalogState] = useVideoValue<VideoRequest<VideoCatalog>>('recording.catalog', { status: 'idle' })
  const [analysis] = useVideoValue<VideoRequest<VideoAnalysis>>('recording.analysis', { status: 'idle' })
  const [selectedClip, setClipId] = useVideoValue('recording.clip', '')
  const [question, setQuestion] = useVideoValue('recording.question', '')
  const [checkId, setCheckId] = useVideoValue('recording.check', '')
  const [playback, setPlayback] = useVideoValue('recording.playback', 0)
  const [windowSeconds, setWindowSeconds] = useVideoValue('recording.window', 10)
  const [validationError, setError] = useVideoValue('recording.validation', '')
  const videoRef = useRef<HTMLVideoElement>(null)
  const catalog = catalogState.value, result = analysis.value, busy = analysis.status === 'loading'
  const error = validationError || analysis.error || catalogState.error
  const clipId = selectedClip || catalog?.clips[0]?.id || ''
  const clip = catalog?.clips.find(item => item.id === clipId)
  useEffect(() => { void session.run('recording.catalog', signal => getVideoCatalog(farmId, signal)) }, [farmId, session])
  const segment = videoSegment(playback, clip?.duration_seconds ?? 0, windowSeconds)
  function submit() {
    if (!clip || busy || !question.trim()) return
    const frozen = videoSegment(videoRef.current?.currentTime ?? playback, clip.duration_seconds, windowSeconds)
    if (frozen.end_seconds <= frozen.start_seconds) { setError('영상을 재생하거나 시간을 이동한 뒤 질문해 주세요.'); return }
    videoRef.current?.pause(); setError('')
    void session.run('recording.analysis', signal => analyzeVideo(farmId, { clip_id: clip.id, question: `${question.trim()}\n${patrolBoundary}`, ...frozen }, signal), true)
  }
  function clearResult() { session.cancel('recording.analysis') }
  function selectClip(id: string) {
    clearResult(); setClipId(id); setPlayback(0); setError('')
  }
  return <section className="panel video-observation" aria-label="영상 관제 녹화 영상">
    <div className="panel-head"><div><h2>시설·출입 관제 <span>녹화 확인</span></h2><p>출입구·시설 주변·작업 통로에서 보이는 상황을 근거 화면과 함께 확인합니다.</p></div><button className="secondary-button" disabled={busy} onClick={() => void session.run('recording.catalog', signal => getVideoCatalog(farmId, signal), true)}>목록 새로고침</button></div>
    <p className="patrol-source-note">현재 영상은 MEVA 공개 관제 자료입니다. 실제 농장 영상이나 실시간 경보가 아닙니다.</p>
    <div className="patrol-checks" aria-label="관제 확인 목적">{patrolChecks.map(check => <button key={check.id} type="button" disabled={busy} aria-pressed={checkId === check.id} onClick={() => { setCheckId(check.id); setQuestion(check.question); clearResult() }}><b>{check.title}</b><span>{check.purpose}</span></button>)}</div>
    <p className="patrol-instructions">1. 확인 목적 선택 → 2. 영상 재생 위치 선택 → 3. 구간 확인<br />출입 권한과 실제 대응 여부는 담당자가 확인합니다. 자동 신고·장치 제어는 실행하지 않습니다.</p>
    {error && <p role="alert" className="video-error">{error}</p>}
    {!catalog && !error && <p role="status">영상 목록 확인 중…</p>}
    {catalog && (!catalog.enabled || !catalog.clips.length) && <div className="video-empty"><b>등록된 녹화 영상이 없습니다</b><p>{catalog.reason || '영상 데이터와 분석 모델을 연결하면 녹화 영상의 지정 구간을 확인할 수 있습니다.'}</p><small>농장 실시간 영상이나 임의의 대체 영상을 표시하지 않습니다.</small></div>}
    {catalog?.enabled && clip && <div className="video-workspace">
      <div className="video-player"><label>카메라 · 녹화 영상<select value={clipId} onChange={event => selectClip(event.target.value)}>{catalog.clips.map(item => <option key={item.id} value={item.id}>{item.camera_id} · {item.title}</option>)}</select></label><AuthenticatedMedia key={`${farmId}:${clip.id}`} farmId={farmId} path={clip.media_url} videoRef={videoRef} startSeconds={playback} onTime={setPlayback} /><small>{clip.source_label} · 사건 {clip.event_id}</small></div>
      <div className="video-question"><h3>확인할 내용</h3><p>선택 구간의 화면 3장을 확인합니다. 화면 사이의 움직임 전체를 추적하는 기능은 아닙니다.</p><label>확인 범위<select value={windowSeconds} disabled={busy} onChange={event => setWindowSeconds(Number(event.target.value))}><option value={5}>직전 5초</option><option value={10}>직전 10초</option><option value={30}>직전 30초</option></select></label><output>{segment.start_seconds.toFixed(1)}–{segment.end_seconds.toFixed(1)}초</output><label>관제 질문<textarea value={question} disabled={busy} onChange={event => { setQuestion(event.target.value); setCheckId(''); clearResult() }} maxLength={1700} placeholder="예: 출입구 주변에 사람이나 차량이 보이나요?" /></label><button className="primary-button" disabled={busy || !question.trim() || segment.end_seconds <= segment.start_seconds} onClick={() => void submit()}>{busy ? '근거 화면 확인 중…' : '이 구간 확인하기'}</button>{segment.end_seconds <= segment.start_seconds && <small>재생 막대를 이동하면 확인할 구간이 선택됩니다.</small>}</div>
      {result && <article className="video-result" aria-live="polite"><h3>{result.decision === 'answer' ? 'AI 관제 확인 결과' : result.decision === 'abstain' ? '화면만으로 확인하기 어렵습니다' : '영상 확인을 완료하지 못했습니다'}</h3><p>{result.answer}</p><button className="secondary-button" onClick={() => { if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = result.start_seconds } }}>근거 구간 다시 보기 · {result.start_seconds.toFixed(1)}–{result.end_seconds.toFixed(1)}초</button><div className="video-evidence">{result.frame_urls.map((path, index) => <AuthenticatedMedia key={`${path}:${index}`} farmId={farmId} path={path} image />)}</div><small>담당자 확인: 출입 기록과 현장 상황을 대조하세요. 보이지 않는다고 이상이 없다고 판단할 수 없습니다.</small></article>}
    </div>}
  </section>
}
