# opencode-discord-presence

[![npm version](https://img.shields.io/npm/v/opencode-discord-presence.svg)](https://www.npmjs.com/package/opencode-discord-presence)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[한국어](README.ko.md) | English

Display your current OpenCode session status in Discord Rich Presence. Show which AI agent you're using, the current model, prompt/file activity, and more.

<img width="293" height="119" alt="image" src="https://github.com/user-attachments/assets/879207e0-4759-477d-ba34-f79f927737bd" />


## Features

- **Real-time agent display** - Shows which AI agent (Claude, Prometheus, etc.) you're currently using
- **Model information** - Displays the active model (Claude Sonnet, GPT-4, etc.)
- **Discord elapsed timer** - Presence includes a Discord start timestamp so elapsed coding time appears in the client timer UI
- **Korean language support** - Proper Korean particle handling (을/를, 은/는)
- **Idle detection** - Automatically shows when you're taking a break
- **Live File Spotlight** - Shows the file currently being edited, read, or diagnosed by the agent, with language-specific Discord icons
- **Task Mission Board** - Displays active todo progress with task labels and completion counts (e.g., "Implementing dark mode (2/5)")
- **Diagnostics placeholder support** - Keeps the diagnostics display surface reserved for future/external integrations; current OpenCode plugin API v1 logs diagnostics events but does not expose counts (see [limitations](#limitations))
- **Smart rotation** - Critical states (errors, idle, all-done) pin; informational cards (file spotlight, mission board, session stats) rotate every 20 seconds by default
- **Session recap** - When a session ends, a recap card shows total prompts and files touched for 30 seconds

## Installation

```bash
# Using bun
bun add opencode-discord-presence

# Using npm
npm install opencode-discord-presence

# Using pnpm
pnpm add opencode-discord-presence
```

## Quick Start

Register the plugin in your `opencode.json`:

```json
{
  "plugin": ["opencode-discord-presence"]
}
```

That's it! The plugin will automatically connect to Discord and display your session status.

> `opencode.json` only **registers** the plugin. All plugin settings live in `.discord-presence.json` or environment variables — see [Configuration](#configuration) below.

## Configuration

Create a `.discord-presence.json` file in your project root (preferred) or home directory:

```json
{
  "enabled": true,
  "applicationId": "YOUR_DISCORD_APP_ID",
  "language": "ko",
  "richPresence": {
    "enableFileSpotlight": false,
    "enableMissionBoard": true,
    "rotationIntervalSeconds": 20,
    "mainAgentOnly": false,
    "diagnostics": {
      "errorsOnly": true
    }
  }
}
```

> ⚠️ `enableFileSpotlight` is **off by default**: turning it on broadcasts the path of the file you're currently editing to anyone viewing your Discord profile. Only enable it if you're working on a public repo or don't mind that exposure.

Or use environment variables:

```bash
OPENCODE_DISCORD_ENABLED=true
OPENCODE_DISCORD_CLIENT_ID=YOUR_APP_ID
OPENCODE_DISCORD_LANGUAGE=ko
OPENCODE_DISCORD_DEBUG=true
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable or disable the plugin |
| `applicationId` | `string` | (built-in) | Custom Discord Application ID for your own branding |
| `language` | `string` | `"en"` | Display language (`"en"` or `"ko"`) |
| `debug` | `boolean` | `false` | Emit `[discord-presence]` lifecycle logs (connect / disconnect / failures). Off by default so nothing prints in your OpenCode console. |
| `richPresence.enableFileSpotlight` | `boolean` | `false` | Show the path of the file currently being edited/read. **Off by default for privacy** — Discord broadcasts your activity to anyone viewing your profile, so leaking working file paths can expose private repo internals. Enable explicitly if you're OK with that. |
| `richPresence.enableMissionBoard` | `boolean` | `true` | Show task mission board card |
| `richPresence.rotationIntervalSeconds` | `number` | `20` | How often informational cards rotate (10–60 seconds) |
| `richPresence.mainAgentOnly` | `boolean` | `false` | When `true`, only `chat.message` events from the **main** session (root, no `parentID`) update Discord presence; sub-agent / task sessions are filtered out so a background planner or explore agent does not flicker the user's profile. When `false`, every chat.message overwrites presence — last writer wins, but the orchestrator still tracks busy/idle across all sessions so the "idle" text appears only when every tracked session reports idle. |
| `richPresence.diagnostics.errorsOnly` | `boolean` | `true` | Reserved for future/external diagnostics integrations; inactive with current OpenCode plugin API v1 |

For backward compatibility, the parser also accepts `discordPresence.applicationId`, but new configs should use the top-level `applicationId` shown above.

### Where the plugin reads from

Each setting is resolved in this order — the first defined value wins:

1. **`<projectRoot>/.discord-presence.json`** — per-project config, lives next to your `opencode.json`. Recommended for project-specific tweaks (e.g. a Korean idle string for a Korean codebase).
2. **`~/.discord-presence.json`** — your global default, used by every OpenCode project.
3. **Environment variables** — `OPENCODE_DISCORD_ENABLED`, `OPENCODE_DISCORD_CLIENT_ID`, `OPENCODE_DISCORD_LANGUAGE`, `OPENCODE_DISCORD_DEBUG`. Convenient for one-off overrides (`OPENCODE_DISCORD_DEBUG=true opencode …`).
4. **Built-in defaults** — silent (`debug: false`), English, shared Discord App ID.

> `opencode.json` itself is **not** a config source for this plugin. Putting `discordPresence: { … }` inside `opencode.json` will not be picked up; use `.discord-presence.json` instead. (The shared OpenCode schema does not allow plugin-specific fields, so this keeps your `opencode.json` valid.)

### Per-project example

```bash
# In any OpenCode project, alongside opencode.json:
cat > .discord-presence.json <<'JSON'
{
  "language": "ko",
  "debug": false,
  "richPresence": {
    "rotationIntervalSeconds": 15
  }
}
JSON
```

Restart OpenCode and the new settings take effect on the next chat message.

## Custom Discord Application

For custom branding (your own images and app name):

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Rich Presence" → "Art Assets"
4. Upload your images (at least one named `opencode-logo`)
5. Copy the Application ID from "General Information"
6. Add it to your config:

```json
{
  "applicationId": "YOUR_APPLICATION_ID"
}
```

## How It Works

The plugin hooks into OpenCode's event system:

- **chat.message** - Updates presence when you send/receive messages, tracking the current agent and model
- **tool.execute.before** / **tool.execute.after** - Captures file context and tool operation labels (edit, read, search, build, test, etc.)
- **file.edited** - Updates the live file spotlight with the edited file path and language icon
- **todo.updated** - Drives mission board progress with active task labels and completion counts
- **session.idle** - Triggers idle state with the last active task shown in the state line
- **session.deleted** - Triggers session recap showing total prompts and files touched for 30 seconds

### Limitations

- **lsp.client.diagnostics** is listened for, but error/warning counts are not available through the OpenCode plugin API v1. Diagnostic counts shown in presence require external LSP configuration. The plugin logs diagnostics events but does not fabricate counts.

### Presence States

| State | English | Korean | Description |
|-------|---------|--------|-------------|
| Active editing | `Working with {agent}` | `{agent}을/를 작업중` | File being edited |
| Active reading | `Working with {agent}` | `{agent}을/를 작업중` | File being read |
| Task active | `Working with {agent}` | `{agent}을/를 작업중` | With mission progress |
| Diagnostics error | `Working with {agent}` | `{agent}을/를 작업중` | Errors detected |
| Idle | `{agent} is idle` | `{agent}은/는 휴식중` | No activity |
| Session complete | `Session Complete!` | `세션 완료!` | Session ended (30s) |
| All tasks done | `All tasks complete!` | `모든 작업 완료!` | No pending tasks |

Korean particles (을/를, 은/는) are automatically selected based on whether the agent name ends with a consonant (받침).

## Visual Sample Matrix

The following states are fully supported in v1 (runtime-backed):

| Condition | Headline | State line | Large image |
|-----------|----------|------------|-------------|
| Editing file | `Working with Claude` | `src/plugin.ts` | language icon |
| Reading file | `Working with Claude` | `src/services/discord-rpc.ts` | action-reading |
| Task active | `Working with Claude` | `Implementing dark mode (2/5)` | task |
| Diagnostics error | `Working with Claude` | `5 errors, 2 warnings` / `오류 5개, 경고 2개` | state-error |
| Idle | `Claude is idle` | `Last task: Add theme toggle` / `마지막 작업: Add theme toggle` | state-idle |
| Session recap | `Session Complete!` / `세션 완료!` | `27 prompts • 3 files` / `27개 프롬프트 • 3개 파일` | state-recap |
| All tasks complete | `All tasks complete!` / `모든 작업 완료!` | `5/5 finished` / `5/5 완료` | state-complete |

Illustrative-only states (not implemented in v1):

| Condition | Headline | State line | Notes |
|-----------|----------|------------|-------|
| Night mode | `Burning the midnight oil` | `src/index.ts` | Not in v1 unless time-based config added |

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Build
bun run build
```

## Architecture

```
src/
├── index.ts              # Main entry point & exports
├── plugin.ts             # OpenCode hook registration + presence engine
├── config.ts             # Configuration management
├── types/
│   └── index.ts          # TypeScript type definitions
├── services/
│   └── discord-rpc.ts    # Discord RPC service (hardened lifecycle)
├── state/
│   └── presence-state.ts # Instance-scoped presence snapshot + reducer
└── utils/
    ├── activity-rotation.ts # Precedence + rotation engine
    ├── file-label.ts        # Path sanitization + truncation
    ├── file-icons.ts        # Language → icon mapping
    ├── session-metrics.ts   # Session counters + recap
    ├── tool-label.ts        # Tool → operation label mapping
    └── particle.ts          # Korean particle handling (을/를, 은/는)
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

### Quick Contribution Guide

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`bun test`)
4. Commit your changes (`git commit -m 'feat: add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [OpenCode](https://github.com/opencode-ai/opencode) - The AI coding assistant this plugin extends
- [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc) - Discord RPC library used by this plugin

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.
