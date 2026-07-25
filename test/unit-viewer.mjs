#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatViewerEvent,
  launchVisibleRolloutViewer,
  startRolloutViewer,
  visibleViewerTitle,
  waitForViewerReceipt,
  writeViewerReceipt
} from "../src/rollout-viewer.mjs";

let failures = 0;
const check = (name, condition, extra = "") => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("\n[viewer-1] event formatting");
const formatted = formatViewerEvent({
  t: "2026-07-24T21:00:00.000Z",
  kind: "assistant_message",
  summary: "Visible answer"
}, { color: false });
check("assistant event is readable", formatted.includes("ASSISTANT") && formatted.includes("Visible answer"));

console.log("\n[viewer-2] live rollout rendering");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-viewer-"));
const codexHome = path.join(tmp, ".codex");
const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "24");
const threadId = "019f9999-aaaa-7bbb-cccc-000000000456";
const rolloutPath = path.join(rolloutDir, `rollout-2026-07-24T21-00-00-${threadId}.jsonl`);
fs.mkdirSync(rolloutDir, { recursive: true });
fs.writeFileSync(rolloutPath, JSON.stringify({
  timestamp: "2026-07-24T21:00:00.000Z",
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First prompt" }] }
}) + "\n");
let output = "";
const viewer = startRolloutViewer({
  codexHome, threadId, pollMs: 100, history: 10, color: false,
  output: { write(chunk) { output += chunk; } }
});
check("history renders user message", output.includes("USER") && output.includes("First prompt"), output);
fs.appendFileSync(rolloutPath, JSON.stringify({
  timestamp: "2026-07-24T21:00:01.000Z",
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[[CALLBACK:PLAN_READY]] Viewer ready" }] }
}) + "\n");
await sleep(250);
viewer.stop();
check("new assistant message renders live", output.includes("ASSISTANT") && output.includes("Viewer ready"), output);
check("callback renders live", output.includes("CALLBACK") && output.includes("PLAN_READY"), output);

console.log("\n[viewer-3] durable non-secret receipt");
const bindingId = "visible-request-abc123";
const receiptNonce = "receipt-nonce-abc123";
const receiptPath = path.join(tmp, "state", "viewer.json");
writeViewerReceipt(receiptPath, {
  binding_id: bindingId,
  thread_id: threadId,
  receipt_nonce: receiptNonce,
  rollout_path: rolloutPath,
  viewer_pid: 456,
  viewer_title: visibleViewerTitle(bindingId),
  started_at: "2026-07-24T21:00:00.000Z"
});
const receipt = await waitForViewerReceipt({
  receiptPath, bindingId, threadId, receiptNonce, timeoutMs: 100, pollMs: 10
});
check("receipt binds viewer to exact rollout", receipt.viewer_pid === 456 && receipt.rollout_path === rolloutPath);
check("receipt contains no prompt text", !fs.readFileSync(receiptPath, "utf8").includes("First prompt"));

if (process.platform === "win32") {
  let captured = null;
  const launched = await launchVisibleRolloutViewer({
    bindingId, threadId, codexHome, receiptPath, receiptNonce, cwd: tmp, terminalPath: "C:\\Windows\\System32\\wt.exe",
    spawnProcess(command, args, options) {
      captured = { command, args, options };
      return { pid: 123, unref() {} };
    },
    waitForReceipt: async () => receipt,
    inspectWindow: async (title) => ({
      window_pid: 789,
      window_handle: "1011",
      session_id: 7,
      title
    })
  });
  check("viewer Windows Terminal stays visible", captured?.options?.windowsHide === false);
  check("viewer passes the requested thread", captured?.args?.includes(threadId));
  check("viewer uses one named Windows Terminal", captured?.args?.[0] === "-w" && captured?.args?.[1] === bindingId);
  check("viewer receives binding + receipt", captured?.args?.includes("--binding-id") && captured?.args?.includes(receiptPath) && captured?.args?.includes(receiptNonce));
  check(
    "launch result binds receipt, viewer, window, HWND, exact title, and session",
    launched.binding_id === bindingId &&
      launched.receipt_nonce === receiptNonce &&
      launched.viewer_pid === 456 &&
      launched.window_pid === 789 &&
      launched.window_handle === "1011" &&
      launched.viewer_title === visibleViewerTitle(bindingId) &&
      launched.session_id === 7
  );

  let wrongBindingRejected = false;
  try {
    await launchVisibleRolloutViewer({
      bindingId,
      threadId,
      codexHome,
      receiptPath,
      receiptNonce,
      cwd: tmp,
      terminalPath: "C:\\Windows\\System32\\wt.exe",
      spawnProcess: () => ({ pid: 124, unref() {} }),
      waitForReceipt: async () => ({ ...receipt, binding_id: "wrong-binding" }),
      inspectWindow: async (title) => ({
        window_pid: 789,
        window_handle: "1011",
        session_id: 7,
        title
      })
    });
  } catch (error) {
    wrongBindingRejected = /exact launch/.test(String(error?.message || error));
  }
  check("launcher rejects a receipt with the wrong binding ID", wrongBindingRejected);
}

console.log("");
if (failures === 0) { console.log("VIEWER TEST PASS"); process.exit(0); }
console.error(`VIEWER TEST FAIL (${failures})`); process.exit(1);
