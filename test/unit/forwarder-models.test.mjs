// ABOUTME: Guards the model pin on every shipped forwarder agent.
// ABOUTME: A Haiku forwarder substituted its own answer during a CLI outage, so all must run on Sonnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const agentsDir = new URL("../../plugins/multi/agents/", import.meta.url);

test("every shipped forwarder agent pins model: sonnet", () => {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "expected shipped forwarder agents");
  for (const f of files) {
    const text = readFileSync(new URL(f, agentsDir), "utf8");
    const model = text.match(/^model:\s*(\S+)/m)?.[1];
    assert.equal(model, "sonnet", `${f} pins model: ${model}`);
  }
});
