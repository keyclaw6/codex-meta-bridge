#!/usr/bin/env node
/**
 * Dependency-free core test: tailer parsing + incremental reads + inbox
 * ticket lifecycle + rollout confirmation. (The full MCP transport test is
 * test/selftest.mjs, which needs npm dependencies.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RolloutTailer, findRolloutFile, STEERING_MARKER } from "../src/tailer.mjs";
import { Inbox } from "../src/inbox.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "019f9315-fc11-7c90-b7ae-304ca4d8f127";
let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-core-"));
const codexHome = path.join(tmp, ".codex");
const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(rolloutDir, { recursive: true });
const rolloutPath = path.join(rolloutDir, `rollout-2026-07-24T09-45-24-${THREAD_ID}.jsonl`);
fs.copyFileSync(path.join(__dirname, "fixture-rollout.jsonl"), rolloutPath);

console.log("\n[core-1] discovery");
check("findRolloutFile locates dated-subdir rollout", findRolloutFile(codexHome, THREAD_ID) === rolloutPath);
check("findRolloutFile returns null for unknown id", findRolloutFile(codexHome, "ffffffff-0000-0000-0000-000000000000") === null);

console.log("\n[core-2] initial parse + digest");
const confirmed = [];
const inbox = new Inbox(path.join(tmp, "bridge"));
const tailer = new RolloutTailer({
  codexHome, threadId: THREAD_ID, pollMs: 200,
  onSteeringConfirmed: (ticket, at) => { confirmed.push(ticket); inbox.markConfirmed(ticket, at); }
});
tailer.start();
await sleep(300);
let d = tailer.digest();
check("rollout found", d.rolloutFound === true, d.tailerError || "");
check("meta originator", d.sessionMeta?.originator === "Codex Desktop");
check("meta cli_version", d.sessionMeta?.cli_version === "0.145.0-alpha.30");
check("last user msg has mission", d.lastUserMessage?.text?.includes("$orchestrate-mission"));
check("last assistant msg has STATUS", d.lastAssistantMessage?.text?.includes("STATUS: phase=1/3"));
check("tokens window 258400", d.tokens?.window === 258400);
check("window_used_pct ≈ 34.6", Math.abs((d.tokens?.window_used_pct ?? 0) - 34.6) < 0.5, String(d.tokens?.window_used_pct));
check("rate limit 90% pro", d.rateLimit?.used_percent === 90 && d.rateLimit?.plan === "pro");
check("subagents include source_scout", d.subagents.includes("source_scout"));
check("event counts track messages", (d.eventCounts["response_item.message"] ?? 0) === 2, JSON.stringify(d.eventCounts));

console.log("\n[core-3] recent events + filters");
let evs = tailer.recentEvents(50);
check("≥8 events buffered", evs.length >= 8, String(evs.length));
check("filter assistant only", tailer.recentEvents(50, ["assistant_message"]).every((e) => e.kind === "assistant_message"));
check("spawn summary includes task name", evs.some((e) => e.kind === "tool_call" && e.summary.includes("task=source_scout")));

console.log("\n[core-4] inbox ticket lifecycle");
const t = inbox.createTicket({ message: "Proceed to phase 2. Do not stop.", targetThreadId: THREAD_ID, priority: "urgent" });
check("ticket created with marker", t.message.startsWith(`${STEERING_MARKER} ${t.ticket}]`));
const pendingFile = path.join(tmp, "bridge", "inbox", "pending", `${t.ticket}.json`);
check("pending file on disk", fs.existsSync(pendingFile));
let state = inbox.listState();
check("listState shows pending", state.pending.length === 1 && state.pending[0].ticket === t.ticket);

console.log("\n[core-5] incremental append + confirmation");
fs.renameSync(pendingFile, path.join(tmp, "bridge", "inbox", "delivered", `${t.ticket}.json`));
// Append in two raw chunks split mid-line to exercise the partial-line buffer:
const confLine = JSON.stringify({
  timestamp: new Date().toISOString(),
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${STEERING_MARKER} ${t.ticket}]\n\nProceed to phase 2. Do not stop.` }] }
}) + "\n";
const mid = Math.floor(confLine.length / 2);
fs.appendFileSync(rolloutPath, confLine.slice(0, mid));
await sleep(350); // tailer sees partial line, must buffer it
fs.appendFileSync(rolloutPath, confLine.slice(mid));
await sleep(500);
check("confirmation callback fired once", confirmed.length === 1 && confirmed[0] === t.ticket, JSON.stringify(confirmed));
state = inbox.listState();
check("delivered ticket has rollout confirmation", !!state.delivered.find((r) => r.ticket === t.ticket)?.confirmed_in_rollout_at);
d = tailer.digest();
check("digest exposes confirmed ticket", d.confirmedSteeringTickets.some((c) => c.ticket === t.ticket));

console.log("\n[core-6] unparseable + unknown lines are tolerated");
fs.appendFileSync(rolloutPath, "this is not json\n" + JSON.stringify({ timestamp: new Date().toISOString(), type: "world_state", payload: {} }) + "\n");
await sleep(500);
d = tailer.digest();
check("unparseable counted, not fatal", (d.eventCounts["unparseable"] ?? 0) === 1);
check("unknown kind counted", (d.eventCounts["world_state"] ?? 0) === 1);
check("tailer still healthy", d.tailerError === null || d.tailerError === undefined || d.tailerError === "", String(d.tailerError));

console.log("\n[core-7] retarget");
const OTHER = "019f9320-5cb8-7ea1-926d-b85ffd0bd146";
fs.writeFileSync(path.join(rolloutDir, `rollout-2026-07-24T09-56-39-${OTHER}.jsonl`),
  JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: OTHER, originator: "codex exec", cli_version: "0.144.6" } }) + "\n");
tailer.retarget(OTHER);
await sleep(300);
d = tailer.digest();
check("retargeted rollout found", d.rolloutFound === true && d.threadId === OTHER);
check("state reset on retarget", d.subagents.length === 0 && !d.lastUserMessage);

console.log("\n[core-8] config isolation (BRIDGE_CONFIG_PATH resolved lazily)");
{
  const isolated = path.join(tmp, "isolated.config.json");
  process.env.BRIDGE_CONFIG_PATH = isolated;
  const { configPath, saveConfig, REPO_ROOT } = await import("../src/config.mjs");
  check("configPath honors env at call time", configPath() === isolated);
  saveConfig({ token: "t", targetThreadId: THREAD_ID });
  check("saveConfig wrote to isolated path", fs.existsSync(isolated));
  const repoCfg = path.join(REPO_ROOT, "bridge.config.json");
  check("repo-root live config untouched", !fs.existsSync(repoCfg) || fs.readFileSync(repoCfg, "utf8").includes("\"token\"") === true && JSON.parse(fs.readFileSync(repoCfg, "utf8")).token !== "t");
  delete process.env.BRIDGE_CONFIG_PATH;
  check("configPath falls back to repo root", configPath() === repoCfg);
}

tailer.stop();
console.log("");
if (failures === 0) { console.log("CORE TEST PASS"); process.exit(0); }
console.error(`CORE TEST FAIL (${failures})`); process.exit(1);
