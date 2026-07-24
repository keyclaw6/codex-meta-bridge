#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { REPO_ROOT, CONFIG_PATH, DEFAULTS } from "../src/config.mjs";

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

let cfg = { ...DEFAULTS };
if (fs.existsSync(CONFIG_PATH)) {
  cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  console.log("Existing config found; preserving values (token kept unless --rotate-token).");
}

if (argVal("target")) cfg.targetThreadId = argVal("target");
if (argVal("port")) cfg.port = Number(argVal("port"));
if (argVal("codex-home")) cfg.codexHome = argVal("codex-home");
if (!cfg.token || args.includes("--rotate-token")) cfg.token = crypto.randomBytes(32).toString("hex");

fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
fs.mkdirSync(path.join(cfg.bridgeDir, "logs"), { recursive: true });
for (const d of ["pending", "delivered", "failed"]) fs.mkdirSync(path.join(cfg.bridgeDir, "inbox", d), { recursive: true });

// Windows launcher for Task Scheduler (logs appended under bridge/logs/).
const cmdPath = path.join(REPO_ROOT, "start-bridge.cmd");
const cmd = [
  "@echo off",
  `cd /d "${REPO_ROOT}"`,
  `node src\\daemon.mjs >> "${path.join(cfg.bridgeDir, "logs", "daemon.log")}" 2>&1`,
  ""
].join("\r\n");
fs.writeFileSync(cmdPath, cmd, "utf8");

const registrationUrl = `https://<YOUR-FUNNEL-HOSTNAME>/mcp/${cfg.token}`;

console.log(`
== codex-meta-bridge initialized ==

Config:            ${CONFIG_PATH}
Target thread:     ${cfg.targetThreadId || "(unset — set with --target <threadId> or the set_target_thread MCP tool)"}
Delivery mode:     ${cfg.deliveryMode}
Local endpoint:    http://${cfg.host}:${cfg.port}
Launcher:          ${cmdPath}

Next steps:
  1) Start now:            start-bridge.cmd   (or: npm start)
  2) Health check:         curl http://${cfg.host}:${cfg.port}/healthz
  3) Auto-start at logon:  schtasks /Create /SC ONLOGON /TN "CodexMetaBridge" /TR "\\"${cmdPath}\\"" /F
  4) Expose via Tailscale: tailscale funnel --bg ${cfg.port}
                           then: tailscale funnel status   (note the public https hostname)
  5) MCP registration URL (paste into Hyperagent -> Settings -> Integrations -> Add MCP server):
       ${registrationUrl}

SECURITY: the URL above contains the auth token. Never commit bridge.config.json,
never post the token into repos or logs. Rotate anytime with: node setup/init.mjs --rotate-token
`);
