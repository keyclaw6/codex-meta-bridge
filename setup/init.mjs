#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { REPO_ROOT, configPath, DEFAULTS } from "../src/config.mjs";

const CONFIG_PATH = configPath();
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const IS_WIN = process.platform === "win32";

let cfg = { ...DEFAULTS };
if (fs.existsSync(CONFIG_PATH)) {
  cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  console.log("Existing config found; preserving values (token kept unless --rotate-token).");
}
if (argVal("target")) cfg.targetThreadId = argVal("target");
if (argVal("port")) cfg.port = Number(argVal("port"));
if (argVal("codex-home")) cfg.codexHome = argVal("codex-home");
if (argVal("mode")) cfg.deliveryMode = argVal("mode"); // "owned" | "inbox"
if (!cfg.token || args.includes("--rotate-token")) cfg.token = crypto.randomBytes(32).toString("hex");

fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
for (const d of ["logs", "state", path.join("inbox", "pending"), path.join("inbox", "delivered"), path.join("inbox", "delivering"), path.join("inbox", "failed"), "commands"]) {
  fs.mkdirSync(path.join(cfg.bridgeDir, d), { recursive: true });
}

const daemonLog = path.join(cfg.bridgeDir, "logs", "daemon.log");
let serviceInstructions;

if (IS_WIN) {
  // Start launcher
  fs.writeFileSync(path.join(REPO_ROOT, "start-bridge.cmd"),
    ["@echo off", `cd /d "${REPO_ROOT}"`, `node src\\daemon.mjs >> "${daemonLog}" 2>&1`, ""].join("\r\n"), "utf8");
  serviceInstructions = `Install self-healing per-user startup persistence:
     npm run windows:persistence -- install
   Check it anytime with: npm run windows:persistence -- status
   This installs one HKCU Run value that starts one hidden watchdog loop.`;
} else {
  // Linux/macOS: start script + systemd user units (service Restart=always for
  // crashes; a health timer runs the watchdog for hang detection).
  fs.writeFileSync(path.join(REPO_ROOT, "start-bridge.sh"),
    ["#!/bin/sh", `cd "${REPO_ROOT}"`, `exec node src/daemon.mjs >> "${daemonLog}" 2>&1`, ""].join("\n"), { mode: 0o755 });
  const node = process.execPath;
  const svc = `[Unit]
Description=codex-meta-bridge daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
ExecStart=${node} src/daemon.mjs
Restart=always
RestartSec=3
StandardOutput=append:${daemonLog}
StandardError=append:${daemonLog}

[Install]
WantedBy=default.target
`;
  const healthSvc = `[Unit]
Description=codex-meta-bridge health watchdog (hang detection)

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=${node} setup/watchdog.mjs
`;
  const healthTimer = `[Unit]
Description=run codex-meta-bridge watchdog every minute

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=15

[Install]
WantedBy=timers.target
`;
  fs.writeFileSync(path.join(REPO_ROOT, "codex-meta-bridge.service"), svc);
  fs.writeFileSync(path.join(REPO_ROOT, "codex-meta-bridge-health.service"), healthSvc);
  fs.writeFileSync(path.join(REPO_ROOT, "codex-meta-bridge-health.timer"), healthTimer);
  const sh = `#!/bin/sh
set -e
mkdir -p ~/.config/systemd/user
cp codex-meta-bridge.service codex-meta-bridge-health.service codex-meta-bridge-health.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-meta-bridge.service
systemctl --user enable --now codex-meta-bridge-health.timer
loginctl enable-linger "$USER" || echo "NOTE: run 'sudo loginctl enable-linger $USER' so the bridge runs without an active login."
echo "Installed + started codex-meta-bridge (Restart=always) + health watchdog timer."
`;
  fs.writeFileSync(path.join(REPO_ROOT, "install-service.sh"), sh, { mode: 0o755 });
  serviceInstructions = `Install self-healing service (systemd --user):
     sh install-service.sh
   This enables the daemon (Restart=always) plus a 1-minute watchdog timer for
   hang detection, and enables linger so it survives logout/reboot.`;
}

const registrationUrl = `https://<YOUR-FUNNEL-HOSTNAME>/mcp/${cfg.token}`;
console.log(`
== codex-meta-bridge initialized (${IS_WIN ? "windows" : "unix"}) ==

Config:         ${CONFIG_PATH}
Target thread:  ${cfg.targetThreadId || "(unset — use --target, start_mission, or set_target_thread)"}
Delivery mode:  ${cfg.deliveryMode}${cfg.deliveryMode === "owned" ? "  (daemon owns the orchestrator; no liaison needed)" : "  (Desktop liaison delivers steering)"}
Local endpoint: http://${cfg.host}:${cfg.port}

Next steps:
  1) ${serviceInstructions}
  2) Health check:  curl http://${cfg.host}:${cfg.port}/healthz
  3) Expose:        tailscale funnel --bg ${cfg.port}   (then: tailscale funnel status)
  4) Register in Hyperagent (Settings -> Integrations -> Add MCP server):
       ${registrationUrl}

SECURITY: the URL contains the auth token. Never commit bridge.config.json or the token.
Rotate anytime:  node setup/init.mjs --rotate-token   (then restart the service)
`);
