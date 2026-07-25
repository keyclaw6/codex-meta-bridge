#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Inbox } from "../src/inbox.mjs";
import { OwnedConsumer } from "../src/owned-consumer.mjs";
import { StartCoordinator, StartCoordinatorError, atomicWriteJson } from "../src/start-coordinator.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-start-flow-"));
let checks = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok    ${name}`);
};
const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
};

console.log("\n[start-flow-1] one visible binding, one writer, one FIFO");
const bridgeDir = path.join(tmp, "bridge");
const codexHome = path.join(tmp, ".codex");
const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "25");
fs.mkdirSync(rolloutDir, { recursive: true });
const threadId = "019f9999-aaaa-7bbb-cccc-000000001111";
const rolloutPath = path.join(rolloutDir, `rollout-2026-07-25T10-00-00-${threadId}.jsonl`);
const cfg = {
  bridgeDir,
  codexHome,
  targetThreadId: null,
  default_mission_cwd: "C:\\mission",
  default_mission_sandbox: "workspace-write",
  allowOwnedForDesktop: false
};
const inbox = new Inbox(bridgeDir);
const coordinatorPath = path.join(bridgeDir, "state", "start-bindings.json");
const coordinator = new StartCoordinator({ statePath: coordinatorPath });
let releaseFirstTurn;
const firstTurnGate = new Promise((resolve) => { releaseFirstTurn = resolve; });
let startCount = 0;
let resumeCount = 0;
let viewerLaunchCount = 0;
let writerProbeCount = 0;
let resumeStarted = false;
let rolloutBusy = false;
const fakeCodex = {
  startThread() {
    startCount++;
    fs.writeFileSync(rolloutPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: threadId, originator: "codex exec", cli_version: "test" }
    }) + "\n");
    return {
      id: threadId,
      async runStreamed() {
        async function* events() {
          yield { type: "thread.started", thread_id: threadId };
          await firstTurnGate;
          yield { type: "turn.completed" };
        }
        return { events: events() };
      }
    };
  },
  resumeThread() {
    resumeCount++;
    return {
      async run() {
        resumeStarted = true;
        return { finalResponse: "steering complete" };
      }
    };
  }
};
const pool = {
  get() {
    return {
      digest() {
        return {
          rolloutFound: true,
          rolloutPath,
          idleSeconds: rolloutBusy ? 0 : 120,
          active_command: rolloutBusy ? { summary: "active turn" } : null,
          sessionMeta: { originator: "codex exec" }
        };
      }
    };
  }
};
const audit = () => {};
const viewerLauncher = async ({
  bindingId,
  threadId: receivedThreadId,
  receiptPath,
  receiptNonce
}) => {
  viewerLaunchCount++;
  const viewerTitle = `Codex Meta ${bindingId.slice(0, 12)}`;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify({
    binding_id: bindingId,
    thread_id: receivedThreadId,
    rollout_path: rolloutPath,
    receipt_nonce: receiptNonce,
    viewer_pid: 6101,
    viewer_title: viewerTitle,
    started_at: new Date().toISOString()
  }));
  return {
    binding_id: bindingId,
    thread_id: receivedThreadId,
    receipt_nonce: receiptNonce,
    rollout_path: rolloutPath,
    viewer_pid: 6101,
    viewer_title: viewerTitle,
    window_pid: 6102,
    window_handle: "6103",
    session_id: 7
  };
};
const writerProcesses = async () => {
  writerProbeCount++;
  return writerProbeCount === 1 ? [] : [{ pid: 6001, name: "codex.exe" }];
};
const consumer = new OwnedConsumer({
  cfg,
  pool,
  inbox,
  audit,
  codexFactory: () => fakeCodex,
  setTarget: () => {},
  startCoordinator: coordinator,
  visibleViewerLauncher: viewerLauncher,
  writerProcesses
});
const startArgs = {
  requestKey: "visible-flow-1",
  startType: "start_visible_cli_mission",
  prompt: "Unique visible mission",
  threadOptions: {
    workingDirectory: "C:\\mission",
    sandboxMode: "workspace-write",
    approvalPolicy: "never"
  }
};
const [firstStart, duplicateStart] = await Promise.all([
  consumer.startMission(startArgs),
  consumer.startMission({ ...startArgs, threadOptions: { ...startArgs.threadOptions } })
]);
check("concurrent same-key requests start one SDK thread", startCount === 1);
check("concurrent same-key requests launch one viewer", viewerLaunchCount === 1);
check("one response is the durable reuse", [firstStart.reused, duplicateStart.reused].filter(Boolean).length === 1);
check("visible activation binds one thread and writer identity", firstStart.thread_id === threadId && firstStart.writer_owner_pid === process.pid && firstStart.writer_pid === 6001);
check(
  "visible surface binds launch, viewer, Windows Terminal, HWND, and session",
  Boolean(firstStart.viewer_launch_id) &&
    firstStart.viewer_pid === 6101 &&
    firstStart.viewer_window_pid === 6102 &&
    firstStart.viewer_hwnd === "6103" &&
    firstStart.viewer_window_session_id === 7
);
check("first SDK turn remains the active FIFO head", consumer.threadQueues.has(threadId) && consumer.activeTurns.has(threadId));

const steering = inbox.createTicket({
  message: "Steer while the initial turn is busy",
  targetThreadId: threadId
});
await consumer.processPending();
await new Promise((resolve) => setTimeout(resolve, 30));
check("busy steering is claimed but cannot overtake the initial turn", inbox.listState().delivering.some((row) => row.ticket === steering.ticket) && !resumeStarted);
releaseFirstTurn();
check("queued steering runs after the initial turn", await waitFor(() => resumeStarted && inbox.listState().delivered.some((row) => row.ticket === steering.ticket)));
check("exactly one later SDK resume wrote the thread", resumeCount === 1);

await assert.rejects(
  consumer.startMission({ ...startArgs, requestKey: "other-visible", prompt: "conflict" }),
  (error) => error instanceof StartCoordinatorError && error.code === "VISIBLE_LEASE_CONFLICT"
);
checks++;
console.log("  ok    different visible request cannot create a duplicate");
await assert.rejects(
  consumer.startMission({
    ...startArgs,
    requestKey: "legacy-headless",
    startType: "start_mission",
    prompt: "legacy conflict"
  }),
  (error) => error instanceof StartCoordinatorError && error.code === "VISIBLE_LEASE_CONFLICT"
);
checks++;
console.log("  ok    legacy start_mission cannot bypass the visible lease");

inbox.createCommand({
  type: "start_mission",
  request_key: "legacy-command",
  prompt: "queued legacy conflict",
  threadOptions: startArgs.threadOptions
});
await consumer.processCommands();
check("legacy command ingestion also uses the same coordinator", startCount === 1 && fs.readdirSync(path.join(bridgeDir, "commands")).filter((file) => file.endsWith(".json")).length === 0);

console.log("\n[start-flow-2] headless publication boundary preserves one FIFO writer");
const headlessBridgeDir = path.join(tmp, "headless", "bridge");
const headlessCodexHome = path.join(tmp, "headless", ".codex");
const headlessRolloutDir = path.join(headlessCodexHome, "sessions", "2026", "07", "25");
fs.mkdirSync(headlessRolloutDir, { recursive: true });
const headlessThreadId = "019f9999-aaaa-7bbb-cccc-000000002222";
const headlessRolloutPath = path.join(
  headlessRolloutDir,
  `rollout-2026-07-25T11-00-00-${headlessThreadId}.jsonl`
);
const headlessInbox = new Inbox(headlessBridgeDir);
let releaseActiveCommit;
const activeCommitGate = new Promise((resolve) => { releaseActiveCommit = resolve; });
let publicationHeldResolve;
const publicationHeld = new Promise((resolve) => { publicationHeldResolve = resolve; });
let holdFreshActiveCommit = true;
const headlessCoordinator = new StartCoordinator({
  statePath: path.join(headlessBridgeDir, "state", "start-bindings.json"),
  persistSnapshot: async (statePath, snapshot) => {
    const fresh = snapshot.records.find((record) => record.request_key === "fresh-headless");
    if (holdFreshActiveCommit && fresh?.state === "active") {
      publicationHeldResolve();
      await activeCommitGate;
      holdFreshActiveCommit = false;
    }
    await atomicWriteJson(statePath, snapshot);
  }
});
await headlessCoordinator.reserve({
  requestKey: "abandoned-reserved",
  normalizedPayload: { prompt: "never started" },
  type: "start_mission",
  visibility: "headless"
});

let releaseHeadlessInitial;
const headlessInitialGate = new Promise((resolve) => { releaseHeadlessInitial = resolve; });
let headlessStartCount = 0;
let headlessResumeCount = 0;
let activeWriters = 0;
let maximumActiveWriters = 0;
const writerOrder = [];
const enterWriter = (name) => {
  activeWriters++;
  maximumActiveWriters = Math.max(maximumActiveWriters, activeWriters);
  writerOrder.push(`${name}:start`);
};
const leaveWriter = (name) => {
  writerOrder.push(`${name}:end`);
  activeWriters--;
};
const headlessCodex = {
  startThread() {
    headlessStartCount++;
    fs.writeFileSync(headlessRolloutPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: headlessThreadId, originator: "codex exec", cli_version: "test" }
    })}\n`);
    return {
      id: headlessThreadId,
      async runStreamed() {
        enterWriter("initial");
        async function* events() {
          try {
            yield { type: "thread.started", thread_id: headlessThreadId };
            await headlessInitialGate;
            yield { type: "turn.completed" };
          } finally {
            leaveWriter("initial");
          }
        }
        return { events: events() };
      }
    };
  },
  resumeThread() {
    headlessResumeCount++;
    return {
      async run() {
        enterWriter("steering");
        await Promise.resolve();
        leaveWriter("steering");
        return { finalResponse: "headless steering complete" };
      }
    };
  }
};
let publishedHeadlessTarget = null;
const headlessConsumer = new OwnedConsumer({
  cfg: {
    ...cfg,
    bridgeDir: headlessBridgeDir,
    codexHome: headlessCodexHome
  },
  pool: {
    get() {
      return { digest: () => ({ sessionMeta: { originator: "codex exec" } }) };
    }
  },
  inbox: headlessInbox,
  audit,
  codexFactory: () => headlessCodex,
  setTarget: (id) => { publishedHeadlessTarget = id; },
  startCoordinator: headlessCoordinator,
  rolloutResolver: async () => headlessRolloutPath,
  writerProcesses: async () => []
});

await headlessConsumer.reconcileAfterRestart();
const abandoned = headlessCoordinator.get("abandoned-reserved");
check(
  "restart terminalizes an abandoned reservation as pre-side-effect recovery",
  abandoned.state === "terminal" && /before any side effects/.test(abandoned.reason)
);

const freshHeadlessStart = headlessConsumer.startMission({
  requestKey: "fresh-headless",
  startType: "start_mission",
  prompt: "fresh headless mission",
  threadOptions: {
    workingDirectory: "C:\\mission",
    sandboxMode: "workspace-write",
    approvalPolicy: "never"
  }
});
await publicationHeld;
check(
  "publication boundary is held after target publication with the initial turn already queued",
  publishedHeadlessTarget === headlessThreadId &&
    headlessCoordinator.get("fresh-headless").state === "thread-bound" &&
    headlessConsumer.threadQueues.has(headlessThreadId) &&
    headlessConsumer.activeTurns.has(headlessThreadId)
);

const publicationTicket = headlessInbox.createTicket({
  message: "steer at the headless publication boundary",
  targetThreadId: headlessThreadId
});
await headlessConsumer.processPending();
check(
  "thread-bound headless steering remains pending until durable active",
  headlessInbox.listState().pending.some((row) => row.ticket === publicationTicket.ticket) &&
    headlessResumeCount === 0 &&
    activeWriters === 1
);

releaseActiveCommit();
const freshHeadlessResult = await freshHeadlessStart;
check(
  "a fresh key starts after reserved recovery and publishes active",
  freshHeadlessResult.state === "active" && headlessStartCount === 1
);
await headlessConsumer.processPending();
await new Promise((resolve) => setTimeout(resolve, 30));
check(
  "active steering is claimed behind the initial FIFO head without a second writer",
  headlessInbox.listState().delivering.some((row) => row.ticket === publicationTicket.ticket) &&
    headlessResumeCount === 0 &&
    activeWriters === 1
);

releaseHeadlessInitial();
check(
  "headless steering runs after the initial writer and reaches delivered",
  await waitFor(() => (
    headlessInbox.listState().delivered.some((row) => row.ticket === publicationTicket.ticket) &&
    headlessResumeCount === 1
  ))
);
check(
  "publication-boundary execution has exactly one writer and strict FIFO order",
  maximumActiveWriters === 1 &&
    activeWriters === 0 &&
    JSON.stringify(writerOrder) === JSON.stringify([
      "initial:start", "initial:end", "steering:start", "steering:end"
    ])
);
check(
  "headless completion becomes terminal only after active was durably published",
  await waitFor(() => headlessCoordinator.get("fresh-headless").state === "terminal")
);
check(
  "headless terminal reached through active permits normal later steering",
  headlessConsumer.steeringBlockReason(headlessThreadId) === null
);

console.log("\n[start-flow-3] restart reconciliation and safe stale release");
let writerAlive = true;
let viewerAlive = true;
let windowOverrides = {};
rolloutBusy = true;
const restartedCoordinator = new StartCoordinator({ statePath: coordinatorPath });
const restartedConsumer = new OwnedConsumer({
  cfg,
  pool,
  inbox,
  audit,
  codexFactory: () => fakeCodex,
  setTarget: () => {},
  startCoordinator: restartedCoordinator,
  viewerInspector: async (title) => viewerAlive ? {
    window_pid: 6102,
    window_handle: "6103",
    session_id: 7,
    title,
    ...windowOverrides
  } : null,
  processExistsImpl: (pid) => Number(pid) === 6001 ? writerAlive : viewerAlive,
  writerProcesses: async () => [],
  staleReleaseMs: 0
});
await restartedConsumer.reconcileAfterRestart();
check("restart during an active writer turn remains fail-closed", restartedCoordinator.get("visible-flow-1").state === "uncertain");
check("uncertain restarted turn rejects steering", /uncertain/.test(restartedConsumer.steeringBlockReason(threadId)));
writerAlive = false;
rolloutBusy = false;
const activeBinding = restartedCoordinator.get("visible-flow-1").binding;
const persistedReceipt = JSON.parse(fs.readFileSync(activeBinding.receipt_path, "utf8"));
const writePersistedReceipt = (patch = {}) => fs.writeFileSync(
  activeBinding.receipt_path,
  JSON.stringify({ ...persistedReceipt, ...patch }, null, 2)
);

writePersistedReceipt({ binding_id: "wrong-launch-binding" });
await restartedConsumer.reconcileUncertainBindings();
check("wrong receipt binding ID remains fail-closed", restartedCoordinator.get("visible-flow-1").state === "uncertain");
writePersistedReceipt({ viewer_pid: 6199 });
await restartedConsumer.reconcileUncertainBindings();
check("receipt viewer PID differing from persisted viewer PID remains fail-closed", restartedCoordinator.get("visible-flow-1").state === "uncertain");
writePersistedReceipt();

for (const [name, overrides] of [
  ["Windows Terminal PID", { window_pid: 6199 }],
  ["HWND", { window_handle: "6198" }],
  ["exact title", { title: "Codex Meta wrong-title" }],
  ["window session", { session_id: 8 }]
]) {
  windowOverrides = overrides;
  await restartedConsumer.reconcileUncertainBindings();
  check(
    `re-observed ${name} differing from persisted evidence remains fail-closed`,
    restartedCoordinator.get("visible-flow-1").state === "uncertain"
  );
}
windowOverrides = {};
await restartedConsumer.reconcileUncertainBindings();
check("restart restores active only after writer exit plus matching viewer and idle-rollout evidence", restartedCoordinator.get("visible-flow-1").state === "active");
check("reconciled active binding permits FIFO steering", restartedConsumer.steeringBlockReason(threadId) === null);

await restartedCoordinator.markUncertain("visible-flow-1", "viewer exited");
viewerAlive = false;
await restartedConsumer.reconcileUncertainBindings();
check("dead viewer releases only after writer absence, idle rollout, and empty queues", restartedCoordinator.get("visible-flow-1").state === "terminal");
check("visible terminal remains blocked for steering", /terminal/.test(restartedConsumer.steeringBlockReason(threadId)));
await restartedCoordinator.reserve({
  requestKey: "visible-after-release",
  normalizedPayload: { prompt: "new", working_directory: "C:\\mission" },
  type: "start_visible_cli_mission",
  visibility: "visible"
});
check("safe terminal reconciliation releases the visible lease", restartedCoordinator.get("visible-after-release").state === "reserved");

console.log("\n[start-flow-4] viewer-starting crash can bind first positive after-side evidence");
const preactiveBridgeDir = path.join(tmp, "preactive");
const preactiveInbox = new Inbox(preactiveBridgeDir);
const preactiveCoordinator = new StartCoordinator({
  statePath: path.join(preactiveBridgeDir, "state", "start-bindings.json")
});
const preactiveThreadId = "019f9999-aaaa-7bbb-cccc-000000003333";
const preactiveRolloutPath = path.join(rolloutDir, `rollout-preactive-${preactiveThreadId}.jsonl`);
const preactiveReceiptPath = path.join(preactiveBridgeDir, "state", "viewer-receipts", "launch-preactive.json");
fs.mkdirSync(path.dirname(preactiveReceiptPath), { recursive: true });
fs.writeFileSync(preactiveRolloutPath, "{}\n");
await preactiveCoordinator.reserve({
  requestKey: "preactive",
  normalizedPayload: { prompt: "preactive crash" },
  type: "start_visible_cli_mission",
  visibility: "visible"
});
await preactiveCoordinator.transition("preactive", "thread-starting");
await preactiveCoordinator.transition("preactive", "thread-bound", {
  binding: {
    thread_id: preactiveThreadId,
    rollout_path: preactiveRolloutPath,
    writer_pid: 7200
  }
});
await preactiveCoordinator.transition("preactive", "viewer-starting", {
  binding: {
    viewer_launch_id: "launch-preactive",
    viewer_title: "Codex Meta launch-preac",
    receipt_path: preactiveReceiptPath,
    receipt_nonce: "nonce-preactive"
  }
});
await preactiveCoordinator.markUncertain("preactive", "crash after viewer spawn before active receipt commit");
fs.writeFileSync(preactiveReceiptPath, JSON.stringify({
  binding_id: "launch-preactive",
  thread_id: preactiveThreadId,
  rollout_path: preactiveRolloutPath,
  receipt_nonce: "nonce-preactive",
  viewer_pid: 7201,
  viewer_title: "Codex Meta launch-preac"
}, null, 2));
const preactiveConsumer = new OwnedConsumer({
  cfg: { ...cfg, bridgeDir: preactiveBridgeDir },
  pool: {
    get: () => ({ digest: () => ({ rolloutFound: true, active_command: null, idleSeconds: 120 }) })
  },
  inbox: preactiveInbox,
  audit,
  codexFactory: () => fakeCodex,
  setTarget: () => {},
  startCoordinator: preactiveCoordinator,
  viewerInspector: async () => ({
    window_pid: 7202,
    window_handle: "7203",
    session_id: 7,
    title: "Codex Meta launch-preac"
  }),
  processExistsImpl: (pid) => Number(pid) === 7201,
  writerProcesses: async () => [],
  staleReleaseMs: 0
});
await preactiveConsumer.reconcileUncertainBindings();
const preactiveActive = preactiveCoordinator.get("preactive");
check(
  "pre-active viewer-starting crash binds positive receipt/window evidence",
  preactiveActive.state === "active" &&
    preactiveActive.binding.viewer_pid === 7201 &&
    preactiveActive.binding.viewer_window_pid === 7202 &&
    preactiveActive.binding.viewer_hwnd === "7203" &&
    preactiveActive.binding.viewer_window_session_id === 7
);

console.log("\n[start-flow-5] stale delivering is visible, uncertain, and never replayed");
const staleBridgeDir = path.join(tmp, "stale");
const previousInboxInstance = new Inbox(staleBridgeDir);
const staleTicket = previousInboxInstance.createTicket({
  message: "must not replay",
  targetThreadId: threadId
});
const staleFile = `${staleTicket.ticket}.json`;
const pendingPath = path.join(previousInboxInstance.pending, staleFile);
const stalePayload = {
  ...JSON.parse(fs.readFileSync(pendingPath, "utf8")),
  delivery_started_at: new Date(Date.now() - 60000).toISOString(),
  delivery_owner_pid: process.pid,
  delivery_owner_id: previousInboxInstance.deliveryOwnerId
};
fs.writeFileSync(pendingPath, JSON.stringify(stalePayload, null, 2));
fs.renameSync(pendingPath, path.join(previousInboxInstance.delivering, staleFile));
const staleInbox = new Inbox(staleBridgeDir);
let staleResumeCount = 0;
const staleConsumer = new OwnedConsumer({
  cfg: { ...cfg, bridgeDir: staleBridgeDir },
  pool,
  inbox: staleInbox,
  audit,
  codexFactory: () => ({
    resumeThread() {
      staleResumeCount++;
      return { async run() { return {}; } };
    }
  }),
  setTarget: () => {},
  writerProcesses: async () => []
});
const staleState = staleInbox.listState();
check(
  "same-PID restart still surfaces the abandoned delivery as uncertain",
  previousInboxInstance.deliveryOwnerId !== staleInbox.deliveryOwnerId &&
    staleState.delivering.length === 1 &&
    staleState.delivering[0].delivery_owner_pid === process.pid &&
    staleState.delivering[0].uncertain === true
);
check("uncertain delivery blocks further steering for its thread", /will not be replayed/.test(staleConsumer.steeringBlockReason(threadId)));
await staleConsumer.processPending();
check("consumer never scans or replays delivering tickets", staleResumeCount === 0 && staleInbox.listState().delivering.length === 1);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nSTART FLOW TEST PASS (${checks} checks)`);
