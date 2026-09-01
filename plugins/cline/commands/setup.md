---
description: Verify that Cline is installed and authenticated with the cline-pass provider (DeepSeek-V4-Flash). Pass --probe to run a live auth round-trip.
argument-hint: "[--probe]"
allowed-tools: Bash(cline:*)
---

Check that the `cline` CLI is installed and configured for the `cline-pass` provider (model `cline-pass/deepseek-v4-flash`).

**Requirements:**

1. `cline` must be on your PATH. Install via the Cline VS Code extension's headless CLI, or from https://github.com/cline/cline.
2. The `cline-pass` provider must be configured with model `cline-pass/deepseek-v4-flash`. This is what the adapter uses — no other model or provider is needed for `/cline:review`.

**Without `--probe`:** print the requirements above and tell the user to confirm `cline --version` succeeds before running `/cline:review`.

**With `--probe`:** run exactly one live auth round-trip to confirm Cline is reachable and authenticated:

```bash
cline -p --json -t 60 "reply ACK"
```

- Exit 0 with non-empty JSON output → auth OK. Report: `Cline auth OK — cline-pass/deepseek-v4-flash is reachable.`
- Non-zero exit or empty output → auth failed. Report the exact error and suggest:
  - Confirm `cline --version` works.
  - Check that `cline-pass` is configured as a provider in Cline's settings.
  - Confirm the DeepSeek-V4-Flash model is accessible under that provider.
