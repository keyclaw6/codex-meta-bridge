#!/usr/bin/env node
/**
 * Liveness watchdog. Run periodically by the OS (Windows scheduled task /
 * Linux systemd timer). Probes the daemon's health endpoint; if it is not
 * healthy (crashed OR hung), it frees the port and starts a fresh daemon.
 *
 *   node setup/watchdog.mjs           # probe; recover only if unhealthy
 *   node setup/watchdog.mjs --force   # always kill port holder + restart
 *
 * This is what makes the bridge self-recovering and is independent of the
 * daemon process itself (so it works even when the daemon is fully down).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { probeHealth, findPidsOnPort, killPids, spawnDaemonDetached, waitForPortFree, waitForHealth } from "../src/proc.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

const cfg = loadConfig();
const logPath = path.join(cfg.bridgeDir, "logs", "watchdog.log");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = (msg, extra = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), msg, ...extra });
  try { fs.appendFileSync(logPath, line + "\n"); } catch { /* ignore */ }
  console.log(line);
};

const health = await probeHealth(cfg.port);
if (health.ok && !force) {
  log("healthy", { status: health.status });
  process.exit(0);
}

log(force ? "forced restart requested" : "unhealthy — recovering", { status: health.status, body: health.body });

const pids = findPidsOnPort(cfg.port);
if (pids.length) {
  const { killed, errors } = killPids(pids);
  log("killed port holders", { pids, killed, errors });
  await waitForPortFree(cfg.port, 10000);
}

const daemonLog = path.join(cfg.bridgeDir, "logs", "daemon.log");
const pid = spawnDaemonDetached(REPO_ROOT, daemonLog);
log("spawned daemon", { pid });

const back = await waitForHealth(cfg.port, 20000);
log(back ? "daemon healthy after restart" : "daemon did NOT become healthy in time", { healthy: back });
process.exit(back ? 0 : 1);
