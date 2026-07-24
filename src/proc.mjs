import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** GET http://127.0.0.1:<port>/healthz. Resolves {ok, status, body} — never throws. */
export function probeHealth(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: body.trim() }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: String(e?.code || e?.message || e) }));
  });
}

/** Best-effort: PIDs listening on a TCP port. Returns number[] (empty on failure). */
export function findPidsOnPort(port) {
  try {
    if (IS_WIN) {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(Number(m[1]));
      }
      return [...pids].filter((p) => p > 0);
    }
    // posix: try lsof, then ss
    try {
      const out = execFileSync("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN`], { encoding: "utf8" });
      return out.split(/\s+/).map(Number).filter(Boolean);
    } catch {
      const out = execFileSync("sh", ["-c", `ss -ltnp 'sport = :${port}' 2>/dev/null`], { encoding: "utf8" });
      const pids = new Set();
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      return [...pids].filter(Boolean);
    }
  } catch {
    return [];
  }
}

/** Best-effort force-kill. Returns {killed:number[], errors:string[]}. */
export function killPids(pids, { excludeSelf = true } = {}) {
  const killed = [], errors = [];
  for (const pid of pids) {
    if (excludeSelf && pid === process.pid) continue;
    try {
      if (IS_WIN) execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch (e) {
      errors.push(`${pid}: ${String(e?.message || e)}`);
    }
  }
  return { killed, errors };
}

/** Launch a fresh daemon, fully detached, logging to logPath. Returns child pid. */
export function spawnDaemonDetached(repoRoot, logPath, extraEnv = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [path.join("src", "daemon.mjs")], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...extraEnv }
  });
  child.unref();
  return child.pid;
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

export function waitForHealth(port, timeoutMs = 15000) {
  return waitFor(async () => (await probeHealth(port)).ok, { timeoutMs });
}

export function waitForPortFree(port, timeoutMs = 10000) {
  const free = () => new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(true));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(true); });
  });
  return waitFor(free, { timeoutMs, intervalMs: 400 });
}
