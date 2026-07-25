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
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  return predicate();
};

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
const noWriterProcesses = async () => [];
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
      const startedRollout = path.join(
        path.dirname(rolloutPath),
        `rollout-2026-07-24T10-00-00-${id}.jsonl`
      );
      fs.writeFileSync(startedRollout, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: { id, originator: "codex exec", cli_version: "test" }
      }) + "\n");
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
  const consumer = new OwnedConsumer({ cfg, pool, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout, { resumed: (_id, options) => { resumeOptions = options; }, ran: (_id, options) => { turnSignal = options?.signal; } }), setTarget: () => {}, writerProcesses: noWriterProcesses });
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
  const consumer = new OwnedConsumer({ cfg, pool, inbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout, { started: (_id, _prompt, options, turnOptions) => { sdkOptions = options; startSignal = turnOptions?.signal; } }), setTarget: (id, options) => { newTarget = id; targetOptions = options; }, writerProcesses: noWriterProcesses });
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
  const resumedConsumer = new OwnedConsumer({ cfg, pool, inbox: reloadedInbox, audit, pollMs: 150, codexFactory: () => makeFakeCodex(cliRollout, { resumed: (_id, options) => { resumedOptions = options; } }), setTarget: () => {}, writerProcesses: noWriterProcesses });
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
  const consumer = new OwnedConsumer({ cfg: cfg2, pool, inbox, audit, pollMs: 150, codexFactory: guardedFake, setTarget: () => {}, writerProcesses: noWriterProcesses });
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

console.log("\n[owned-6] recovery interruption settles and the same thread remains usable");
{
  const interruptInbox = new Inbox(path.join(tmp, "interrupt-bridge"));
  let runCount = 0;
  let firstTurnEntered = false;
  let abortObserved = false;
  let secondTurnCompleted = false;
  const fakeCodex = {
    resumeThread(id) {
      return {
        id,
        async run(_message, { signal }) {
          runCount++;
          if (runCount === 1) {
            firstTurnEntered = true;
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("fake SDK turn was not interrupted")), 1500);
              signal.addEventListener("abort", () => {
                clearTimeout(timeout);
                abortObserved = true;
                reject(signal.reason || new Error("aborted"));
              }, { once: true });
            });
          }
          secondTurnCompleted = true;
          return { finalResponse: "ack after interrupt" };
        }
      };
    }
  };
  const interruptPool = { get: () => ({ digest: () => ({ sessionMeta: { originator: "codex exec" } }) }) };
  const consumer = new OwnedConsumer({
    cfg,
    pool: interruptPool,
    inbox: interruptInbox,
    audit,
    pollMs: 20,
    codexFactory: () => fakeCodex,
    setTarget: () => {},
    writerProcesses: noWriterProcesses
  });
  const interruptedTicket = interruptInbox.createTicket({ message: "long fake turn", targetThreadId: CLI_THREAD });
  consumer.start();
  check("fake SDK turn is genuinely in flight", await waitFor(() => firstTurnEntered && consumer.activeTurns.has(CLI_THREAD)));
  const interruptedAt = Date.now();
  check("interruptTurn reports the in-flight turn", consumer.interruptTurn(CLI_THREAD) === true);
  const interruptedSettled = await waitFor(() => {
    const state = interruptInbox.listState();
    return abortObserved &&
      state.failed.some((row) => row.ticket === interruptedTicket.ticket) &&
      state.delivering.length === 0 &&
      !consumer.activeTurns.has(CLI_THREAD) &&
      !consumer.threadQueues.has(CLI_THREAD);
  }, 1000);
  check("interrupted turn settles and cleans up within one second", interruptedSettled && Date.now() - interruptedAt < 1000);

  const recoveryTicket = interruptInbox.createTicket({ message: "same thread after interrupt", targetThreadId: CLI_THREAD });
  check("a subsequent same-thread turn succeeds", await waitFor(() => (
    secondTurnCompleted && interruptInbox.listState().delivered.some((row) => row.ticket === recoveryTicket.ticket)
  ), 1000));
  check("same-thread recovery leaves no active turn or queue", !consumer.activeTurns.has(CLI_THREAD) && !consumer.threadQueues.has(CLI_THREAD));
  check("interruptTurn rejects the now-idle thread", consumer.interruptTurn(CLI_THREAD) === false);
  consumer.stop();
}

console.log("\n[owned-6b] idle same-thread tickets run through one FIFO writer");
{
  const fifoInbox = new Inbox(path.join(tmp, "fifo-bridge"));
  const expectedTickets = [];
  for (const message of ["fifo one", "fifo two", "fifo three", "fifo four"]) {
    expectedTickets.push(fifoInbox.createTicket({ message, targetThreadId: CLI_THREAD }));
    await sleep(5);
  }
  let activeWriters = 0;
  let maxWriters = 0;
  const startedMessages = [];
  const completedMessages = [];
  const fakeCodex = {
    resumeThread(id) {
      return {
        id,
        async run(message) {
          activeWriters++;
          maxWriters = Math.max(maxWriters, activeWriters);
          startedMessages.push(message);
          try {
            await sleep(30);
            completedMessages.push(message);
            return { finalResponse: "ack" };
          } finally {
            activeWriters--;
          }
        }
      };
    }
  };
  const fifoPool = { get: () => ({ digest: () => ({ sessionMeta: { originator: "codex exec" } }) }) };
  const consumer = new OwnedConsumer({
    cfg,
    pool: fifoPool,
    inbox: fifoInbox,
    audit,
    pollMs: 20,
    codexFactory: () => fakeCodex,
    setTarget: () => {},
    writerProcesses: noWriterProcesses
  });
  check("same thread is idle before the batch", consumer.activeTurns.size === 0 && consumer.threadQueues.size === 0);
  consumer.start();
  check("all same-thread tickets are delivered", await waitFor(() => fifoInbox.listState().delivered.length === expectedTickets.length, 1500));
  const expectedMessages = expectedTickets.map((ticket) => ticket.message);
  check("same-thread batch has maximum one writer", maxWriters === 1, `max=${maxWriters}`);
  check("same-thread starts preserve exact ticket order", JSON.stringify(startedMessages) === JSON.stringify(expectedMessages), JSON.stringify(startedMessages));
  check("same-thread completions preserve exact ticket order", JSON.stringify(completedMessages) === JSON.stringify(expectedMessages), JSON.stringify(completedMessages));
  check("FIFO queue cleans up after the batch", activeWriters === 0 && !consumer.activeTurns.has(CLI_THREAD) && !consumer.threadQueues.has(CLI_THREAD));
  consumer.stop();
}

console.log("\n[owned-7] busy thread does not block other steering or mission start");
{
  const testBridgeDir = path.join(tmp, "concurrent-bridge");
  const testInbox = new Inbox(testBridgeDir);
  const threadA = "019f9320-5cb8-7ea1-926d-b85ffd0bd146";
  const threadB = "019f9320-5cb8-7ea1-926d-b85ffd0bd147";
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  let startedA = false;
  let deliveredB = false;
  let missionStarted = false;
  const fakeCodex = {
    resumeThread(id) {
      return {
        id,
        async run() {
          if (id === threadA) {
            startedA = true;
            await gateA;
          } else if (id === threadB) {
            deliveredB = true;
          }
          return { finalResponse: "ack" };
        }
      };
    },
    startThread() {
      const id = "019f9999-aaaa-7bbb-cccc-000000000002";
      const startedRollout = path.join(
        rolloutDir,
        `rollout-2026-07-24T10-00-00-${id}.jsonl`
      );
      fs.writeFileSync(startedRollout, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: { id, originator: "codex exec", cli_version: "test" }
      }) + "\n");
      return {
        id,
        async runStreamed() {
          missionStarted = true;
          async function* events() { yield { type: "thread.started", thread_id: id }; }
          return { events: events() };
        }
      };
    }
  };
  const testPool = { get: () => ({ digest: () => ({ sessionMeta: { originator: "codex exec" } }) }) };
  const consumer = new OwnedConsumer({
    cfg,
    pool: testPool,
    inbox: testInbox,
    audit,
    pollMs: 20,
    codexFactory: () => fakeCodex,
    setTarget: () => {},
    writerProcesses: noWriterProcesses
  });
  const ticketA = testInbox.createTicket({ message: "block A", targetThreadId: threadA });
  consumer.start();
  check("thread A entered its long turn", await waitFor(() => startedA));

  const ticketB = testInbox.createTicket({ message: "deliver B", targetThreadId: threadB });
  testInbox.createCommand({ type: "start_mission", prompt: "start while A is busy" });
  check("thread B delivered while A remained busy", await waitFor(() => deliveredB));
  check("mission started while A remained busy", await waitFor(() => missionStarted));
  check("thread A is still in flight", consumer.activeTurns.has(threadA));

  releaseA();
  check("both steering tickets reach delivered", await waitFor(() => {
    const delivered = testInbox.listState().delivered;
    return delivered.some((r) => r.ticket === ticketA.ticket) && delivered.some((r) => r.ticket === ticketB.ticket);
  }));
  consumer.stop();
}

pool.stopAll();
console.log("");
if (failures === 0) { console.log("OWNED TEST PASS"); process.exit(0); }
console.error(`OWNED TEST FAIL (${failures})`); process.exit(1);
