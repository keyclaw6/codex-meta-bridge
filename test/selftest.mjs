#!/usr/bin/env node
/**
 * End-to-end selftest. No Codex required; simulates a rollout file and drives
 * the full daemon stack (tailer -> digest -> MCP over Streamable HTTP -> inbox
 * -> rollout confirmation). Exits 0 with "SELFTEST PASS" on success.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { STEERING_MARKER } from "../src/tailer.mjs";
import { TailerPool } from "../src/tailer-pool.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startHttp, makeAudit } from "../src/mcp.mjs";
import { OwnedConsumer } from "../src/owned-consumer.mjs";
import { StartCoordinator } from "../src/start-coordinator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "019f9315-fc11-7c90-b7ae-304ca4d8f127";
const TOKEN = "selftest-token-0123456789abcdef";
const PORT = 8917;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  return predicate();
};

// --- workspace: fake CODEX_HOME + bridge dir in a temp folder
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-selftest-"));
const codexHome = path.join(tmp, ".codex");
const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(rolloutDir, { recursive: true });
const rolloutPath = path.join(rolloutDir, `rollout-2026-07-24T09-45-24-${THREAD_ID}.jsonl`);
fs.copyFileSync(path.join(__dirname, "fixture-rollout.jsonl"), rolloutPath);

const bridgeDir = path.join(tmp, "bridge");
const cfg = {
  host: "127.0.0.1", port: PORT, token: TOKEN, targetThreadId: THREAD_ID,
  deliveryMode: "inbox", codexHome, bridgeDir, pollMs: 300,
  truncateUser: 2000, truncateAssistant: 4000, webhookUrl: "",
  default_mission_cwd: "/tmp/default-mission", default_mission_sandbox: "danger-full-access"
};
// Isolate config writes (set_target_thread -> saveConfig) to the temp dir.
// Safe even though src modules are already imported: configPath() resolves
// the env var lazily at CALL time, never at import time (v0.1.1 fix).
process.env.BRIDGE_CONFIG_PATH = path.join(tmp, "bridge.config.json");
fs.writeFileSync(process.env.BRIDGE_CONFIG_PATH, JSON.stringify(cfg, null, 2));

const auditRows = [];
const writeAudit = makeAudit(bridgeDir);
const audit = (...args) => {
  auditRows.push({ event: args[0], args: args[1], result: args[2] });
  writeAudit(...args);
};
const inbox = new Inbox(bridgeDir);
const pool = new TailerPool({ codexHome, pollMs: 300, onSteeringConfirmed: (ticket, at) => inbox.markConfirmed(ticket, at) });
pool.pin(THREAD_ID);
const restartsLogPath = path.join(bridgeDir, "logs", "restarts.jsonl");
const recentMissions = [];
const startCalls = [];
const startCoordinator = new StartCoordinator({
  statePath: path.join(bridgeDir, "state", "selftest-start-bindings.json")
});
let sideEffectCount = 0;
let missionSequence = 100;
let releaseFirstStart;
const firstStartGate = new Promise((resolve) => { releaseFirstStart = resolve; });
const consumer = new OwnedConsumer({
  cfg,
  pool,
  inbox,
  audit,
  startCoordinator,
  setTarget: () => {},
  writerProcesses: async () => []
});

// Keep the coordinator and consumer boundary real while replacing only the
// irreversible launch surface with one deterministic, gated fake side effect.
consumer.startReservedMission = async function ({ requestKey, prompt, threadOptions }) {
  startCalls.push({ requestKey, prompt, threadOptions });
  sideEffectCount++;
  await this.startCoordinator.transition(requestKey, "thread-starting");
  if (sideEffectCount === 1) await firstStartGate;

  const threadId = `019f9999-aaaa-7bbb-cccc-${String(++missionSequence).padStart(12, "0")}`;
  const rollout = path.join(rolloutDir, `rollout-2026-07-24T20-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { id: threadId, originator: "codex_cli_rs", cwd: threadOptions.workingDirectory }
  }) + "\n");
  await this.startCoordinator.transition(requestKey, "thread-bound", {
    binding: {
      thread_id: threadId,
      rollout_path: rollout
    }
  });
  const active = await this.startCoordinator.transition(requestKey, "active");
  inbox.recordMissionOptions({
    thread_id: threadId,
    cwd: threadOptions.workingDirectory || null,
    sandbox_mode: threadOptions.sandboxMode,
    approval_policy: threadOptions.approvalPolicy || "never"
  });
  pool.get(threadId);
  return this.startResult(active, false);
};
let fatalErrors = 0;
const httpServer = startHttp({ cfg, pool, inbox, audit, restartsLogPath, recentMissions, consumer, repoRoot: path.resolve(__dirname, ".."), candidateId: "selftest-candidate", onFatal: () => { fatalErrors++; } });
await sleep(500);

console.log("\n[0] Ingress observability + keep-alive mitigation");
{
  check("keep-alive raised above observed idle gap", httpServer.keepAliveTimeout === 20 * 60 * 1000);
  check("headers timeout remains above keep-alive", httpServer.headersTimeout > httpServer.keepAliveTimeout);

  let probeSocket;
  const serverSocket = await new Promise((resolve) => {
    httpServer.once("connection", resolve);
    probeSocket = net.connect({ host: "127.0.0.1", port: PORT });
    probeSocket.on("error", () => {});
  });
  serverSocket.emit("error", Object.assign(new Error("selftest socket error"), { code: "ESELFTEST_SOCKET" }));
  await sleep(20);
  check("socket errors are audited", auditRows.some((r) => r.event === "ingress_socket_error" && r.args?.code === "ESELFTEST_SOCKET"));
  probeSocket.destroy();

  let clientSocketDestroyed = false;
  httpServer.emit(
    "clientError",
    Object.assign(new Error("selftest client error"), { code: "ESELFTEST_CLIENT" }),
    { remoteAddress: "127.0.0.1", destroy: () => { clientSocketDestroyed = true; } }
  );
  check("client errors are audited and destroyed", clientSocketDestroyed && auditRows.some((r) => r.event === "ingress_client_error" && r.args?.code === "ESELFTEST_CLIENT"));

  httpServer.emit("error", Object.assign(new Error("selftest server error"), { code: "ESELFTEST_SERVER" }));
  check("server errors are audited and fatal", fatalErrors === 1 && auditRows.some((r) => r.event === "ingress_server_error" && r.args?.code === "ESELFTEST_SERVER"));
}

console.log("\n[1] Auth");
{
  const bad = await fetch(`http://127.0.0.1:${PORT}/mcp/wrong-token`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } })
  });
  check("wrong token rejected with 401", bad.status === 401, `got ${bad.status}`);
  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  const healthBody = await health.json();
  check("healthz responds with sanitized service identity", health.status === 200 && healthBody.ok === true && healthBody.service === "codex-meta-bridge");
  const ingressRows = auditRows.filter((r) => r.event === "ingress_request");
  check("requests are audited before dispatch", ingressRows.some((r) => r.args?.path === "/mcp/:token") && ingressRows.some((r) => r.args?.path === "/healthz"));
  check("ingress audit records reuse without leaking token", ingressRows.every((r) => typeof r.args?.reused === "boolean") && !JSON.stringify(ingressRows).includes(TOKEN));
}

console.log("\n[2] MCP session (capability URL)");
const client = new Client({ name: "selftest-client", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${TOKEN}`)));
{
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  const expected = ["bridge_health", "orchestrator_status", "read_transcript", "get_event", "send_steering", "list_steering", "list_callbacks", "ack_callback", "set_target_thread", "start_mission", "interrupt_turn", "get_diagnostics", "get_logs", "restart_bridge"];
  check(`${expected.length} tools registered`, names.length === expected.length, names.join(","));
  for (const n of expected) check(`tool present: ${n}`, names.includes(n));
}

console.log("\n[2b] MCP + queued starts converge on one coordinator boundary");
{
  cfg.deliveryMode = "owned";
  const requestKey = "selftest-converged-start";
  const missionArguments = {
    request_key: requestKey,
    prompt: "headless test",
    working_directory: "/tmp/mission",
    sandbox_mode: "workspace-write"
  };
  const firstCall = client.callTool({ name: "start_mission", arguments: missionArguments });
  check("first MCP start reaches the gated side-effect boundary", await waitFor(() => sideEffectCount === 1));

  const duplicateCall = client.callTool({ name: "start_mission", arguments: missionArguments });

  const legacyCommand = inbox.createCommand({
    type: "start_mission",
    request_key: requestKey,
    prompt: missionArguments.prompt,
    threadOptions: {
      workingDirectory: missionArguments.working_directory,
      sandboxMode: missionArguments.sandbox_mode,
      approvalPolicy: "never"
    }
  });

  releaseFirstStart();
  const [firstResponse, duplicateResponse] = await Promise.all([firstCall, duplicateCall]);
  await consumer.processCommands();
  const firstOut = JSON.parse(firstResponse.content[0].text);
  const duplicateOut = JSON.parse(duplicateResponse.content[0].text);
  check("MCP start returns one active binding", firstOut.ok === true && firstOut.reused === false, JSON.stringify(firstOut));
  check("same-key MCP retry reuses the in-flight result", duplicateOut.ok === true && duplicateOut.reused === true && duplicateOut.thread_id === firstOut.thread_id, JSON.stringify(duplicateOut));
  check("queued duplicate is consumed without another side effect", !fs.existsSync(legacyCommand.file));
  check("all three ingress paths made one reservation and one side effect", startCoordinator.list().length === 1 && sideEffectCount === 1, JSON.stringify(startCoordinator.list()));

  const differentHash = JSON.parse((await client.callTool({
    name: "start_mission",
    arguments: { ...missionArguments, prompt: "different normalized payload" }
  })).content[0].text);
  check("same request key with a different hash is rejected", differentHash.ok === false && differentHash.error_code === "REQUEST_KEY_CONFLICT", JSON.stringify(differentHash));
  check("start registers tailer", pool.get(firstOut.thread_id).digest().rolloutFound === true);
  check("start persists resume options", inbox.missionOptions(firstOut.thread_id)?.cwd === "/tmp/mission");
  await startCoordinator.transition(requestKey, "terminal", { reason: "selftest convergence complete" });
  cfg.deliveryMode = "inbox";
}

console.log("\n[3] Read plane: digest from fixture rollout");
{
  const res = await client.callTool({ name: "orchestrator_status", arguments: {} });
  const d = JSON.parse(res.content[0].text);
  check("rollout found", d.rolloutFound === true, d.tailerError || "");
  check("session meta parsed (Codex Desktop)", d.sessionMeta?.originator === "Codex Desktop");
  check("last user message contains mission", d.lastUserMessage?.text?.includes("$orchestrate-mission"));
  check("last assistant message contains STATUS", d.lastAssistantMessage?.text?.includes("STATUS: phase=1/3"));
  check("token window parsed (258400)", d.tokens?.window === 258400);
  check("window used pct computed", typeof d.tokens?.window_used_pct === "number" && d.tokens.window_used_pct > 30);
  check("rate limit parsed (90%)", d.rateLimit?.used_percent === 90);
  check("subagent source_scout detected", Array.isArray(d.subagents) && d.subagents.includes("source_scout"));
}

console.log("\n[4] Read plane: transcript events");
{
  const res = await client.callTool({ name: "read_transcript", arguments: { last_n: 50 } });
  const t = JSON.parse(res.content[0].text);
  check("events returned", t.count >= 8, `count=${t.count}`);
  const kinds = t.events.map((e) => e.kind);
  check("has user_message", kinds.includes("user_message"));
  check("has assistant_message", kinds.includes("assistant_message"));
  check("has tool_call", kinds.includes("tool_call"));
  const res2 = await client.callTool({ name: "read_transcript", arguments: { last_n: 50, kinds: ["assistant_message"] } });
  const t2 = JSON.parse(res2.content[0].text);
  check("kind filter works", t2.events.every((e) => e.kind === "assistant_message") && t2.count >= 1);
  const expandedRes = await client.callTool({ name: "read_transcript", arguments: { last_n: 50, max_chars_per_event: 4000 } });
  const expanded = JSON.parse(expandedRes.content[0].text);
  const eventRef = expanded.events.find((e) => e.id || e.t);
  check("max_chars_per_event accepted", expanded.count >= 1 && expanded.events.every((e) => e.summary.length <= 4000));
  const oneRes = await client.callTool({ name: "get_event", arguments: { event_timestamp_or_id: eventRef.id || eventRef.t } });
  const one = JSON.parse(oneRes.content[0].text);
  check("get_event returns full event", one.ok === true && one.event?.text !== undefined, JSON.stringify(one));
}

console.log("\n[5] Write plane: steering ticket + inbox file");
let ticket;
{
  const res = await client.callTool({ name: "send_steering", arguments: { message: "Continue to phase 2 immediately after source_scout returns. Do not stop after phase 1.", priority: "urgent" } });
  const out = JSON.parse(res.content[0].text);
  check("send_steering ok", out.ok === true);
  ticket = out.ticket;
  const pendingFile = path.join(bridgeDir, "inbox", "pending", `${ticket}.json`);
  check("pending inbox file written", fs.existsSync(pendingFile));
  const payload = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  check("payload carries steering marker + ticket", payload.message.startsWith(`${STEERING_MARKER} ${ticket}]`));
  check("payload targets configured thread", payload.target_thread_id === THREAD_ID);
}

console.log("\n[6] Delivery simulation: liaison moves file, rollout confirms");
{
  // Liaison delivers: move pending -> delivered
  fs.renameSync(
    path.join(bridgeDir, "inbox", "pending", `${ticket}.json`),
    path.join(bridgeDir, "inbox", "delivered", `${ticket}.json`)
  );
  // The steering message then appears in the target rollout as a user turn:
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${STEERING_MARKER} ${ticket}]\n\nContinue to phase 2 immediately after source_scout returns. Do not stop after phase 1.` }] }
  });
  fs.appendFileSync(rolloutPath, line + "\n");
  await sleep(1200); // > pollMs
  const res = await client.callTool({ name: "list_steering", arguments: {} });
  const s = JSON.parse(res.content[0].text);
  const row = s.delivered.find((r) => r.ticket === ticket);
  check("ticket listed as delivered", !!row);
  check("rollout confirmation observed", !!row?.confirmed_in_rollout_at, JSON.stringify(s));
  const st = await client.callTool({ name: "orchestrator_status", arguments: {} });
  const d = JSON.parse(st.content[0].text);
  check("digest exposes confirmed ticket", d.confirmedSteeringTickets?.some((c) => c.ticket === ticket));
}

console.log("\n[7] Live append visibility (file growth -> digest updates)");
{
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Acknowledged steering. Proceeding to phase 2 now.\n\nSTATUS: phase=2/3 blockers=none next=extraction pass" }] }
  });
  fs.appendFileSync(rolloutPath, line + "\n");
  await sleep(1000);
  const res = await client.callTool({ name: "orchestrator_status", arguments: {} });
  const d = JSON.parse(res.content[0].text);
  check("new assistant message observed", d.lastAssistantMessage?.text?.includes("phase=2/3"));
}

console.log("\n[8] Retarget");
{
  const OTHER = "019f9320-5cb8-7ea1-926d-b85ffd0bd146";
  const otherPath = path.join(rolloutDir, `rollout-2026-07-24T09-56-39-${OTHER}.jsonl`);
  fs.writeFileSync(otherPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: OTHER, originator: "codex exec", cli_version: "0.144.6" } }) + "\n");
  const res = await client.callTool({ name: "set_target_thread", arguments: { thread_id: OTHER } });
  const out = JSON.parse(res.content[0].text);
  check("retarget ok + rollout found", out.ok === true && out.rollout_found === true, JSON.stringify(out));
  const back = await client.callTool({ name: "set_target_thread", arguments: { thread_id: THREAD_ID } });
  check("retarget back ok", JSON.parse(back.content[0].text).rollout_found === true);
}

console.log("\n[8b] Reverse channel: orchestrator callback -> meta");
{
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Plan drafted.\n[[CALLBACK:PLAN_READY]] acceptance matrix + architecture ready for approval" }] }
  });
  fs.appendFileSync(rolloutPath, line + "\n");
  await sleep(900);
  const res = await client.callTool({ name: "list_callbacks", arguments: { thread_id: THREAD_ID } });
  const cb = JSON.parse(res.content[0].text);
  const row = cb.callbacks.find((c) => c.kind === "PLAN_READY");
  check("callback surfaced to meta", !!row && /approval/.test(row.summary), JSON.stringify(cb));
  check("bridge_health counts it unacked", JSON.parse((await client.callTool({ name: "bridge_health", arguments: {} })).content[0].text).unacked_callbacks >= 1);
  await client.callTool({ name: "ack_callback", arguments: { id: row.id } });
  const after = JSON.parse((await client.callTool({ name: "list_callbacks", arguments: { thread_id: THREAD_ID } })).content[0].text);
  check("acked callback no longer unacked", !after.callbacks.some((c) => c.id === row.id));
}

console.log("\n[9] Recovery plane: diagnostics + logs");
{
  const res = await client.callTool({ name: "get_diagnostics", arguments: {} });
  const d = JSON.parse(res.content[0].text);
  check("diagnostics ok", d.ok === true);
  check("diagnostics report daemon pid + port", d.daemon?.pid > 0 && d.daemon?.port === PORT);
  check("diagnostics report target rollout", d.target?.rolloutFound === true);
  check("diagnostics reports real codex version", typeof d.codexVersion === "string" && d.codexVersion.startsWith("codex-cli "), JSON.stringify(d.codexVersion));
  const logs = await client.callTool({ name: "get_logs", arguments: { lines: 20 } });
  const l = JSON.parse(logs.content[0].text);
  check("audit log tail present", Array.isArray(l.audit?.lines) && l.audit.lines.length > 0);
}

console.log("\n[10] start_mission rejected in inbox mode");
{
  const res = await client.callTool({ name: "start_mission", arguments: { request_key: "inbox-refusal", prompt: "test" } });
  const out = JSON.parse(res.content[0].text);
  check("start_mission refused (mode=inbox)", out.ok === false && /owned/i.test(out.error));

  cfg.deliveryMode = "owned";
  const defaultsRes = await client.callTool({ name: "start_mission", arguments: { request_key: "defaults", prompt: "test defaults" } });
  const defaultsOut = JSON.parse(defaultsRes.content[0].text);
  check("start_mission reports effective defaults", defaultsOut.cwd === "/tmp/default-mission" && defaultsOut.sandbox_mode === "danger-full-access", JSON.stringify(defaultsOut));
  const defaultsCall = startCalls.find((call) => call.requestKey === "defaults");
  check("start maps defaults to SDK option names", defaultsCall?.threadOptions?.workingDirectory === "/tmp/default-mission" && defaultsCall?.threadOptions?.sandboxMode === "danger-full-access" && defaultsCall?.threadOptions?.approvalPolicy === "never", JSON.stringify(defaultsCall?.threadOptions));

  const overrideRes = await client.callTool({ name: "start_mission", arguments: { request_key: "override", prompt: "test override", working_directory: "/tmp/override", sandbox_mode: "workspace-write" } });
  const overrideOut = JSON.parse(overrideRes.content[0].text);
  const overrideCall = startCalls.find((call) => call.requestKey === "override");
  check("explicit mission options override defaults", overrideOut.cwd === "/tmp/override" && overrideOut.sandbox_mode === "workspace-write" && overrideCall?.threadOptions?.workingDirectory === "/tmp/override" && overrideCall?.threadOptions?.sandboxMode === "workspace-write", JSON.stringify(overrideCall?.threadOptions));
  cfg.deliveryMode = "inbox";
}

console.log("\n[11] interrupt_turn rejected in inbox mode");
{
  const res = await client.callTool({ name: "interrupt_turn", arguments: { thread_id: THREAD_ID, confirm: true } });
  const out = JSON.parse(res.content[0].text);
  check("interrupt_turn refused (mode=inbox)", out.ok === false && /owned/i.test(out.error || ""), JSON.stringify(out));
}

await client.close();
pool.stopAll();
httpServer.close();

console.log("");
if (failures === 0) {
  console.log("SELFTEST PASS (all checks green)");
  process.exit(0);
} else {
  console.error(`SELFTEST FAIL (${failures} failing check${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
