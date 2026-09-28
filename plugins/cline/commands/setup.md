---
description: Verify that Cline is installed and authenticated with the cline-pass provider (DeepSeek-V4.1-Flash). Pass --probe to run a live auth round-trip.
argument-hint: "[--probe]"
allowed-tools: Bash(cline:*)
---

Check that the `cline` CLI is installed and configured for the `cline-pass` provider (model `cline-pass/deepseek-v4.1-flash`).

**Requirements:**

1. `cline` must be on your PATH. Install via the Cline VS Code extension's headless CLI, or from https://github.com/cline/cline.
2. The `cline-pass` provider must be configured with model `cline-pass/deepseek-v4.1-flash`. This is what the adapter uses — no other model or provider is needed for `/cline:review`.

**Without `--probe`:** print the requirements above and tell the user to confirm `cline --version` succeeds before running `/cline:review`.

**With `--probe`:** run exactly one live round-trip against the same provider and model the adapter uses (honoring `CLINE_CLI_DEFAULT_MODEL`), so a retired model ID fails here instead of on the next review:

```bash
cline -p --json -t 60 -P cline-pass -m "${CLINE_CLI_DEFAULT_MODEL:-cline-pass/deepseek-v4.1-flash}" "reply ACK"
```

- Exit 0 and a `run_result` line with `"finishReason":"completed"` and non-empty `text` → OK. Report: `Cline OK — <model> is reachable.` naming the model the probe used.
- `model not found` → the pinned model ID was retired by the provider. Report it and suggest overriding `CLINE_CLI_DEFAULT_MODEL` with a current `cline-pass/<id>`.
- Non-zero exit or empty output → auth failed. Report the exact error and suggest:
  - Confirm `cline --version` works.
  - Check that `cline-pass` is configured as a provider in Cline's settings.
  - Confirm the DeepSeek-V4.1-Flash model is accessible under that provider.
