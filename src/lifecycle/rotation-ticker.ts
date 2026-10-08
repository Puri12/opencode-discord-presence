export interface RotationTickerOptions {
  getRotationIndex: () => number
  setRotationIndex: (index: number) => void
  countCards: () => number
  pushPresence: () => Promise<void>
  onError: (error: unknown) => void
}

export interface RotationTicker {
  tick: () => Promise<void>
}

export function createRotationTicker(opts: RotationTickerOptions): RotationTicker {
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      opts.setRotationIndex((opts.getRotationIndex() + 1) % opts.countCards())
      await opts.pushPresence()
    } catch (error) {
      opts.onError(error)
    } finally {
      inFlight = false
    }
  }

  return { tick }
}
