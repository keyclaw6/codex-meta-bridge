#!/usr/bin/env node
/**
 * Independent bridge watchdog.
 *
 * Default and --force are bounded one-shot checks. On Windows, --loop is the
 * resident per-user supervisor. Every mode shares one atomic named-pipe
 * authority, so duplicate launchers delegate instead of overlapping recovery.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../src/config.mjs";
import {
  probeHealth,
  findOwnedBridgePidsOnPort,
  killPids,
  spawnDaemonDetached,
  waitForPortFree,
  waitForHealth
} from "../src/proc.mjs";

export const WATCHDOG_PROTOCOL = "codex-meta-bridge-watchdog/1";
export const WATCHDOG_INTERVAL_MS = 60000;
const PIPE_TIMEOUT_MS = 2000;
const MAX_PIPE_MESSAGE_BYTES = 2048;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const safeErrorCode = (error) => String(error?.code || error?.name || "WATCHDOG_ERROR")
  .replace(/[^A-Za-z0-9_.-]/g, "_")
  .slice(0, 80);

const canonicalPath = (value, { platform = process.platform, realpathSyncImpl = fs.realpathSync.native } = {}) => {
  let resolved = path.resolve(String(value));
  try { resolved = realpathSyncImpl(resolved); } catch { /* path may not exist in pure tests */ }
  resolved = path.normalize(resolved);
  if (platform !== "win32") return resolved;
  if (resolved.startsWith("\\\\?\\UNC\\")) resolved = `\\\\${resolved.slice(8)}`;
  else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
  return resolved.toLowerCase();
};

export function buildWatchdogIdentity(repoRoot, cfgPath, options = {}) {
  const repo = canonicalPath(repoRoot, options);
  const config = canonicalPath(cfgPath, options);
  return crypto.createHash("sha256")
    .update(`codex-meta-bridge-watchdog-v1\0${repo}\0${config}`)
    .digest("hex")
    .slice(0, 32);
}

export function watchdogPipePath(identity, platform = process.platform) {
  if (platform !== "win32") return null;
  return `\\\\.\\pipe\\codex-meta-bridge-watchdog-v1-${identity}`;
}

export function readCandidateId(cfg, {
  env = process.env,
  readFileSyncImpl = fs.readFileSync
} = {}) {
  const fromEnv = String(env.BRIDGE_CANDIDATE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return String(readFileSyncImpl(path.join(cfg.bridgeDir, "state", "candidate-id"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export function healthIdentityMatches(health, ownership, cfg, candidateId) {
  const identity = health?.identity;
  const authority = ownership?.authority?.[0];
  return health?.ok === true
    && Number(health.status) === 200
    && identity?.ok === true
    && identity?.service === "codex-meta-bridge"
    && ownership?.ok === true
    && ownership.owned?.length === 1
    && Number(ownership.listener_count) === 1
    && authority != null
    && Number(identity.pid) === Number(ownership.owned[0])
    && Number(authority.pid) === Number(ownership.owned[0])
    && (identity.candidate_id || null) === (candidateId || null)
    && (authority.candidate_id || null) === (candidateId || null)
    && identity.repo_identity === authority.repo_identity
    && identity.process_instance === authority.process_instance
    && identity.process_creation_time_filetime_utc === authority.process_creation_time_filetime_utc
    && String(identity.host || "").toLowerCase() === String(cfg.host || "").toLowerCase()
    && Number(identity.port) === Number(cfg.port);
}

export function createFileLogger(logPath, {
  appendFileSyncImpl = fs.appendFileSync,
  mkdirSyncImpl = fs.mkdirSync,
  now = () => new Date()
} = {}) {
  mkdirSyncImpl(path.dirname(logPath), { recursive: true });
  return (msg, extra = {}) => {
    const line = JSON.stringify({ t: now().toISOString(), msg, ...extra });
    try { appendFileSyncImpl(logPath, line + "\n"); } catch { /* best effort */ }
  };
}

export async function runRecoveryCycle({
  cfg,
  repoRoot = REPO_ROOT,
  force = false,
  log = () => {},
  proc = {}
}) {
  const probeHealthImpl = proc.probeHealth || probeHealth;
  const findOwnedBridgePidsOnPortImpl = proc.findOwnedBridgePidsOnPort || findOwnedBridgePidsOnPort;
  const killPidsImpl = proc.killPids || killPids;
  const waitForPortFreeImpl = proc.waitForPortFree || waitForPortFree;
  const spawnDaemonDetachedImpl = proc.spawnDaemonDetached || spawnDaemonDetached;
  const waitForHealthImpl = proc.waitForHealth || waitForHealth;

  const candidateId = readCandidateId(cfg);
  const health = await probeHealthImpl(cfg.port);
  let ownership = null;
  if (health.ok) {
    ownership = await findOwnedBridgePidsOnPortImpl(cfg.port, {
      host: cfg.host,
      repoRoot,
      bridgeDir: cfg.bridgeDir,
      candidateId,
    });
    if (!healthIdentityMatches(health, ownership, cfg, candidateId)) {
      log("health identity ambiguous - recovery refused", {
        status: Number(health.status) || 0,
        listener_count: Number(ownership?.listener_count) || 0,
      });
      return { ok: false, recovered: false, healthy: false, status: Number(health.status) || 0, error: "HEALTH_IDENTITY_AMBIGUOUS" };
    }
    if (!force) {
      log("healthy", { status: Number(health.status) || 0 });
      return { ok: true, recovered: false, healthy: true, status: Number(health.status) || 0, identity_verified: true };
    }
  }

  log(force ? "forced restart requested" : "unhealthy - recovering", {
    status: Number(health.status) || 0
  });

  ownership ||= await findOwnedBridgePidsOnPortImpl(cfg.port, {
    host: cfg.host,
    repoRoot,
    bridgeDir: cfg.bridgeDir,
    candidateId,
  });
  if (!ownership.ok) {
    log("port owner ambiguous - recovery refused", {
      listener_count: Number(ownership.listener_count) || 0,
      ambiguous_count: Array.isArray(ownership.ambiguous) ? ownership.ambiguous.length : 0,
    });
    return { ok: false, recovered: false, healthy: false, status: 0, error: ownership.error || "PORT_OWNER_AMBIGUOUS" };
  }
  const pids = ownership.owned;
  if (pids.length) {
    const authority = ownership.authority?.[0];
    if (pids.length !== 1 || !authority || Number(authority.pid) !== Number(pids[0])) {
      return { ok: false, recovered: false, healthy: false, status: 0, error: "PORT_OWNER_AMBIGUOUS" };
    }
    const revalidatePidImpl = (pid) => {
      try {
        const current = findOwnedBridgePidsOnPortImpl(cfg.port, {
          host: cfg.host,
          repoRoot,
          bridgeDir: cfg.bridgeDir,
          candidateId,
        });
        const currentAuthority = current.authority?.[0];
        return current.ok
          && current.owned.length === 1
          && Number(current.owned[0]) === Number(pid)
          && currentAuthority?.process_instance === authority.process_instance
          && currentAuthority?.process_creation_time_filetime_utc === authority.process_creation_time_filetime_utc
          && currentAuthority?.repo_identity === authority.repo_identity
          && (currentAuthority?.candidate_id || null) === (authority.candidate_id || null);
      } catch { return false; }
    };
    const { killed, errors } = killPidsImpl(pids, { verifiedPids: pids, revalidatePidImpl });
    log("killed port holders", {
      pids,
      killed_count: killed.length,
      error_count: errors.length,
      error_codes: errors.map((value) => String(value).split(": ").slice(1).join(": ")).filter(Boolean),
    });
    if (errors.length || killed.length !== pids.length) {
      return { ok: false, recovered: false, healthy: false, status: 0, error: "PROCESS_TERMINATION_FAILED" };
    }
    const free = await waitForPortFreeImpl(cfg.port, 10000);
    if (!free) {
      log("port did not become free", { pid_count: pids.length });
      return { ok: false, recovered: false, healthy: false, status: 0, error: "PORT_NOT_FREE" };
    }
  }

  const daemonLog = path.join(cfg.bridgeDir, "logs", "daemon.log");
  const pid = spawnDaemonDetachedImpl(repoRoot, daemonLog);
  log("spawned daemon", { pid });

  const back = await waitForHealthImpl(cfg.port, 20000, {
    probeHealthImpl,
    validateHealth: async (currentHealth) => {
      const currentOwnership = await findOwnedBridgePidsOnPortImpl(cfg.port, {
        host: cfg.host,
        repoRoot,
        bridgeDir: cfg.bridgeDir,
        candidateId,
      });
      return healthIdentityMatches(currentHealth, currentOwnership, cfg, candidateId);
    },
  });
  log(back ? "daemon healthy after restart" : "daemon did NOT become healthy in time", { healthy: back });
  return {
    ok: back,
    recovered: back,
    healthy: back,
    status: back ? 200 : 0,
    ...(back ? { identity_verified: true } : { error: "DAEMON_HEALTH_TIMEOUT" })
  };
}

export function bindCycleResultToProcessInstance(result, processInstance) {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return result;
  const { process_instance: _untrustedProcessInstance, ...sanitized } = result;
  return sanitized.ok === true && typeof processInstance === "string" && processInstance.length > 0
    ? { ...sanitized, process_instance: processInstance }
    : sanitized;
}

export function createCycleScheduler({
  mode,
  runCycle,
  intervalMs = WATCHDOG_INTERVAL_MS,
  log = () => {},
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
}) {
  if (mode !== "loop" && mode !== "once") throw new Error("mode must be loop or once");

  let active = false;
  let activeForce = false;
  let pendingForce = false;
  let stopping = false;
  let stopped = false;
  let timer = null;
  let timerDueAt = null;
  let lastStartedAt = null;
  let lastFinishedAt = null;
  let lastResult = null;
  let lastError = null;
  let cycleCount = 0;
  let resolveStopped;
  const whenStopped = new Promise((resolve) => { resolveStopped = resolve; });

  const finish = () => {
    if (stopped) return;
    stopped = true;
    stopping = true;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    timerDueAt = null;
    resolveStopped();
  };

  const arm = (delayMs) => {
    if (stopping || stopped || mode !== "loop") return;
    if (timer !== null) clearTimeoutImpl(timer);
    const delay = Math.max(0, Number(delayMs) || 0);
    timerDueAt = now() + delay;
    timer = setTimeoutImpl(() => {
      timer = null;
      timerDueAt = null;
      void execute(false);
    }, delay);
  };

  const execute = async (force) => {
    if (active || stopping || stopped) return;
    active = true;
    activeForce = Boolean(force);
    const startedAtMs = now();
    lastStartedAt = new Date(startedAtMs).toISOString();
    cycleCount++;
    try {
      lastResult = await runCycle(Boolean(force));
      lastError = null;
    } catch (error) {
      lastResult = { ok: false, healthy: false, error: "CYCLE_ERROR" };
      lastError = safeErrorCode(error);
      log("cycle error", { error: lastError });
    } finally {
      active = false;
      activeForce = false;
      lastFinishedAt = new Date(now()).toISOString();
    }

    if (stopping) return finish();
    if (pendingForce) {
      pendingForce = false;
      return void execute(true);
    }
    if (mode === "once") return finish();
    arm(Math.max(0, startedAtMs + intervalMs - now()));
  };

  const request = (op) => {
    if (stopping || stopped) return { accepted: false, coalesced: false };
    const force = op === "FORCE";
    if (active) {
      if (force && !activeForce) {
        const alreadyPending = pendingForce;
        pendingForce = true;
        return { accepted: true, coalesced: alreadyPending };
      }
      return { accepted: true, coalesced: true };
    }
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
      timerDueAt = null;
    }
    void execute(force);
    return { accepted: true, coalesced: false };
  };

  const stop = () => {
    if (stopped) return { accepted: true, already_stopped: true };
    stopping = true;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    timerDueAt = null;
    if (!active) finish();
    return { accepted: true, already_stopped: false };
  };

  return {
    start(force = false) {
      if (active || stopped || stopping || cycleCount > 0) return false;
      void execute(force);
      return true;
    },
    request,
    stop,
    whenStopped,
    status() {
      return {
        mode,
        cycle_state: active ? "running" : (stopped ? "stopped" : "idle"),
        active_force: active && activeForce,
        pending_force: pendingForce,
        stopping,
        cycle_count: cycleCount,
        last_started_at: lastStartedAt,
        last_finished_at: lastFinishedAt,
        next_due_at: timerDueAt === null ? null : new Date(timerDueAt).toISOString(),
        last_result: lastResult,
        last_error: lastError
      };
    }
  };
}

const writePipeResponse = (socket, response) => {
  if (socket.destroyed || !socket.writable) return;
  try { socket.end(JSON.stringify(response) + "\n"); } catch { socket.destroy(); }
};

export async function listenWatchdogServer({
  pipePath,
  identity,
  port,
  candidateId,
  mode,
  processInstance,
  startedAt,
  pid = process.pid,
  controller,
  createServerImpl = net.createServer
}) {
  const baseStatus = () => ({
    ok: true,
    protocol: WATCHDOG_PROTOCOL,
    identity,
    mode,
    process_instance: processInstance,
    pid,
    started_at: startedAt,
    candidate_id: candidateId,
    port,
    ...controller.status()
  });

  const server = createServerImpl((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.setTimeout(PIPE_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      try {
        input += chunk;
        if (Buffer.byteLength(input, "utf8") > MAX_PIPE_MESSAGE_BYTES) return socket.destroy();
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        socket.removeAllListeners("data");
        let request;
        try { request = JSON.parse(input.slice(0, newline)); }
        catch { return writePipeResponse(socket, { ok: false, protocol: WATCHDOG_PROTOCOL, identity, error: "INVALID_REQUEST" }); }
        if (request?.protocol !== WATCHDOG_PROTOCOL || request?.identity !== identity) {
          return writePipeResponse(socket, { ok: false, protocol: WATCHDOG_PROTOCOL, identity, error: "IDENTITY_MISMATCH" });
        }
        const op = String(request.op || "").toUpperCase();
        if (op === "PING") return writePipeResponse(socket, baseStatus());
        if (op === "STATUS") return writePipeResponse(socket, baseStatus());
        if (op === "CHECK" || op === "FORCE") {
          const result = controller.request(op);
          return writePipeResponse(socket, {
            ...baseStatus(),
            ...result,
            ok: result.accepted === true,
            ...(result.accepted === true ? {} : { error: "WATCHDOG_NOT_ACCEPTING" }),
            op
          });
        }
        if (op === "STOP") {
          if (mode !== "loop") return writePipeResponse(socket, { ...baseStatus(), ok: false, error: "NOT_RESIDENT_LOOP" });
          if (!request.process_instance || request.process_instance !== processInstance) {
            return writePipeResponse(socket, { ...baseStatus(), ok: false, error: "INSTANCE_MISMATCH" });
          }
          return writePipeResponse(socket, { ...baseStatus(), ...controller.stop(), op });
        }
        return writePipeResponse(socket, { ...baseStatus(), ok: false, error: "UNKNOWN_OPERATION" });
      } catch {
        return writePipeResponse(socket, { ok: false, protocol: WATCHDOG_PROTOCOL, identity, error: "REQUEST_FAILED" });
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: pipePath, readableAll: false, writableAll: false });
  });
  return server;
}

export async function sendWatchdogCommand({
  pipePath,
  identity,
  port,
  candidateId,
  op,
  allowRuntimeMismatch = false,
  expectedProcessInstance = null,
  timeoutMs = PIPE_TIMEOUT_MS,
  createConnectionImpl = net.createConnection
}) {
  const response = await new Promise((resolve, reject) => {
    const socket = createConnectionImpl(pipePath);
    let input = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(reject, Object.assign(new Error("watchdog pipe timeout"), { code: "WATCHDOG_PIPE_TIMEOUT" })));
    socket.on("error", (error) => finish(reject, error));
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        protocol: WATCHDOG_PROTOCOL,
        identity,
        op,
        ...(expectedProcessInstance ? { process_instance: expectedProcessInstance } : {})
      }) + "\n");
    });
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_PIPE_MESSAGE_BYTES) {
        return finish(reject, Object.assign(new Error("watchdog response too large"), { code: "WATCHDOG_RESPONSE_TOO_LARGE" }));
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try { finish(resolve, JSON.parse(input.slice(0, newline))); }
      catch { finish(reject, Object.assign(new Error("invalid watchdog response"), { code: "WATCHDOG_INVALID_RESPONSE" })); }
    });
  });

  if (response?.protocol !== WATCHDOG_PROTOCOL || response?.identity !== identity) {
    throw Object.assign(new Error("foreign watchdog pipe"), { code: "WATCHDOG_FOREIGN_PIPE" });
  }
  if (expectedProcessInstance && response.process_instance !== expectedProcessInstance) {
    throw Object.assign(new Error("watchdog process instance mismatch"), { code: "WATCHDOG_INSTANCE_MISMATCH" });
  }
  if (!allowRuntimeMismatch && (Number(response.port) !== Number(port) || (response.candidate_id || null) !== (candidateId || null))) {
    throw Object.assign(new Error("watchdog runtime identity mismatch"), { code: "WATCHDOG_RUNTIME_MISMATCH" });
  }
  if (!response.ok) throw Object.assign(new Error("watchdog command rejected"), { code: response.error || "WATCHDOG_COMMAND_REJECTED" });
  return response;
}

const RETRYABLE_DELEGATION_ERRORS = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "WATCHDOG_PIPE_TIMEOUT"
]);

export async function acquireWatchdogAuthority({
  listenOwner,
  delegateOwner,
  attempts = 3,
  retryDelayMs = 75,
  delayImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return { kind: "owner", server: await listenOwner(), attempt };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }

    try {
      return { kind: "delegated", response: await delegateOwner(), attempt };
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_DELEGATION_ERRORS.has(error?.code)) throw error;
    }

    if (attempt < attempts) await delayImpl(retryDelayMs);
  }

  throw Object.assign(new Error("watchdog authority could not be safely established"), {
    code: "WATCHDOG_AUTHORITY_UNCERTAIN",
    cause: lastError
  });
}

const closeServer = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
});

const optionValue = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export async function main(args = process.argv.slice(2), env = process.env) {
  const explicitConfigPath = optionValue(args, "--config-path");
  if (explicitConfigPath) env.BRIDGE_CONFIG_PATH = explicitConfigPath;

  const cfg = loadConfig();
  const cfgPath = configPath();
  const candidateId = readCandidateId(cfg, { env });
  const identity = buildWatchdogIdentity(REPO_ROOT, cfgPath);
  const pipePath = watchdogPipePath(identity);
  const log = createFileLogger(path.join(cfg.bridgeDir, "logs", "watchdog.log"));
  const controls = ["PING", "STATUS", "CHECK", "STOP"];
  const selectedControls = controls.filter((op) => args.includes(`--${op.toLowerCase()}`));
  const wantsLoop = args.includes("--loop");
  const force = args.includes("--force");

  if (selectedControls.length > 1 || (wantsLoop && (force || selectedControls.length))) {
    log("invalid watchdog arguments", { error: "INVALID_ARGUMENTS" });
    return 2;
  }

  if (process.platform !== "win32") {
    if (wantsLoop || selectedControls.length) {
      log("watchdog control unavailable", { error: "WINDOWS_ONLY_CONTROL" });
      return 2;
    }
    const result = await runRecoveryCycle({ cfg, force, log });
    return result.ok ? 0 : 1;
  }

  if (selectedControls.length) {
    try {
      const op = selectedControls[0];
      const status = op === "STOP"
        ? await sendWatchdogCommand({ pipePath, identity, port: cfg.port, candidateId, op: "STATUS" })
        : null;
      const response = await sendWatchdogCommand({
        pipePath,
        identity,
        port: cfg.port,
        candidateId,
        op,
        ...(status ? { expectedProcessInstance: status.process_instance } : {})
      });
      process.stdout.write(JSON.stringify(response) + "\n");
      return 0;
    } catch (error) {
      log("watchdog control failed", { error: safeErrorCode(error) });
      return 1;
    }
  }

  const mode = wantsLoop ? "loop" : "once";
  const processInstance = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const controller = createCycleScheduler({
    mode,
    log,
    runCycle: async (cycleForce) => bindCycleResultToProcessInstance(
      await runRecoveryCycle({ cfg, force: cycleForce, log }),
      processInstance,
    )
  });
  let server;
  try {
    const op = wantsLoop ? "PING" : (force ? "FORCE" : "CHECK");
    const authority = await acquireWatchdogAuthority({
      listenOwner: () => listenWatchdogServer({
        pipePath,
        identity,
        port: cfg.port,
        candidateId,
        mode,
        processInstance,
        startedAt,
        controller
      }),
      delegateOwner: () => sendWatchdogCommand({ pipePath, identity, port: cfg.port, candidateId, op })
    });
    if (authority.kind === "delegated") return 0;
    server = authority.server;
  } catch (error) {
    log("watchdog authority failed", { error: safeErrorCode(error) });
    return 1;
  }

  const stop = () => controller.stop();
  if (mode === "loop") {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  controller.start(force);
  await controller.whenStopped;
  await closeServer(server);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    try {
      const cfg = loadConfig();
      createFileLogger(path.join(cfg.bridgeDir, "logs", "watchdog.log"))("watchdog fatal", { error: safeErrorCode(error) });
    } catch { /* no configured logger */ }
    process.exitCode = 1;
  });
}
