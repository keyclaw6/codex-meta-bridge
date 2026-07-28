#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatViewerEvent, startRolloutViewer } from "../src/rollout-viewer.mjs";

assert.match(formatViewerEvent({
  t: "2026-07-24T21:00:00.000Z",
  kind: "assistant_message",
  summary: "Answer"
}, { color: false }), /ASSISTANT\nAnswer/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-viewer-"));
const threadId = "019f9999-aaaa-7bbb-cccc-000000000456";
const rolloutDir = path.join(tmp, "sessions", "2026", "07", "24");
const rolloutPath = path.join(rolloutDir, `rollout-${threadId}.jsonl`);
fs.mkdirSync(rolloutDir, { recursive: true });
fs.writeFileSync(rolloutPath, `${JSON.stringify({
  timestamp: "2026-07-24T21:00:00.000Z",
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First prompt" }] }
})}\n`);

let output = "";
const viewer = startRolloutViewer({
  codexHome: tmp,
  threadId,
  pollMs: 100,
  color: false,
  output: { write: (chunk) => { output += chunk; } }
});
assert.match(output, /USER[\s\S]*First prompt/);
viewer.stop();

console.log("VIEWER TEST PASS");
