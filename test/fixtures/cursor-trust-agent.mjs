#!/usr/bin/env node
// ABOUTME: Simulates Cursor's external trust-marker write for offline adapter integration tests.
// ABOUTME: Supports successful turns, crashes, and readiness-signalled hangs for deterministic cancellation.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.argv.includes("--version")) {
  console.log("2026.10.01-e373342");
  process.exit(0);
}
const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
const marker = join(process.env.HOME, ".cursor", "projects", "vendor.name-with-dots", ".workspace-trusted");
mkdirSync(dirname(marker), { recursive: true });
if (!existsSync(marker)) {
  writeFileSync(marker, JSON.stringify({ trustedAt: "2026-10-14T00:00:00Z", workspacePath: workspace }));
}
if (process.env.TRUST_TEST_READY) writeFileSync(process.env.TRUST_TEST_READY, "ready");
if (process.env.TRUST_TEST_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (process.env.TRUST_TEST_MODE === "crash") process.exit(7);
    console.log(JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s1" }));
  });
}
