---
description: Read-only diff review via Cursor (default Auto model). Reviews working-tree changes in an isolated, tool-denied session and reports findings with file:line citations and severity. Never edits files.
argument-hint: "[--base <ref>] [--background|--wait] [--model <model>] [focus]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch to the `multi:cursor-review` subagent. The companion resolves the diff (working tree, or `base...HEAD` with `--base`) and hands it to Cursor as the prompt. Cursor runs in an empty throwaway workspace with every tool denied, so it reviews the diff alone and never sees or touches the repository.

Use this for a second-opinion review from a different model than `/cline:review`, without consuming Claude's context on the diff.

Raw user request:
$ARGUMENTS

- Default foreground; a single code review is one turn. Pass `--background` for a very large diff.
- If `--base <ref>` is present, pass it through as `--base`.
- A bare `/cursor:review` with no arguments is valid — it reviews the working-tree diff. Don't ask "what to review" unless the user's focus is genuinely ambiguous.
- Pass `--model` through only if the user named one; the default is Cursor's Auto model.

Return the subagent's output verbatim.
