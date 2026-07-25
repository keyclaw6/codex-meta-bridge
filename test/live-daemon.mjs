#!/usr/bin/env node
/**
 * TRUE live integration test: spawns the actual daemon as a separate process
 * (as it runs on Linux/Windows), then drives it over real HTTP — OAuth flow,
 * MCP tools via the SDK client, owned-mode steering delivery (sim Codex), and
 * the reverse callback channel. Proves the deployed artifact, not an in-process
 * mock. Exits 0 with LIVE DAEMON TEST PASS.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildBridgeProcessIdentity, findPidsOnPort } from "../src/proc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ok    ${n}`); else { failures++; console.error(`  FAIL  ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitChild = (child, timeoutMs = 8000) => new Promise((resolve) => {
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } resolve(null); }, timeoutMs);
  child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
});

// --- temp CODEX_HOME with a CLI-owned orchestrator rollout ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-live-"));
const codexHome = path.join(tmp, ".codex");
const rdir = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(rdir, { recursive: true });
const TID = "019f0000-0000-7000-0000-00000000live";
const rollout = path.join(rdir, `rollout-2026-07-24T10-00-00-${TID}.jsonl`);
fs.writeFileSync(rollout,
  JSON.stringify({ timestamp: "2026-07-24T10:00:00Z", type: "session_meta", payload: { id: TID, originator: "codex exec", cli_version: "0.144.6" } }) + "\n" +
  JSON.stringify({ timestamp: "2026-07-24T10:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Orchestrator up. STATUS: phase=1" }] } }) + "\n");

const PORT = 8951;
const TOKEN = crypto.randomBytes(32).toString("hex");
const bridgeDir = path.join(tmp, "bridge");
const cfgPath = path.join(tmp, "bridge.config.json");
fs.writeFileSync(cfgPath, JSON.stringify({
  host: "127.0.0.1", port: PORT, token: TOKEN, targetThreadId: TID, deliveryMode: "owned",
  codexHome, bridgeDir, pollMs: 400
}, null, 2));

console.log("Spawning real daemon process…");
const daemon = spawn(process.execPath, ["src/daemon.mjs"], {
  cwd: REPO,
  env: {
    ...process.env,
    BRIDGE_CONFIG_PATH: cfgPath,
    BRIDGE_CODEX_FAKE: codexHome,
    BRIDGE_CANDIDATE_ID: "live-test-candidate"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let daemonLog = "";
daemon.stdout.on("data", (d) => { daemonLog += d; });
daemon.stderr.on("data", (d) => { daemonLog += d; });

const base = `http://127.0.0.1:${PORT}`;
async function waitHealth(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(300);
  }
  return false;
}

let ok = false;
let recoveredPid = null;
let ackedCallbackId = null;
let watchdogLoopPid = null;
try {
  check("daemon became healthy", (ok = await waitHealth(8000)), daemonLog.slice(-400));
  if (!ok) throw new Error("daemon did not start");

  console.log("\n[live-1] real OAuth flow against the running daemon");
  {
    const iss = `${base}/mcp/${TOKEN}`;
    const prm = await (await fetch(`${iss}/.well-known/oauth-protected-resource`)).json();
    check("protected-resource metadata served", prm.authorization_servers?.[0] === iss);
    const as = await (await fetch(`${iss}/.well-known/oauth-authorization-server`)).json();
    check("AS metadata served", !!as.authorization_endpoint && !!as.token_endpoint);
    const reg = await (await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://app/cb"] }) })).json();
    check("DCR issued client_id", typeof reg.client_id === "string");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const ar = await fetch(`${as.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("https://app/cb")}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`, { redirect: "manual" });
    const code = new URL(ar.headers.get("location")).searchParams.get("code");
    check("authorize issued code", ar.status === 302 && !!code);
    const tok = await (await fetch(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://app/cb", client_id: reg.client_id, code_verifier: verifier }) })).json();
    check("token endpoint issued bearer", tok.token_type === "Bearer" && !!tok.access_token);
    const authed = await fetch(iss, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "0" } } }) });
    check("OAuth bearer authorizes MCP initialize", authed.status === 200);
    const bogusPath = `${base}/mcp/${"z".repeat(TOKEN.length)}`;
    const denied = await fetch(bogusPath, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer bogus" }, body: "{}" });
    const wa = denied.headers.get("www-authenticate") || "";
    check("bogus token 401 + challenge", denied.status === 401 && /Bearer/.test(wa));
    check("challenge never leaks the real token", !wa.includes(TOKEN));
  }

  console.log("\n[live-2] MCP tools via SDK client (capability URL)");
  const client = new Client({ name: "live", version: "0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));
  {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const expectedTools = [
      "ack_callback", "bridge_health", "get_diagnostics", "get_event", "get_logs",
      "interrupt_turn", "list_callbacks", "list_steering", "orchestrator_status",
      "read_transcript", "restart_bridge", "send_steering", "set_target_thread",
      "start_mission", "start_visible_cli_mission"
    ].sort();
    check("exact 15-tool schema is live", JSON.stringify(tools) === JSON.stringify(expectedTools), tools.join(","));
    const h = JSON.parse((await client.callTool({ name: "bridge_health", arguments: {} })).content[0].text);
    check("health owned mode", h.delivery_mode === "owned" && h.ok === true);
    check("health binds the running candidate identity", h.candidate_id === "live-test-candidate");
    const s = JSON.parse((await client.callTool({ name: "orchestrator_status", arguments: { thread_id: TID } })).content[0].text);
    check("status reads orchestrator", s.lastAssistantMessage?.text?.includes("phase=1"));
    check("status exposes observability fields", Object.hasOwn(s, "active_command") && Array.isArray(s.subagent_threads) && s.busy_children_best_effort === true && Array.isArray(s.busy_children));
  }

  console.log("\n[live-3] owned steering delivered by the daemon (sim Codex) + confirmed");
  {
    const r = JSON.parse((await client.callTool({ name: "send_steering", arguments: { target_thread_id: TID, message: "Proceed to phase 2. Do not stop." } })).content[0].text);
    check("steering queued (owned)", r.ok === true && r.delivery_mode === "owned");
    let confirmed = false;
    for (let i = 0; i < 20 && !confirmed; i++) {
      await sleep(400);
      const st = JSON.parse((await client.callTool({ name: "list_steering", arguments: { thread_id: TID } })).content[0].text);
      confirmed = st.delivered.some((x) => x.ticket === r.ticket && x.confirmed_in_rollout_at);
    }
    check("daemon delivered + rollout-confirmed the steering", confirmed);
  }

  console.log("\n[live-4] reverse channel end to end");
  {
    fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[[CALLBACK:CANDIDATE_READY]] completion candidate frozen" }] } }) + "\n");
    let row = null;
    for (let i = 0; i < 15 && !row; i++) { await sleep(400); row = JSON.parse((await client.callTool({ name: "list_callbacks", arguments: { thread_id: TID } })).content[0].text).callbacks.find((c) => c.kind === "CANDIDATE_READY"); }
    check("callback surfaced live", !!row);
    if (row) {
      ackedCallbackId = row.id;
      await client.callTool({ name: "ack_callback", arguments: { id: row.id } });
      const after = JSON.parse((await client.callTool({ name: "list_callbacks", arguments: { thread_id: TID } })).content[0].text);
      check("ack clears it live", !after.callbacks.some((c) => c.id === row.id));
    }
  }

  console.log("\n[live-5] diagnostics + logs from the live process");
  {
    const d = JSON.parse((await client.callTool({ name: "get_diagnostics", arguments: {} })).content[0].text);
    check("diagnostics reports live pid", d.daemon?.pid === daemon.pid, `diag=${d.daemon?.pid} daemon=${daemon.pid}`);
    check("diagnostics binds the running candidate identity", d.daemon?.candidateId === "live-test-candidate");
    const l = JSON.parse((await client.callTool({ name: "get_logs", arguments: { lines: 30 } })).content[0].text);
    check("audit log has owned delivery", (l.audit?.lines || []).some((x) => /owned_delivered|send_steering/.test(x)));
  }
  await client.close();

  console.log("\n[live-6] hidden singleton watchdog loop recovers the isolated daemon");
  daemon.kill("SIGTERM");
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (!response.ok) break;
    } catch {
      break;
    }
    await sleep(100);
  }
  const watchdog = spawn(process.execPath, ["setup/watchdog.mjs", "--loop", "--config-path", cfgPath], {
    cwd: REPO,
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: cfgPath,
      BRIDGE_CODEX_FAKE: codexHome,
      BRIDGE_CANDIDATE_ID: "live-test-candidate"
    },
    stdio: "ignore",
    windowsHide: true,
    detached: true
  });
  watchdogLoopPid = watchdog.pid;
  watchdog.unref();
  check("watchdog loop launcher is detached and has a process id", Number(watchdog.pid) > 0);
  check("watchdog restored health", await waitHealth(8000));
  const watchdogLogPath = path.join(bridgeDir, "logs", "watchdog.log");
  let watchdogLog = "";
  for (let i = 0; i < 40; i++) {
    watchdogLog = fs.readFileSync(watchdogLogPath, "utf8");
    if (/daemon healthy after restart/.test(watchdogLog)) break;
    await sleep(100);
  }
  check("watchdog recorded successful recovery", /daemon healthy after restart/.test(watchdogLog), watchdogLog.slice(-400));
  const restartRows = fs.readFileSync(path.join(bridgeDir, "logs", "restarts.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const recoveredStart = restartRows.filter((row) => row.event === "start").at(-1);
  recoveredPid = recoveredStart?.pid || null;
  check("watchdog started a new process with the same candidate identity", recoveredStart?.pid !== daemon.pid && recoveredStart?.candidate_id === "live-test-candidate");
  check("restart receipt binds exact daemon process authority", recoveredStart?.host === "127.0.0.1"
    && recoveredStart?.port === PORT
    && typeof recoveredStart?.process_instance === "string"
    && recoveredStart.process_instance.length >= 16
    && typeof recoveredStart?.process_creation_time_filetime_utc === "string"
    && /^[1-9]\d+$/.test(recoveredStart.process_creation_time_filetime_utc)
    && recoveredStart?.repo_identity === buildBridgeProcessIdentity(REPO));

  const duplicateLoop = spawn(process.execPath, ["setup/watchdog.mjs", "--loop", "--config-path", cfgPath], {
    cwd: REPO,
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: cfgPath,
      BRIDGE_CODEX_FAKE: codexHome,
      BRIDGE_CANDIDATE_ID: "live-test-candidate"
    },
    stdio: "ignore",
    windowsHide: true
  });
  check("duplicate watchdog loop delegates and exits cleanly", (await waitChild(duplicateLoop)) === 0);

  const delegatedCheck = spawn(process.execPath, ["setup/watchdog.mjs", "--config-path", cfgPath], {
    cwd: REPO,
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: cfgPath,
      BRIDGE_CODEX_FAKE: codexHome,
      BRIDGE_CANDIDATE_ID: "live-test-candidate"
    },
    stdio: "ignore",
    windowsHide: true
  });
  check("default one-shot delegates CHECK to the resident loop", (await waitChild(delegatedCheck)) === 0);

  const startsBeforeForce = fs.readFileSync(path.join(bridgeDir, "logs", "restarts.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.event === "start").length;
  const delegatedForce = spawn(process.execPath, ["setup/watchdog.mjs", "--force", "--config-path", cfgPath], {
    cwd: REPO,
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: cfgPath,
      BRIDGE_CODEX_FAKE: codexHome,
      BRIDGE_CANDIDATE_ID: "live-test-candidate"
    },
    stdio: "ignore",
    windowsHide: true
  });
  check("forced one-shot delegates FORCE to the resident loop", (await waitChild(delegatedForce)) === 0);
  let forcedStart = null;
  for (let i = 0; i < 100 && !forcedStart; i++) {
    const starts = fs.readFileSync(path.join(bridgeDir, "logs", "restarts.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === "start");
    if (starts.length > startsBeforeForce) forcedStart = starts.at(-1);
    if (!forcedStart) await sleep(100);
  }
  check("delegated FORCE creates one later daemon start receipt", !!forcedStart && forcedStart.pid !== recoveredPid);
  check("forced restart refreshes the exact process-instance authority", forcedStart?.host === "127.0.0.1"
    && forcedStart?.port === PORT
    && typeof forcedStart?.process_instance === "string"
    && forcedStart.process_instance !== recoveredStart?.process_instance
    && typeof forcedStart?.process_creation_time_filetime_utc === "string"
    && /^[1-9]\d+$/.test(forcedStart.process_creation_time_filetime_utc)
    && forcedStart?.repo_identity === buildBridgeProcessIdentity(REPO));
  if (forcedStart) recoveredPid = forcedStart.pid;
  check("delegated FORCE recovers the isolated daemon", await waitHealth(8000));

  console.log("\n[live-7] callback ack survives watchdog restart and reconnect");
  const recoveredClient = new Client({ name: "live-recovered", version: "0.1" });
  await recoveredClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));
  let persistedCallback = null;
  if (ackedCallbackId) {
    for (let i = 0; i < 20 && !persistedCallback; i++) {
      const all = JSON.parse((await recoveredClient.callTool({
        name: "list_callbacks",
        arguments: { thread_id: TID, unacked_only: false }
      })).content[0].text);
      persistedCallback = all.callbacks.find((row) => row.id === ackedCallbackId) || null;
      if (!persistedCallback) await sleep(200);
    }
  }
  check("reconnected daemon reloads the callback as acked", !!persistedCallback && persistedCallback.acked === true, JSON.stringify(persistedCallback));
  const unackedAfterRestart = JSON.parse((await recoveredClient.callTool({
    name: "list_callbacks",
    arguments: { thread_id: TID }
  })).content[0].text);
  check("reconnected daemon does not surface the callback as unacked", !!ackedCallbackId && !unackedAfterRestart.callbacks.some((row) => row.id === ackedCallbackId));
  await recoveredClient.close();

  const stopWatchdog = spawn(process.execPath, ["setup/watchdog.mjs", "--stop", "--config-path", cfgPath], {
    cwd: REPO,
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: cfgPath,
      BRIDGE_CODEX_FAKE: codexHome,
      BRIDGE_CANDIDATE_ID: "live-test-candidate"
    },
    stdio: "ignore",
    windowsHide: true
  });
  check("resident watchdog loop accepts bounded STOP", (await waitChild(stopWatchdog)) === 0);
  let loopAlive = false;
  for (let i = 0; i < 50; i++) {
    try { process.kill(watchdogLoopPid, 0); loopAlive = true; }
    catch { loopAlive = false; break; }
    await sleep(100);
  }
  check("resident watchdog loop leaves no surviving process", !loopAlive);
  if (!loopAlive) watchdogLoopPid = null;
} finally {
  if (watchdogLoopPid) {
    try { process.kill(watchdogLoopPid, "SIGTERM"); } catch { /* already stopped */ }
  }
  daemon.kill("SIGTERM");
  if (recoveredPid) {
    try { process.kill(recoveredPid, "SIGTERM"); } catch { /* already stopped */ }
  }
  for (const pid of findPidsOnPort(PORT)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
  }
  await sleep(300);
  if (!daemon.killed) daemon.kill("SIGKILL");
}

console.log("");
if (failures === 0) { console.log("LIVE DAEMON TEST PASS"); process.exit(0); }
console.error(`LIVE DAEMON TEST FAIL (${failures})`); process.exit(1);
