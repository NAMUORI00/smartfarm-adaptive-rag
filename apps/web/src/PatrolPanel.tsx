import { useEffect, useRef, useState } from 'react'
import type { FarmId } from './types'
import { listPatrolEvents, patrolRequest } from './video-api'
import type { PatrolEvent } from './video-api'
import type { VideoRequest } from './video-session'
import { useVideoSession, useVideoValue } from './video-context'
import { AuthenticatedMedia } from './AuthenticatedMedia'
import './PatrolPanel.css'
import { PatrolBrief } from './PatrolBrief'
import { PatrolProgress } from './PatrolProgress'

const date = (value: string) => new Date(value).toLocaleString('ko-KR')
export function PatrolPanel({ farmId }: { farmId: FarmId }) {
  const session = useVideoSession()
  const [records] = useVideoValue<VideoRequest<PatrolEvent[]>>('events.catalog', { status: 'idle' })
  const [mutation] = useVideoValue<VideoRequest<PatrolEvent>>('events.mutation', { status: 'idle' })
  const [selected, setSelected] = useVideoValue<string | null>('events.selected', null)
  const [detailOpen, setDetailOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const events = records.value ?? [], current = events.find(e => e.id === selected)
  const busy = mutation.status === 'loading', error = mutation.error || records.error
  useEffect(() => { void session.run('events.catalog', signal => listPatrolEvents(farmId, signal)) }, [farmId, session])
  useEffect(() => {
    if (!detailOpen) { dialog.current?.close(); return }
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { previous?.focus() }
  }, [detailOpen])
  function change(event: PatrolEvent, operation: 'brief' | 'resolve', body: object) {
    return session.run('events.mutation', async signal => {
      const updated = await patrolRequest(farmId, `/${event.id}/${operation}`, body, signal)
      if (!signal.aborted) {
        const latest = session.read<VideoRequest<PatrolEvent[]>>('events.catalog')?.value ?? []
        session.write('events.catalog', { status: 'ready', value: [updated, ...latest.filter(e => e.id !== updated.id)] })
        setSelected(updated.id)
      }
      return updated
    }, true)
  }
  function brief(event: PatrolEvent) { return change(event, 'brief', {}) }
  function resolve(outcome: string) { if (current) return change(current, 'resolve', { outcome }) }
  return <section className="panel patrol-panel" aria-label="관제 기록">
    <header><div><small>기존 사건과 처리 이력</small><h2>관제 기록</h2></div><button disabled={busy || records.status === 'loading'} onClick={() => void session.run('events.catalog', signal => listPatrolEvents(farmId, signal), true)}>기록 새로고침</button></header>
    {records.status === 'loading' && <p role="status">관제 기록 확인 중…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="patrol-event-list">{events.map(event => <button key={event.id} className={`patrol-event ${event.status}`} onClick={() => { setSelected(event.id); setDetailOpen(true) }}><b>{event.title}</b><span>{event.camera_id} · 접수 {date(event.created_at)}</span><small>{event.status === 'resolved' ? '확인 완료' : event.status === 'reviewing' ? '현장 확인 중' : '확인 필요'} · {event.source === 'test_event' ? '검증용 기록' : '녹화 검토'}</small><strong>상황 확인 →</strong></button>)}</div>
    {records.status === 'ready' && !events.length && <p>아직 관제 기록이 없습니다.</p>}
    <dialog ref={dialog} className="patrol-dialog" aria-labelledby="patrol-title" onCancel={() => setDetailOpen(false)}>
      <header><h2 id="patrol-title">{current?.title ?? '관제 브리핑'}</h2><button onClick={() => setDetailOpen(false)}>닫기</button></header>
      {current && <><p>{current.camera_id} · 접수 {date(current.created_at)}</p><p>녹화 구간 {current.start_seconds}–{current.end_seconds}초</p><details><summary>이벤트 정보</summary><p>지정 구간에 연결한 테스트 입력입니다. 감시 영역 진입을 측정한 결과가 아닙니다.</p></details>
      <div className="video-player"><AuthenticatedMedia key={current.id} farmId={farmId} path={`/v1/video/media/${current.clip_id}`} startSeconds={current.start_seconds} endSeconds={current.end_seconds} /></div>
      <h3>AI 브리핑</h3><PatrolProgress event={current} /><PatrolBrief content={current.analysis?.answer ?? '브리핑 완료 후 확인 결과가 여기에 표시됩니다.'} />
      {current.analysis && <small>{current.analysis.decision === 'answer' ? '프레임 기반 관측' : current.analysis.decision === 'abstain' ? '근거 부족' : '분석 불가'} · 신원·출입 권한은 별도 확인</small>}
      <details><summary>근거 화면 보기</summary><div className="video-evidence">{current.analysis?.frame_urls.map(path => <AuthenticatedMedia key={path} farmId={farmId} path={path} image />)}</div></details>
      {error && <p role="alert">{error}</p>}
      {current.status !== 'resolved' && <div className="patrol-actions"><button disabled={busy} onClick={() => void brief(current)}>AI 브리핑 확인</button><button disabled={busy} onClick={() => void resolve('reviewing')}>현장 확인 중</button><button disabled={busy} onClick={() => void resolve('authorized')}>허가된 출입</button><button disabled={busy} onClick={() => void resolve('false_alarm')}>오탐</button><button disabled={busy} onClick={() => void resolve('handled')}>현장 조치 완료</button></div>}
      <h3>처리 기록</h3><ol>{current.history.map((h, i) => <li key={i}><time>{date(h.at)}</time> · {h.label === '침입 의심 시연 이벤트 발생 · 자동 탐지 아님' ? '검증용 접근 확인 요청 접수 · 자동 탐지 아님' : h.label.replace('AI 화면 확인: answer', 'AI 브리핑 완료').replace('AI 화면 확인: abstain', '영상 근거 부족').replace('AI 화면 확인: unavailable', '영상 분석 연결 확인 필요')}</li>)}</ol><p>사람이 화면에서 사라져도 확인 전에는 경고를 유지합니다. 자동 신고나 장치 제어는 하지 않습니다.</p></>}
    </dialog>
  </section>
}
