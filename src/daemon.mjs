#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { RolloutTailer } from "./tailer.mjs";
import { Inbox } from "./inbox.mjs";
import { startHttp, makeAudit } from "./mcp.mjs";

const cfg = loadConfig();
const audit = makeAudit(cfg.bridgeDir);
const inbox = new Inbox(cfg.bridgeDir);

const tailer = new RolloutTailer({
  codexHome: cfg.codexHome,
  threadId: cfg.targetThreadId,
  pollMs: cfg.pollMs,
  truncateUser: cfg.truncateUser,
  truncateAssistant: cfg.truncateAssistant,
  onSteeringConfirmed: (ticket, at) => {
    inbox.markConfirmed(ticket, at);
    audit("steering_confirmed", { ticket }, at);
  },
  onTurnComplete: (at) => {
    if (cfg.webhookUrl) {
      fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "turn_complete", thread_id: cfg.targetThreadId, at })
      }).catch((e) => audit("webhook_error", {}, String(e?.message || e)));
    }
  }
});

if (cfg.targetThreadId) {
  tailer.start();
} else {
  audit("startup_warning", {}, "No targetThreadId configured; tailer idle until set_target_thread is called.");
  tailer.start(); // still polls so retargeting works live
}

const httpServer = startHttp({ cfg, tailer, inbox, audit });

audit("startup", {
  host: cfg.host,
  port: cfg.port,
  delivery_mode: cfg.deliveryMode,
  target_thread_id: cfg.targetThreadId || "(unset)",
  codex_home: cfg.codexHome
}, "daemon running");

console.log(`codex-meta-bridge listening on http://${cfg.host}:${cfg.port} (MCP at /mcp/<token>, health at /healthz)`);

process.on("SIGINT", () => {
  tailer.stop();
  httpServer.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  tailer.stop();
  httpServer.close();
  process.exit(0);
});
