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

const VERSION = "0.3.0";
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
  const { cfg, tailer, inbox, audit, restartsLogPath, repoRoot } = ctx;
  const server = new McpServer({ name: "codex-meta-bridge", version: VERSION });

  // ---- read plane ----
  server.registerTool("bridge_health", {
    title: "Bridge health",
    description: "Daemon health: version, uptime, delivery mode, target thread, rollout status, pending steering, consumer error. Cheap; call first.",
    inputSchema: {}
  }, async () => {
    const d = tailer.digest();
    const out = {
      ok: true, version: VERSION, started_at: STARTED_AT, pid: process.pid,
      uptime_sec: Math.round(process.uptime()),
      delivery_mode: cfg.deliveryMode, target_thread_id: cfg.targetThreadId,
      rollout_found: d.rolloutFound, rollout_mtime: d.fileMtime, idle_seconds: d.idleSeconds,
      pending_steering: inbox.listState().pending.length,
      consumer_error: ctx.consumer?.lastError ?? null, tailer_error: d.tailerError
    };
    audit("bridge_health", {}, true);
    return toolResult(out);
  });

  server.registerTool("orchestrator_status", {
    title: "Orchestrator status digest",
    description: "Compact digest of the target Codex session: last user/assistant messages, tokens vs context window, rate limits, subagents, idle time, compactions. Read before steering.",
    inputSchema: {}
  }, async () => { audit("orchestrator_status", {}, true); return toolResult(tailer.digest()); });

  server.registerTool("read_transcript", {
    title: "Read recent transcript events",
    description: "Recent parsed rollout events (newest last). Filter with kinds, e.g. [\"user_message\",\"assistant_message\"] for conversation, [\"tool_call\"] for activity.",
    inputSchema: {
      last_n: z.number().int().min(1).max(200).optional(),
      kinds: z.array(z.string()).optional()
    }
  }, async ({ last_n, kinds }) => {
    const events = tailer.recentEvents(last_n ?? 30, kinds ?? null);
    audit("read_transcript", { last_n, kinds }, true);
    return toolResult({ threadId: tailer.threadId, count: events.length, events });
  });

  // ---- write / control plane ----
  server.registerTool("send_steering", {
    title: "Send a steering message",
    description: "Queue a steering message for the target orchestrator. In owned mode the daemon delivers it within seconds; in inbox mode the Desktop liaison delivers on its next heartbeat. Returns a ticket; confirmation shows in list_steering when the tagged message appears in the target rollout. Write explicit, continuation-forcing instructions — Codex takes them literally.",
    inputSchema: {
      message: z.string().min(1).max(20000),
      target_thread_id: z.string().optional(),
      priority: z.enum(["normal", "urgent"]).optional()
    }
  }, async ({ message, target_thread_id, priority }) => {
    const target = target_thread_id || cfg.targetThreadId;
    if (!target) return toolResult({ ok: false, error: "No target thread. Call set_target_thread or start_mission first." });
    const t = inbox.createTicket({ message, targetThreadId: target, priority: priority || "normal" });
    audit("send_steering", { ticket: t.ticket, target, mode: cfg.deliveryMode, chars: message.length }, true);
    return toolResult({
      ok: true, ticket: t.ticket, target_thread_id: target, delivery_mode: cfg.deliveryMode,
      note: cfg.deliveryMode === "owned" ? "owned consumer will deliver within seconds" : "queued for Desktop liaison pickup"
    });
  });

  server.registerTool("list_steering", {
    title: "List steering tickets",
    description: "Pending / delivering / delivered / failed steering tickets, with rollout confirmation timestamps and failure reasons where present.",
    inputSchema: {}
  }, async () => { audit("list_steering", {}, true); return toolResult(inbox.listState()); });

  server.registerTool("set_target_thread", {
    title: "Set target thread",
    description: "Point the bridge at a different Codex thread id. Persists and re-tails.",
    inputSchema: { thread_id: z.string().regex(/^[0-9a-fA-F-]{8,}$/) }
  }, async ({ thread_id }) => {
    cfg.targetThreadId = thread_id; saveConfig(cfg); tailer.retarget(thread_id);
    const d = tailer.digest();
    audit("set_target_thread", { thread_id }, d.rolloutFound);
    return toolResult({ ok: true, target_thread_id: thread_id, rollout_found: d.rolloutFound, rollout_path: d.rolloutPath, originator: d.sessionMeta?.originator ?? null });
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
