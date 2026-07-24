#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.mjs";
import { TailerPool } from "./tailer-pool.mjs";
import { Inbox } from "./inbox.mjs";
import { OwnedConsumer } from "./owned-consumer.mjs";
import { startHttp, makeAudit, VERSION } from "./mcp.mjs";

const cfg = loadConfig();
const audit = makeAudit(cfg.bridgeDir);
const inbox = new Inbox(cfg.bridgeDir);
const stateDir = path.join(cfg.bridgeDir, "state");
const restartsLogPath = path.join(cfg.bridgeDir, "logs", "restarts.jsonl");
fs.mkdirSync(stateDir, { recursive: true });

// Record this start (helps get_diagnostics show restart history).
try {
  fs.appendFileSync(restartsLogPath, JSON.stringify({ t: new Date().toISOString(), event: "start", pid: process.pid, version: VERSION }) + "\n");
} catch { /* best effort */ }

const pool = new TailerPool({
  codexHome: cfg.codexHome,
  pollMs: cfg.pollMs,
  truncateUser: cfg.truncateUser,
  truncateAssistant: cfg.truncateAssistant,
  onSteeringConfirmed: (ticket, at) => { inbox.markConfirmed(ticket, at); audit("steering_confirmed", { ticket }, at); },
  onTurnComplete: (at) => {
    if (cfg.webhookUrl) {
      fetch(cfg.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "turn_complete", at }) })
        .catch((e) => audit("webhook_error", {}, String(e?.message || e)));
    }
  },
  onCallback: (cb) => {
    audit("orchestrator_callback", { id: cb.id, kind: cb.kind, thread: cb.threadId }, cb.summary);
    // Wake the meta agent immediately for a fresh (unacked) callback.
    if (cfg.webhookUrl && !inbox.ackedCallbacks().has(cb.id)) {
      fetch(cfg.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "callback", kind: cb.kind, thread_id: cb.threadId, summary: cb.summary, at: cb.at }) })
        .catch((e) => audit("webhook_error", {}, String(e?.message || e)));
    }
  }
});
if (cfg.targetThreadId) pool.pin(cfg.targetThreadId); // pre-warm + never evict the default

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recentMissions = []; // {threadId, at, cwd, sandbox_mode} for start_mission, surfaced in bridge_health

// setTarget is used by start_mission: register the new orchestrator in the pool
// and record it so the launching session can discover its thread id. It does
// NOT overwrite the shared default target (that would clobber other sessions).
function setTarget(threadId, { cwd = null, sandbox_mode = null } = {}) {
  pool.get(threadId);
  recentMissions.push({ threadId, at: new Date().toISOString(), cwd, sandbox_mode });
  if (recentMissions.length > 20) recentMissions.shift();
  if (!cfg.targetThreadId) { // only adopt as default if there wasn't one
    cfg.targetThreadId = threadId;
    try { saveConfig(cfg); } catch (e) { audit("set_target_save_failed", { threadId }, String(e?.message || e)); }
    pool.pin(threadId);
  }
  audit("mission_target_registered", { threadId, cwd, sandbox_mode }, true);
}

// Owned consumer (CLI mode): daemon delivers steering + starts missions itself.
let consumer = null;
if (cfg.deliveryMode === "owned") {
  consumer = new OwnedConsumer({ cfg, pool, inbox, audit, pollMs: cfg.pollMs, setTarget });
  consumer.start();
  audit("owned_consumer_started", {}, true);
}

// Periodic last-known-good state snapshot (survives restarts; useful for diagnostics).
const snap = setInterval(() => {
  try {
    const dflt = cfg.targetThreadId ? pool.get(cfg.targetThreadId).digest() : null;
    fs.writeFileSync(path.join(stateDir, "last-status.json"), JSON.stringify({ default: dflt, tailed: pool.list() }, null, 2));
  } catch { /* best effort */ }
}, Math.max(5000, cfg.pollMs * 2));
snap.unref?.();

const httpServer = startHttp({ cfg, pool, inbox, audit, consumer, recentMissions, restartsLogPath, repoRoot: REPO_ROOT });

audit("startup", { version: VERSION, host: cfg.host, port: cfg.port, delivery_mode: cfg.deliveryMode, target_thread_id: cfg.targetThreadId || "(unset)", codex_home: cfg.codexHome }, "daemon running");
console.log(`codex-meta-bridge ${VERSION} listening on http://${cfg.host}:${cfg.port} (MCP /mcp/<token>, health /healthz, mode=${cfg.deliveryMode})`);

function shutdown() {
  pool.stopAll();
  consumer?.stop();
  httpServer.close();
  try { fs.appendFileSync(restartsLogPath, JSON.stringify({ t: new Date().toISOString(), event: "stop", pid: process.pid }) + "\n"); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (e) => { audit("uncaught_exception", {}, String(e?.stack || e)); });
process.on("unhandledRejection", (e) => { audit("unhandled_rejection", {}, String(e?.message || e)); });
