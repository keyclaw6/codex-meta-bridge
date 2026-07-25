import crypto from "node:crypto";
import path from "node:path";

export const WINDOWS_PERSISTENCE = Object.freeze({
  marker: "CodexMetaBridgeWatchdog",
  runKey: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  runValueName: "CodexMetaBridgeWatchdog",
  vbsName: "watchdog-supervisor-hidden.vbs",
});

export function windowsPersistenceInstallerPipePath(watchdogIdentity) {
  const identity = String(watchdogIdentity || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(identity)) throw new Error("A valid watchdog identity is required for the installer singleton");
  return `\\\\.\\pipe\\codex-meta-bridge-watchdog-install-v1-${identity.toLowerCase()}`;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const vbsCommandArgument = (value) => {
  const text = String(value);
  if (!text || /["\r\n]/.test(text)) throw new Error("Windows persistence paths must be non-empty and cannot contain quotes or newlines");
  return `""${text}""`;
};

export function renderWindowsServiceFiles({ repoRoot, bridgeDir, nodePath }) {
  const watchdogPath = path.win32.join(repoRoot, "setup", "watchdog.mjs");
  const vbsPath = path.win32.join(bridgeDir, WINDOWS_PERSISTENCE.vbsName);
  const command = `${vbsCommandArgument(nodePath)} ${vbsCommandArgument(watchdogPath)} --loop`;
  const vbs = [
    `' ${WINDOWS_PERSISTENCE.marker} managed launcher v1`,
    "Option Explicit",
    "Dim shell, command, ignored",
    'Set shell = CreateObject("WScript.Shell")',
    `command = "${command}"`,
    "ignored = shell.Run(command, 0, False)",
    "",
  ].join("\r\n");
  const runData = `wscript.exe //B //Nologo "${vbsPath}"`;

  return {
    watchdogPath,
    vbsPath,
    vbs,
    vbsHash: sha256(vbs),
    runValue: { type: "REG_SZ", data: runData },
    runData,
  };
}

export class WindowsPersistenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WindowsPersistenceError";
    this.code = code;
    Object.assign(this, details);
  }
}

const safeCall = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch { return { ok: false, value: null }; }
};

const controlIsAbsent = (value) => value == null || value.exists === false;

const completedImmediateCycle = (value) => {
  const result = value?.last_result;
  return value?.ok === true
    && Number(value?.cycle_count) >= 1
    && value?.cycle_state === "idle"
    && result != null
    && typeof result === "object"
    && !Array.isArray(result)
    && result.ok === true
    && result.healthy === true
    && Number(result.status) === 200
    && result.identity_verified === true
    && result.process_instance === value.process_instance
    && value.error == null
    && value.last_error == null
    && value.ambiguous !== true
    && value.contradictory !== true
    && result.error == null
    && result.ambiguous !== true
    && result.contradictory !== true;
};

const controlIsSameBridge = (value, expected) => value?.exists === true
  && value.responsive === true
  && value.identity === expected.identity
  && value.mode === "loop"
  && typeof value.process_instance === "string"
  && value.process_instance.length > 0
  && Number.isInteger(Number(value.pid))
  && Number(value.pid) > 0
  && typeof value.started_at === "string"
  && value.started_at.length > 0;

const controlIsOwned = (value, expected, requireCycle = true) => controlIsSameBridge(value, expected)
  && (value.candidate_id || null) === expected.candidateId
  && Number(value.port) === expected.port
  && (!requireCycle || completedImmediateCycle(value));

const classifyRegistry = (read, expected) => {
  if (!read.ok) return "error";
  if (read.value == null) return "absent";
  return read.value.type === expected.type && read.value.data === expected.data ? "exact" : "foreign";
};

const classifyVbs = (read, expectedHash) => {
  if (!read.ok) return "error";
  if (read.value == null) return "absent";
  return sha256(read.value) === expectedHash ? "exact" : "foreign";
};

const classifyControl = (read, expected) => {
  if (!read.ok) return "error";
  if (controlIsAbsent(read.value)) return "absent";
  if (controlIsOwned(read.value, expected)) return "exact";
  if (controlIsOwned(read.value, expected, false)) return "starting";
  if (controlIsSameBridge(read.value, expected)) return "cutover";
  return "foreign";
};

export function createWindowsPersistence({
  repoRoot,
  bridgeDir,
  nodePath,
  watchdogIdentity,
  candidateId,
  port,
  registry,
  files,
  launcher,
  control,
  lock,
}) {
  const artifacts = renderWindowsServiceFiles({ repoRoot, bridgeDir, nodePath });
  const expected = {
    identity: String(watchdogIdentity || "").trim() || null,
    candidateId: String(candidateId || "").trim() || null,
    port: Number(port),
  };

  const inspect = async () => {
    const [runRead, vbsRead, controlRead] = await Promise.all([
      safeCall(() => registry.read()),
      safeCall(() => files.read(artifacts.vbsPath)),
      safeCall(() => control.status()),
    ]);
    const checks = {
      registry: classifyRegistry(runRead, artifacts.runValue),
      vbs: classifyVbs(vbsRead, artifacts.vbsHash),
      control: classifyControl(controlRead, expected),
    };
    const all = Object.values(checks);
    const state = all.every((value) => value === "absent")
      ? "NONE"
      : expected.identity && expected.candidateId && Number.isInteger(expected.port) && expected.port > 0 && expected.port <= 65535
        && all.every((value) => value === "exact")
        ? "RUN"
        : "AMBIGUOUS";
    const exactArtifacts = checks.registry === "exact" && checks.vbs === "exact";
    const cutoverRequired = exactArtifacts && checks.control === "cutover";
    const retryable = exactArtifacts && (checks.control === "absent" || checks.control === "starting");
    const reason = state === "NONE" ? "not-installed"
      : state === "RUN" ? "owned-run"
      : cutoverRequired ? "owned-cutover-required"
      : retryable && checks.control === "absent" ? "repairable-no-loop"
      : retryable ? "repairable-starting-loop"
      : "foreign-or-incomplete-evidence";
    return {
      ok: state !== "AMBIGUOUS",
      state,
      checks,
      identity: expected.identity,
      candidateId: expected.candidateId,
      port: expected.port,
      vbsPath: artifacts.vbsPath,
      vbsHash: artifacts.vbsHash,
      reason,
      cutoverRequired,
      retryable,
    };
  };

  const lockedInspect = async () => {
    try { return await lock.withLock(inspect); }
    catch { return { ...(await inspect()), ok: false, state: "AMBIGUOUS", reason: "transaction-busy" }; }
  };

  const waitForRun = async () => {
    if (control.waitForStatus) await control.waitForStatus(expected);
    return inspect();
  };

  const waitForAbsent = async () => {
    if (control.waitForAbsent) await control.waitForAbsent();
  };

  const rollbackInstall = async ({ launchAttempted }) => {
    const issues = [];
    if (launchAttempted) {
      const owner = await safeCall(() => control.status());
      if (owner.ok && controlIsOwned(owner.value, expected, false)) {
        try {
          await control.stop({ ...expected, processInstance: owner.value.process_instance });
          await waitForAbsent();
        }
        catch { issues.push("stop-failed"); }
      } else if (!owner.ok || !controlIsAbsent(owner.value)) {
        issues.push("control-ownership-uncertain");
      }
    }
    try { await registry.deleteExact(artifacts.runValue); }
    catch { issues.push("registry-restore-failed"); }
    try { await files.deleteExact(artifacts.vbsPath, artifacts.vbsHash); }
    catch { issues.push("vbs-restore-failed"); }
    const final = await inspect();
    return { complete: final.state === "NONE", state: final.state, issues };
  };

  const restoreRun = async () => {
    const issues = [];
    try { await files.ensureExact(artifacts.vbsPath, artifacts.vbs); }
    catch { issues.push("vbs-restore-failed"); }
    try { await registry.ensureExact(artifacts.runValue); }
    catch { issues.push("registry-restore-failed"); }

    const owner = await safeCall(() => control.status());
    if (owner.ok && controlIsAbsent(owner.value)) {
      try { await launcher.launch(artifacts.vbsPath); await waitForRun(); }
      catch { issues.push("launcher-restore-failed"); }
    } else if (!owner.ok || !controlIsOwned(owner.value, expected, false)) {
      issues.push("control-ownership-uncertain");
    }
    const final = await inspect();
    return { complete: final.state === "RUN", state: final.state, issues };
  };

  const install = () => lock.withLock(async () => {
    const before = await inspect();
    if (before.state === "RUN") return { ...before, operation: "install", reused: true };
    if (before.cutoverRequired || before.retryable) {
      if (!expected.candidateId) {
        throw new WindowsPersistenceError("CANDIDATE_REQUIRED", "A frozen candidate identity is required before installation");
      }
      let cutoverCommitted = before.retryable;
      let stopAttempted = false;
      let priorProcessInstance = null;
      try {
        const owner = await control.status();
        if (before.cutoverRequired) {
          if (!controlIsSameBridge(owner, expected)) throw new Error("control ownership changed");
          priorProcessInstance = owner.process_instance;
          stopAttempted = true;
          await control.stop({
            ...expected,
            candidateId: owner.candidate_id || null,
            port: Number(owner.port),
            processInstance: owner.process_instance,
          });
          cutoverCommitted = true;
          await waitForAbsent();
        } else if (!controlIsAbsent(owner) && !controlIsOwned(owner, expected, false)) {
          throw new Error("control ownership changed");
        }
        if (controlIsAbsent(await control.status())) await launcher.launch(artifacts.vbsPath);
        const after = await waitForRun();
        if (after.state !== "RUN") throw new Error("verification failed");
        return { ...after, operation: "install", reused: false, cutover: before.cutoverRequired };
      } catch {
        let observed = await safeCall(() => control.status());
        if (!cutoverCommitted && stopAttempted && observed.ok) {
          cutoverCommitted = controlIsSameBridge(observed.value, expected)
            && observed.value.process_instance === priorProcessInstance
            ? false
            : null;
        } else if (!cutoverCommitted && stopAttempted && !observed.ok) {
          cutoverCommitted = null;
        }
        if (cutoverCommitted && observed.ok && controlIsOwned(observed.value, expected, false)) {
          try {
            await control.stop({ ...expected, processInstance: observed.value.process_instance });
            await waitForAbsent();
            observed = { ok: true, value: null };
          } catch { /* exact artifacts remain; status is fail-closed below */ }
        }
        const after = await inspect();
        throw new WindowsPersistenceError(
          "CUTOVER_FAILED",
          cutoverCommitted === true
            ? "The prior watchdog was stopped, but the current watchdog did not verify; exact Run/VBS persistence remains for an explicit retry or next logon"
            : cutoverCommitted === false
              ? "Watchdog cutover did not reach its STOP commit boundary; the same prior runtime was re-observed and persistence was left unchanged"
              : "The STOP outcome is uncertain; exact Run/VBS persistence remains, but runtime ownership requires inspection",
          {
            rollbackComplete: cutoverCommitted === false,
            cutoverCommitted,
            state: "AMBIGUOUS",
            reason: cutoverCommitted === true ? "cutover-failed"
              : cutoverCommitted === false ? after.reason
              : "cutover-uncertain",
            repairable: cutoverCommitted === true && after.checks.control === "absent",
          },
        );
      }
    }
    if (before.state !== "NONE") {
      throw new WindowsPersistenceError("AMBIGUOUS", "Windows persistence ownership is ambiguous; no artifacts were changed");
    }
    if (!expected.candidateId) {
      throw new WindowsPersistenceError("CANDIDATE_REQUIRED", "A frozen candidate identity is required before installation");
    }

    let launchAttempted = false;
    try {
      await files.create(artifacts.vbsPath, artifacts.vbs);
      await registry.create(artifacts.runValue);
      launchAttempted = true;
      await launcher.launch(artifacts.vbsPath);
      const after = await waitForRun();
      if (after.state !== "RUN") throw new Error("verification failed");
      return { ...after, operation: "install", reused: false };
    } catch {
      const rollback = await rollbackInstall({ launchAttempted });
      throw new WindowsPersistenceError(
        "INSTALL_FAILED",
        rollback.complete ? "Windows persistence install failed and was rolled back" : "Windows persistence install failed; rollback is incomplete and requires inspection",
        { rollbackComplete: rollback.complete, state: rollback.state, rollbackIssues: rollback.issues },
      );
    }
  });

  const remove = (operation) => lock.withLock(async () => {
    const before = await inspect();
    if (before.state === "NONE") return { ...before, operation, reused: true };
    if (before.state !== "RUN") {
      throw new WindowsPersistenceError("AMBIGUOUS", "Windows persistence ownership is ambiguous; no artifacts were changed");
    }

    try {
      const owner = await control.status();
      if (!controlIsOwned(owner, expected, false)) throw new Error("control ownership changed");
      await control.stop({ ...expected, processInstance: owner.process_instance });
      await waitForAbsent();
      await registry.deleteExact(artifacts.runValue);
      await files.deleteExact(artifacts.vbsPath, artifacts.vbsHash);
      const after = await inspect();
      if (after.state !== "NONE") throw new Error("verification failed");
      return { ...after, operation, reused: false };
    } catch {
      const rollback = await restoreRun();
      throw new WindowsPersistenceError(
        operation === "rollback" ? "ROLLBACK_FAILED" : "UNINSTALL_FAILED",
        rollback.complete ? `Windows persistence ${operation} failed and the prior RUN state was restored` : `Windows persistence ${operation} failed; restoration is incomplete and requires inspection`,
        { rollbackComplete: rollback.complete, state: rollback.state, rollbackIssues: rollback.issues },
      );
    }
  });

  return {
    artifacts,
    inspect: lockedInspect,
    install,
    uninstall: () => remove("uninstall"),
    rollback: () => remove("rollback"),
  };
}
