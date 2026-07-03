---
description: Verify that Cline is installed and authenticated with the cline-pass provider (GLM-5.2). Pass --probe to run a live auth round-trip.
argument-hint: "[--probe]"
allowed-tools: Bash(cline:*)
---

Check that the `cline` CLI is installed and configured for the `cline-pass` provider (model `cline-pass/glm-5.2`).

**Requirements:**

1. `cline` must be on your PATH. Install via the Cline VS Code extension's headless CLI, or from https://github.com/cline/cline.
2. The `cline-pass` provider must be configured with model `cline-pass/glm-5.2`. This is what the adapter uses — no other model or provider is needed for `/cline:review`.

**Without `--probe`:** print the requirements above and tell the user to confirm `cline --version` succeeds before running `/cline:review`.

**With `--probe`:** run exactly one live auth round-trip to confirm Cline is reachable and authenticated:

```bash
cline -p --json -t 60 "reply ACK"
```

- Exit 0 with non-empty JSON output → auth OK. Report: `Cline auth OK — cline-pass/glm-5.2 is reachable.`
- Non-zero exit or empty output → auth failed. Report the exact error and suggest:
  - Confirm `cline --version` works.
  - Check that `cline-pass` is configured as a provider in Cline's settings.
  - Confirm the GLM-5.2 model is accessible under that provider.
