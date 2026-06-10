# Contributing to opencode-discord-presence

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0.0 or higher
- [Discord](https://discord.com) client installed (for testing Rich Presence)
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/Puri12/opencode-discord-presence.git
cd opencode-discord-presence

# Install dependencies
bun install

# Run tests to verify setup
bun test
```

## Development Workflow

### Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run specific test file
bun test src/config.test.ts
```

### Code Quality

```bash
# Type checking
bun run typecheck

# Lint code
bun run lint

# Auto-fix lint issues
bun run lint:fix

# Format code
bun run format
```

### Building

```bash
# Build for production
bun run build
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Configuration is in `biome.json`.

### Key Style Guidelines

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions small and focused

### File Organization

```
src/
├── index.ts              # Public exports only
├── plugin.ts             # Main plugin implementation
├── config.ts             # Configuration management
├── types/                # TypeScript types
├── services/             # External service integrations
└── utils/                # Pure utility functions
```

## Testing Guidelines

Config compatibility note: new docs and examples should use the top-level `applicationId` key in `.discord-presence.json`. The parser still accepts `discordPresence.applicationId` only for backward compatibility.

### Test Structure

Tests use [Bun Test](https://bun.sh/docs/test/writing). Each source file should have a corresponding `.test.ts` file.

```typescript
import { describe, expect, test } from "bun:test"
import { myFunction } from "./my-module"

describe("myFunction", () => {
  test("should do something", () => {
    expect(myFunction(input)).toBe(expected)
  })
})
```

### Test Categories

1. **Unit Tests** - Test individual functions in isolation
2. **Integration Tests** - Test modules working together
3. **Contract Tests** - Verify API signatures match expectations

### Coverage Expectations

- All public functions should have tests
- Edge cases should be covered
- Aim for >80% coverage on new code

## Commit Guidelines

This project follows [Conventional Commits](https://www.conventionalcommits.org/).

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, etc.) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build process or auxiliary tool changes |

### Examples

```bash
feat(plugin): add idle detection support
fix(rpc): handle Discord connection timeout
docs: update README with configuration options
test(utils): add edge case tests for formatTokens
```

## Pull Request Process

### Before Submitting

1. Ensure all tests pass: `bun test`
2. Ensure type checking passes: `bun run typecheck`
3. Ensure linting passes: `bun run lint`
4. Update documentation if needed
5. Add tests for new functionality

### PR Guidelines

- Keep PRs focused on a single change
- Write a clear description of what changed and why
- Link related issues
- Request review from maintainers

### PR Template

```markdown
## Description
[Describe your changes]

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
[Describe how you tested your changes]

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Types updated
- [ ] Changelog updated (if applicable)
```

## Issue Guidelines

### Bug Reports

Include:
- Clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Bun version, Discord version)
- Error messages/logs

### Feature Requests

Include:
- Clear description of the feature
- Use case / motivation
- Proposed implementation (optional)
- Alternatives considered

## Architecture Decisions

### Why Bun?

- Fast execution and testing
- Built-in TypeScript support
- Native test runner
- Good Discord RPC compatibility

### Why Singleton for RPC?

- Discord only allows one RPC connection per client
- Prevents connection conflicts
- Simplifies state management

### Why Korean Particles?

- Project originated with Korean users
- Demonstrates proper i18n patterns
- Can be extended for other languages

## Error-Handling Conventions

Failure semantics are layered — follow these when adding code:

1. **Hook boundary (`src/plugin.ts`)**: hooks never throw into the OpenCode host. Every returned hook is wrapped in `guard()`, which catches, logs only when `debug: true`, and resolves. Timer callbacks follow the same rule.
2. **Services (`DiscordRPCService`, `InstanceCoordinator`)**: expected failures (connection refused, fs write failure) return `false` or no-op; they never throw to callers. Unexpected internal errors are caught and surfaced via debug-gated logs.
3. **Utils (`session-persistence`, etc.)**: best-effort and silent. fs errors are swallowed; loads return `null`/`undefined` on missing or corrupt data.
4. **"Silent by default"**: nothing prints to the console unless `debug: true`. Never add an unconditional `console.*` call.

## Getting Help

- Check existing issues and discussions
- Read the README and documentation
- Ask in Discord (if community server exists)
- Open an issue for bugs or feature requests

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
