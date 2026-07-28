#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { startRolloutViewer } from "../src/rollout-viewer.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const threadId = args.find((arg) => !arg.startsWith("-"));
if (!threadId || args.includes("--help")) {
  console.log("Usage: node scripts/view-rollout.mjs <thread-id> [--codex-home PATH] [--poll-ms N] [--history N] [--no-color]");
  process.exit(threadId ? 0 : 1);
}

const cfg = loadConfig();
const viewer = startRolloutViewer({
  threadId,
  codexHome: valueAfter("--codex-home") || cfg.codexHome,
  pollMs: Number(valueAfter("--poll-ms")) || 500,
  history: Number(valueAfter("--history")) || 30,
  color: !args.includes("--no-color")
});

const stop = () => {
  viewer.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
