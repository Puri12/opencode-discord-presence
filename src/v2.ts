/**
 * OpenCode V2 adapter for opencode-discord-presence.
 *
 * OpenCode V2 (>= 2.0.x) loads plugins through `@opencode/plugin` and expects a
 * default export shaped as `{ id, setup }` (see `Plugin.define`). The V2 plugin
 * `Context` is very different from the legacy V1 `PluginInput`:
 *
 *   - There is NO raw `client` object. We provide a thin shim that maps
 *     `client.session.get` to `ctx.session.get` and turns `client.app.log`
 *     into a best-effort debug log.
 *   - V1 hooks are returned by string key; V2 registers each hook on the domain
 *     that owns the operation (`ctx.session.hook`, `ctx.tool.hook`).
 *   - Events arrive from `ctx.event.subscribe()` as `{ type, data, ... }`
 *     whereas the V1 handler consumes `{ type, properties }`. We translate V2
 *     events into the V1 shape so the battle-tested presence engine in
 *     `plugin.ts` can be reused verbatim.
 *
 * The V1 implementation is preserved untouched and re-exported as `server` on
 * the package entry point so OpenCode V1 (1.18.29+) keeps working too.
 *
 * Types are modelled locally instead of importing `@opencode/plugin`: V2's
 * `Plugin.define` is an identity function, so a plain `{ id, setup }` object is
 * a valid definition and the published package needs no extra runtime
 * dependency.
 */
import { OpenCodeDiscordPresence } from "./plugin.js"

/** Stable plugin identifier reported to OpenCode V2. */
export const PLUGIN_ID = "opencode-discord-presence"

// ── V2 structural types (only the members this adapter consumes) ─────────────

interface V2Registration {
  dispose: () => Promise<void>
}

interface V2EventEnvelope {
  id?: string
  created?: number
  type: string
  data?: Record<string, unknown>
  location?: { directory?: string }
}

interface V2SessionInfo {
  id?: string
  parentID?: string | null
  agent?: string
  model?: { id?: string; providerID?: string }
}

interface V2PromptEvent {
  sessionID: string
  messageID?: string
}

interface V2ToolEvent {
  tool: string
  sessionID: string
  id: string
  input?: unknown
}

export interface V2Context {
  location: {
    directory: string
    project?: { id?: string; directory?: string; canonical?: string }
  }
  session: {
    get(input: { sessionID: string }): Promise<V2SessionInfo>
    hook(
      name: "prompt",
      callback: (event: V2PromptEvent) => Promise<void> | void,
    ): Promise<V2Registration>
  }
  tool: {
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: V2ToolEvent) => Promise<void> | void,
    ): Promise<V2Registration>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2EventEnvelope>
  }
}

type V1Handlers = Awaited<ReturnType<typeof OpenCodeDiscordPresence>>

interface SessionIdentity {
  agent?: string
  model?: string
  providerID?: string
}

/** V1 event shape the legacy `event` handler consumes. */
interface V1TranslatedEvent {
  type: string
  properties: Record<string, unknown>
}

// ── Coercion helpers ────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

// ── Client shim ─────────────────────────────────────────────────────────────

/** Build a V1-compatible `client` shim backed by the V2 context. */
export function createClientShim(ctx: V2Context, debug = false) {
  return {
    session: {
      get: async (input: { path?: { id?: string }; sessionID?: string }) => {
        const sessionID = input?.path?.id ?? input?.sessionID
        if (!sessionID) {
          throw new Error("session.get: sessionID is required")
        }
        const info = await ctx.session.get({ sessionID })
        // The V1 SessionTracker reads `response.data ?? response`, so wrapping
        // the session record mirrors the SDK response shape it expects.
        return { data: info }
      },
    },
    app: {
      // OpenCode V2 exposes no plugin-facing log API. Keep the method present so
      // the shared engine's diagnostics path does not throw; surface the message
      // only when the user explicitly opted into debug logging.
      log: async (input: { body?: { message?: string } }) => {
        const message = input?.body?.message
        if (debug && message) {
          console.log(`[discord-presence] ${message}`)
        }
      },
    },
  }
}

// ── Event translation (V2 -> V1) ────────────────────────────────────────────

/**
 * Translate a V2 event envelope into the V1 `{ type, properties }` shape the
 * existing handler understands. Returns `null` for events we do not consume.
 *
 * Note: V2's `session.execution.*` events are the reliable busy/idle signal
 * (the schema-defined `session.idle` is not always emitted), so they map onto
 * the V1 `session.status` / `session.idle` handlers. Re-marking an already
 * busy/idle session is idempotent in the orchestrator, so overlapping signals
 * are safe.
 */
export function translateV2Event(event: V2EventEnvelope): V1TranslatedEvent | null {
  const data = asRecord(event.data)

  switch (event.type) {
    case "session.created":
      return {
        type: "session.created",
        properties: {
          info: { id: asString(data.sessionID), parentID: asString(data.parentID) },
        },
      }
    case "session.deleted":
      return {
        type: "session.deleted",
        properties: { info: { id: asString(data.sessionID) } },
      }
    case "session.status":
      return {
        type: "session.status",
        properties: { sessionID: asString(data.sessionID), status: data.status },
      }
    case "session.idle":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return {
        type: "session.idle",
        properties: { sessionID: asString(data.sessionID) },
      }
    case "session.execution.started":
      return {
        type: "session.status",
        properties: { sessionID: asString(data.sessionID), status: { type: "busy" } },
      }
    case "file.edited":
      return {
        type: "file.edited",
        properties: { file: asString(data.file) },
      }
    case "lsp.updated":
      return { type: "lsp.client.diagnostics", properties: {} }
    default:
      return null
  }
}

/**
 * V2 has no `todo.updated` event. The mission board is fed instead from the
 * todo tool's input captured in the `tool.execute.before` hook.
 */
export function extractTodosFromToolInput(input: unknown): unknown[] | undefined {
  const todos = asRecord(input).todos
  return Array.isArray(todos) ? todos : undefined
}

/** Update the per-session agent/model cache used by the prompt hook. */
function updateIdentityCache(cache: Map<string, SessionIdentity>, envelope: V2EventEnvelope): void {
  const data = asRecord(envelope.data)
  const sessionID = asString(data.sessionID)
  if (!sessionID) return

  if (envelope.type === "session.created") {
    const model = asRecord(data.model)
    cache.set(sessionID, {
      agent: asString(data.agent),
      model: asString(model.id),
      providerID: asString(model.providerID),
    })
    return
  }

  if (envelope.type === "session.agent.selected") {
    cache.set(sessionID, { ...(cache.get(sessionID) ?? {}), agent: asString(data.agent) })
    return
  }

  if (envelope.type === "session.model.selected") {
    const model = asRecord(data.model)
    cache.set(sessionID, {
      ...(cache.get(sessionID) ?? {}),
      model: asString(model.id),
      providerID: asString(model.providerID),
    })
  }
}

/** Forward a todo tool invocation to the V1 engine as a `todo.updated` event. */
async function emitTodoEvent(handlers: V1Handlers, event: V2ToolEvent): Promise<void> {
  if (!/todo/i.test(event.tool)) return
  if (typeof handlers.event !== "function") return
  const todos = extractTodosFromToolInput(event.input)
  if (!todos) return
  try {
    await handlers.event({
      event: { type: "todo.updated", properties: { todos, sessionID: event.sessionID } } as never,
    })
  } catch {
    // The V1 handler logs internally; never let one bad event break the hook.
  }
}

// ── V2 plugin definition ────────────────────────────────────────────────────

/**
 * V2 plugin definition. Exported as a plain object (equivalent to
 * `Plugin.define`, which is an identity function) so the package needs no
 * runtime dependency on `@opencode/plugin`.
 */
export const openCodeDiscordPresenceV2 = {
  id: PLUGIN_ID,
  async setup(ctx: V2Context): Promise<(() => Promise<void>) | void> {
    const directory = ctx.location.directory
    const debug = process.env.OPENCODE_DISCORD_DEBUG === "true"
    const client = createClientShim(ctx, debug)

    const pluginInput = {
      directory,
      worktree: directory,
      project: ctx.location.project ?? { id: "", directory, worktree: directory },
      client,
      serverUrl: new URL("http://127.0.0.1"),
      experimental_workspace: { register() {} },
      $: undefined,
    } as unknown as Parameters<typeof OpenCodeDiscordPresence>[0]

    // Reuse the entire V1 presence engine by invoking it with shimmed inputs.
    const handlers = await OpenCodeDiscordPresence(pluginInput)

    // Disabled, or this is not the process-wide primary instance: register
    // nothing so we do not duplicate the instance that already owns Discord.
    if (typeof handlers.event !== "function" && typeof handlers["chat.message"] !== "function") {
      return
    }

    const identityCache = new Map<string, SessionIdentity>()
    const registrations: V2Registration[] = []

    // V1 `chat.message` -> V2 `prompt` hook. The prompt hook carries no
    // agent/model, so identity is resolved from the per-session cache seeded by
    // session lifecycle and agent/model selection events.
    if (typeof handlers["chat.message"] === "function") {
      const chatMessage = handlers["chat.message"]
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          const identity = identityCache.get(event.sessionID)
          await chatMessage(
            {
              sessionID: event.sessionID,
              agent: identity?.agent,
              model: identity?.model
                ? { providerID: identity.providerID ?? "", modelID: identity.model }
                : undefined,
            } as never,
            { message: undefined, parts: [] } as never,
          )
        }),
      )
    }

    // V1 `tool.execute.before` -> V2 `execute.before` hook. V2 passes the call
    // id on `event.id` and the tool arguments on `event.input`.
    if (typeof handlers["tool.execute.before"] === "function") {
      const before = handlers["tool.execute.before"]
      registrations.push(
        await ctx.tool.hook("execute.before", async (event) => {
          await emitTodoEvent(handlers, event)
          await before(
            { tool: event.tool, sessionID: event.sessionID, callID: event.id } as never,
            { args: event.input } as never,
          )
        }),
      )
    }

    // V1 `tool.execute.after` -> V2 `execute.after` hook. The V1 handler reads
    // only the call id, which is stable across before/after in V2.
    if (typeof handlers["tool.execute.after"] === "function") {
      const after = handlers["tool.execute.after"]
      registrations.push(
        await ctx.tool.hook("execute.after", async (event) => {
          await after(
            { tool: event.tool, sessionID: event.sessionID, callID: event.id } as never,
            {} as never,
          )
        }),
      )
    }

    // V1 `event` hook -> V2 event subscription.
    const abort = new AbortController()
    const eventTask = (async () => {
      try {
        for await (const envelope of ctx.event.subscribe({ signal: abort.signal })) {
          updateIdentityCache(identityCache, envelope)
          const translated = translateV2Event(envelope)
          if (!translated || typeof handlers.event !== "function") continue
          try {
            await handlers.event({ event: translated as never })
          } catch {
            // The V1 handler logs internally; never tear down the subscription.
          }
        }
      } catch {
        // Subscription ended (server shutdown / abort). Nothing to do.
      }
    })()

    // V2 cleanup: stop consuming events, drop hooks, and run the V1 dispose.
    return async () => {
      abort.abort()
      try {
        await eventTask
      } catch {
        // ignore
      }
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch {
          // ignore
        }
      }
      try {
        // The V1 `Hooks` type does not declare `dispose`, but the V1 engine
        // always returns it at runtime.
        await (handlers as { dispose?: () => Promise<void> }).dispose?.()
      } catch {
        // ignore
      }
    }
  },
}
