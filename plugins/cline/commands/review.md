---
description: Read-only second-opinion code review via Cline (GLM-5.2). Inspects working-tree changes and reports findings with file:line citations and severity. Never edits files.
argument-hint: "[--base <ref>] [--background|--wait] <what to review>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch to the `multi:cline-review` subagent. Cline runs read-only (review mode) — it inspects the working-tree diff, reports findings citing file:line with severity, and never edits files.

Use this for a fast second-opinion review without consuming Claude's context on the diff.

Raw user request:
$ARGUMENTS

- Default foreground; a single code review is usually one turn. Pass `--background` for a large or deep review.
- If `--base <ref>` is present, pass it through as `--base` so the companion scopes the diff to changes since that ref.
- A bare `/cline:review` with no arguments is valid — the companion reviews the working-tree diff by default. No need to ask "what to review" unless the user's focus is genuinely ambiguous.
- Do NOT pass `--model` — the adapter pins `cline-pass/glm-5.2` automatically.

Return the subagent's output verbatim.
