import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { FarmId } from './types'
import { loadVideoMedia } from './video-api'

export function AuthenticatedMedia({ farmId, path, image = false, videoRef, onTime, startSeconds = 0, endSeconds }: { farmId: FarmId; path: string; image?: boolean; videoRef?: RefObject<HTMLVideoElement | null>; onTime?: (seconds: number) => void; startSeconds?: number; endSeconds?: number }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setUrl(''); setFailed(false)
    void loadVideoMedia(farmId, path, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [farmId, path])
  if (failed) return <p role="status">영상 근거를 불러오지 못했습니다.</p>
  if (!url) return <p role="status">미디어 불러오는 중…</p>
  return image ? <img src={url} alt="분석에 사용한 녹화 영상 프레임" /> : <video ref={videoRef} controls preload="metadata" src={url} onLoadedMetadata={event => { event.currentTarget.currentTime = startSeconds }} onError={() => setFailed(true)} onTimeUpdate={event => { if (endSeconds !== undefined && event.currentTarget.currentTime >= endSeconds) event.currentTarget.pause(); onTime?.(event.currentTarget.currentTime) }} />
}
