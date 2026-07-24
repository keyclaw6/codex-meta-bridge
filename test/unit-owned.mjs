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
import { TailerPool } from "../src/tailer-pool.mjs";
import { Inbox } from "../src/inbox.mjs";
import { OwnedConsumer } from "../src/owned-consumer.mjs";
import { deliverOwned } from "../src/owned.mjs";
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
const cfg = { host: "127.0.0.1", port: 8799, token: "x", targetThreadId: CLI_THREAD, deliveryMode: "owned", codexHome, bridgeDir, pollMs: 200, truncateUser: 2000, truncateAssistant: 4000, default_mission_cwd: "C:\\fallback", default_mission_sandbox: "workspace-write", allowOwnedForDesktop: false };
const audit = (...a) => { /* quiet */ };
const inbox = new Inbox(bridgeDir);

// Fake Codex SDK: resumeThread().run() appends the user turn to the rollout
// (simulating Codex recording the injected message), like the real engine.
function makeFakeCodex(rolloutPath, { started, resumed, ran } = {}) {
  return {
    resumeThread(id, options) {
      resumed?.(id, options);
      return {
        id,
        async run(text, turnOptions) {
          ran?.(id, turnOptions);
          fs.appendFileSync(rolloutPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n");
          fs.appendFileSync(rolloutPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ack" }] } }) + "\n");
          return { finalResponse: "ack" };
        }
      };
    },
    startThread(options) {
      const id = "019f9999-aaaa-7bbb-cccc-000000000001";
      return {
        id,
        async runStreamed(prompt, turnOptions) {
          started?.(id, prompt, options, turnOptions);
          async function* gen() { yield { type: "thread.started", thread_id: id }; yield { type: "turn.completed" }; }
          return { events: gen() };
        }
      };
    }
  };
}

const pool = new TailerPool({ codexHome, pollMs: 200, onSteeringConfirmed: (t, at) => inbox.markConfirmed(t, at) });
const tailer = pool.get(CLI_THREAD);
await sleep(250);

console.log("\n[owned-1] guard allows CLI-owned target");
check("originator is codex exec", tailer.digest().sessionMeta?.originator === "codex exec");

console.log("\n[owned-2] steering delivered by consumer + confirmed via rollout");
{
  let resumeOptions = null;
  let turnSignal = null;
  const consumer = new OwnedConsumer({ cfg, pool, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout, { resumed: (_id, options) => { resumeOptions = options; }, ran: (_id, options) => { turnSignal = options?.signal; } }), setTarget: () => {} });
  const t = inbox.createTicket({ message: "Proceed to phase 2. Do not stop.", targetThreadId: CLI_THREAD, priority: "urgent" });
  consumer.start();
  await sleep(1200);
  consumer.stop();
  const state = inbox.listState();
  check("ticket moved to delivered", state.delivered.some((r) => r.ticket === t.ticket), JSON.stringify(state.pending));
  check("no failures", state.failed.length === 0);
  check("unrecorded thread resume uses configured fallback options", resumeOptions?.workingDirectory === "C:\\fallback" && resumeOptions?.sandboxMode === "workspace-write" && resumeOptions?.approvalPolicy === "never", JSON.stringify(resumeOptions));
  check("owned steering receives an AbortSignal", turnSignal instanceof AbortSignal);
  await sleep(400);
  check("rollout marker confirmed", inbox.confirmedTickets().has(t.ticket));
  check("digest shows confirmation", tailer.digest().confirmedSteeringTickets.some((c) => c.ticket === t.ticket));
}

console.log("\n[owned-3] start_mission command sets new target");
{
  let newTarget = null;
  let targetOptions = null;
  let sdkOptions = null;
  let startSignal = null;
  const consumer = new OwnedConsumer({ cfg, pool, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout, { started: (_id, _prompt, options, turnOptions) => { sdkOptions = options; startSignal = turnOptions?.signal; } }), setTarget: (id, options) => { newTarget = id; targetOptions = options; } });
  inbox.createCommand({ type: "start_mission", prompt: "$orchestrate-mission\n\nMission: test.", threadOptions: { workingDirectory: "C:\\mission", sandboxMode: "danger-full-access", approvalPolicy: "never" } });
  consumer.start();
  await sleep(900);
  consumer.stop();
  check("onThreadId fired -> setTarget called", newTarget === "019f9999-aaaa-7bbb-cccc-000000000001", String(newTarget));
  check("SDK receives cwd + sandbox + never approval", sdkOptions?.workingDirectory === "C:\\mission" && sdkOptions?.sandboxMode === "danger-full-access" && sdkOptions?.approvalPolicy === "never", JSON.stringify(sdkOptions));
  check("started mission receives an AbortSignal", startSignal instanceof AbortSignal);
  check("recent mission metadata receives effective options", targetOptions?.cwd === "C:\\mission" && targetOptions?.sandbox_mode === "danger-full-access", JSON.stringify(targetOptions));
  check("command file consumed", fs.readdirSync(path.join(bridgeDir, "commands")).filter((f) => f.endsWith(".json")).length === 0);

  const reloadedInbox = new Inbox(bridgeDir);
  const stored = reloadedInbox.missionOptions(newTarget);
  check("mission options persist across inbox reload", stored?.cwd === "C:\\mission" && stored?.sandbox_mode === "danger-full-access" && stored?.approval_policy === "never", JSON.stringify(stored));

  let resumedOptions = null;
  const resumedConsumer = new OwnedConsumer({ cfg, pool, inbox: reloadedInbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout, { resumed: (_id, options) => { resumedOptions = options; } }), setTarget: () => {} });
  reloadedInbox.createTicket({ message: "resume with launch options", targetThreadId: newTarget });
  resumedConsumer.start();
  await sleep(700);
  resumedConsumer.stop();
  check("steering resume restores persisted launch options", resumedOptions?.workingDirectory === "C:\\mission" && resumedOptions?.sandboxMode === "danger-full-access" && resumedOptions?.approvalPolicy === "never", JSON.stringify(resumedOptions));

  let helperOptions = null;
  await deliverOwned({ targetThreadId: newTarget, message: "helper resume", ticket: "helper-ticket", cfg, inbox: reloadedInbox, codexFactory: () => makeFakeCodex(cliRollout, { resumed: (_id, options) => { helperOptions = options; } }) });
  check("shared resume helper restores persisted launch options", helperOptions?.workingDirectory === "C:\\mission" && helperOptions?.sandboxMode === "danger-full-access" && helperOptions?.approvalPolicy === "never", JSON.stringify(helperOptions));
}

console.log("\n[owned-4] Desktop-writer guard routes to liaison (mixed mode)");
{
  // Point at a Desktop-owned rollout; consumer must NOT run it via SDK — the
  // ticket stays in pending for the Desktop liaison pump.
  const desktopRollout = path.join(rolloutDir, `rollout-2026-07-24T07-45-24-${DESKTOP_THREAD}.jsonl`);
  fs.copyFileSync(path.join(__dirname, "fixture-rollout.jsonl"), desktopRollout);
  const cfg2 = { ...cfg, targetThreadId: DESKTOP_THREAD };
  const t2 = pool.get(DESKTOP_THREAD); // pre-warm so originator is read before the consumer runs
  await sleep(300);
  check("target originator is Desktop", /desktop/i.test(t2.digest().sessionMeta?.originator || ""));
  let sdkTouched = false;
  const guardedFake = () => { sdkTouched = true; return makeFakeCodex(desktopRollout); };
  const consumer = new OwnedConsumer({ cfg: cfg2, pool, inbox, audit, pollMs: 150, codexFactory: guardedFake, setTarget: () => {} });
  const t = inbox.createTicket({ message: "should be left for liaison", targetThreadId: DESKTOP_THREAD });
  consumer.start();
  await sleep(700);
  consumer.stop();
  const state = inbox.listState();
  check("ticket left in pending for liaison", state.pending.some((r) => r.ticket === t.ticket));
  check("not delivered, not failed", !state.delivered.some((r) => r.ticket === t.ticket) && !state.failed.some((r) => r.ticket === t.ticket));
  check("SDK never invoked for Desktop target", sdkTouched === false);
  // cleanup: simulate the liaison delivering it so later phases see a clean inbox
  fs.renameSync(path.join(bridgeDir, "inbox", "pending", `${t.ticket}.json`), path.join(bridgeDir, "inbox", "delivered", `${t.ticket}.json`));
}

console.log("\n[owned-5] diagnostics never throws + reports essentials");
{
  const diag = gatherDiagnostics({ cfg, tailer, startedAt: new Date().toISOString(), restartsLogPath: path.join(bridgeDir, "logs", "restarts.jsonl") });
  check("diag.ok", diag.ok === true);
  check("has platform + node", !!diag.platform?.type && !!diag.node);
  check("reports target rollout", diag.target?.threadId === CLI_THREAD);
  check("codexVersion probed (string or error object)", diag.codexVersion !== undefined);
}

console.log("\n[owned-6] recovery interruption requires an active owned turn");
{
  const consumer = new OwnedConsumer({ cfg, pool, inbox, audit, codexFactory: () => makeFakeCodex(cliRollout), setTarget: () => {} });
  const controller = new AbortController();
  consumer.activeTurns.set(CLI_THREAD, controller);
  check("interruptTurn reports active turn", consumer.interruptTurn(CLI_THREAD) === true);
  check("interruptTurn aborts the SDK signal", controller.signal.aborted === true);
  consumer.activeTurns.delete(CLI_THREAD);
  check("interruptTurn rejects idle thread", consumer.interruptTurn(CLI_THREAD) === false);
}

pool.stopAll();
console.log("");
if (failures === 0) { console.log("OWNED TEST PASS"); process.exit(0); }
console.error(`OWNED TEST FAIL (${failures})`); process.exit(1);
