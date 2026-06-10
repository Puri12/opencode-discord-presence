# Improvement Plan — opencode-discord-presence v0.7.2

Branch: `improve/robustness-and-quality`
Status: PROPOSED (awaiting review)
Baseline: 289 tests pass, typecheck/lint clean, multi-CLI QA 21+6 scenarios pass

## 한국어 요약

프로젝트 전체 리뷰 결과, **견고성(robustness) 결함 4건(HIGH)**, **코드 건강 문제 다수(SHOULD)**, **선택적 기능 아이디어(COULD)** 를 발견했습니다.

- **Wave 1 (MUST)**: 이벤트 핸들러 예외 미차단, 시그널 리스너 누수, RPC connect 동시호출 레이스, 코디네이터 fail-open — 실사용 중 프레즌스가 깨지거나 호스트(OpenCode)에 예외가 전파될 수 있는 버그들.
- **Wave 2 (MUST)**: Discord rate-limit 준수(debounce 100ms → 2s 코얼레싱), 재연결 백오프+지터, 회전 타이머 중첩 방지, 메트릭 파일 원자적 쓰기.
- **Wave 3 (SHOULD)**: plugin.ts 766줄 분할, 카드 카운트 로직 중복 제거, 죽은 코드 제거, config 검증.
- **Wave 4 (SHOULD)**: 의존성 업데이트, CI 핀/캐시/권한, npm provenance, package.json 정리.
- **COULD (별도 브랜치 제안)**: git 브랜치 표시, 커스텀 버튼 설정, privacy blacklist 등 기능 추가.

각 작업은 TDD(RED→GREEN) + 실표면 QA(스모크/멀티CLI 스크립트)로 검증합니다. 기존 멀티-CLI 조정 동작(13개 수정사항)은 절대 회귀 금지.

---

## Constraints (binding)

- TDD mandatory: failing test first, then minimal fix.
- `bun test` (289+), `bun run typecheck`, `bun run lint` must stay green after EVERY task.
- Multi-CLI regression gates: `bun scripts/multi-cli-coordinator-qa.ts` (21 scenarios) and `bun scripts/multi-process-coordinator-qa.ts` (6 scenarios) must pass after every wave.
- "Silent by default" logging promise preserved (debug-gated logs only).
- No config-format breaking changes (published package, 0.7.2 on npm).

---

## Wave 1 — Robustness MUST-fixes (independent, parallelizable)

### T1.1 Contain event-handler failures
- **Where**: `src/plugin.ts:495-764`
- **What**: Wrap each returned hook (`chat.message`, `tool.execute.before/after`, `event`) in a `guard()` helper that catches rejections, logs via debug gate, and never rethrows into the host. Timer callbacks too.
- **Why**: An fs error in `saveSessionMetrics` or RPC error in `pushPresence` currently bubbles out of the handler into OpenCode.
- **Verify**: RED test: handler whose inner save throws → hook promise resolves (no rejection). GREEN. Plus full suite.

### T1.2 Fix signal-listener leak + complete shutdown
- **Where**: `src/plugin.ts:473-491`
- **What**: Store SIGINT/SIGTERM handler refs; remove them in `shutdown()` (`process.off`). Make `shutdown()` idempotent (already mostly is via `rpc=null`, formalize with a flag).
- **Why**: Plugin reload (dispose → re-init) stacks duplicate process listeners holding old closures → memory leak + double-shutdown of new instance state.
- **Verify**: RED test: init plugin twice with dispose between → `process.listenerCount("SIGINT")` unchanged. GREEN.

### T1.3 Singleflight `DiscordRPCService.connect()`
- **Where**: `src/services/discord-rpc.ts:143-209`
- **What**: If a connect is already in flight, return the same promise. Destroy/neutralize any previous client before creating a new one (generation counter already exists — use it to also destroy the orphan).
- **Why**: `chat.message` self-heal (plugin.ts:507-509) + ownership settle connect (plugin.ts:209) can race → two `Client` instances, orphaned listeners, zombie IPC sockets (Discord throttles >2 fresh connections).
- **Verify**: RED test: call `connect()` twice synchronously → exactly one Client constructed. GREEN. Manual QA: `bun scripts/smoke-test.ts`.

### T1.4 Coordinator fail-closed on startup write failure
- **Where**: `src/services/instance-coordinator.ts:60-82,119-121` (+ consumer `src/plugin.ts:460-462`)
- **What**: If the constructor's initial `writeOwnFile()` fails (mkdir/write error), start with `isOwnerFlag=false` instead of `true`; ownership can still be gained on a later successful tick.
- **Why**: ENOSPC/EACCES at startup currently yields a phantom owner that pushes presence then gets demoted — split-brain window.
- **Verify**: RED test: inject failing fs → `isOwner()` false immediately after construction. GREEN. Regression: both coordinator QA scripts.

---

## Wave 2 — Robustness MUST-fixes (depends on Wave 1 landing)

### T2.1 Discord rate-limit-aware presence coalescing
- **Where**: `src/services/discord-rpc.ts:8,313-338`
- **What**: Raise `DEBOUNCE_MS` 100ms → trailing-edge coalescing window of ~2000ms (latest snapshot wins; first update after quiet period flushes fast). Keep injection points for tests.
- **Why**: Discord allows 5 setActivity per 20s. Bursty tool events (tool.execute.before+after+file.edited per operation) can exceed it; Discord silently drops updates.
- **Verify**: RED test: 10 setPresence calls in 1s → ≤2 client.setActivity invocations, last payload wins. GREEN. Manual QA: smoke-test, presence visibly updates.

### T2.2 Reconnect backoff + jitter
- **Where**: `src/services/discord-rpc.ts:6,267-282`
- **What**: Replace fixed `RECONNECT_DELAY=5000` with exponential backoff (5s → cap 60s) + ±20% jitter. Keep MAX_RETRIES and the existing self-heal reset semantics intact.
- **Why**: Multiple CLIs retrying in lockstep every 5s hammer Discord's IPC (documented throttling of repeated fresh connections); jitter desynchronizes them.
- **Verify**: RED test with injected timers: delays grow and differ run-to-run within bounds. GREEN.

### T2.3 Non-overlapping rotation timer
- **Where**: `src/plugin.ts:413-427`
- **What**: Guard the interval callback with an `inFlight` flag (skip tick if previous push not finished) and catch rejections (covered by T1.1 guard, but assert explicitly).
- **Verify**: RED test: slow pushPresence + 3 ticks → no concurrent execution. GREEN.

### T2.4 Atomic session-metrics writes + legacy file pruning
- **Where**: `src/utils/session-persistence.ts:48-70,107-153`
- **What**: `saveSessionMetrics` writes `<file>.<rand>.tmp` then rename (same pattern as coordinator's writeOwnFile). Add legacy `session-metrics.json` to the stale-prune sweep. Swallow-and-debug-log write errors (never throw into handlers).
- **Verify**: RED tests: interrupted-write simulation leaves no torn file; legacy file older than threshold gets pruned. GREEN.

---

## Wave 3 — Code health SHOULD-fixes

### T3.1 Split `src/plugin.ts` (766 lines) into modules
- **What**: Extract with NO behavior change (characterization tests first):
  - `src/config-loader.ts` ← `loadConfigFile` (plugin.ts:39-57)
  - `src/utils/arg-paths.ts` ← `extractFilePathFromArgs` (81-122)
  - `src/lifecycle/ownership-handler.ts` ← createOwnershipHandler + buildInstancesDir (142-220)
  - `src/lifecycle/recap-scheduler.ts` ← createRecapScheduler (222-286)
  - plugin.ts keeps factory + handlers (~400 lines)
- **Verify**: All 289+ tests pass unchanged (import paths updated); typecheck/lint; both QA scripts.

### T3.2 De-duplicate rotating-card logic
- **Where**: `src/plugin.ts:124-135` vs `src/utils/activity-rotation.ts:105-120`
- **What**: Single source of truth in activity-rotation (export card-list builder; plugin derives count from it). Eliminates index/modulus drift risk.
- **Verify**: RED test asserting plugin count === rotation card list length across option permutations. GREEN.

### T3.3 Remove dead exports
- **What**: Verify and delete `createRecapCleanupTask` (discord-rpc.ts:19-29, unused in runtime) and `startPluginAsync` (plugin.ts:299-311, superseded by ownershipHandler bootstrap) — confirm zero runtime references first; delete their tests-only usages accordingly.
- **Verify**: typecheck + full suite + grep for references.

### T3.4 Config validation + malformed-config visibility
- **Where**: `src/config.ts:82-100`, `src/plugin.ts:39-57`
- **What**: Type-narrow parsed JSON (booleans actually boolean, strings actually string — coerce or fall back per-field). When project config is malformed JSON, still fall back BUT remember the parse error and emit one debug-gated log line after config resolution (debug may come from env var, so the gate is resolvable). No behavior change for valid configs.
- **Verify**: RED tests: `{"enabled":"yes"}` → defaults not garbage; malformed project file + valid home file → home config used. GREEN.

### T3.5 Unify error-handling semantics (documentation-level)
- **What**: Add a short convention note (CONTRIBUTING.md): handlers swallow+debug-log; services return booleans for expected failure; never throw across the hook boundary. Align stragglers found during T1.1.
- **Verify**: lint + review.

## Wave 4 — Hygiene SHOULD-fixes (independent, parallelizable)

### T4.1 Dependency updates
- **What**: `@biomejs/biome` 2.3.13→2.4.x, `@types/bun` →1.3.14, `@opencode-ai/plugin` 1.1.47→1.16.x (review changelog for hook-surface changes; peerDep range `>=0.1.0` stays). Remove `playwright` devDep if truly unused (verify scripts/). Regenerate bun.lock (fixes stale `opencode-rich-presence-server` name).
- **Verify**: bun install + full suite + typecheck + lint + build.

### T4.2 CI hardening
- **Where**: `.github/workflows/ci.yml`, `publish.yml`
- **What**: Pin bun-version (e.g. `1.3.x`), add dependency cache, `concurrency` group, explicit minimal `permissions:` in ci.yml; add `--provenance` to npm publish (id-token: write already present).
- **Verify**: CI green on the PR for this branch; publish flow validated at next release.

### T4.3 package.json polish
- **What**: Fill `author`, confirm `files`/`exports` (already good), consider `packageManager` field.
- **Verify**: `npm pack --dry-run` output review.

---

## COULD — Feature backlog (separate branch, NOT in this effort)

| Idea | Source |
|------|--------|
| Git branch display (`vcs.branch.updated` event) | plugin API 1.16 event surface |
| Custom buttons config (label/url) | vscord, presence.nvim parity |
| Per-path privacy blacklist for file spotlight | vscord parity |
| Configurable idle text | user requests pattern |
| `permission.asked` → "waiting for approval" card | new plugin API event |

---

## Execution order & verification gates

```
Wave 1: T1.1 ∥ T1.2 ∥ T1.3 ∥ T1.4   → gate: full suite + both QA scripts
Wave 2: T2.1 ∥ T2.2 ∥ T2.3 ∥ T2.4   → gate: full suite + both QA scripts + smoke-test (real Discord IPC)
Wave 3: T3.1 → T3.2 ∥ T3.3 ∥ T3.4 ∥ T3.5 → gate: full suite + QA scripts
Wave 4: T4.1 ∥ T4.2 ∥ T4.3           → gate: build + CI green
Final: live manual QA — run opencode with file:// plugin path, observe Discord presence through busy→idle→recap cycle, multi-CLI handoff with 2 instances.
```

Each task: RED test → GREEN fix → surface artifact (QA script output / smoke-test transcript) recorded in PR description.
