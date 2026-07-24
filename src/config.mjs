import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const CONFIG_PATH = process.env.BRIDGE_CONFIG_PATH || path.join(REPO_ROOT, "bridge.config.json");

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  token: "",
  targetThreadId: "",
  deliveryMode: "inbox", // "inbox" (Desktop liaison pumps files) | "owned" (daemon runs the turn via @openai/codex-sdk)
  codexHome: path.join(os.homedir(), ".codex"),
  bridgeDir: path.join(REPO_ROOT, "bridge"),
  pollMs: 2000,
  truncateUser: 2000,
  truncateAssistant: 4000,
  webhookUrl: "" // optional: Hyperagent webhook to ping on turn-complete / long idle (not required for v1)
};

export function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  if (!cfg.token) {
    throw new Error(`No auth token configured. Run: node setup/init.mjs (config expected at ${CONFIG_PATH})`);
  }
  return cfg;
}

export function saveConfig(cfg) {
  const persisted = { ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2) + "\n", "utf8");
}
