/** Shared by every advisor entry point in this browser, not by farm devices. */
export class AdvisorRequests {
  private active = new Set<string>()
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  busy = (farmId: string) => this.active.has(farmId)
  async run<T>(farmId: string, request: () => Promise<T>): Promise<T> {
    if (this.active.has(farmId)) throw new Error('진행 중인 자문이 있습니다. 답변 확인 후 다시 질문해 주세요.')
    this.active.add(farmId); this.listeners.forEach(listener => listener())
    try { return await request() }
    finally { this.active.delete(farmId); this.listeners.forEach(listener => listener()) }
  }
}
export const advisorRequests = new AdvisorRequests()
