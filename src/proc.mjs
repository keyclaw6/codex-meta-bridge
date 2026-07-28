import http from "node:http";
import net from "node:net";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROCESS_HELPER_TIMEOUT_MS = 5000;

const canonicalProcessPath = (value, { realpathSyncImpl = fs.realpathSync.native } = {}) => {
  let resolved = path.resolve(String(value || ""));
  try { resolved = realpathSyncImpl(resolved); } catch { /* fail closed at the equality check */ }
  resolved = path.normalize(resolved);
  return resolved;
};

export function buildBridgeProcessIdentity(repoRoot, options = {}) {
  const canonical = canonicalProcessPath(repoRoot, options);
  return crypto.createHash("sha256").update(`codex-meta-bridge-daemon-v1\0${canonical}`).digest("hex").slice(0, 32);
}

/** GET http://127.0.0.1:<port>/healthz. Resolves sanitized identity when present — never throws. */
export function probeHealth(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let identity = null;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) identity = parsed;
        } catch { /* a foreign/non-JSON 200 is handled as missing identity */ }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, body: body.trim(), identity });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: String(e?.code || e?.message || e) }));
  });
}

/** Best-effort: PIDs listening on a TCP port (POSIX: lsof, then ss). Returns number[] (empty on failure). */
export function findPidsOnPort(port, {
  execFileSyncImpl = execFileSync,
  timeoutMs = PROCESS_HELPER_TIMEOUT_MS
} = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return [];
  try {
    try {
      const out = execFileSyncImpl("lsof", ["-ti", `tcp:${numericPort}`, "-sTCP:LISTEN"], {
        encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024
      });
      return out.split(/\s+/).map(Number).filter(Boolean);
    } catch {
      const out = execFileSyncImpl("ss", ["-ltnp", `sport = :${numericPort}`], {
        encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024
      });
      const pids = new Set();
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      return [...pids].filter(Boolean);
    }
  } catch {
    return [];
  }
}

export function waitFor(fn, { timeoutMs = 15000, intervalMs = 500 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      if (await fn()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function waitForHealth(port, timeoutMs = 15000, {
  probeHealthImpl = probeHealth,
  validateHealth = (health) => health.ok,
} = {}) {
  return waitFor(async () => validateHealth(await probeHealthImpl(port)), { timeoutMs });
}

export function waitForPortFree(port, timeoutMs = 10000) {
  const free = () => new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(true));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(true); });
  });
  return waitFor(free, { timeoutMs, intervalMs: 400 });
}
