#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.mjs";
import { TailerPool } from "./tailer-pool.mjs";
import { Inbox } from "./inbox.mjs";
import { OwnedConsumer } from "./owned-consumer.mjs";
import { startHttp, makeAudit, VERSION } from "./mcp.mjs";
import { StartCoordinator } from "./start-coordinator.mjs";
import { buildBridgeProcessIdentity } from "./proc.mjs";
import { HyperagentWaker } from "./hyperagent.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cfg = loadConfig();
const audit = makeAudit(cfg.bridgeDir);
const inbox = new Inbox(cfg.bridgeDir);
const stateDir = path.join(cfg.bridgeDir, "state");
const restartsLogPath = path.join(cfg.bridgeDir, "logs", "restarts.jsonl");
fs.mkdirSync(stateDir, { recursive: true });
const candidateId = (() => {
  const fromEnv = String(process.env.BRIDGE_CANDIDATE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try { return fs.readFileSync(path.join(stateDir, "candidate-id"), "utf8").trim() || null; }
  catch { return null; }
})();
const daemonProcessInstance = crypto.randomUUID();
const daemonRepoIdentity = buildBridgeProcessIdentity(REPO_ROOT);
const waker = new HyperagentWaker({ cfg, inbox, audit });

// Record this start (helps get_diagnostics show restart history).
try {
  fs.appendFileSync(restartsLogPath, JSON.stringify({
    t: new Date().toISOString(),
    event: "start",
    pid: process.pid,
    version: VERSION,
    candidate_id: candidateId,
    host: cfg.host,
    port: cfg.port,
    process_instance: daemonProcessInstance,
    repo_identity: daemonRepoIdentity,
  }) + "\n");
} catch { /* best effort */ }

const pool = new TailerPool({
  codexHome: cfg.codexHome,
  pollMs: cfg.pollMs,
  truncateUser: cfg.truncateUser,
  truncateAssistant: cfg.truncateAssistant,
  maxTailers: cfg.maxTailers,
  onSteeringConfirmed: (ticket, at) => { inbox.markConfirmed(ticket, at); audit("steering_confirmed", { ticket }, at); },
  onCallback: (cb) => {
    audit("orchestrator_callback", { id: cb.id, kind: cb.kind, thread: cb.threadId }, cb.summary);
    waker.enqueue(cb);
  }
});
if (cfg.targetThreadId) pool.pin(cfg.targetThreadId); // pre-warm + never evict the default
for (const mission of inbox.missionOptionsList().slice(-pool.maxTailers)) pool.get(mission.thread_id);

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
  const startCoordinator = new StartCoordinator({
    statePath: path.join(stateDir, "start-bindings.json")
  });
  consumer = new OwnedConsumer({
    cfg,
    pool,
    inbox,
    audit,
    pollMs: cfg.pollMs,
    setTarget,
    startCoordinator
  });
  await consumer.start();
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

const httpServer = startHttp({
  cfg,
  pool,
  inbox,
  audit,
  consumer,
  recentMissions,
  restartsLogPath,
  candidateId,
  requestRestart: shutdown,
  onFatal: () => process.exit(1),
  healthIdentity: {
    service: "codex-meta-bridge",
    pid: process.pid,
    candidate_id: candidateId,
    repo_identity: daemonRepoIdentity,
    process_instance: daemonProcessInstance,
    host: cfg.host,
    port: cfg.port,
  },
});

audit("startup", { version: VERSION, candidate_id: candidateId, host: cfg.host, port: cfg.port, delivery_mode: cfg.deliveryMode, target_thread_id: cfg.targetThreadId || "(unset)", codex_home: cfg.codexHome }, "daemon running");
console.log(`codex-meta-bridge ${VERSION} listening on http://${cfg.host}:${cfg.port} (MCP /mcp/<token>, health /healthz, mode=${cfg.deliveryMode})`);

function shutdown() {
  pool.stopAll();
  waker.stop();
  consumer?.stop();
  httpServer.close();
  try { fs.appendFileSync(restartsLogPath, JSON.stringify({ t: new Date().toISOString(), event: "stop", pid: process.pid }) + "\n"); } catch { /* ignore */ }
  process.exit(0);
}
function fatal(event, error) {
  audit(event, {}, String(error?.stack || error));
  process.exit(1);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => fatal("uncaught_exception", error));
process.on("unhandledRejection", (error) => fatal("unhandled_rejection", error));
