#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  WINDOWS_PERSISTENCE,
  createWindowsPersistence,
  renderWindowsServiceFiles,
  windowsPersistenceInstallerPipePath,
} from "../src/windows-service.mjs";
import {
  createControlAdapter,
  createInstallerLock,
  createRegExeAdapter,
  createWscriptAdapter,
  runWindowsPersistenceCli,
} from "../setup/windows-persistence.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
const check = (name, condition) => {
  checks++;
  assert.ok(condition, name);
};

const repoRoot = "C:\\Program Files\\Codex Meta Bridge";
const bridgeDir = "C:\\Users\\Ada O'Brien\\Bridge State";
const nodePath = "C:\\Program Files\\nodejs\\node.exe";
const candidateId = "worktree-sha256:test-candidate";
const port = 8787;
const watchdogIdentity = "0123456789abcdef0123456789abcdef";

function makeLock() {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  return {
    async withLock(fn) {
      let release;
      const mine = new Promise((resolve) => { release = resolve; });
      const before = tail;
      tail = mine;
      await before;
      active++;
      maxActive = Math.max(maxActive, active);
      try { return await fn(); }
      finally { active--; release(); }
    },
    get maxActive() { return maxActive; },
  };
}

function makeHarness() {
  const state = { run: null, vbs: null, control: null, calls: [], failure: null };
  const lock = makeLock();
  const step = async (name, effect = () => {}) => {
    state.calls.push(name);
    const shouldFail = (when) => {
      const point = `${name}:${when}`;
      if (state.failure === point) { state.failure = null; return true; }
      if (state.failure?.point !== point) return false;
      state.failure.skip = Number(state.failure.skip || 0) - 1;
      if (state.failure.skip >= 0) return false;
      state.failure = null;
      return true;
    };
    if (shouldFail("before")) throw new Error("injected");
    effect();
    if (shouldFail("after")) throw new Error("injected");
  };
  const registry = {
    read: async () => { await step("registry.read"); return state.run && { ...state.run }; },
    create: async (value) => step("registry.create", () => {
      if (state.run) throw new Error("collision");
      state.run = { ...value };
    }),
    ensureExact: async (value) => step("registry.ensureExact", () => {
      if (state.run && (state.run.type !== value.type || state.run.data !== value.data)) throw new Error("foreign");
      state.run = { ...value };
    }),
    deleteExact: async (value) => step("registry.deleteExact", () => {
      if (!state.run) return;
      if (state.run.type !== value.type || state.run.data !== value.data) throw new Error("foreign");
      state.run = null;
    }),
  };
  const files = {
    read: async () => { await step("files.read"); return state.vbs; },
    create: async (_filePath, value) => step("files.create", () => {
      if (state.vbs != null) throw new Error("collision");
      state.vbs = value;
    }),
    ensureExact: async (_filePath, value) => step("files.ensureExact", () => {
      if (state.vbs != null && state.vbs !== value) throw new Error("foreign");
      state.vbs = value;
    }),
    deleteExact: async (_filePath, expectedHash) => step("files.deleteExact", () => {
      if (state.vbs == null) return;
      if (digest(state.vbs) !== expectedHash) throw new Error("foreign");
      state.vbs = null;
    }),
  };
  const ownedControl = () => ({
    ok: true,
    exists: true,
    responsive: true,
    identity: watchdogIdentity,
    mode: "loop",
    process_instance: "watchdog-process-instance",
    pid: 4321,
    started_at: "2026-07-25T00:00:00.000Z",
    candidate_id: candidateId,
    port,
    cycle_count: 1,
    cycle_state: "idle",
    last_error: null,
    last_result: {
      ok: true,
      recovered: false,
      healthy: true,
      status: 200,
      identity_verified: true,
      process_instance: "watchdog-process-instance",
    },
  });
  const launcher = {
    launch: async () => step("launcher.launch", () => {
      state.control = ownedControl();
      if (state.launchContradiction) state.launchContradiction(state.control);
    }),
  };
  const control = {
    status: async () => { await step("control.status"); return state.control && structuredClone(state.control); },
    waitForStatus: async () => step("control.waitForStatus", () => {
      if (!state.control
        || state.control.identity !== watchdogIdentity
        || state.control.candidate_id !== candidateId
        || Number(state.control.port) !== port
        || state.control.cycle_count < 1
        || state.control.cycle_state !== "idle"
        || state.control.ok !== true
        || state.control.error != null
        || state.control.last_error != null
        || state.control.ambiguous === true
        || state.control.contradictory === true
        || state.control.last_result == null
        || typeof state.control.last_result !== "object"
        || Array.isArray(state.control.last_result)
        || state.control.last_result.ok !== true
        || state.control.last_result.healthy !== true
        || Number(state.control.last_result.status) !== 200
        || state.control.last_result.identity_verified !== true
        || state.control.last_result.process_instance !== state.control.process_instance
        || state.control.last_result.error != null
        || state.control.last_result.ambiguous === true
        || state.control.last_result.contradictory === true) throw new Error("missing, mismatched, or unsuccessful");
    }),
    stop: async (expected) => step("control.stop", () => {
      if (!state.control || state.control.identity !== watchdogIdentity || expected.processInstance !== state.control.process_instance) throw new Error("foreign");
      state.control = null;
    }),
    waitForAbsent: async () => step("control.waitForAbsent", () => {
      if (state.control) throw new Error("present");
    }),
  };
  const service = createWindowsPersistence({
    repoRoot, bridgeDir, nodePath, watchdogIdentity, candidateId, port,
    registry, files, launcher, control, lock,
  });
  const seedRun = () => {
    state.run = { ...service.artifacts.runValue };
    state.vbs = service.artifacts.vbs;
    state.control = ownedControl();
  };
  return { state, lock, service, seedRun };
}

console.log("\n[windows-persistence-1] exact artifacts and quoting");
const rendered = renderWindowsServiceFiles({ repoRoot, bridgeDir, nodePath, token: "MUST_NOT_LEAK" });
check("VBS is under bridgeDir", rendered.vbsPath === `${bridgeDir}\\watchdog-supervisor-hidden.vbs`);
check("Run data is exact", rendered.runData === `wscript.exe //B //Nologo "${rendered.vbsPath}"`);
check("Node path is quoted", rendered.vbs.includes('""C:\\Program Files\\nodejs\\node.exe""'));
check("watchdog path is quoted and loop mode is exact", rendered.vbs.includes('""C:\\Program Files\\Codex Meta Bridge\\setup\\watchdog.mjs"" --loop'));
check("VBS starts hidden without waiting", rendered.vbs.includes("Run(command, 0, False)"));
check("VBS contains ownership marker", rendered.vbs.startsWith("' CodexMetaBridgeWatchdog managed launcher v1\r\n"));
check("VBS hash is deterministic", rendered.vbsHash === digest(rendered.vbs));
check("VBS has no UI or secret material", !/echo|msgbox|MUST_NOT_LEAK|https:\/\//i.test(rendered.vbs));
check("installer singleton is identity-hashed", windowsPersistenceInstallerPipePath(watchdogIdentity).endsWith(watchdogIdentity));
check("isolated watchdog identities use isolated installer singletons", windowsPersistenceInstallerPipePath("ffffffffffffffffffffffffffffffff") !== windowsPersistenceInstallerPipePath(watchdogIdentity));
assert.throws(() => createInstallerLock(), /identity-hashed/);
checks++;
assert.throws(() => renderWindowsServiceFiles({ repoRoot: 'C:\\bad"path', bridgeDir, nodePath }), /cannot contain/);
checks++;

console.log("\n[windows-persistence-2] stable ownership states and foreign collisions");
{
  const h = makeHarness();
  check("empty evidence is NONE", (await h.service.inspect()).state === "NONE");
  h.state.run = { type: "REG_SZ", data: "foreign secret value" };
  const foreignRun = await h.service.inspect();
  check("foreign Run value is AMBIGUOUS", foreignRun.state === "AMBIGUOUS");
  const before = structuredClone(h.state);
  await assert.rejects(h.service.install(), (error) => error.code === "AMBIGUOUS"); checks++;
  check("foreign Run collision is untouched", h.state.run.data === before.run.data && h.state.vbs === before.vbs && h.state.control === before.control);
}
{
  const h = makeHarness();
  h.state.vbs = "foreign VBS secret";
  check("foreign VBS is AMBIGUOUS", (await h.service.inspect()).state === "AMBIGUOUS");
  await assert.rejects(h.service.uninstall(), (error) => error.code === "AMBIGUOUS"); checks++;
  check("foreign VBS is untouched", h.state.vbs === "foreign VBS secret");
}
for (const [name, mutate] of [
  ["foreign pipe identity", (c) => { c.identity = "other-watchdog-identity"; }],
  ["wrong mode", (c) => { c.mode = "oneshot"; }],
  ["incomplete immediate cycle", (c) => { c.cycle_count = 0; c.last_result = null; }],
  ["running immediate cycle", (c) => { c.cycle_state = "running"; }],
  ["failed immediate result", (c) => { c.last_result = { ok: false, healthy: false, status: 503 }; }],
  ["unhealthy immediate result", (c) => { c.last_result = { ok: true, healthy: false, status: 200 }; }],
  ["null immediate result", (c) => { c.last_result = null; }],
  ["partial immediate result", (c) => { c.last_result = { ok: true }; }],
  ["array immediate result", (c) => { c.last_result = []; }],
  ["non-success immediate status", (c) => { c.last_result.status = 503; }],
  ["missing health identity proof", (c) => { delete c.last_result.identity_verified; }],
  ["missing result process instance", (c) => { delete c.last_result.process_instance; }],
  ["stale prior-process result", (c) => { c.last_result.process_instance = "prior-watchdog-process-instance"; }],
  ["contradictory immediate result", (c) => { c.last_result.error = "failed despite success fields"; }],
  ["top-level failed STATUS", (c) => { c.ok = false; }],
  ["top-level scheduler error", (c) => { c.last_error = "cycle failed"; }],
  ["legacy completion shortcut with failure", (c) => {
    c.immediateCycleComplete = true;
    c.last_result = { ok: false, healthy: false, status: 503, error: "failed" };
  }],
  ["missing process instance", (c) => { c.process_instance = ""; }],
  ["mismatched candidate", (c) => { c.candidate_id = "old-candidate"; }],
  ["mismatched port", (c) => { c.port = 9999; }],
]) {
  const h = makeHarness(); h.seedRun(); mutate(h.state.control);
  check(`${name} is AMBIGUOUS`, (await h.service.inspect()).state === "AMBIGUOUS");
}
{
  const h = makeHarness(); h.seedRun(); h.state.control.candidate_id = "old-candidate"; h.state.control.port = 9999;
  const before = await h.service.inspect();
  check("same-identity old runtime is an explicit cutover state", before.state === "AMBIGUOUS" && before.cutoverRequired === true);
  const upgraded = await h.service.install();
  check("owned cutover verifies current candidate, port, identity proof, and loop instance", upgraded.state === "RUN" && upgraded.cutover === true
    && h.state.control.last_result.identity_verified === true
    && h.state.control.last_result.process_instance === h.state.control.process_instance);
  check("owned cutover uses instance-bound STOP once", h.state.calls.filter((name) => name === "control.stop").length === 1);
}
{
  const h = makeHarness(); h.seedRun();
  check("exact Run, VBS, pipe identity, candidate, port and cycle is RUN", (await h.service.inspect()).state === "RUN");
  const reused = await h.service.install();
  check("current semantically successful RUN is reused without relaunch", reused.state === "RUN" && reused.reused === true && !h.state.calls.includes("launcher.launch"));
}
{
  const h = makeHarness(); h.state.failure = "registry.read:before";
  const denied = await h.service.inspect();
  check("unreadable ownership evidence is stable AMBIGUOUS", denied.state === "AMBIGUOUS" && denied.checks.registry === "error");
}

console.log("\n[windows-persistence-3] idempotency, concurrency, uninstall and rollback");
{
  const h = makeHarness();
  const [first, second] = await Promise.all([h.service.install(), h.service.install()]);
  check("concurrent installs converge on RUN", first.state === "RUN" && second.state === "RUN");
  check("fresh install success is identity-proven and bound to its current loop instance", h.state.control.last_result.identity_verified === true
    && h.state.control.last_result.process_instance === h.state.control.process_instance);
  check("only one concurrent install mutates", [first.reused, second.reused].filter(Boolean).length === 1);
  check("installer lock serializes transactions", h.lock.maxActive === 1);
  check("only one launcher runs", h.state.calls.filter((name) => name === "launcher.launch").length === 1);
  const removed = await h.service.uninstall();
  check("uninstall reaches NONE", removed.state === "NONE" && removed.reused === false);
  check("uninstall is idempotent", (await h.service.uninstall()).reused === true);
  await h.service.install();
  check("explicit rollback removes exact RUN", (await h.service.rollback()).state === "NONE");
}

console.log("\n[windows-persistence-4] exact failure rollback");
for (const point of [
  "files.create:before", "files.create:after",
  "registry.create:before", "registry.create:after",
  "launcher.launch:before", "launcher.launch:after",
  "control.waitForStatus:before", "control.waitForStatus:after",
]) {
  const h = makeHarness(); h.state.failure = point;
  await assert.rejects(h.service.install(), (error) => error.code === "INSTALL_FAILED" && error.rollbackComplete === true); checks++;
  check(`install failure ${point} restores NONE`, (await h.service.inspect()).state === "NONE");
}
{
  const h = makeHarness();
  h.state.launchContradiction = (control) => {
    control.immediateCycleComplete = true;
    control.last_result = { ok: false, healthy: false, status: 503, error: "initial health failed" };
  };
  await assert.rejects(h.service.install(), (error) => error.code === "INSTALL_FAILED" && error.rollbackComplete === true); checks++;
  const after = await h.service.inspect();
  check("fresh install with failed immediate health restores exact NONE", after.state === "NONE" && h.state.control == null && h.state.run == null && h.state.vbs == null);
}
for (const point of [
  "control.stop:before", "control.stop:after",
  "control.waitForAbsent:before", "control.waitForAbsent:after",
  "registry.deleteExact:before", "registry.deleteExact:after",
  "files.deleteExact:before", "files.deleteExact:after",
]) {
  const h = makeHarness(); h.seedRun(); h.state.failure = point;
  await assert.rejects(h.service.uninstall(), (error) => error.code === "UNINSTALL_FAILED" && error.rollbackComplete === true); checks++;
  check(`uninstall failure ${point} restores RUN`, (await h.service.inspect()).state === "RUN");
}

console.log("\n[windows-persistence-5] explicit cutover commit boundary");
{
  const h = makeHarness(); h.seedRun(); h.state.control.candidate_id = "old-candidate"; h.state.control.port = 9999;
  h.state.failure = "control.stop:before";
  let failure;
  try { await h.service.install(); } catch (error) { failure = error; }
  check("pre-STOP failure is reported safely", failure?.code === "CUTOVER_FAILED" && failure.cutoverCommitted === false && failure.rollbackComplete === true);
  const after = await h.service.inspect();
  check("pre-STOP failure preserves prior owned cutover state", after.cutoverRequired === true && h.state.control.candidate_id === "old-candidate");
}
{
  const h = makeHarness(); h.seedRun(); h.state.control.candidate_id = "old-candidate"; h.state.control.port = 9999;
  h.state.failure = "control.stop:after";
  let failure;
  try { await h.service.install(); } catch (error) { failure = error; }
  check("STOP error without re-observing the prior instance is uncertain", failure?.code === "CUTOVER_FAILED" && failure.cutoverCommitted === null && failure.rollbackComplete === false && failure.reason === "cutover-uncertain");
  const after = await h.service.inspect();
  check("uncertain STOP with an absent pipe is visibly repairable but not called rollback success", after.reason === "repairable-no-loop" && after.retryable === true);
}
for (const injection of [
  "control.waitForAbsent:before", "control.waitForAbsent:after",
  "launcher.launch:before", "launcher.launch:after",
  "control.waitForStatus:before", "control.waitForStatus:after",
  { point: "control.status:before", skip: 2, label: "post-STOP STATUS" },
  { point: "control.status:before", skip: 3, label: "final STATUS verification" },
  { point: "registry.read:before", skip: 1, label: "final artifact inspection" },
]) {
  const point = typeof injection === "string" ? injection : injection.label;
  const h = makeHarness(); h.seedRun(); h.state.control.candidate_id = "old-candidate"; h.state.control.port = 9999;
  h.state.failure = typeof injection === "string" ? injection : { ...injection };
  let failure;
  try { await h.service.install(); } catch (error) { failure = error; }
  check(`post-STOP failure ${point} is a committed cutover failure`, failure?.code === "CUTOVER_FAILED" && failure.cutoverCommitted === true && failure.rollbackComplete === false);
  const after = await h.service.inspect();
  check(`post-STOP failure ${point} leaves repairable exact artifacts and no loop`, after.state === "AMBIGUOUS" && after.reason === "repairable-no-loop" && after.retryable === true);
  check(`post-STOP failure ${point} preserves exact Run/VBS`, h.state.run?.data === h.service.artifacts.runData && h.state.vbs === h.service.artifacts.vbs);
  const retried = await h.service.install();
  check(`explicit reinstall repairs ${point}`, retried.state === "RUN");
}
{
  const h = makeHarness(); h.seedRun(); h.state.control.candidate_id = "old-candidate"; h.state.control.port = 9999;
  h.state.launchContradiction = (control) => { control.identity = "foreign-runtime"; };
  let failure;
  try { await h.service.install(); } catch (error) { failure = error; }
  check("post-STOP runtime contradiction fails closed", failure?.code === "CUTOVER_FAILED" && failure.cutoverCommitted === true && failure.repairable === false);
  const after = await h.service.inspect();
  check("contradictory runtime is never called RUN or removed", after.state === "AMBIGUOUS" && after.reason === "foreign-or-incomplete-evidence" && h.state.run?.data === h.service.artifacts.runData && h.state.vbs === h.service.artifacts.vbs);
}
{
  const h = makeHarness(); h.seedRun();
  h.state.control.last_result = { ok: false, healthy: false, status: 503, error: "current cycle failed" };
  let failure;
  try { await h.service.install(); } catch (error) { failure = error; }
  check("failed current-cycle reinstall is never reused as RUN", failure?.code === "CUTOVER_FAILED" && failure.cutoverCommitted === true && failure.rollbackComplete === false);
  const after = await h.service.inspect();
  check("failed current-cycle reinstall quiesces the owned loop and retains repairable persistence", after.reason === "repairable-no-loop" && after.retryable === true && h.state.run?.data === h.service.artifacts.runData && h.state.vbs === h.service.artifacts.vbs);
  const repaired = await h.service.install();
  check("explicit reinstall repairs a failed current-cycle status", repaired.state === "RUN");
}
{
  const h = makeHarness(); h.seedRun(); h.state.control.candidate_id = "old-candidate"; h.state.control.port = 9999;
  h.state.launchContradiction = (control) => {
    control.immediateCycleComplete = true;
    control.last_result = { ok: false, healthy: false, status: 503, error: "post-STOP health failed" };
  };
  let failure;
  try { await h.service.install(); } catch (error) { failure = error; }
  check("post-STOP failed immediate health is a committed cutover failure", failure?.code === "CUTOVER_FAILED" && failure.cutoverCommitted === true && failure.rollbackComplete === false);
  const after = await h.service.inspect();
  check("post-STOP failed health retains exact persistence but never RUN", after.state === "AMBIGUOUS" && after.reason === "repairable-no-loop" && after.retryable === true && h.state.run?.data === h.service.artifacts.runData && h.state.vbs === h.service.artifacts.vbs);
  h.state.launchContradiction = null;
  const repaired = await h.service.install();
  check("explicit reinstall repairs post-STOP failed immediate health", repaired.state === "RUN");
}

console.log("\n[windows-persistence-6] bounded hidden executable adapters and safe CLI output");
{
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options });
    queueMicrotask(() => callback(null, `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ${WINDOWS_PERSISTENCE.runValueName}    REG_SZ    ${rendered.runData}\r\n`, ""));
    return { stdin: { end() {} } };
  };
  const reg = createRegExeAdapter({ execFileImpl, timeoutMs: 321 });
  check("reg query parses exact value", (await reg.read()).data === rendered.runData);
  check("reg.exe is hidden and bounded", calls[0].command === "reg.exe" && calls[0].options.windowsHide === true && calls[0].options.timeout === 321);
  await reg.create(rendered.runValue);
  check("registry create is non-forcing to avoid overwriting a race collision", !calls.at(-1).args.includes("/f"));
  const wscript = createWscriptAdapter({ execFileImpl, timeoutMs: 654 });
  await wscript.launch(rendered.vbsPath);
  const launch = calls.at(-1);
  check("wscript.exe is hidden and bounded", launch.command === "wscript.exe" && launch.options.windowsHide === true && launch.options.timeout === 654);
  check("wscript arguments are exact and shell-free", JSON.stringify(launch.args) === JSON.stringify(["//B", "//Nologo", rendered.vbsPath]));
}
{
  const failingExec = (stderrText) => (_command, _args, _options, callback) => {
    const error = Object.assign(new Error("reg failed"), { code: 1 });
    queueMicrotask(() => callback(error, "", stderrText));
    return { stdin: { end() {} } };
  };
  const missing = createRegExeAdapter({ execFileImpl: failingExec("ERROR: The system was unable to find the specified registry value.") });
  check("missing Run value is distinguished from a denied read", await missing.read() === null);
  const denied = createRegExeAdapter({ execFileImpl: failingExec("ERROR: Access is denied.") });
  await assert.rejects(denied.read()); checks++;
}
{
  const calls = [];
  const sendWatchdogCommandImpl = async (input) => {
    calls.push(input);
    return {
      ok: true,
      identity: watchdogIdentity,
      mode: "loop",
      process_instance: "instance-bound-stop",
      pid: 4321,
      started_at: "2026-07-25T00:00:00.000Z",
      candidate_id: candidateId,
      port,
      cycle_count: 1,
      cycle_state: "idle",
      last_error: null,
      last_result: {
        ok: true,
        recovered: false,
        healthy: true,
        status: 200,
        identity_verified: true,
        process_instance: "instance-bound-stop",
      },
    };
  };
  const adapter = createControlAdapter({
    identity: watchdogIdentity,
    pipePath: "identity-hashed-test-pipe",
    port,
    candidateId,
    sendWatchdogCommandImpl,
  });
  await adapter.status();
  await adapter.stop({ identity: watchdogIdentity, candidateId, port, processInstance: "instance-bound-stop" });
  check("STATUS reuses watchdog sender with narrow mismatch inspection", calls[0].op === "STATUS" && calls[0].allowRuntimeMismatch === true);
  check("STOP is bound to the inspected process instance", calls[1].op === "STOP" && calls[1].expectedProcessInstance === "instance-bound-stop");
}
{
  const nonresponsive = createControlAdapter({
    identity: watchdogIdentity,
    pipePath: "identity-hashed-test-pipe",
    port,
    candidateId,
    sendWatchdogCommandImpl: async () => { throw Object.assign(new Error("busy"), { code: "ECONNREFUSED" }); },
  });
  await assert.rejects(nonresponsive.status()); checks++;
}
{
  const h = makeHarness();
  h.state.run = { type: "REG_SZ", data: "FOREIGN_SECRET_MUST_NOT_PRINT" };
  let stdout = ""; let stderr = "";
  const exitCode = await runWindowsPersistenceCli({
    command: "install",
    service: h.service,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  check("ambiguous CLI exits 2", exitCode === 2);
  check("CLI never prints foreign registry data", !`${stdout}${stderr}`.includes("FOREIGN_SECRET_MUST_NOT_PRINT"));
}

console.log(`\nWINDOWS PERSISTENCE TEST PASS (${checks} checks)`);
