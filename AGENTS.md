# AGENTS.md

Orientation for AI agents (Claude, Codex, Cursor Cloud Agents) working in this repo. **Read this first.**

## This fork

This is **marceldarvas/cc-multi-cli-plugin**, a fork of [greenpolo/cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin). The live CLI set is **Codex, Antigravity, OpenCode, and Cline**. The upstream Cursor CLI provider (`plugins/cursor/`, `lib/adapters/cursor.mjs`, `/cursor:*` commands) was **intentionally removed** and replaced by Cline for read-only review. Do not restore Cursor-as-a-delegate-CLI unless a human asks.

Cursor Cloud Agents work **on** this repo. They are not a plugin provider here.

## What this is

`cc-multi-cli-plugin` is a Claude Code plugin that **offloads heavy coding work to external CLIs** — Codex (app-server), Antigravity (headless `agy -p`), OpenCode (headless `opencode run --format json`), and Cline (`cline -p --json` review) — so the orchestrating Claude session spends as few tokens as possible. The plugin's entire value is *token reduction by delegation*. Keep that goal central to every change.

## The golden rule

Claude does as little thinking as possible; the external CLI does the work.

- The per-command subagents (`plugins/multi/agents/codex-*.md`) are **thin forwarders**: they build exactly one companion command, run it, and return stdout unchanged. They must not read files, reason about the task, or "help."
- Forwarder models are tuned by role. Forwarders that **frame/route** the prompt — `codex-execute`, `codex-rescue`, and the antigravity/opencode write roles — run on **Sonnet**, because shaping the task well (model/effort choice, prompt framing) materially improves what the external CLI then produces (this mirrors the official `codex-plugin-cc` rescue subagent). Forwarders that do **no framing** and only bridge to the companion — `codex-review`, `cline-review` — run on **Haiku**, the correct cheapest model for a pure forwarder. Keep them all thin either way: never add file reading or task reasoning.
- Do **not** spawn fleets of Claude subagents to do or validate work in this repo — that defeats the plugin's purpose. Validate with `npm test` (offline) or by delegating to a CLI.

## The request chain

```
/<cli>:<cmd>  →  multi:<cli>-<role> (thin forwarder)  →  multi-cli-companion.mjs <subcommand> --cli <name>
              →  lib/adapters/<name>.mjs  →  (codex app-server broker | antigravity headless `agy -p` | opencode headless `opencode run --format json` | cline `cline -p --json`)  →  external CLI
```

`--cli` is one of `codex|antigravity|opencode|cline` (default `codex`). See `ARCHITECTURE.md` for the job / state / broker model.

## Cursor Cloud Agent environment

`.cursor/environment.json` bootstraps Cloud Agents. Install is `npm ci` (devDependencies only: the ACP vendor rebuild toolchain). There is **no `start` script** — no servers, databases, or daemons.

- Validate with `npm test` only. It is offline and needs no CLI auth.
- Do **not** run `npm run test:live` during environment install or as a default check. Live smokes spawn a real Cline CLI, cost tokens, and need a signed-in `cline` binary.
- Runtime plugin work (Codex/Antigravity/OpenCode/Cline binaries, API keys) is **operator-local**. Cloud Agents do not install those CLIs and do not need those secrets to change or unit-test this repo.
- Shared ACP helpers still mention Cursor (`lib/acp/resolve.mjs` → `resolveCursorAcp`, `CURSOR_AGENT_PATH`). That is leftover transport infrastructure, not a live adapter. Leave it unless the task is to delete or revive the Cursor provider.

## Build & test

Runtime adapters have no production npm dependencies. Unit tests use Node's built-in test runner (Node ≥ 20; this environment is Node 22). `npm ci` installs only the ACP vendor rebuild toolchain (`@agentclientprotocol/sdk`, `esbuild`, `zod`).

- `npm test` — fast, **offline** unit tests. Run this to self-verify any change. No CLI calls, no tokens.
- `npm run test:live` — end-to-end Cline smokes (`test/live/`). **Spawns a real Cline CLI** (costs tokens + time). Run only when touching the live Cline path, and only when `cline` is installed and signed in.
- `npm run build:acp-vendor` — rebuild the committed ACP SDK bundle after bumping the vendored SDK.

**Definition of done** for a change: `npm test` passes, no `DEP0190` warnings, and `CHANGELOG.md` updated for user-facing changes.

## Map

- `plugins/multi/` — the hub plugin: `agents/` (forwarders), `commands/` (slash cmds), `skills/` (forwarder contracts), `schemas/`, `prompts/`, `hooks/`.
- `plugins/multi/scripts/multi-cli-companion.mjs` — CLI entrypoint; dispatches subcommands (`task`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `setup`).
- `plugins/multi/scripts/lib/adapters/` — one adapter per CLI. Interface in `CONTRACT.md`.
- `plugins/multi/scripts/lib/` — shared runtime: broker lifecycle, app-server, job control, render, git. The ACP client layer lives in `lib/acp/` (`client.mjs` = `runAcpTurn` on the official SDK, `resolve.mjs`, `diagnostics.mjs`); a legacy `lib/acp-client.mjs` predates it and is slated for deletion.
- `plugins/{codex,antigravity,opencode,cline}/` — per-CLI command slices that forward into `multi`.
- `test/` — `unit/` (offline) + `fixtures/` (sandbox helper). `test:live` is Cline-only smokes.

## Landmines

- **Broker lifecycle**: the Codex app-server broker is a detached per-cwd daemon, reused across tasks. The SessionEnd hook reaps the session's *primary*-cwd broker; brokers for any other cwd self-terminate after an idle window (`CODEX_COMPANION_BROKER_IDLE_MS`, default 600000 ms — see `app-server-broker.mjs` + `lib/broker-lifecycle.mjs` → `shouldIdleShutdown`). Set the env to `0` to disable idle shutdown.
- **State is per-cwd**: jobs and brokers key off the working directory; always pass `--cwd`. Parallel agents should use separate worktrees / cwds to stay isolated.
- **`spark`** (`gpt-5.3-codex-spark`) is rejected on ChatGPT-auth Codex accounts — expect a 400; not a bug.
- **Cline is review-only.** `/cline:review` runs `cline -p --json` (plan mode — that `-p` is what keeps it from writing files; do not drop it). The companion resolves the git diff and sends it as the prompt; Cline must not explore the repo. Default model is `cline-pass/glm-5.2` unless `CLINE_CLI_DEFAULT_MODEL` overrides. A completed non-empty review is the only success path — aborted narration is a failure.
- **OpenCode uses headless `opencode run --format json` by default** (ACP is opt-in via `MULTI_TRANSPORT_OPENCODE=acp`): on headless the prompt is on stdin, NDJSON event stream on stdout. Read-only roles (`research`, `explore`) are enforced via injected oc-* primary agents with write/edit/bash denied (no `--read-only` flag). Write roles use `--dangerously-skip-permissions`. `--until-done` is supported; `--effort` is not. Default model: `opencode/claude-opus-4-8` (Zen). **Token-offload caveat:** `anthropic/*` models = zero offload (same Claude bill). Use `opencode/*`, `openai/*`, `google/*`, etc. for real offload. Set `OPENCODE_CLI_DEFAULT_MODEL` or `OPENCODE_CLI_PATH` for overrides.
- **ACP transport** (`lib/acp/client.mjs`, official `@agentclientprotocol/sdk`): OpenCode can run ACP vs headless per turn from `MULTI_TRANSPORT_OPENCODE`. ACP gives in-protocol model select (`set_config_option` vs the live options list), read-only via `set_mode`/deny-env, and `session/cancel` (OpenCode mislabels cancel as `end_turn`, so the client treats cancel-requested+ended as cancelled). Inactivity watchdog covers the handshake; `MULTI_ACP_INACTIVITY_MS`/`MULTI_ACP_OVERALL_MS` tune it. Codex (ASP), Antigravity (`agy`), and Cline have no ACP path. `resolveCursorAcp` remains in `lib/acp/resolve.mjs` as unused shared code from the trimmed Cursor provider.
- **Forwarders only have `Bash`** (review additionally `git`) — by design. Don't add tools.

## Conventions

- Keep files small and single-purpose. Smaller files = parallel agents don't collide. Splitting the two monoliths — `multi-cli-companion.mjs`, `lib/adapters/codex.mjs` — is ongoing; the pure option normalizers were extracted to `lib/task-options.mjs` as the first step. Continue by pulling out one cohesive, independently-testable unit at a time and verifying with `npm test`.
- Add or extend a unit test with every behavior change. Pin contracts in tests, not in a smart model's head — this is what lets the thin forwarders (all `model: sonnet`) and offloaded CLIs stay correct.
- AI-authored research/plans stay local: put scratch in `.agent/` (gitignored). `*_RESEARCH.md` and `/docs/superpowers/` are already gitignored.
