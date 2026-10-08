export const DEFAULT_RECAP_DELAY_MS = 30_000

export interface RecapSchedulerOptions {
  clearRecapState: () => void
  delayMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface RecapScheduler {
  schedule: () => void
  flushNow: () => void
  cancel: () => void
}

/**
 * Owns the lifecycle of the post-session recap card. The recap is purely a
 * visual state on the snapshot — the RPC lifecycle stays tied to ownership,
 * not the recap. After `delayMs`, the recap state is cleared so rotation no
 * longer surfaces the recap card. `flushNow()` clears immediately (used by
 * any user activity that should resume normal presence); `cancel()` drops
 * the pending clear without running it (used on dispose).
 */
export function createRecapScheduler(opts: RecapSchedulerOptions): RecapScheduler {
  const setT = opts.setTimeoutImpl ?? setTimeout
  const clearT = opts.clearTimeoutImpl ?? clearTimeout
  const delayMs = opts.delayMs ?? DEFAULT_RECAP_DELAY_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false

  const runOnce = (): void => {
    if (!pending) return
    pending = false
    opts.clearRecapState()
  }

  const schedule = (): void => {
    if (timer) clearT(timer)
    pending = true
    timer = setT(() => {
      timer = null
      runOnce()
    }, delayMs)
    timer?.unref?.()
  }

  const flushNow = (): void => {
    if (timer) {
      clearT(timer)
      timer = null
    }
    runOnce()
  }

  const cancel = (): void => {
    if (timer) {
      clearT(timer)
      timer = null
    }
    pending = false
  }

  return { schedule, flushNow, cancel }
}
