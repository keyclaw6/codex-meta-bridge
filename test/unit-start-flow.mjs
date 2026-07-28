#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Inbox } from "../src/inbox.mjs";
import { OwnedConsumer } from "../src/owned-consumer.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-start-flow-"));
const bridgeDir = path.join(tmp, "bridge");
const codexHome = path.join(tmp, ".codex");
const threadId = "019f9999-aaaa-7bbb-cccc-000000001111";
const rolloutPath = path.join(codexHome, "sessions", `rollout-${threadId}.jsonl`);
fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });

let releaseInitial;
const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
let starts = 0;
let resumes = 0;
let steeringStarted = false;
const fakeCodex = {
  startThread() {
    starts++;
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: new Date().toISOString(), type: "session_meta",
      payload: { id: threadId, originator: "codex exec" }
    })}\n`);
    return {
      id: threadId,
      async runStreamed() {
        async function* events() {
          yield { type: "thread.started", thread_id: threadId };
          await initialGate;
          yield { type: "turn.completed" };
        }
        return { events: events() };
      }
    };
  },
  resumeThread() {
    resumes++;
    return { async run() { steeringStarted = true; return { finalResponse: "done" }; } };
  }
};
const inbox = new Inbox(bridgeDir);
const consumer = new OwnedConsumer({
  cfg: {
    bridgeDir, codexHome, targetThreadId: null,
    default_mission_sandbox: "workspace-write", allowOwnedForDesktop: false
  },
  pool: { get: () => ({ digest: () => ({ sessionMeta: { originator: "codex exec" } }) }) },
  inbox,
  audit: () => {},
  codexFactory: () => fakeCodex,
  setTarget: () => {},
  rolloutResolver: async () => rolloutPath
});
const args = {
  requestKey: "mission-1",
  prompt: "Run mission",
  threadOptions: { workingDirectory: tmp, sandboxMode: "workspace-write", approvalPolicy: "never" }
};
const [first, duplicate] = await Promise.all([
  consumer.startMission(args),
  consumer.startMission({ ...args, threadOptions: { ...args.threadOptions } })
]);
assert.equal(starts, 1);
assert.equal([first.reused, duplicate.reused].filter(Boolean).length, 1);
assert.equal(first.thread_id, threadId);

const ticket = inbox.createTicket({ message: "continue", targetThreadId: threadId });
await consumer.processPending();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(steeringStarted, false);
assert.equal(inbox.listState().delivering.some((row) => row.ticket === ticket.ticket), true);

releaseInitial();
for (let i = 0; i < 100 && !steeringStarted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(steeringStarted, true);
assert.equal(resumes, 1);

const staleDir = path.join(tmp, "stale");
const oldInbox = new Inbox(staleDir);
const stale = oldInbox.createTicket({ message: "do not replay", targetThreadId: threadId });
const staleName = `${stale.ticket}.json`;
fs.renameSync(path.join(oldInbox.pending, staleName), path.join(oldInbox.delivering, staleName));
const newInbox = new Inbox(staleDir);
const staleConsumer = new OwnedConsumer({
  cfg: { bridgeDir: staleDir, codexHome, allowOwnedForDesktop: false },
  pool: { get: () => ({ digest: () => ({ sessionMeta: { originator: "codex exec" } }) }) },
  inbox: newInbox, audit: () => {}, codexFactory: () => fakeCodex, setTarget: () => {}
});
assert.match(staleConsumer.steeringBlockReason(threadId), /will not be replayed/);
assert.equal(newInbox.listState().delivering[0].uncertain, true);

console.log("START FLOW TEST PASS");
