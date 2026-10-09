import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, SetStateAction } from 'react'
import { VideoSession } from './video-session'

const VideoContext = createContext<VideoSession | null>(null)
export function VideoSessionProvider({ children }: { children: ReactNode }) {
  const parent = useContext(VideoContext)
  const [session] = useState(() => new VideoSession())
  useEffect(() => () => { if (!parent) session.stop(); }, [session, parent])
  return <VideoContext.Provider value={parent ?? session}>{children}</VideoContext.Provider>
}
export function useVideoSession() {
  const session = useContext(VideoContext)
  if (!session) throw new Error('Video session provider is required')
  return session
}
export function useVideoValue<T>(key: string, initial: T): [T, (next: SetStateAction<T>) => void] {
  const session = useVideoSession(), fallback = useRef(initial)
  const value = useSyncExternalStore(session.subscribe, () => session.read<T>(key) ?? fallback.current)
  return [value, next => session.write(key, typeof next === 'function' ? (next as (current: T) => T)(session.read<T>(key) ?? fallback.current) : next)]
}
