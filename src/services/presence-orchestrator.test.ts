import { describe, expect, test } from "bun:test"
import { PresenceOrchestrator } from "./presence-orchestrator"

describe("PresenceOrchestrator", () => {
  test("markBusy from a fresh state reports wasIdle=true and records identity", () => {
    const o = new PresenceOrchestrator()
    const result = o.markBusy("ses_main", "Prometheus", "claude-sonnet-4")
    expect(result.wasIdle).toBe(true)
    expect(result.lastAgent).toBe("Prometheus")
    expect(result.lastModel).toBe("claude-sonnet-4")
    expect(o.isBusy()).toBe(true)
    expect(o.getBusyCount()).toBe(1)
  })

  test("second markBusy on different session reports wasIdle=false", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_a", "A")
    const second = o.markBusy("ses_b", "B")
    expect(second.wasIdle).toBe(false)
    expect(second.lastAgent).toBe("B")
    expect(o.getBusyCount()).toBe(2)
  })

  test("sub-agent markBusy overwrites lastAgent (last writer wins)", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_main", "Prometheus", "claude-sonnet-4")
    o.markBusy("ses_sub", "planner", "claude-haiku-4")
    expect(o.getLastAgent()).toBe("planner")
    expect(o.getLastModel()).toBe("claude-haiku-4")
    expect(o.getBusyCount()).toBe(2)
  })

  test("markBusy without agent preserves existing lastAgent (status:busy keep-alive)", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_main", "Prometheus", "claude-sonnet-4")
    const result = o.markBusy("ses_main")
    expect(result.lastAgent).toBe("Prometheus")
    expect(result.lastModel).toBe("claude-sonnet-4")
  })

  test("markBusy with empty model string sets model (explicit clear)", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_main", "Prometheus", "claude-sonnet-4")
    o.markBusy("ses_main", "Prometheus", "")
    expect(o.getLastModel()).toBe("")
  })

  test("markIdle while another session still busy reports nowAllIdle=false", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_a", "A")
    o.markBusy("ses_b", "B")
    const result = o.markIdle("ses_a")
    expect(result.nowAllIdle).toBe(false)
    expect(o.getBusyCount()).toBe(1)
  })

  test("markIdle on the last busy session reports nowAllIdle=true with lastAgent retained", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_main", "Prometheus")
    o.markBusy("ses_sub", "planner")
    o.markIdle("ses_main")
    const result = o.markIdle("ses_sub")
    expect(result.nowAllIdle).toBe(true)
    expect(result.lastAgent).toBe("planner")
    expect(o.isBusy()).toBe(false)
  })

  test("markIdle for unknown session is no-op (nowAllIdle=false even when empty)", () => {
    const o = new PresenceOrchestrator()
    const result = o.markIdle("ses_never_busy")
    expect(result.nowAllIdle).toBe(false)
  })

  test("markIdle followed by markBusy for same session restarts cycle", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_main", "A")
    o.markIdle("ses_main")
    const result = o.markBusy("ses_main", "B")
    expect(result.wasIdle).toBe(true)
    expect(result.lastAgent).toBe("B")
  })

  test("empty sessionID is ignored", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("", "Ghost")
    expect(o.getBusyCount()).toBe(0)
    expect(o.getLastAgent()).toBe("Ghost")
    const idleResult = o.markIdle("")
    expect(idleResult.nowAllIdle).toBe(false)
  })

  test("reset clears all state", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_a", "A", "m")
    o.markBusy("ses_b", "B", "m")
    o.reset()
    expect(o.getBusyCount()).toBe(0)
    expect(o.getLastAgent()).toBe("")
    expect(o.getLastModel()).toBe("")
  })

  test("rapid main → sub → main keeps the last writer", () => {
    const o = new PresenceOrchestrator()
    o.markBusy("ses_main", "Sisyphus")
    o.markBusy("ses_sub", "explore")
    o.markBusy("ses_main", "Sisyphus")
    expect(o.getLastAgent()).toBe("Sisyphus")
    expect(o.getBusyCount()).toBe(2)
  })
})
