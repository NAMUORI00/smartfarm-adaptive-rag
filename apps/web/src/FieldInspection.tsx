import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { DashboardSnapshot } from './types'
import './FieldInspection.css'

export function FieldInspection({ open, onClose, onOpen, zone, snapshot, alertId, onAdvisor, onDevices, children }: {
  open: boolean; onClose: () => void; onOpen: () => void; zone: string;
  snapshot: DashboardSnapshot; alertId: string | null; onAdvisor: () => void;
  onDevices: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const label = zone === 'all' ? '전체 구역' : zone === 'zone-a' ? '1구역' : '2구역'
  const alerts = snapshot.alerts.filter(a => a.status !== 'resolved' && (zone === 'all' || !a.zoneId || a.zoneId === zone))
  const alert = alerts.find(a => a.id === alertId) ?? alerts[0]
  const metrics = snapshot.metrics.filter(m => zone === 'all' || m.zoneId === zone)
  const devices = snapshot.actuators.filter(a => zone === 'all' || a.zoneId === zone)
  const priorityMetrics = metrics.filter(m => m.status !== 'normal' || ['재배실 온도', '근권 온도', '상대 습도'].includes(m.label))
  const extraMetrics = metrics.filter(m => !priorityMetrics.includes(m))
  const zoneName = (id?: string | null) => id === 'zone-a' ? '1구역' : id === 'zone-b' ? '2구역' : '공용'
  const renderMetrics = (items: typeof metrics) => <div className="field-metrics">{items.map(m => <article key={`${m.zoneId}:${m.key}`}><span>{zone === 'all' ? `${zoneName(m.zoneId)} · ` : ''}{m.label}</span><strong>{m.value} <small>{m.unit}</small></strong>{m.status !== 'normal' && <em>{m.status === 'critical' ? '위험' : '주의'}</em>}</article>)}</div>
  const stateLabel = (value: string) => value.replace(/^on$/, '켜짐').replace(/^off$/, '꺼짐').replace(/^ready$/, '준비됨').replace(/^completed$/, '완료').replace(' open', ' 열림').replace(' closed', ' 닫힘')
  useEffect(() => {
    if (!open) { dialog.current?.close(); return }
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [open])
  return <>
    <section className="panel field-entry" aria-label="현장 확인">
      <div><span className="field-eyebrow">{label} · 현장 확인</span><h2>{alerts.length ? `확인이 필요한 경보 ${alerts.length}건` : '센서와 장치 상태 함께 보기'}</h2><p>상태를 확인하고 AI 조언 또는 직접 조절로 이어갑니다.</p></div>
      <button className="secondary-button" onClick={onOpen}>현장 확인</button>
    </section>
    <dialog ref={dialog} className="field-inspection" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} aria-labelledby="field-inspection-title">
      <div className="field-inspection-inner">
        <header className="field-inspection-header"><div><span className="field-eyebrow">{label}</span><h2 id="field-inspection-title">현장 확인</h2></div><button className="secondary-button" onClick={onClose} autoFocus aria-label="현장 확인 닫기">닫기</button></header>
        <div className="field-inspection-body">
          <section className="field-situation"><span className="field-eyebrow">현재 상황</span><h3>{alert?.title ?? '현재 대응할 경보가 없습니다'}</h3><p>{alert?.detail ?? '장치 실행 결과와 환경 회복 여부는 별도로 확인하세요.'}</p><small>센서 수신 {snapshot.updatedAt}</small></section>
          <section><h3>주요 센서 관측</h3>{renderMetrics(priorityMetrics)}{!!extraMetrics.length && <details><summary>나머지 센서 {extraMetrics.length}개 보기</summary>{renderMetrics(extraMetrics)}</details>}</section>
          <section><h3>장치 상태</h3><p className="field-note">표시된 상태와 환경 개선 여부는 다를 수 있습니다.</p><details><summary>연결된 장치 {devices.length}개 확인</summary><dl className="field-devices">{devices.map(d => <div key={`${d.zoneId}:${d.key}`}><dt>{zone === 'all' ? `${zoneName(d.zoneId)} · ` : ''}{d.label}</dt><dd>{stateLabel(d.state)}</dd></div>)}</dl></details>{!devices.length && <p>이 구역에 연결된 장치가 없습니다.</p>}</section>
          <section className="field-camera-empty"><h3>현장 영상</h3><p>이 구역에 연결된 실제 농장 영상이 없습니다.</p><small>아래 화면 예시와 공개 영상은 현재 센서 상황의 근거가 아닙니다.</small></section>
          {open && children}
        </div>
        <footer className="field-inspection-footer"><button className="secondary-button" onClick={() => { onClose(); onDevices() }}>장치 직접 조절</button><button className="primary-button" onClick={() => { onClose(); onAdvisor() }}>AI와 이어서 확인</button></footer>
      </div>
    </dialog>
  </>
}
