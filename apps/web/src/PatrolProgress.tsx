import type { PatrolEvent } from './video-api'

const phases = [['preparing', '요청 접수'], ['extracting', '영상 확인'], ['analyzing', 'AI 분석'], ['formatting', '브리핑 정리'], ['completed', '완료']]
export function PatrolProgress({ event }: { event?: PatrolEvent }) {
  const progress = event?.progress
  if (!progress) return null
  const failed = ['failed', 'interrupted'].includes(progress.phase)
  const current = phases.findIndex(([id]) => id === progress.phase)
  const reached = new Set(progress.steps.map(s => s.phase))
  return <div className="patrol-progress" role="status" aria-live="polite"><strong>{failed ? (progress.phase === 'interrupted' ? '분석 중단 · 다시 요청해 주세요' : '분석 실패 · 경고는 유지됩니다') : progress.phase === 'completed' ? '브리핑 확인 완료' : `${phases[current]?.[1] ?? '처리'} 중`}</strong><ol>{phases.map(([id, label], i) => <li key={id} className={!failed && current === i ? 'active' : reached.has(id) ? 'done' : ''}>{label}<span>{!failed && current === i ? (id === 'completed' ? '완료' : '진행 중') : reached.has(id) ? '처리됨' : '대기'}</span></li>)}</ol><small>서버 처리 상태 · {new Date(progress.updated_at).toLocaleTimeString('ko-KR')}</small></div>
}
