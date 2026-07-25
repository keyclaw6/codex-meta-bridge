#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_PROTOCOL,
  buildWatchdogIdentity,
  watchdogPipePath,
  readCandidateId,
  runRecoveryCycle,
  bindCycleResultToProcessInstance,
  createCycleScheduler,
  listenWatchdogServer,
  sendWatchdogCommand,
  acquireWatchdogAuthority
} from "../setup/watchdog.mjs";

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function fakeClock(start = Date.UTC(2026, 6, 25)) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeoutImpl(fn, delay) {
      const id = nextId++;
      timers.set(id, { at: current + delay, fn });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    async advance(ms) {
      const target = current + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = due[1].at;
        due[1].fn();
        await settle();
      }
      current = target;
      await settle();
    }
  };
}

const closeServer = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections?.();
});
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-watchdog-unit-"));

console.log("\n[watchdog-1] deterministic non-secret identity + candidate precedence");
{
  const repo = path.join(tempRoot, "Repo");
  const config = path.join(tempRoot, "bridge.config.json");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(config, "{}\n");
  const first = buildWatchdogIdentity(repo, config, {
    platform: "win32",
    realpathSyncImpl: (value) => value
  });
  const second = buildWatchdogIdentity(repo.toUpperCase(), config.toUpperCase(), {
    platform: "win32",
    realpathSyncImpl: (value) => value
  });
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(first, second);
  assert.doesNotMatch(first, /bridge\.config|Repo/i);
  assert.match(watchdogPipePath(first, "win32"), new RegExp(`${first}$`));
  assert.equal(watchdogPipePath(first, "linux"), null);

  const bridgeDir = path.join(tempRoot, "candidate-bridge");
  fs.mkdirSync(path.join(bridgeDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "state", "candidate-id"), "state-candidate\n");
  assert.equal(readCandidateId({ bridgeDir }, { env: { BRIDGE_CANDIDATE_ID: " env-candidate " } }), "env-candidate");
  assert.equal(readCandidateId({ bridgeDir }, { env: {} }), "state-candidate");
}

console.log("[watchdog-2] recovery cycle reuses process helpers without leaking health bodies");
{
  const logged = [];
  const secretBody = "SECRET_RESPONSE_BODY_MUST_NOT_APPEAR";
  const authorityFor = (pid, instance) => ({
    ok: true,
    owned: [pid],
    authority: [{
      pid,
      process_instance: instance,
      process_creation_time_filetime_utc: `13413610800000${pid}`,
      repo_identity: "repo-41",
      candidate_id: null,
    }],
    ambiguous: [],
    listener_count: 1,
  });
  const healthFor = (port, pid, instance, candidateId = null) => ({
    ok: true,
    status: 200,
    body: secretBody,
    identity: {
      ok: true,
      service: "codex-meta-bridge",
      pid,
      candidate_id: candidateId,
      repo_identity: "repo-41",
      process_instance: instance,
      process_creation_time_filetime_utc: `13413610800000${pid}`,
      host: "127.0.0.1",
      port,
    },
  });
  const healthy = await runRecoveryCycle({
    cfg: { host: "127.0.0.1", port: 9001, bridgeDir: tempRoot },
    log: (msg, extra) => logged.push({ msg, ...extra }),
    proc: {
      probeHealth: async () => healthFor(9001, 40, "instance-40"),
      findOwnedBridgePidsOnPort: () => authorityFor(40, "instance-40"),
    }
  });
  assert.deepEqual(healthy, { ok: true, recovered: false, healthy: true, status: 200, identity_verified: true });
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(secretBody));

  for (const [name, health, ownership] of [
    ["foreign", healthFor(9001, 99, "foreign"), { ok: false, owned: [], authority: [], ambiguous: [{ pid: 99 }], listener_count: 1, error: "PORT_OWNER_AMBIGUOUS" }],
    ["stale-candidate", healthFor(9001, 40, "instance-40", "stale-candidate"), authorityFor(40, "instance-40")],
    ["missing-identity", { ok: true, status: 200, body: secretBody, identity: null }, authorityFor(40, "instance-40")],
  ]) {
    let destructive = false;
    const result = await runRecoveryCycle({
      cfg: { host: "127.0.0.1", port: 9001, bridgeDir: tempRoot },
      repoRoot: tempRoot,
      proc: {
        probeHealth: async () => health,
        findOwnedBridgePidsOnPort: () => ownership,
        killPids: () => { destructive = true; return { killed: [], errors: [] }; },
        spawnDaemonDetached: () => { destructive = true; return 99; },
      },
    });
    assert.equal(result.error, "HEALTH_IDENTITY_AMBIGUOUS", `${name} HTTP 200 must be ambiguous`);
    assert.equal(Object.hasOwn(result, "identity_verified"), false, `${name} ambiguity must not claim identity proof`);
    assert.equal(Object.hasOwn(result, "process_instance"), false, `${name} ambiguity must not claim a loop instance`);
    assert.equal(destructive, false, `${name} HTTP 200 must not be killed or replaced`);
  }

  const calls = [];
  let spawned = false;
  const recovered = await runRecoveryCycle({
    cfg: { host: "127.0.0.1", port: 9002, bridgeDir: tempRoot },
    repoRoot: tempRoot,
    force: true,
    log: (msg, extra) => logged.push({ msg, ...extra }),
    proc: {
      probeHealth: async () => healthFor(9002, 41, "instance-41"),
      findOwnedBridgePidsOnPort: () => {
        calls.push("find");
        return spawned ? authorityFor(42, "instance-42") : authorityFor(41, "instance-41");
      },
      killPids: (pids, options) => {
        calls.push("kill");
        assert.deepEqual(pids, [41]);
        assert.deepEqual(options.verifiedPids, [41]);
        assert.equal(options.revalidatePidImpl(41), true);
        return { killed: [41], errors: [] };
      },
      waitForPortFree: async () => { calls.push("free"); return true; },
      spawnDaemonDetached: () => { calls.push("spawn"); spawned = true; return 42; },
      waitForHealth: async (_port, _timeout, options) => {
        calls.push("health");
        return options.validateHealth(healthFor(9002, 42, "instance-42"));
      }
    }
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.identity_verified, true);
  assert.deepEqual(calls, ["find", "kill", "find", "free", "spawn", "health", "find"]);
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(secretBody));

  let destructive = false;
  const refused = await runRecoveryCycle({
    cfg: { host: "127.0.0.1", port: 9003, bridgeDir: tempRoot },
    repoRoot: tempRoot,
    force: true,
    proc: {
      probeHealth: async () => ({ ok: false, status: 503 }),
      findOwnedBridgePidsOnPort: () => ({ ok: false, owned: [], ambiguous: [{ pid: 99 }], listener_count: 1, error: "PORT_OWNER_AMBIGUOUS" }),
      killPids: () => { destructive = true; return { killed: [], errors: [] }; },
      spawnDaemonDetached: () => { destructive = true; return 100; },
    },
  });
  assert.equal(refused.error, "PORT_OWNER_AMBIGUOUS");
  assert.equal(Object.hasOwn(refused, "identity_verified"), false);
  assert.equal(Object.hasOwn(refused, "process_instance"), false);
  assert.equal(destructive, false, "ambiguous listener ownership must fail before kill or spawn");

  let spawnedAfterTreeFailure = false;
  const treeFailure = await runRecoveryCycle({
    cfg: { host: "127.0.0.1", port: 9004, bridgeDir: tempRoot },
    repoRoot: tempRoot,
    force: true,
    proc: {
      probeHealth: async () => healthFor(9004, 43, "instance-43"),
      findOwnedBridgePidsOnPort: () => authorityFor(43, "instance-43"),
      killPids: () => ({ killed: [], errors: ["43: taskkill-tree-remains"] }),
      spawnDaemonDetached: () => { spawnedAfterTreeFailure = true; return 44; },
    },
  });
  assert.equal(treeFailure.error, "PROCESS_TERMINATION_FAILED");
  assert.equal(Object.hasOwn(treeFailure, "identity_verified"), false);
  assert.equal(Object.hasOwn(treeFailure, "process_instance"), false);
  assert.equal(spawnedAfterTreeFailure, false, "a changing or surviving tree must block replacement spawn");
}

console.log("[watchdog-3] immediate non-overlapping 60-second cadence survives cycle errors");
{
  const clock = fakeClock();
  const starts = [];
  let calls = 0;
  const scheduler = createCycleScheduler({
    mode: "loop",
    intervalMs: WATCHDOG_INTERVAL_MS,
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    runCycle: async () => {
      starts.push(clock.now());
      calls++;
      if (calls === 1) throw Object.assign(new Error("sensitive cycle detail"), { code: "EXPECTED_CYCLE_FAILURE" });
      return { ok: true, healthy: true };
    }
  });
  assert.equal(scheduler.start(), true);
  await settle();
  assert.equal(starts.length, 1, "loop must check immediately");
  await clock.advance(WATCHDOG_INTERVAL_MS - 1);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  assert.equal(starts.length, 2, "next check starts at the 60-second cadence");
  assert.equal(scheduler.status().last_error, null, "a successful later cycle clears the prior error");
  scheduler.stop();
  await scheduler.whenStopped;
}

{
  const currentInstance = "watchdog-current-instance";
  const scheduler = createCycleScheduler({
    mode: "once",
    runCycle: async () => bindCycleResultToProcessInstance({
      ok: true,
      recovered: false,
      healthy: true,
      status: 200,
      identity_verified: true,
      process_instance: "stale-untrusted-instance",
    }, currentInstance),
  });
  scheduler.start();
  await scheduler.whenStopped;
  assert.equal(scheduler.status().last_result.process_instance, currentInstance, "STATUS binds success to its producing loop instance");
  const failed = bindCycleResultToProcessInstance({
    ok: false,
    healthy: false,
    error: "HEALTH_IDENTITY_AMBIGUOUS",
    process_instance: "forged-instance",
  }, currentInstance);
  assert.equal(Object.hasOwn(failed, "process_instance"), false, "failure discards an untrusted process-instance tag");
}

console.log("[watchdog-4] active work coalesces CHECK and serializes a pending FORCE");
{
  let releaseFirst;
  let active = 0;
  let maxActive = 0;
  const forces = [];
  const scheduler = createCycleScheduler({
    mode: "loop",
    runCycle: async (force) => {
      forces.push(force);
      active++;
      maxActive = Math.max(maxActive, active);
      if (forces.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      active--;
      return { ok: true, healthy: true };
    }
  });
  scheduler.start();
  await settle();
  assert.deepEqual(scheduler.request("CHECK"), { accepted: true, coalesced: true });
  assert.deepEqual(scheduler.request("FORCE"), { accepted: true, coalesced: false });
  assert.deepEqual(scheduler.request("FORCE"), { accepted: true, coalesced: true });
  assert.deepEqual(scheduler.request("CHECK"), { accepted: true, coalesced: true });
  releaseFirst();
  await settle();
  assert.deepEqual(forces, [false, true]);
  assert.equal(maxActive, 1);
  scheduler.stop();
  await scheduler.whenStopped;
}

console.log("[watchdog-5] transient delegation revalidates kernel authority and fails closed");
{
  let listenCalls = 0;
  let delegateCalls = 0;
  const recovered = await acquireWatchdogAuthority({
    listenOwner: async () => {
      listenCalls++;
      if (listenCalls === 1) throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
      return { id: "successor" };
    },
    delegateOwner: async () => {
      delegateCalls++;
      throw Object.assign(new Error("transient timeout"), { code: "WATCHDOG_PIPE_TIMEOUT" });
    },
    retryDelayMs: 0,
    delayImpl: async () => {}
  });
  assert.equal(recovered.kind, "owner");
  assert.equal(recovered.attempt, 2);
  assert.equal(listenCalls, 2);
  assert.equal(delegateCalls, 1);

  let ownerClaimed = false;
  let delegated = 0;
  const contend = () => acquireWatchdogAuthority({
    listenOwner: async () => {
      if (ownerClaimed) throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
      ownerClaimed = true;
      return { id: "only-owner" };
    },
    delegateOwner: async () => {
      delegated++;
      return { ok: true, accepted: true };
    },
    retryDelayMs: 0,
    delayImpl: async () => {}
  });
  const contenders = await Promise.all([contend(), contend(), contend()]);
  assert.equal(contenders.filter((result) => result.kind === "owner").length, 1);
  assert.equal(contenders.filter((result) => result.kind === "delegated").length, 2);
  assert.equal(delegated, 2);

  let unsafeReacquire = false;
  await assert.rejects(() => acquireWatchdogAuthority({
    listenOwner: async () => {
      if (unsafeReacquire) throw new Error("unexpected reacquire");
      unsafeReacquire = true;
      throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    },
    delegateOwner: async () => {
      throw Object.assign(new Error("foreign"), { code: "WATCHDOG_FOREIGN_PIPE" });
    },
    retryDelayMs: 0,
    delayImpl: async () => {}
  }), { code: "WATCHDOG_FOREIGN_PIPE" });
}

if (process.platform === "win32") {
  console.log("[watchdog-6] named pipe is atomic, validated, controllable, and reusable after close");
  const identity = crypto.randomBytes(16).toString("hex");
  const pipePath = watchdogPipePath(identity);
  let requested = null;
  let stopped = false;
  const controller = {
    status: () => ({ cycle_state: "idle", cycle_count: 1 }),
    request: (op) => { requested = op; return { accepted: true, coalesced: false }; },
    stop: () => { stopped = true; return { accepted: true, already_stopped: false }; }
  };
  const serverArgs = {
    pipePath,
    identity,
    port: 9010,
    candidateId: "test-candidate",
    mode: "loop",
    processInstance: "instance-1",
    startedAt: "2026-07-25T00:00:00.000Z",
    pid: 1234,
    controller
  };
  const server = await listenWatchdogServer(serverArgs);
  await assert.rejects(() => listenWatchdogServer({ ...serverArgs, processInstance: "instance-2" }), { code: "EADDRINUSE" });
  const status = await sendWatchdogCommand({ pipePath, identity, port: 9010, candidateId: "test-candidate", op: "STATUS" });
  assert.equal(status.protocol, WATCHDOG_PROTOCOL);
  assert.equal(status.process_instance, "instance-1");
  assert.equal(status.pid, 1234);
  assert.equal(status.started_at, "2026-07-25T00:00:00.000Z");
  const upgradeStatus = await sendWatchdogCommand({
    pipePath,
    identity,
    port: 9999,
    candidateId: "next-candidate",
    op: "STATUS",
    allowRuntimeMismatch: true
  });
  assert.equal(upgradeStatus.candidate_id, "test-candidate");
  assert.equal(upgradeStatus.port, 9010);
  await sendWatchdogCommand({ pipePath, identity, port: 9010, candidateId: "test-candidate", op: "FORCE" });
  assert.equal(requested, "FORCE");
  await sendWatchdogCommand({
    pipePath,
    identity,
    port: 9010,
    candidateId: "test-candidate",
    op: "STOP",
    expectedProcessInstance: "instance-1"
  });
  assert.equal(stopped, true);
  await assert.rejects(
    () => sendWatchdogCommand({
      pipePath,
      identity,
      port: 9010,
      candidateId: "test-candidate",
      op: "STOP",
      expectedProcessInstance: "wrong-instance"
    }),
    { code: "WATCHDOG_INSTANCE_MISMATCH" }
  );
  await assert.rejects(
    () => sendWatchdogCommand({ pipePath, identity, port: 9010, candidateId: "wrong-candidate", op: "PING" }),
    { code: "WATCHDOG_RUNTIME_MISMATCH" }
  );
  await closeServer(server);
  const replacement = await listenWatchdogServer({ ...serverArgs, processInstance: "instance-3" });
  await closeServer(replacement);

  console.log("[watchdog-7] foreign and nonresponsive pipe holders fail closed");
  const foreignIdentity = crypto.randomBytes(16).toString("hex");
  const foreignPath = watchdogPipePath(foreignIdentity);
  const foreignSockets = new Set();
  const foreign = net.createServer((socket) => {
    foreignSockets.add(socket);
    socket.on("close", () => foreignSockets.delete(socket));
    socket.end(JSON.stringify({
      ok: true, protocol: WATCHDOG_PROTOCOL, identity: "not-ours", port: 9011
    }) + "\n");
  });
  await new Promise((resolve, reject) => foreign.once("error", reject).listen(foreignPath, resolve));
  await assert.rejects(
    () => sendWatchdogCommand({ pipePath: foreignPath, identity: foreignIdentity, port: 9011, candidateId: null, op: "PING" }),
    { code: "WATCHDOG_FOREIGN_PIPE" }
  );
  for (const socket of foreignSockets) socket.destroy();
  await closeServer(foreign);

  const silentIdentity = crypto.randomBytes(16).toString("hex");
  const silentPath = watchdogPipePath(silentIdentity);
  const silentSockets = new Set();
  const silent = net.createServer((socket) => {
    silentSockets.add(socket);
    socket.on("close", () => silentSockets.delete(socket));
  });
  await new Promise((resolve, reject) => silent.once("error", reject).listen(silentPath, resolve));
  await assert.rejects(
    () => sendWatchdogCommand({ pipePath: silentPath, identity: silentIdentity, port: 9012, candidateId: null, op: "PING", timeoutMs: 50 }),
    { code: "WATCHDOG_PIPE_TIMEOUT" }
  );
  for (const socket of silentSockets) socket.destroy();
  await closeServer(silent);

  console.log("[watchdog-8] mixed/disconnecting clients preserve one pipe owner and one cycle writer");
  const stressIdentity = crypto.randomBytes(16).toString("hex");
  const stressPath = watchdogPipePath(stressIdentity);
  let releaseInitial;
  let active = 0;
  let maxActive = 0;
  const forces = [];
  const stressController = createCycleScheduler({
    mode: "loop",
    runCycle: async (cycleForce) => {
      forces.push(cycleForce);
      active++;
      maxActive = Math.max(maxActive, active);
      if (forces.length === 1) await new Promise((resolve) => { releaseInitial = resolve; });
      active--;
      return { ok: true, healthy: true };
    }
  });
  const stressArgs = {
    pipePath: stressPath,
    identity: stressIdentity,
    port: 9013,
    candidateId: "stress-candidate",
    mode: "loop",
    processInstance: "stress-instance",
    startedAt: "2026-07-25T00:00:00.000Z",
    pid: 5678,
    controller: stressController
  };
  const stressServer = await listenWatchdogServer(stressArgs);
  stressController.start();
  await settle();

  const disconnect = (payload) => new Promise((resolve) => {
    const socket = net.createConnection(stressPath);
    socket.on("error", () => resolve());
    socket.on("connect", () => {
      socket.write(payload);
      socket.destroy();
      resolve();
    });
  });
  await Promise.all([
    ...Array.from({ length: 20 }, (_, index) => disconnect(index % 2
      ? "{malformed\n"
      : JSON.stringify({ protocol: WATCHDOG_PROTOCOL, identity: stressIdentity, op: index % 4 ? "STATUS" : "FORCE" }) + "\n")),
    ...Array.from({ length: 10 }, () => disconnect("x".repeat(9000)))
  ]);

  const operations = Array.from({ length: 80 }, (_, index) => ["PING", "STATUS", "CHECK", "FORCE"][index % 4]);
  const responses = await Promise.all(operations.map((op) => sendWatchdogCommand({
    pipePath: stressPath,
    identity: stressIdentity,
    port: 9013,
    candidateId: "stress-candidate",
    op,
    timeoutMs: 1000
  })));
  assert.equal(responses.length, operations.length);
  assert.equal(responses.every((response) => response.process_instance === "stress-instance"), true);
  assert.equal(responses.filter((response) => response.op === "FORCE" && response.coalesced === false).length <= 1, true);
  assert.equal(responses.filter((response) => response.op === "FORCE").every((response) => response.accepted === true), true);
  await assert.rejects(() => listenWatchdogServer({ ...stressArgs, processInstance: "contender" }), { code: "EADDRINUSE" });

  releaseInitial();
  for (let attempt = 0; attempt < 100 && forces.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(forces, [false, true]);
  assert.equal(maxActive, 1);
  const survived = await sendWatchdogCommand({
    pipePath: stressPath,
    identity: stressIdentity,
    port: 9013,
    candidateId: "stress-candidate",
    op: "STATUS"
  });
  assert.equal(survived.process_instance, "stress-instance");
  assert.equal(survived.cycle_count, 2);
  await sendWatchdogCommand({
    pipePath: stressPath,
    identity: stressIdentity,
    port: 9013,
    candidateId: "stress-candidate",
    op: "STOP",
    expectedProcessInstance: "stress-instance"
  });
  await stressController.whenStopped;
  await closeServer(stressServer);
}

console.log("\nWATCHDOG TEST PASS");
