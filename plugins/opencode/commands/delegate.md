---
description: Delegate an implementation task or plan step to OpenCode (agentic, writes code; default model opencode/claude-opus-4-8)
argument-hint: "[--plan <path>] [--background|--wait] [--resume|--fresh] [--until-done] [--max-turns <n>] [--model <model>] <plan step or task>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `multi:opencode-delegate` subagent via the `Agent` tool, forwarding the user's request as the prompt.

The subagent runs OpenCode in agent mode on the claude-opus-4-8 model — give it a concrete, well-defined task or plan step and OpenCode implements it (reads, writes, edits). OpenCode is the fast lane: pick it when the spec is clear and the work is mostly mechanical (long file writes, pattern application across many files, bulk refactors) and you want throughput.

**Verification is yours, not OpenCode's.** The subagent does not run build/test suites — it lists the commands to run in a `## Verification` block. After it returns, run those commands with your own Bash tool and surface the results.

Raw user request:
$ARGUMENTS

Execution:

- **Plan-by-reference (preferred when applicable):** if a plan file is in conversation context (Plan mode `Plan File Info` block, a path like `~/.claude/plans/*.md`, or a plan you authored this session), pass `--plan <path>` instead of paraphrasing. The subagent translates `--plan` to `--prompt-file` and OpenCode reads the file's bytes directly. See the `multi-plan-handoff` skill for detection rules. Trigger phrases like "execute via opencode", "delegate to opencode", "send this plan to opencode" all qualify.
- For small steps, invoke the subagent in the foreground. For multi-file work expected to take more than ~3 minutes, invoke the subagent with the `Agent` tool's `run_in_background: true`: the subagent runs OpenCode in the foreground, so the harness notifies you with a `<task-notification>` when the subagent ends — instead of stalling silently. A run longer than 600s (the subagent's Bash maximum) detaches: the notification then carries a `still running` line instead of the result, and you fetch the result with `/multi:status` and `/multi:result`. Do not re-dispatch a detached step: it is still editing files. Do NOT add the companion's `--background` flag for this (it detaches a worker the harness can't see); keep `--background` for explicit fire-and-forget polled via `/multi:status`. (On the default headless transport OpenCode has no turn watchdog, so a wedged process won't self-fail, but the subagent ending still notifies. The opt-in ACP transport, `MULTI_TRANSPORT_OPENCODE=acp`, uses the shared ACP inactivity watchdog: 120s by default without a session update, set by `MULTI_ACP_INACTIVITY_MS`.)
- The subagent uses opencode/claude-opus-4-8 by default. If the user passes `--model`, that wins.
- If the user passes `--resume`, the subagent continues the latest OpenCode delegate session for this repo.
- **Autonomous multi-step (`--until-done`):** when the user hands off a whole multi-step plan and wants OpenCode to run end-to-end without re-dispatch, pass `--until-done` (optionally with `--max-turns <n>`). The subagent loops OpenCode turns on the same session until it signals completion, hits the turn ceiling, errors, or stops making progress. For long autonomous runs, invoke the subagent with `run_in_background: true` (foreground companion) so you're notified when the subagent ends — avoid the companion's detached `--background`. A multi-turn run can outlive the 600s Bash maximum; then the notification is a `still running` line and the result comes from `/multi:result`. Default off.
- If the request includes no prompt text AND no plan file in context, ask what OpenCode should implement before proceeding.

After the subagent returns, read its `## Verification` section, run those commands via your own Bash tool, then surface OpenCode's report and your verification results to the user.

Return OpenCode's output verbatim, followed by your verification results.
