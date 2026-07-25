#!/usr/bin/env node
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, DEFAULTS, REPO_ROOT } from "../src/config.mjs";
import {
  WINDOWS_PERSISTENCE,
  WindowsPersistenceError,
  createWindowsPersistence,
  windowsPersistenceInstallerPipePath,
} from "../src/windows-service.mjs";
import {
  buildWatchdogIdentity,
  readCandidateId,
  sendWatchdogCommand,
  watchdogPipePath,
} from "./watchdog.mjs";

const COMMAND_TIMEOUT_MS = 5_000;
const CONTROL_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 10_000;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runBoundedHidden = ({ execFileImpl, timeoutMs }, command, args) => new Promise((resolve, reject) => {
  const child = execFileImpl(command, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  }, (error, stdout = "", stderr = "") => {
    if (error) {
      const failure = new Error("bounded hidden command failed");
      failure.exitCode = error.code;
      failure.stderrText = String(stderr || error.stderr || "");
      reject(failure);
      return;
    }
    resolve(String(stdout));
  });
  child?.stdin?.end?.();
});

export function createRegExeAdapter({ execFileImpl = execFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const run = (args) => runBoundedHidden({ execFileImpl, timeoutMs }, "reg.exe", args);
  const missing = (error) => /unable to find|cannot find|not found/i.test(error?.stderrText || "");

  const read = async () => {
    let stdout;
    try {
      stdout = await run(["query", WINDOWS_PERSISTENCE.runKey, "/v", WINDOWS_PERSISTENCE.runValueName]);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const escaped = WINDOWS_PERSISTENCE.runValueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = stdout.match(new RegExp(`^\\s*${escaped}\\s+(REG_[A-Z0-9_]+)\\s+(.*)$`, "mi"));
    if (!match) throw new Error("registry response did not contain the requested value");
    return { type: match[1], data: match[2].trimEnd() };
  };

  const create = async ({ type, data }) => {
    await run(["add", WINDOWS_PERSISTENCE.runKey, "/v", WINDOWS_PERSISTENCE.runValueName, "/t", type, "/d", data]);
  };

  const ensureExact = async (expected) => {
    const current = await read();
    if (current?.type === expected.type && current.data === expected.data) return;
    if (current != null) throw new Error("foreign registry value");
    await create(expected);
  };

  const deleteExact = async (expected) => {
    const current = await read();
    if (current == null) return;
    if (current.type !== expected.type || current.data !== expected.data) throw new Error("foreign registry value");
    await run(["delete", WINDOWS_PERSISTENCE.runKey, "/v", WINDOWS_PERSISTENCE.runValueName, "/f"]);
  };

  return { read, create, ensureExact, deleteExact };
}

export function createWscriptAdapter({ execFileImpl = execFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return {
    launch: (vbsPath) => runBoundedHidden(
      { execFileImpl, timeoutMs },
      "wscript.exe",
      ["//B", "//Nologo", vbsPath],
    ),
  };
}

export function createFileAdapter({ fsImpl = fs } = {}) {
  const read = async (filePath) => {
    try { return await fsImpl.promises.readFile(filePath, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  };
  const create = async (filePath, content) => {
    await fsImpl.promises.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  };
  const ensureExact = async (filePath, content) => {
    const current = await read(filePath);
    if (current === content) return;
    if (current != null) throw new Error("foreign VBS file");
    await create(filePath, content);
  };
  const deleteExact = async (filePath, expectedHash) => {
    const current = await read(filePath);
    if (current == null) return;
    if (sha256(current) !== expectedHash) throw new Error("foreign VBS file");
    await fsImpl.promises.unlink(filePath);
  };
  return { read, create, ensureExact, deleteExact };
}

const controlMatches = (value, expected, requireCycle = true) => value?.exists === true
  && value.responsive === true
  && value.identity === expected.identity
  && value.mode === "loop"
  && (!expected.processInstance || value.process_instance === expected.processInstance)
  && (value.candidate_id || null) === expected.candidateId
  && Number(value.port) === expected.port
  && (!requireCycle || (Number(value.cycle_count) >= 1
    && value.cycle_state === "idle"
    && value.last_result != null));

export function createControlAdapter({
  identity,
  pipePath = watchdogPipePath(identity),
  port,
  candidateId,
  sendWatchdogCommandImpl = sendWatchdogCommand,
  requestTimeoutMs = CONTROL_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
} = {}) {
  const request = (op, extra = {}) => sendWatchdogCommandImpl({
    pipePath,
    identity,
    port,
    candidateId,
    op,
    timeoutMs: requestTimeoutMs,
    allowRuntimeMismatch: true,
    ...extra,
  });

  const status = async () => {
    try { return { exists: true, responsive: true, ...await request("STATUS") }; }
    catch (error) {
      if (error?.code === "ENOENT") return { exists: false };
      throw error;
    }
  };

  const stop = async (expected) => {
    if (!expected.processInstance) throw new Error("watchdog process instance is required for STOP");
    const response = {
      exists: true,
      responsive: true,
      ...await request("STOP", { expectedProcessInstance: expected.processInstance }),
    };
    if (response.ok !== true || !controlMatches(response, expected, false)) throw new Error("watchdog STOP identity mismatch");
    return response;
  };

  const waitUntil = async (predicate) => {
    const deadline = Date.now() + readyTimeoutMs;
    let current;
    do {
      current = await status();
      if (predicate(current)) return current;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error("watchdog control verification timed out");
  };

  return {
    status,
    stop,
    waitForStatus: (expected) => waitUntil((value) => controlMatches(value, expected)),
    waitForAbsent: () => waitUntil((value) => value.exists === false),
  };
}

export function createInstallerLock({
  netImpl = net,
  pipePath,
  timeoutMs = CONTROL_TIMEOUT_MS,
} = {}) {
  if (!String(pipePath || "").startsWith("\\\\.\\pipe\\codex-meta-bridge-watchdog-install-v1-")) {
    throw new Error("An identity-hashed Windows persistence installer pipe is required");
  }
  return {
    withLock: async (fn) => {
      const server = netImpl.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new WindowsPersistenceError("BUSY", "Another Windows persistence transaction is active")), timeoutMs);
        const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
        server.once("error", finish((error) => reject(new WindowsPersistenceError("BUSY", "Another Windows persistence transaction is active", { causeCode: error?.code }))));
        server.listen(pipePath, finish(resolve));
      });
      try { return await fn(); }
      finally {
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };
}

const readLocalConfig = () => {
  const persisted = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  return { ...DEFAULTS, ...persisted };
};

export async function runWindowsPersistenceCli({ command, service, stdout = process.stdout, stderr = process.stderr }) {
  if (!new Set(["install", "status", "uninstall", "rollback"]).has(command)) {
    stderr.write(`${JSON.stringify({ ok: false, code: "USAGE", message: "Usage: windows-persistence.mjs install|status|uninstall|rollback" })}\n`);
    return 64;
  }
  try {
    const result = command === "status" ? await service.inspect() : await service[command]();
    stdout.write(`${JSON.stringify({ ...result, operation: command })}\n`);
    return result.state === "AMBIGUOUS" ? 2 : 0;
  } catch (error) {
    const safe = {
      ok: false,
      operation: command,
      code: error instanceof WindowsPersistenceError ? error.code : "PERSISTENCE_FAILED",
      message: error instanceof WindowsPersistenceError ? error.message : "Windows persistence operation failed",
      rollbackComplete: error?.rollbackComplete ?? null,
      state: error?.state || "AMBIGUOUS",
      reason: error?.reason || null,
      repairable: error?.repairable === true,
      cutoverCommitted: error?.cutoverCommitted ?? null,
      rollbackIssues: error?.rollbackIssues || [],
    };
    stderr.write(`${JSON.stringify(safe)}\n`);
    return safe.code === "AMBIGUOUS" || safe.code === "BUSY" ? 2 : 1;
  }
}

async function main() {
  const command = process.argv[2];
  if (process.platform !== "win32") {
    process.stderr.write(`${JSON.stringify({ ok: false, code: "WINDOWS_ONLY", message: "Windows persistence is available only on Windows" })}\n`);
    return 1;
  }
  if (!new Set(["install", "status", "uninstall", "rollback"]).has(command)) {
    return runWindowsPersistenceCli({ command, service: null });
  }
  try {
    const cfg = readLocalConfig();
    const cfgPath = configPath();
    const watchdogIdentity = buildWatchdogIdentity(REPO_ROOT, cfgPath);
    const candidateId = readCandidateId(cfg);
    const service = createWindowsPersistence({
      repoRoot: REPO_ROOT,
      bridgeDir: cfg.bridgeDir,
      nodePath: process.execPath,
      watchdogIdentity,
      candidateId,
      port: cfg.port,
      registry: createRegExeAdapter(),
      files: createFileAdapter(),
      launcher: createWscriptAdapter(),
      control: createControlAdapter({
        identity: watchdogIdentity,
        pipePath: watchdogPipePath(watchdogIdentity),
        port: cfg.port,
        candidateId,
      }),
      lock: createInstallerLock({
        pipePath: windowsPersistenceInstallerPipePath(watchdogIdentity),
      }),
    });
    return runWindowsPersistenceCli({ command, service });
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, code: "SETUP_FAILED", message: "Unable to prepare Windows persistence safely" })}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
