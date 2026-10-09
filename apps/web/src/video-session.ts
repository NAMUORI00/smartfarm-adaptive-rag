export type VideoRequest<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; value?: T; error?: string }

/** One farm's video work survives screen changes; responses from retired requests cannot publish. */
export class VideoSession {
  private values = new Map<string, unknown>()
  private listeners = new Set<() => void>()
  private pending = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  read<T>(key: string): T | undefined { return this.values.get(key) as T | undefined }
  write<T>(key: string, value: T) { this.values.set(key, value); this.listeners.forEach(listener => listener()) }
  cancel(key: string) {
    this.pending.get(key)?.controller.abort()
    this.pending.delete(key)
    this.write<VideoRequest<unknown>>(key, { status: 'idle' })
  }
  stop() { for (const key of this.pending.keys()) this.cancel(key) }
  run<T>(key: string, task: (signal: AbortSignal) => Promise<T>, refresh = false): Promise<void> {
    const active = this.pending.get(key)
    if (active) return active.promise
    if (!refresh && this.read<VideoRequest<T>>(key)?.status === 'ready') return Promise.resolve()
    const controller = new AbortController()
    this.write<VideoRequest<T>>(key, { status: 'loading' })
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('영상 응답 확인 시간이 지났습니다.'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timeout = setTimeout(() => controller.abort(), 120_000)
    const promise = Promise.race([Promise.resolve().then(() => task(controller.signal)), aborted]).then(value => {
      if (this.pending.get(key)?.controller === controller && !controller.signal.aborted) this.write(key, { status: 'ready', value })
    }).catch(error => {
      if (this.pending.get(key)?.controller === controller) this.write(key, { status: 'error', error: controller.signal.aborted ? '응답을 확인하지 못했습니다. 다시 확인해 주세요.' : error instanceof Error ? error.message : '영상 연결을 확인해 주세요.' })
    }).finally(() => {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      if (this.pending.get(key)?.controller === controller) this.pending.delete(key)
    })
    this.pending.set(key, { controller, promise })
    return promise
  }
}
