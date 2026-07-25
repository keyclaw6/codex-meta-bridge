#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { startRolloutViewer, writeViewerReceipt } from "../src/rollout-viewer.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const threadId = args.find((arg) => !arg.startsWith("-"));
if (!threadId || args.includes("--help")) {
  console.log("Usage: node scripts/view-rollout.mjs <thread-id> [--codex-home PATH] [--poll-ms N] [--history N] [--no-color] [--binding-id ID --receipt PATH --receipt-nonce NONCE --viewer-title TITLE]");
  process.exit(threadId ? 0 : 1);
}

const cfg = loadConfig();
const bindingId = valueAfter("--binding-id");
const receiptPath = valueAfter("--receipt");
const receiptNonce = valueAfter("--receipt-nonce");
const viewerTitle = valueAfter("--viewer-title");
if ((bindingId || receiptPath || receiptNonce || viewerTitle) && !(bindingId && receiptPath && receiptNonce && viewerTitle)) {
  console.error("--binding-id, --receipt, --receipt-nonce, and --viewer-title must be supplied together");
  process.exit(1);
}
const viewer = startRolloutViewer({
  threadId,
  codexHome: valueAfter("--codex-home") || cfg.codexHome,
  pollMs: Number(valueAfter("--poll-ms")) || 500,
  history: Number(valueAfter("--history")) || 30,
  color: !args.includes("--no-color"),
  onReady: ({ rolloutPath }) => {
    if (!receiptPath) return;
    writeViewerReceipt(receiptPath, {
      binding_id: bindingId,
      thread_id: threadId,
      receipt_nonce: receiptNonce,
      rollout_path: rolloutPath,
      viewer_pid: process.pid,
      viewer_title: viewerTitle,
      started_at: new Date().toISOString()
    });
  }
});

const stop = () => {
  viewer.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
