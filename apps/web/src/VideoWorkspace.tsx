import type { FarmId } from './types'
import { ResearchVideo } from './ResearchVideo'
import { VideoObservation } from './VideoObservation'
import { useVideoValue } from './video-context'

export function VideoWorkspace({ farmId }: { farmId: FarmId }) {
  const [mode, setMode] = useVideoValue<'research' | 'recording'>('workspace.mode', 'research')
  return <section aria-label="영상 관제" className="video-operations">
    <div className="video-mode" role="group" aria-label="영상 확인 방식">
      <button aria-pressed={mode === 'research'} onClick={() => setMode('research')}>근거 기반 관제</button>
      <button aria-pressed={mode === 'recording'} onClick={() => setMode('recording')}>녹화 구간 확인</button>
    </div>
    {mode === 'research' ? <ResearchVideo farmId={farmId} /> : <VideoObservation farmId={farmId} />}
  </section>
}
