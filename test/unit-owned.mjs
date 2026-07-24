#!/usr/bin/env node
/**
 * Dependency-free test of the owned-mode consumer + start_mission + the
 * Desktop-writer safety guard, using an injected fake Codex SDK that
 * simulates turns by appending to the target rollout file (so the tailer's
 * marker-confirmation path is exercised end to end).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RolloutTailer, STEERING_MARKER } from "../src/tailer.mjs";
import { Inbox } from "../src/inbox.mjs";
import { OwnedConsumer } from "../src/owned-consumer.mjs";
import { gatherDiagnostics } from "../src/diagnostics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_THREAD = "019f9320-5cb8-7ea1-926d-b85ffd0bd146";
const DESKTOP_THREAD = "019f9315-fc11-7c90-b7ae-304ca4d8f127";
let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ok    ${n}`); else { failures++; console.error(`  FAIL  ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-owned-"));
const codexHome = path.join(tmp, ".codex");
const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(rolloutDir, { recursive: true });

// A CLI-owned target (originator "codex exec") — owned mode allowed here.
const cliRollout = path.join(rolloutDir, `rollout-2026-07-24T09-56-39-${CLI_THREAD}.jsonl`);
fs.writeFileSync(cliRollout, JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: CLI_THREAD, originator: "codex exec", cli_version: "0.144.6" } }) + "\n");

const bridgeDir = path.join(tmp, "bridge");
const cfg = { host: "127.0.0.1", port: 8799, token: "x", targetThreadId: CLI_THREAD, deliveryMode: "owned", codexHome, bridgeDir, pollMs: 200, truncateUser: 2000, truncateAssistant: 4000, allowOwnedForDesktop: false };
const audit = (...a) => { /* quiet */ };
const inbox = new Inbox(bridgeDir);

// Fake Codex SDK: resumeThread().run() appends the user turn to the rollout
// (simulating Codex recording the injected message), like the real engine.
function makeFakeCodex(rolloutPath, { started } = {}) {
  return {
    resumeThread(id) {
      return {
        id,
        async run(text) {
          fs.appendFileSync(rolloutPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n");
          fs.appendFileSync(rolloutPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ack" }] } }) + "\n");
          return { finalResponse: "ack" };
        }
      };
    },
    startThread() {
      const id = "019f9999-aaaa-7bbb-cccc-000000000001";
      return {
        id,
        async runStreamed(prompt) {
          started?.(id, prompt);
          async function* gen() { yield { type: "thread.started", thread_id: id }; yield { type: "turn.completed" }; }
          return { events: gen() };
        }
      };
    }
  };
}

const tailer = new RolloutTailer({ codexHome, threadId: CLI_THREAD, pollMs: 200, onSteeringConfirmed: (t, at) => inbox.markConfirmed(t, at) });
tailer.start();
await sleep(250);

console.log("\n[owned-1] guard allows CLI-owned target");
check("originator is codex exec", tailer.digest().sessionMeta?.originator === "codex exec");

console.log("\n[owned-2] steering delivered by consumer + confirmed via rollout");
{
  const consumer = new OwnedConsumer({ cfg, tailer, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout), setTarget: () => {} });
  const t = inbox.createTicket({ message: "Proceed to phase 2. Do not stop.", targetThreadId: CLI_THREAD, priority: "urgent" });
  consumer.start();
  await sleep(1200);
  consumer.stop();
  const state = inbox.listState();
  check("ticket moved to delivered", state.delivered.some((r) => r.ticket === t.ticket), JSON.stringify(state.pending));
  check("no failures", state.failed.length === 0);
  await sleep(400);
  check("rollout marker confirmed", inbox.confirmedTickets().has(t.ticket));
  check("digest shows confirmation", tailer.digest().confirmedSteeringTickets.some((c) => c.ticket === t.ticket));
}

console.log("\n[owned-3] start_mission command sets new target");
{
  let newTarget = null;
  const consumer = new OwnedConsumer({ cfg, tailer, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout), setTarget: (id) => { newTarget = id; } });
  inbox.createCommand({ type: "start_mission", prompt: "$orchestrate-mission\n\nMission: test.", threadOptions: {} });
  consumer.start();
  await sleep(900);
  consumer.stop();
  check("onThreadId fired -> setTarget called", newTarget === "019f9999-aaaa-7bbb-cccc-000000000001", String(newTarget));
  check("command file consumed", fs.readdirSync(path.join(bridgeDir, "commands")).filter((f) => f.endsWith(".json")).length === 0);
}

console.log("\n[owned-4] Desktop-writer guard blocks delivery");
{
  // Point at a Desktop-owned rollout; consumer must refuse and fail the ticket.
  const desktopRollout = path.join(rolloutDir, `rollout-2026-07-24T07-45-24-${DESKTOP_THREAD}.jsonl`);
  fs.copyFileSync(path.join(__dirname, "fixture-rollout.jsonl"), desktopRollout);
  const cfg2 = { ...cfg, targetThreadId: DESKTOP_THREAD };
  const tailer2 = new RolloutTailer({ codexHome, threadId: DESKTOP_THREAD, pollMs: 150 });
  tailer2.start();
  await sleep(300);
  check("target originator is Desktop", /desktop/i.test(tailer2.digest().sessionMeta?.originator || ""));
  const consumer = new OwnedConsumer({ cfg: cfg2, tailer: tailer2, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(desktopRollout), setTarget: () => {} });
  const t = inbox.createTicket({ message: "should be refused", targetThreadId: DESKTOP_THREAD });
  consumer.start();
  await sleep(700);
  consumer.stop();
  tailer2.stop();
  const state = inbox.listState();
  const row = state.failed.find((r) => r.ticket === t.ticket);
  check("ticket failed (not delivered)", !!row && !state.delivered.some((r) => r.ticket === t.ticket));
  const failFile = fs.readFileSync(path.join(bridgeDir, "inbox", "failed", `${t.ticket}.json`), "utf8");
  check("failure explains dual-writer guard", /Desktop-owned|dual-writer/i.test(failFile));
}

console.log("\n[owned-5] diagnostics never throws + reports essentials");
{
  const diag = gatherDiagnostics({ cfg, tailer, startedAt: new Date().toISOString(), restartsLogPath: path.join(bridgeDir, "logs", "restarts.jsonl") });
  check("diag.ok", diag.ok === true);
  check("has platform + node", !!diag.platform?.type && !!diag.node);
  check("reports target rollout", diag.target?.threadId === CLI_THREAD);
  check("codexVersion probed (string or error object)", diag.codexVersion !== undefined);
}

tailer.stop();
console.log("");
if (failures === 0) { console.log("OWNED TEST PASS"); process.exit(0); }
console.error(`OWNED TEST FAIL (${failures})`); process.exit(1);
