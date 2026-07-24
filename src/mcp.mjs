import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { saveConfig } from "./config.mjs";
import { gatherDiagnostics, tailLogs } from "./diagnostics.mjs";
import { spawnDaemonDetached } from "./proc.mjs";
import { OAuthProvider } from "./oauth.mjs";

const VERSION = "0.4.0";
const STARTED_AT = new Date().toISOString();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function tokenEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}
function toolResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function buildMcpServer(ctx) {
  const { cfg, pool, inbox, audit, restartsLogPath, repoRoot } = ctx;
  const server = new McpServer({ name: "codex-meta-bridge", version: VERSION });

  // Resolve which orchestrator a call is about. Multiple meta sessions each
  // pass their own thread_id; omitting it falls back to the default target
  // (single-session convenience). Returns null if neither is available.
  const resolve = (threadId) => threadId || cfg.targetThreadId || null;

  // ---- read plane ----
  server.registerTool("bridge_health", {
    title: "Bridge health",
    description: "Daemon health: version, uptime, delivery mode, default target, all actively tailed orchestrators, pending steering, consumer error. Cheap; call first.",
    inputSchema: {}
  }, async () => {
    const dflt = cfg.targetThreadId ? pool.get(cfg.targetThreadId).digest() : null;
    const out = {
      ok: true, version: VERSION, started_at: STARTED_AT, pid: process.pid,
      uptime_sec: Math.round(process.uptime()),
      delivery_mode: cfg.deliveryMode,
      default_target_thread_id: cfg.targetThreadId || null,
      default_rollout_found: dflt?.rolloutFound ?? null,
      default_idle_seconds: dflt?.idleSeconds ?? null,
      tailed_orchestrators: pool.list(),
      recent_started_missions: ctx.recentMissions?.slice(-5) ?? [],
      pending_steering: inbox.listState().pending.length,
      consumer_error: ctx.consumer?.lastError ?? null
    };
    audit("bridge_health", {}, true);
    return toolResult(out);
  });

  server.registerTool("orchestrator_status", {
    title: "Orchestrator status digest",
    description: "Compact digest of a Codex orchestrator session: last user/assistant messages, tokens vs context window, rate limits, subagents, idle time, compactions. Pass thread_id to target a specific orchestrator (required when supervising more than one); omit to use the default target. Read before steering.",
    inputSchema: { thread_id: z.string().optional() }
  }, async ({ thread_id }) => {
    const id = resolve(thread_id);
    if (!id) return toolResult({ ok: false, error: "No thread_id and no default target. Pass thread_id." });
    audit("orchestrator_status", { thread_id: id }, true);
    return toolResult(pool.get(id).digest());
  });

  server.registerTool("read_transcript", {
    title: "Read recent transcript events",
    description: "Recent parsed rollout events for an orchestrator (newest last). Pass thread_id to target a specific one; omit for the default. Filter with kinds, e.g. [\"user_message\",\"assistant_message\"] for conversation, [\"tool_call\"] for activity.",
    inputSchema: {
      thread_id: z.string().optional(),
      last_n: z.number().int().min(1).max(200).optional(),
      kinds: z.array(z.string()).optional()
    }
  }, async ({ thread_id, last_n, kinds }) => {
    const id = resolve(thread_id);
    if (!id) return toolResult({ ok: false, error: "No thread_id and no default target. Pass thread_id." });
    const events = pool.get(id).recentEvents(last_n ?? 30, kinds ?? null);
    audit("read_transcript", { thread_id: id, last_n, kinds }, true);
    return toolResult({ threadId: id, count: events.length, events });
  });

  // ---- write / control plane ----
  server.registerTool("send_steering", {
    title: "Send a steering message",
    description: "Queue a steering message for an orchestrator. Pass target_thread_id to steer a specific one (required when supervising more than one); omit for the default. In owned mode the daemon delivers within seconds; in inbox mode the Desktop liaison delivers on its next heartbeat. Returns a ticket; confirmation shows in list_steering when the tagged message appears in that orchestrator's rollout. Write explicit, continuation-forcing instructions — Codex takes them literally.",
    inputSchema: {
      message: z.string().min(1).max(20000),
      target_thread_id: z.string().optional(),
      priority: z.enum(["normal", "urgent"]).optional()
    }
  }, async ({ message, target_thread_id, priority }) => {
    const target = resolve(target_thread_id);
    if (!target) return toolResult({ ok: false, error: "No target_thread_id and no default target. Pass target_thread_id." });
    pool.get(target); // ensure we tail it so the confirmation marker is observed
    const t = inbox.createTicket({ message, targetThreadId: target, priority: priority || "normal" });
    audit("send_steering", { ticket: t.ticket, target, mode: cfg.deliveryMode, chars: message.length }, true);
    return toolResult({
      ok: true, ticket: t.ticket, target_thread_id: target, delivery_mode: cfg.deliveryMode,
      note: cfg.deliveryMode === "owned" ? "owned consumer will deliver within seconds" : "queued for Desktop liaison pickup"
    });
  });

  server.registerTool("list_steering", {
    title: "List steering tickets",
    description: "Steering tickets across all orchestrators (pending / delivering / delivered / failed), with target thread ids, rollout confirmation timestamps, and failure reasons. Filter to one orchestrator with thread_id.",
    inputSchema: { thread_id: z.string().optional() }
  }, async ({ thread_id }) => {
    audit("list_steering", { thread_id }, true);
    const state = inbox.listState();
    if (!thread_id) return toolResult(state);
    const f = (arr) => arr.filter((r) => r.target_thread_id === thread_id);
    return toolResult({ pending: f(state.pending), delivered: f(state.delivered), failed: f(state.failed) });
  });

  server.registerTool("set_target_thread", {
    title: "Set the default target thread",
    description: "Set the SHARED default orchestrator used when a tool omits thread_id. Note: this is shared across all sessions — when running multiple meta sessions, prefer passing thread_id on each call instead of relying on this.",
    inputSchema: { thread_id: z.string().regex(/^[0-9a-fA-F-]{8,}$/) }
  }, async ({ thread_id }) => {
    cfg.targetThreadId = thread_id; saveConfig(cfg); pool.pin(thread_id);
    const d = pool.get(thread_id).digest();
    audit("set_target_thread", { thread_id }, d.rolloutFound);
    return toolResult({ ok: true, default_target_thread_id: thread_id, rollout_found: d.rolloutFound, rollout_path: d.rolloutPath, originator: d.sessionMeta?.originator ?? null });
  });

  server.registerTool("start_mission", {
    title: "Start a new owned mission",
    description: "OWNED MODE ONLY. Launch a brand-new bridge-owned Codex orchestrator with the given mission prompt; the new thread becomes the target automatically. Poll bridge_health/orchestrator_status for the new thread id. Use this to launch missions as the meta agent.",
    inputSchema: {
      prompt: z.string().min(1).max(60000).describe("Full mission prompt / orchestrate-mission invocation"),
      model: z.string().optional(),
      working_directory: z.string().optional()
    }
  }, async ({ prompt, model, working_directory }) => {
    if (cfg.deliveryMode !== "owned") return toolResult({ ok: false, error: "start_mission requires deliveryMode=owned (CLI). Current mode is inbox (Desktop)." });
    const threadOptions = {};
    if (model) threadOptions.model = model;
    if (working_directory) threadOptions.workingDirectory = working_directory;
    const c = inbox.createCommand({ type: "start_mission", prompt, threadOptions });
    audit("start_mission_queued", { command: c.id, chars: prompt.length }, true);
    return toolResult({ ok: true, command_id: c.id, note: "mission-start queued; the owned consumer will launch it and set the new thread as target. Poll bridge_health for target_thread_id." });
  });

  // ---- recovery plane (hands on the box) ----
  server.registerTool("get_diagnostics", {
    title: "Machine + bridge diagnostics",
    description: "Platform, node/codex versions, daemon pid/uptime/memory, port holders, target rollout state, disk free, recent restarts. Use to diagnose a degraded bridge.",
    inputSchema: {}
  }, async () => {
    audit("get_diagnostics", {}, true);
    const tailer = cfg.targetThreadId ? pool.get(cfg.targetThreadId) : null;
    return toolResult(gatherDiagnostics({ cfg, tailer, startedAt: STARTED_AT, restartsLogPath }));
  });

  server.registerTool("get_logs", {
    title: "Tail bridge logs",
    description: "Last N lines of the audit, daemon stdout, and watchdog logs. Read to see what the daemon and watchdog have been doing.",
    inputSchema: { lines: z.number().int().min(1).max(500).optional() }
  }, async ({ lines }) => {
    audit("get_logs", { lines }, true);
    return toolResult(tailLogs(cfg.bridgeDir, lines ?? 60));
  });

  server.registerTool("restart_bridge", {
    title: "Restart the bridge daemon",
    description: "Force a clean restart of the daemon process (spawns a detached relauncher that frees the port and starts fresh, then this process exits). The OS watchdog is the independent safety net. Use when the bridge is wedged or after a config change.",
    inputSchema: { confirm: z.literal(true).describe("Must be true") }
  }, async ({ confirm }) => {
    if (confirm !== true) return toolResult({ ok: false, error: "confirm must be true" });
    audit("restart_bridge", {}, "relaunch scheduled");
    const logPath = path.join(cfg.bridgeDir, "logs", "watchdog.log");
    // Detached forced watchdog: kills whatever holds the port (this process,
    // once it exits) and starts a fresh daemon.
    try {
      const { spawn } = await import("node:child_process");
      const fd = fs.openSync(logPath, "a");
      const child = spawn(process.execPath, [path.join("setup", "watchdog.mjs"), "--force"], {
        cwd: repoRoot, detached: true, stdio: ["ignore", fd, fd]
      });
      child.unref();
    } catch (e) {
      return toolResult({ ok: false, error: `could not spawn relauncher: ${String(e?.message || e)}` });
    }
    setTimeout(() => process.exit(0), 400);
    return toolResult({ ok: true, note: "relauncher spawned; daemon will restart in a few seconds. Reconnect and call bridge_health." });
  });

  return server;
}

export function startHttp(ctx) {
  const { cfg } = ctx;
  const oauth = new OAuthProvider({ cfg });
  ctx.oauth = oauth;
  const handler = async (req, res) => {
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const baseUrl = `${proto}://${req.headers.host || "localhost"}`;
    const url = new URL(req.url, baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok codex-meta-bridge ${VERSION}\n`);
      return;
    }

    // OAuth discovery + authorize/token/register (handles its own responses).
    try { if (await oauth.handle(req, res, baseUrl)) return; }
    catch (e) { ctx.audit("oauth_error", {}, String(e?.message || e)); if (!res.headersSent) json(res, 500, { error: "oauth_error" }); return; }

    if (parts[0] === "mcp") {
      const pathToken = parts[1];
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const authorized =
        (pathToken && tokenEquals(pathToken, cfg.token)) ||   // capability URL (my curl path)
        (bearer && tokenEquals(bearer, cfg.token)) ||          // static bearer
        (bearer && oauth.validateBearer(bearer));              // OAuth access token (Hyperagent)
      if (!authorized) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": oauth.challenge(baseUrl) });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "POST only (stateless server)" }, id: null });
        return;
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        let parsed;
        try { parsed = body ? JSON.parse(body) : undefined; }
        catch { return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
        try {
          const server = buildMcpServer(ctx);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          res.on("close", () => { transport.close(); server.close(); });
          await server.connect(transport);
          await transport.handleRequest(req, res, parsed);
        } catch (e) {
          ctx.audit("mcp_error", {}, String(e?.message || e));
          if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        }
      });
      return;
    }
    json(res, 404, { error: "not found" });
  };
  const server = http.createServer(handler);
  server.listen(cfg.port, cfg.host);
  return server;
}

export function makeAudit(bridgeDir) {
  const logDir = path.join(bridgeDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const auditPath = path.join(logDir, "audit.jsonl");
  return (event, args, result) => {
    const line = JSON.stringify({ t: new Date().toISOString(), event, args, result });
    try { fs.appendFileSync(auditPath, line + "\n", "utf8"); } catch { /* best effort */ }
    console.log(line);
  };
}

export { VERSION };
