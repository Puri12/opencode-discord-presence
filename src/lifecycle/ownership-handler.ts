import { join } from "node:path"
import type { DiscordRPCService } from "../services/discord-rpc.js"

export function sanitizeForFilename(raw: string, fallback: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_")
  return sanitized || fallback
}

/**
 * Builds the per-machine, per-Discord-app instance election directory.
 * Hostname segregation keeps shared-HOME setups (NFS, SMB, Dropbox) from
 * making one machine's CLIs suppress another's. ClientId segregation keeps
 * users running multiple Discord application IDs from cross-contaminating.
 */
export function buildInstancesDir(home: string, host: string, clientId: string): string {
  const safeHost = sanitizeForFilename(host, "unknown-host")
  const safeClient = sanitizeForFilename(clientId, "default")
  return join(home, ".opencode-discord-presence", "instances", safeHost, safeClient)
}

/**
 * Settle delay between gaining ownership and calling `rpc.connect()`. Must
 * exceed the coordinator's tick interval (default 1000ms in instance-coordinator)
 * so the previous owner has had at least one tick to discover its ownership
 * loss and run its `rpc.clear()` + `rpc.disconnect()` before the new owner
 * contends for Discord's IPC socket. Without this slack, a fast handoff
 * leaves a brief window where A.clear() can erase B's freshly-pushed presence.
 */
export const DEFAULT_OWNER_SETTLE_MS = 1200

export interface OwnershipHandlerOptions {
  rpc: Pick<DiscordRPCService, "connect" | "disconnect" | "clear">
  pushPresence: () => Promise<void>
  startRotationTimer: () => void
  stopRotationTimer: () => void
  isStillOwner: () => boolean
  settleMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface OwnershipHandler {
  onOwnership: (isOwner: boolean) => void
  cancelPending: () => void
}

/**
 * Builds an ownership-change handler with a settle delay before connecting.
 * Gaining ownership schedules a connect after `settleMs`; losing it cancels
 * the pending connect and disconnects immediately. The settle window lets
 * the previous owner finish its disconnect before the new owner contends
 * for Discord's single IPC socket — without it, rapid ownership flips during
 * concurrent CLI startup cause connect/disconnect churn and IPC throttling.
 */
export function createOwnershipHandler(opts: OwnershipHandlerOptions): OwnershipHandler {
  const settleMs = opts.settleMs ?? DEFAULT_OWNER_SETTLE_MS
  const setT = opts.setTimeoutImpl ?? setTimeout
  const clearT = opts.clearTimeoutImpl ?? clearTimeout
  let pending: ReturnType<typeof setTimeout> | null = null

  const cancelPending = () => {
    if (pending) {
      clearT(pending)
      pending = null
    }
  }

  const onOwnership = (isOwner: boolean): void => {
    cancelPending()
    if (isOwner) {
      pending = setT(() => {
        pending = null
        if (!opts.isStillOwner()) return
        opts.startRotationTimer()
        void opts.pushPresence()
        opts.rpc.connect().catch(() => {})
      }, settleMs)
      pending?.unref?.()
    } else {
      opts.stopRotationTimer()
      void opts.rpc.clear()
      void opts.rpc.disconnect()
    }
  }

  return { onOwnership, cancelPending }
}
