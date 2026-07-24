import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { deliverOwned } from "./owned.mjs";
import { saveConfig } from "./config.mjs";

const VERSION = "0.1.0";
const STARTED_AT = new Date().toISOString();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function tokenEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function toolResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function buildMcpServer(ctx) {
  const { cfg, tailer, inbox, audit } = ctx;
  const server = new McpServer({ name: "codex-meta-bridge", version: VERSION });

  server.registerTool(
    "bridge_health",
    {
      title: "Bridge health",
      description: "Daemon health: uptime, delivery mode, target thread, rollout file status, pending steering count.",
      inputSchema: {}
    },
    async () => {
      const d = tailer.digest();
      const s = inbox.listState();
      const out = {
        ok: true,
        version: VERSION,
        started_at: STARTED_AT,
        delivery_mode: cfg.deliveryMode,
        target_thread_id: cfg.targetThreadId,
        rollout_found: d.rolloutFound,
        rollout_path: d.rolloutPath,
        rollout_mtime: d.fileMtime,
        idle_seconds: d.idleSeconds,
        pending_steering: s.pending.length,
        tailer_error: d.tailerError
      };
      audit("bridge_health", {}, out.ok);
      return toolResult(out);
    }
  );

  server.registerTool(
    "orchestrator_status",
    {
      title: "Orchestrator status digest",
      description: "Compact digest of the target Codex session: last user/assistant messages, token usage vs context window, rate limits, subagents, idle time, compactions. Read this before deciding whether to steer.",
      inputSchema: {}
    },
    async () => {
      const d = tailer.digest();
      audit("orchestrator_status", {}, true);
      return toolResult(d);
    }
  );

  server.registerTool(
    "read_transcript",
    {
      title: "Read recent transcript events",
      description: "Recent parsed events from the target session rollout (newest last). Use kinds to filter, e.g. [\"user_message\",\"assistant_message\"] for the conversation only, or [\"tool_call\"] for activity.",
      inputSchema: {
        last_n: z.number().int().min(1).max(200).optional().describe("How many recent events (default 30, max 200)"),
        kinds: z.array(z.string()).optional().describe("Filter by event kind: user_message, assistant_message, tool_call, tool_output, compacted, session_meta")
      }
    },
    async ({ last_n, kinds }) => {
      const events = tailer.recentEvents(last_n ?? 30, kinds ?? null);
      audit("read_transcript", { last_n, kinds }, true);
      return toolResult({ threadId: tailer.threadId, count: events.length, events });
    }
  );

  server.registerTool(
    "send_steering",
    {
      title: "Send a steering message",
      description: "Queue a steering message for the orchestrator (or an explicit target thread). In inbox mode the Desktop liaison delivers it on its next heartbeat; in owned mode the daemon runs the turn directly. Returns a ticket; confirmation appears in list_steering/orchestrator_status when the tagged message shows up in the target rollout. Write steering as explicit, continuation-forcing instructions.",
      inputSchema: {
        message: z.string().min(1).max(20000).describe("The steering message. Be explicit and phase-gated; Codex takes instructions literally."),
        target_thread_id: z.string().optional().describe("Override target thread id (defaults to the configured orchestrator)"),
        priority: z.enum(["normal", "urgent"]).optional().describe("urgent is surfaced first to the liaison"),
        delivery: z.enum(["inbox", "owned"]).optional().describe("Override delivery mode for this message only. NEVER use owned against a Desktop-owned live thread.")
      }
    },
    async ({ message, target_thread_id, priority, delivery }) => {
      const target = target_thread_id || cfg.targetThreadId;
      if (!target) return toolResult({ ok: false, error: "No target thread configured. Call set_target_thread first." });
      const mode = delivery || cfg.deliveryMode;
      const t = inbox.createTicket({ message, targetThreadId: target, priority: priority || "normal" });
      let note = "queued for liaison pickup (inbox mode)";
      if (mode === "owned") {
        // Move ticket out of pending so the liaison won't double-deliver; owned path runs it.
        const from = path.join(inbox.pending, `${t.ticket}.json`);
        const to = path.join(inbox.delivered, `${t.ticket}.json`);
        try { fs.renameSync(from, to); } catch { /* keep pending on failure */ }
        note = "owned delivery started (async; watch list_steering for rollout confirmation)";
        deliverOwned({ targetThreadId: target, message, ticket: t.ticket, log: (m) => audit("owned_delivery", { ticket: t.ticket }, m) })
          .catch((e) => {
            try { fs.renameSync(to, path.join(inbox.failed, `${t.ticket}.json`)); } catch { /* already moved */ }
            audit("owned_delivery_failed", { ticket: t.ticket }, String(e?.message || e));
          });
      }
      audit("send_steering", { ticket: t.ticket, target, mode, priority: priority || "normal", chars: message.length }, true);
      return toolResult({ ok: true, ticket: t.ticket, target_thread_id: target, delivery_mode: mode, note });
    }
  );

  server.registerTool(
    "list_steering",
    {
      title: "List steering tickets",
      description: "Pending / delivered / failed steering tickets, with rollout confirmation timestamps where observed.",
      inputSchema: {}
    },
    async () => {
      const s = inbox.listState();
      audit("list_steering", {}, true);
      return toolResult(s);
    }
  );

  server.registerTool(
    "set_target_thread",
    {
      title: "Set target thread",
      description: "Point the bridge at a different Codex thread id (e.g. a new mission's orchestrator). Persists to config and re-tails the new rollout.",
      inputSchema: {
        thread_id: z.string().regex(/^[0-9a-fA-F-]{8,}$/).describe("Codex thread id (UUID)")
      }
    },
    async ({ thread_id }) => {
      cfg.targetThreadId = thread_id;
      saveConfig(cfg);
      tailer.retarget(thread_id);
      const d = tailer.digest();
      audit("set_target_thread", { thread_id }, d.rolloutFound);
      return toolResult({ ok: true, target_thread_id: thread_id, rollout_found: d.rolloutFound, rollout_path: d.rolloutPath, note: d.rolloutFound ? "tailing new target" : "no rollout file found yet for this id (will keep looking)" });
    }
  );

  return server;
}

export function startHttp(ctx) {
  const { cfg } = ctx;

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok codex-meta-bridge ${VERSION}\n`);
      return;
    }

    // MCP endpoint: /mcp with Bearer auth, or capability URL /mcp/<token>
    if (parts[0] === "mcp") {
      const pathToken = parts[1] || "";
      const authHeader = req.headers.authorization || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const supplied = pathToken || bearer;
      if (!supplied || !tokenEquals(supplied, cfg.token)) {
        json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
        return;
      }
      if (req.method !== "POST") {
        // Stateless server: no SSE stream, no sessions.
        json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server; POST only)" }, id: null });
        return;
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : undefined;
        } catch {
          json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
          return;
        }
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
