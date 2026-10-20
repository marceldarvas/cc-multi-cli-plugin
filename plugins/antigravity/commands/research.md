---
description: "Deep external research with Antigravity's agy CLI (Gemini 3.8 Flash high — web search + synthesis, read-only)."
argument-hint: "<what to research>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch the user's research request to the `multi:antigravity-researcher` subagent via the `Agent` tool. Antigravity runs **Gemini 3.8 Flash (high)** through Google's headless `agy` CLI (`agy -p --output-format json`), with built-in web search. Pass `--model` only when the user named one.

Raw user request:
$ARGUMENTS

- Read-only research mode. Antigravity runs in plan mode, so it plans instead of editing files or running shell.
- Requires the headless `agy` CLI installed and signed in once. Launch `~/.local/bin/agy` (or `$AGY_CLI_PATH`) in a terminal to sign in. `agy` on PATH may be the IDE launcher. The desktop app is NOT required.
- The answer is the JSON envelope on stdout. The adapter defaults to `gemini-3.8-flash-high`. Read-only roles run `--mode plan --dangerously-skip-permissions`: plan mode holds them read-only, and skipping permissions keeps headless `agy` from auto-denying their read and web tools. Plan mode is the only write guard, so this is not a hard sandbox.
- If the request has no prompt, ask what to research.

Return Antigravity's output verbatim.
