import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { saveConfig } from "./config.mjs";
import { gatherDiagnostics, tailLogs } from "./diagnostics.mjs";
import { listBusyDescendants, spawnDaemonDetached } from "./proc.mjs";
import { OAuthProvider } from "./oauth.mjs";
import { launchVisibleCliMission } from "./codex-cli.mjs";

const VERSION = "0.9.0";
const STARTED_AT = new Date().toISOString();
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 20 * 60 * 1000;
const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEP_ALIVE_TIMEOUT_MS + 5000;

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

  // Count callbacks not yet acked, across all tailed orchestrators.
  const countUnackedCallbacks = () => {
    const acked = inbox.ackedCallbacks();
    let n = 0;
    for (const { threadId } of pool.list()) {
      for (const cb of pool.get(threadId).digest().callbacks || []) if (!acked.has(cb.id)) n++;
    }
    return n;
  };

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
      unacked_callbacks: countUnackedCallbacks(),
      consumer_error: ctx.consumer?.lastError ?? null
    };
    audit("bridge_health", {}, true);
    return toolResult(out);
  });

  server.registerTool("orchestrator_status", {
    title: "Orchestrator status digest",
    description: "Compact digest of a Codex orchestrator session: active command, best-effort daemon child-process liveness, subagent threads, messages, tokens, idle time, and compactions. Pass thread_id to target a parent or child orchestrator; omit to use the default target.",
    inputSchema: { thread_id: z.string().optional() }
  }, async ({ thread_id }) => {
    const id = resolve(thread_id);
    if (!id) return toolResult({ ok: false, error: "No thread_id and no default target. Pass thread_id." });
    const digest = pool.get(id).digest();
    const busyChildren = await listBusyDescendants();
    audit("orchestrator_status", { thread_id: id }, true);
    return toolResult({ ...digest, busy_children_best_effort: true, busy_children: busyChildren });
  });

  server.registerTool("read_transcript", {
    title: "Read recent transcript events",
    description: "Recent parsed rollout events for an orchestrator (newest last). Pass thread_id to target a specific one; omit for the default. Filter with kinds, e.g. [\"user_message\",\"assistant_message\"] for conversation, [\"tool_call\"] for activity.",
    inputSchema: {
      thread_id: z.string().optional(),
      last_n: z.number().int().min(1).max(200).optional(),
      kinds: z.array(z.string()).optional(),
      max_chars_per_event: z.number().int().min(1).max(4000).optional()
    }
  }, async ({ thread_id, last_n, kinds, max_chars_per_event }) => {
    const id = resolve(thread_id);
    if (!id) return toolResult({ ok: false, error: "No thread_id and no default target. Pass thread_id." });
    const events = pool.get(id).recentEvents(last_n ?? 30, kinds ?? null, max_chars_per_event ?? 500);
    audit("read_transcript", { thread_id: id, last_n, kinds, max_chars_per_event }, true);
    return toolResult({ threadId: id, count: events.length, events });
  });

  server.registerTool("get_event", {
    title: "Get one full transcript event",
    description: "Return one rollout event by the id or timestamp shown by read_transcript. Event text is capped at 8000 characters. Accepts parent or child thread ids.",
    inputSchema: {
      thread_id: z.string().optional(),
      event_timestamp_or_id: z.string().min(1)
    }
  }, async ({ thread_id, event_timestamp_or_id }) => {
    const id = resolve(thread_id);
    if (!id) return toolResult({ ok: false, error: "No thread_id and no default target. Pass thread_id." });
    const event = pool.get(id).getEvent(event_timestamp_or_id);
    audit("get_event", { thread_id: id, event_timestamp_or_id }, !!event);
    return toolResult(event ? { ok: true, threadId: id, event } : { ok: false, threadId: id, error: "Event not found in the recent-event buffer." });
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

  server.registerTool("list_callbacks", {
    title: "List orchestrator callbacks",
    description: "Callbacks the orchestrator sent to the meta agent (PLAN_READY, MILESTONE_COMPLETE, LONG_COMMAND_STARTED/FINISHED, BLOCKED, CANDIDATE_READY, or any [[CALLBACK:KIND]] it emits). This is the orchestrator→meta channel: read it each wake to see what the orchestrator is asking you to decide. Defaults to unacked only; pass thread_id to scope to one orchestrator. Ack them with ack_callback once handled.",
    inputSchema: { thread_id: z.string().optional(), unacked_only: z.boolean().optional() }
  }, async ({ thread_id, unacked_only }) => {
    const acked = inbox.ackedCallbacks();
    const onlyUnacked = unacked_only !== false;
    const threads = thread_id ? [thread_id] : pool.list().map((e) => e.threadId);
    const out = [];
    for (const id of threads) {
      for (const cb of pool.get(id).digest().callbacks || []) {
        const isAcked = acked.has(cb.id);
        if (onlyUnacked && isAcked) continue;
        out.push({ ...cb, acked: isAcked });
      }
    }
    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    audit("list_callbacks", { thread_id, unacked_only: onlyUnacked, count: out.length }, true);
    return toolResult({ count: out.length, callbacks: out });
  });

  server.registerTool("ack_callback", {
    title: "Acknowledge a callback",
    description: "Mark an orchestrator callback handled so it stops surfacing as unacked (persists across restarts). Ack after you've acted on it (approved a plan, recorded a milestone, sent a recovery directive).",
    inputSchema: { id: z.string().describe("The callback id from list_callbacks") }
  }, async ({ id }) => {
    inbox.markCallbackAcked(id);
    audit("ack_callback", { id }, true);
    return toolResult({ ok: true, acked: id });
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
    description: "OWNED MODE ONLY. Launch a brand-new bridge-owned Codex orchestrator. working_directory defaults to config default_mission_cwd (omitted when empty); sandbox_mode defaults to config default_mission_sandbox (danger-full-access by default). The new thread is registered automatically; poll bridge_health/orchestrator_status for its id.",
    inputSchema: {
      prompt: z.string().min(1).max(60000).describe("Full mission prompt / orchestrate-mission invocation"),
      model: z.string().optional(),
      working_directory: z.string().optional(),
      sandbox_mode: z.enum(["danger-full-access", "workspace-write", "read-only"]).optional()
    }
  }, async ({ prompt, model, working_directory, sandbox_mode }) => {
    if (cfg.deliveryMode !== "owned") return toolResult({ ok: false, error: "start_mission requires deliveryMode=owned (CLI). Current mode is inbox (Desktop)." });
    const cwd = working_directory || cfg.default_mission_cwd || "";
    const effectiveSandbox = sandbox_mode || cfg.default_mission_sandbox;
    const threadOptions = { sandboxMode: effectiveSandbox, approvalPolicy: "never" };
    if (model) threadOptions.model = model;
    if (cwd) threadOptions.workingDirectory = cwd;
    const c = inbox.createCommand({ type: "start_mission", prompt, threadOptions });
    audit("start_mission_queued", { command: c.id, chars: prompt.length, cwd: cwd || null, sandbox_mode: effectiveSandbox }, true);
    return toolResult({ ok: true, command_id: c.id, cwd: cwd || null, sandbox_mode: effectiveSandbox, note: "mission-start queued; the owned consumer will launch it and register the new thread. Poll bridge_health for recent_started_missions." });
  });

  server.registerTool("start_visible_cli_mission", {
    title: "Start a visible Codex CLI mission",
    description: "WINDOWS + OWNED MODE. Launch Codex CLI in its own visible console, discover and tail its rollout, and return its thread id. The existing SDK start_mission path is unchanged.",
    inputSchema: {
      prompt: z.string().min(1).max(60000),
      model: z.string().optional(),
      working_directory: z.string().optional(),
      sandbox_mode: z.enum(["danger-full-access", "workspace-write", "read-only"]).optional()
    }
  }, async ({ prompt, model, working_directory, sandbox_mode }) => {
    if (cfg.deliveryMode !== "owned") return toolResult({ ok: false, error: "start_visible_cli_mission requires deliveryMode=owned." });
    const cwd = working_directory || cfg.default_mission_cwd || process.cwd();
    const effectiveSandbox = sandbox_mode || cfg.default_mission_sandbox;
    const launcher = ctx.visibleCliLauncher || launchVisibleCliMission;
    try {
      const launched = await launcher({
        cfg, prompt, model, workingDirectory: cwd,
        sandboxMode: effectiveSandbox, approvalPolicy: "never"
      });
      const missionOptions = {
        thread_id: launched.threadId,
        cwd,
        sandbox_mode: effectiveSandbox,
        approval_policy: "never"
      };
      inbox.recordMissionOptions(missionOptions);
      pool.get(launched.threadId);
      ctx.recentMissions?.push({
        threadId: launched.threadId, at: new Date().toISOString(),
        cwd, sandbox_mode: effectiveSandbox, visible_cli: true
      });
      if (ctx.recentMissions?.length > 20) ctx.recentMissions.shift();
      audit("visible_cli_started", { threadId: launched.threadId, cwd, pid: launched.pid || null }, true);
      return toolResult({
        ok: true,
        thread_id: launched.threadId,
        rollout_path: launched.rolloutPath,
        pid: launched.pid || null,
        visible: true,
        steering_note: "Empirically supported through send_steering after the visible CLI turn is idle."
      });
    } catch (e) {
      audit("visible_cli_failed", {}, String(e?.message || e));
      return toolResult({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- recovery plane (hands on the box) ----
  server.registerTool("interrupt_turn", {
    title: "Interrupt an active owned turn",
    description: "RECOVERY ONLY. Abort the in-flight SDK turn for a bridge-owned thread so it returns an error and the session can continue. Does not apply to Desktop-owned threads. Requires confirm=true.",
    inputSchema: {
      thread_id: z.string(),
      confirm: z.literal(true).describe("Must be true")
    }
  }, async ({ thread_id, confirm }) => {
    if (confirm !== true) return toolResult({ ok: false, error: "confirm must be true" });
    if (cfg.deliveryMode !== "owned" || !ctx.consumer) return toolResult({ ok: false, error: "interrupt_turn is available only for bridge-owned SDK sessions." });
    const interrupted = ctx.consumer.interruptTurn(thread_id);
    audit("interrupt_turn", { thread_id }, interrupted);
    return toolResult(interrupted
      ? { ok: true, thread_id, note: "Abort requested for the active SDK turn; use orchestrator_status to confirm recovery." }
      : { ok: false, thread_id, error: "No active bridge-owned SDK turn for this thread." });
  });

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
        cwd: repoRoot, detached: true, stdio: ["ignore", fd, fd], windowsHide: true
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
  const socketRequestCounts = new WeakMap();
  const safeAudit = (...args) => {
    try { ctx.audit(...args); } catch { /* observability must never break ingress */ }
  };
  const ingressPath = (rawUrl) => {
    const pathname = String(rawUrl || "/").split("?", 1)[0];
    return /^\/mcp(?:\/|$)/.test(pathname) ? "/mcp/:token" : pathname;
  };
  const handler = async (req, res) => {
    const requestCount = (socketRequestCounts.get(req.socket) || 0) + 1;
    socketRequestCounts.set(req.socket, requestCount);
    safeAudit("ingress_request", {
      method: req.method || null,
      path: ingressPath(req.url),
      reused: requestCount > 1
    }, true);

    // Trust the funnel's X-Forwarded-Proto (Tailscale sets https); fall back to
    // the actual socket for direct/local connections (http) rather than assuming.
    const proto = (req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http")).split(",")[0].trim();
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
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": oauth.challenge(baseUrl, pathToken) });
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
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.on("connection", (socket) => {
    socket.on("error", (error) => {
      safeAudit("ingress_socket_error", {
        code: error?.code || null,
        remote_address: socket.remoteAddress || null
      }, String(error?.message || error));
    });
  });
  server.on("clientError", (error, socket) => {
    safeAudit("ingress_client_error", {
      code: error?.code || null,
      remote_address: socket?.remoteAddress || null
    }, String(error?.message || error));
    try { socket?.destroy(); } catch { /* best effort */ }
  });
  server.on("error", (error) => {
    safeAudit("ingress_server_error", {
      code: error?.code || null
    }, String(error?.message || error));
  });
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
