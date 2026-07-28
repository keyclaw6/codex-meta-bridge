#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, REPO_ROOT, configPath } from "../src/config.mjs";

const CONFIG_PATH = configPath();
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

let cfg = { ...DEFAULTS };
if (fs.existsSync(CONFIG_PATH)) {
  cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  console.log("Existing config found; preserving values (token kept unless --rotate-token).");
}
delete cfg.webhookUrl;
if (argValue("target")) cfg.targetThreadId = argValue("target");
if (argValue("port")) cfg.port = Number(argValue("port"));
if (argValue("codex-home")) cfg.codexHome = argValue("codex-home");
cfg.deliveryMode = "owned";
if (!cfg.token || args.includes("--rotate-token")) cfg.token = crypto.randomBytes(32).toString("hex");

fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
fs.chmodSync(CONFIG_PATH, 0o600);
for (const directory of [
  "logs",
  "state",
  path.join("inbox", "pending"),
  path.join("inbox", "delivered"),
  path.join("inbox", "delivering"),
  path.join("inbox", "failed"),
  "commands"
]) {
  fs.mkdirSync(path.join(cfg.bridgeDir, directory), { recursive: true });
}

const daemonLog = path.join(cfg.bridgeDir, "logs", "daemon.log");
const service = `[Unit]
Description=Codex Meta Bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
UMask=0077
Environment=HOME=/root
Environment=CODEX_HOME=${cfg.codexHome}
WorkingDirectory=${REPO_ROOT}
ExecStart=${process.execPath} ${path.join(REPO_ROOT, "src", "daemon.mjs")}
Restart=always
RestartSec=3
StandardOutput=append:${daemonLog}
StandardError=append:${daemonLog}

[Install]
WantedBy=multi-user.target
`;
const installer = `#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with root authority: sudo sh install-service.sh" >&2
  exit 1
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
chown -R root:root "$repo_dir/bridge"
chmod -R u+rwX,go-rwx "$repo_dir/bridge"
chown root:root "$repo_dir/bridge.config.json"
chmod 0600 "$repo_dir/bridge.config.json"
install -m 0644 "$repo_dir/codex-meta-bridge.service" /etc/systemd/system/codex-meta-bridge.service
systemctl daemon-reload
systemctl enable codex-meta-bridge.service
systemctl restart codex-meta-bridge.service
systemctl --no-pager --full status codex-meta-bridge.service
`;
fs.writeFileSync(path.join(REPO_ROOT, "codex-meta-bridge.service"), service);
fs.writeFileSync(path.join(REPO_ROOT, "install-service.sh"), installer, { mode: 0o755 });

console.log(`
codex-meta-bridge initialized

Config:         ${CONFIG_PATH}
Delivery mode:  ${cfg.deliveryMode}
Local endpoint: http://${cfg.host}:${cfg.port}

Next:
  sudo sh install-service.sh
  curl http://${cfg.host}:${cfg.port}/healthz
  tailscale funnel --bg ${cfg.port}

Register this secret URL in Hyper Agent:
  https://<FUNNEL-HOST>/mcp/<TOKEN-FROM-BRIDGE.CONFIG.JSON>

Never print or commit the token. Rotate it with --rotate-token, then restart the service and update the integration.
`);
