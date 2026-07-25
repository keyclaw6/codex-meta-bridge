#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  StartCoordinator,
  StartCoordinatorError,
  atomicWriteJson,
  canonicalPayloadHash
} from "../src/start-coordinator.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-start-coordinator-"));
let assertions = 0;

function check(name, action) {
  action();
  assertions++;
  console.log(`  ok    ${name}`);
}

async function checkAsync(name, action) {
  await action();
  assertions++;
  console.log(`  ok    ${name}`);
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof StartCoordinatorError && error.code === code);
}

function statePath(name) {
  return path.join(tmp, name, "start-bindings.json");
}

function clock() {
  let tick = 0;
  return () => `2026-07-25T12:00:${String(tick++).padStart(2, "0")}.000Z`;
}

const visiblePayload = {
  prompt: "TOP SECRET PROMPT VALUE",
  working_directory: "C:\\repo",
  model: "gpt-5.6-sol",
  sandbox_mode: "workspace-write",
  approval_policy: "never"
};
const headlessPayload = { ...visiblePayload, prompt: "headless mission" };

console.log("\n[start-coordinator-1] canonical hashing");
check("object key order is canonical", () => {
  const left = canonicalPayloadHash({ b: 2, nested: { z: [3, 4], a: true }, a: 1 });
  const right = canonicalPayloadHash({ a: 1, nested: { a: true, z: [3, 4] }, b: 2 });
  assert.equal(left, right);
});
check("payload value changes are hash-sensitive", () => {
  assert.notEqual(canonicalPayloadHash({ prompt: "one" }), canonicalPayloadHash({ prompt: "two" }));
});

console.log("\n[start-coordinator-2] reservation idempotency and redaction");
{
  const file = statePath("reservation");
  const coordinator = new StartCoordinator({ statePath: file, now: clock() });
  const first = await coordinator.reserve({
    requestKey: "visible-1",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  check("first request creates a durable reservation", () => {
    assert.equal(first.reused, false);
    assert.equal(first.record.state, "reserved");
    assert.equal(new StartCoordinator({ statePath: file }).get("visible-1").state, "reserved");
  });
  check("prompt and payload are never persisted", () => {
    const persisted = fs.readFileSync(file, "utf8");
    assert.equal(persisted.includes(visiblePayload.prompt), false);
    assert.equal(persisted.includes("prompt"), false);
    assert.equal(persisted.includes("working_directory"), false);
    assert.equal(persisted.includes(visiblePayload.model), false);
    assert.equal(persisted.includes("payload"), true); // payload_hash only
  });
  const sequential = await coordinator.reserve({
    requestKey: "visible-1",
    normalizedPayload: { ...visiblePayload },
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  check("sequential same-key same-payload request reuses", () => {
    assert.equal(sequential.reused, true);
    assert.deepEqual(sequential.record, first.record);
  });
  await checkAsync("same key with different payload rejects", async () => {
    await rejectsCode(coordinator.reserve({
      requestKey: "visible-1",
      normalizedPayload: { ...visiblePayload, model: "different" },
      type: "start_visible_cli_mission",
      visibility: "visible"
    }), "REQUEST_KEY_CONFLICT");
  });
}

console.log("\n[start-coordinator-3] concurrent reservation and lease conflict");
{
  const coordinator = new StartCoordinator({ statePath: statePath("concurrent"), now: clock() });
  const calls = Array.from({ length: 12 }, () => coordinator.reserve({
    requestKey: "race-key",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  }));
  const results = await Promise.all(calls);
  check("concurrent same-key calls create exactly one reservation", () => {
    assert.equal(results.filter((result) => !result.reused).length, 1);
    assert.equal(results.filter((result) => result.reused).length, 11);
    assert.equal(coordinator.list().length, 1);
  });
  await checkAsync("visible lease blocks a different visible start", async () => {
    await rejectsCode(coordinator.reserve({
      requestKey: "other-visible",
      normalizedPayload: { ...visiblePayload, prompt: "other" },
      type: "start_visible_cli_mission",
      visibility: "visible"
    }), "VISIBLE_LEASE_CONFLICT");
  });
  await checkAsync("visible lease also blocks the legacy headless tool", async () => {
    await rejectsCode(coordinator.reserve({
      requestKey: "legacy",
      normalizedPayload: headlessPayload,
      type: "start_mission",
      visibility: "headless"
    }), "VISIBLE_LEASE_CONFLICT");
  });
}

console.log("\n[start-coordinator-4] visible state machine and reconstruction");
{
  const file = statePath("states");
  let coordinator = new StartCoordinator({ statePath: file, now: clock() });
  await coordinator.reserve({
    requestKey: "states",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  const reconstruct = (state) => {
    coordinator = new StartCoordinator({ statePath: file, now: clock() });
    assert.equal(coordinator.get("states").state, state);
  };
  reconstruct("reserved");
  await checkAsync("reserved cannot skip the before-side thread boundary", async () => {
    await rejectsCode(coordinator.transition("states", "thread-bound", {
      binding: { thread_id: "thread-1", rollout_path: "C:\\rollouts\\thread-1.jsonl" }
    }), "INVALID_TRANSITION");
  });
  await coordinator.transition("states", "thread-starting");
  reconstruct("thread-starting");
  await coordinator.transition("states", "thread-bound", {
    binding: { thread_id: "thread-1", rollout_path: "C:\\rollouts\\thread-1.jsonl" }
  });
  reconstruct("thread-bound");
  await checkAsync("visible binding cannot become active before viewer-starting", async () => {
    await rejectsCode(coordinator.transition("states", "active", {
      binding: { viewer_pid: 4242, viewer_hwnd: "0x10042" }
    }), "INVALID_TRANSITION");
  });
  await coordinator.transition("states", "viewer-starting", {
    binding: {
      viewer_launch_id: "launch-1",
      viewer_title: "Codex Mission nonce-1",
      receipt_path: "C:\\receipts\\launch-1.json",
      receipt_nonce: "nonce-1"
    }
  });
  reconstruct("viewer-starting");
  await checkAsync("visible active requires complete live viewer evidence", async () => {
    await rejectsCode(coordinator.transition("states", "active", {
      binding: { viewer_pid: 4242 }
    }), "INCOMPLETE_BINDING");
  });
  await checkAsync("visible active requires the observed window session", async () => {
    await rejectsCode(coordinator.transition("states", "active", {
      binding: {
        viewer_pid: 4242,
        viewer_window_pid: 4243,
        viewer_hwnd: "10042"
      }
    }), "INCOMPLETE_BINDING");
  });
  await coordinator.transition("states", "active", {
    binding: {
      viewer_pid: 4242,
      viewer_window_pid: 4243,
      viewer_hwnd: "10042",
      viewer_window_session_id: 7
    }
  });
  reconstruct("active");
  const legacyFile = statePath("legacy-active");
  const legacySnapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  delete legacySnapshot.records[0].binding.viewer_window_session_id;
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify(legacySnapshot, null, 2));
  check("legacy active record missing new session evidence still loads", () => {
    assert.equal(new StartCoordinator({ statePath: legacyFile }).get("states").state, "active");
  });
  check("every state and timestamp remains in durable history", () => {
    assert.deepEqual(coordinator.get("states").history.map((entry) => entry.state), [
      "reserved", "thread-starting", "thread-bound", "viewer-starting", "active"
    ]);
  });
  await checkAsync("forbidden state skip rejects", async () => {
    await rejectsCode(coordinator.transition("states", "thread-bound", {
      binding: { thread_id: "thread-1", rollout_path: "C:\\rollouts\\thread-1.jsonl" }
    }), "INVALID_TRANSITION");
  });
  const terminal = await coordinator.transition("states", "terminal", { reason: "viewer and writer safely stopped" });
  reconstruct("terminal");
  check("terminal records carry reason and end time", () => {
    assert.equal(terminal.reason, "viewer and writer safely stopped");
    assert.ok(terminal.ended_at);
  });
  await checkAsync("terminal bindings reject every further transition", async () => {
    await rejectsCode(coordinator.markUncertain("states", "too late"), "INVALID_TRANSITION");
  });
  await coordinator.reserve({
    requestKey: "after-terminal",
    normalizedPayload: { ...visiblePayload, prompt: "new visible request" },
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  check("only terminal releases the visible lease", () => {
    assert.equal(coordinator.get("after-terminal").state, "reserved");
  });
}

console.log("\n[start-coordinator-5] headless path and forbidden viewer path");
{
  const coordinator = new StartCoordinator({ statePath: statePath("headless"), now: clock() });
  await coordinator.reserve({
    requestKey: "headless",
    normalizedPayload: headlessPayload,
    type: "start_mission",
    visibility: "headless"
  });
  await coordinator.transition("headless", "thread-starting");
  await coordinator.transition("headless", "thread-bound", {
    binding: { thread_id: "thread-h", rollout_path: "C:\\rollouts\\thread-h.jsonl" }
  });
  await checkAsync("headless binding cannot enter viewer-starting", async () => {
    await rejectsCode(coordinator.transition("headless", "viewer-starting", {
      binding: {
        viewer_launch_id: "bad",
        viewer_title: "bad",
        receipt_path: "bad",
        receipt_nonce: "bad"
      }
    }), "INVALID_TRANSITION");
  });
  await coordinator.transition("headless", "active");
  check("headless binding activates directly from thread-bound", () => assert.equal(coordinator.get("headless").state, "active"));
}

console.log("\n[start-coordinator-6] persistence failure boundary");
{
  const file = statePath("failure");
  let failNext = false;
  const persistSnapshot = async (...args) => {
    if (failNext) throw new Error("injected before commit");
    return atomicWriteJson(...args);
  };
  const coordinator = new StartCoordinator({ statePath: file, now: clock(), persistSnapshot });
  await coordinator.reserve({
    requestKey: "failure",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  const priorBytes = fs.readFileSync(file, "utf8");
  failNext = true;
  await checkAsync("failed durable write rejects the transition", async () => {
    await assert.rejects(coordinator.transition("failure", "thread-starting"), /injected before commit/);
  });
  check("failed commit leaves both memory and durable state unchanged", () => {
    assert.equal(coordinator.get("failure").state, "reserved");
    assert.equal(fs.readFileSync(file, "utf8"), priorBytes);
    assert.equal(new StartCoordinator({ statePath: file }).get("failure").state, "reserved");
  });
}

console.log("\n[start-coordinator-7] uncertain fail-closed reconciliation");
{
  const file = statePath("uncertain");
  let coordinator = new StartCoordinator({ statePath: file, now: clock() });
  await coordinator.reserve({
    requestKey: "uncertain",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  await coordinator.transition("uncertain", "thread-starting");
  await coordinator.transition("uncertain", "thread-bound", {
    binding: { thread_id: "thread-u", rollout_path: "C:\\rollouts\\thread-u.jsonl" }
  });
  await coordinator.transition("uncertain", "viewer-starting", {
    binding: {
      viewer_launch_id: "launch-u",
      viewer_title: "Codex Mission nonce-u",
      receipt_path: "C:\\receipts\\launch-u.json",
      receipt_nonce: "nonce-u"
    }
  });
  await coordinator.markUncertain("uncertain", "viewer side effect outcome cannot be disproved");
  coordinator = new StartCoordinator({ statePath: file, now: clock() });
  check("uncertain state and reason reconstruct explicitly", () => {
    assert.equal(coordinator.get("uncertain").state, "uncertain");
    assert.match(coordinator.get("uncertain").reason, /cannot be disproved/);
  });
  await checkAsync("uncertain binding blocks same-key reservation", async () => {
    await rejectsCode(coordinator.reserve({
      requestKey: "uncertain",
      normalizedPayload: visiblePayload,
      type: "start_visible_cli_mission",
      visibility: "visible"
    }), "UNCERTAIN_BINDING");
  });
  await checkAsync("uncertain binding blocks both tool kinds globally", async () => {
    await rejectsCode(coordinator.reserve({
      requestKey: "blocked-headless",
      normalizedPayload: headlessPayload,
      type: "start_mission",
      visibility: "headless"
    }), "UNCERTAIN_BINDING");
  });
  await checkAsync("ordinary transition cannot escape uncertain", async () => {
    await rejectsCode(coordinator.transition("uncertain", "active", {
      binding: { viewer_pid: 5151, viewer_hwnd: "0x5151" }
    }), "INVALID_TRANSITION");
  });
  await checkAsync("reconcile requires an explicit positive evidence decision", async () => {
    await rejectsCode(coordinator.reconcile("uncertain", {
      state: "active",
      binding: { viewer_pid: 5151, viewer_hwnd: "0x5151" }
    }), "RECONCILE_EVIDENCE_REQUIRED");
  });
  await coordinator.reconcile("uncertain", {
    state: "active",
    positive_evidence: true,
    binding: {
      viewer_pid: 5151,
      viewer_window_pid: 5152,
      viewer_hwnd: "5153",
      viewer_window_session_id: 7
    }
  });
  check("positive active evidence is the only safe uncertain-to-active path", () => {
    assert.equal(coordinator.get("uncertain").state, "active");
  });

  const terminalFile = statePath("uncertain-terminal");
  const terminalCoordinator = new StartCoordinator({ statePath: terminalFile, now: clock() });
  await terminalCoordinator.reserve({
    requestKey: "release",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  await terminalCoordinator.markUncertain("release", "crash boundary");
  await terminalCoordinator.reconcile("release", {
    state: "terminal",
    positive_evidence: true,
    reason: "positive evidence proves no writer or viewer exists"
  });
  await terminalCoordinator.reserve({
    requestKey: "new-visible",
    normalizedPayload: { ...visiblePayload, prompt: "after safe release" },
    type: "start_visible_cli_mission",
    visibility: "visible"
  });
  check("positive terminal reconciliation releases the lease", () => {
    assert.equal(terminalCoordinator.get("release").state, "terminal");
    assert.equal(terminalCoordinator.get("new-visible").state, "reserved");
  });
}

console.log("\n[start-coordinator-8] injected crash at every durable boundary");
{
  const file = statePath("every-boundary");
  let failNext = false;
  const persistSnapshot = async (...args) => {
    if (failNext) {
      failNext = false;
      throw new Error("injected durable boundary crash");
    }
    return atomicWriteJson(...args);
  };
  const coordinator = new StartCoordinator({ statePath: file, now: clock(), persistSnapshot });
  const failThenCommit = async (name, operation, expectedBefore, expectedAfter) => {
    failNext = true;
    await assert.rejects(operation(), /injected durable boundary crash/);
    assert.equal(coordinator.get("all-boundaries")?.state ?? null, expectedBefore);
    assert.equal(new StartCoordinator({ statePath: file }).get("all-boundaries")?.state ?? null, expectedBefore);
    await operation();
    assert.equal(coordinator.get("all-boundaries").state, expectedAfter);
    assertions++;
    console.log(`  ok    ${name}`);
  };

  await failThenCommit("reservation crash creates no phantom lease", () => coordinator.reserve({
    requestKey: "all-boundaries",
    normalizedPayload: visiblePayload,
    type: "start_visible_cli_mission",
    visibility: "visible"
  }), null, "reserved");
  await failThenCommit("thread-starting crash remains reserved", () => coordinator.transition(
    "all-boundaries",
    "thread-starting"
  ), "reserved", "thread-starting");
  await failThenCommit("thread-bound crash remains thread-starting", () => coordinator.transition(
    "all-boundaries",
    "thread-bound",
    { binding: { thread_id: "thread-all", rollout_path: "C:\\rollouts\\thread-all.jsonl" } }
  ), "thread-starting", "thread-bound");
  await failThenCommit("viewer-starting crash remains thread-bound", () => coordinator.transition(
    "all-boundaries",
    "viewer-starting",
    {
      binding: {
        viewer_launch_id: "launch-all",
        viewer_title: "Codex Mission all",
        receipt_path: "C:\\receipts\\launch-all.json",
        receipt_nonce: "nonce-all"
      }
    }
  ), "thread-bound", "viewer-starting");
  await failThenCommit("active crash remains viewer-starting", () => coordinator.transition(
    "all-boundaries",
    "active",
    {
      binding: {
        viewer_pid: 7001,
        viewer_window_pid: 7002,
        viewer_hwnd: "7003",
        viewer_window_session_id: 7
      }
    }
  ), "viewer-starting", "active");
  await failThenCommit("uncertain crash remains active", () => coordinator.markUncertain(
    "all-boundaries",
    "injected restart"
  ), "active", "uncertain");
  await failThenCommit("terminal reconciliation crash remains uncertain", () => coordinator.reconcile(
    "all-boundaries",
    {
      state: "terminal",
      positive_evidence: true,
      reason: "positive absence evidence"
    }
  ), "uncertain", "terminal");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nSTART COORDINATOR TEST PASS (${assertions} checks)`);
