import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Resolved LAZILY (at call time, not import time) so that test harnesses can
 * set BRIDGE_CONFIG_PATH after module load and never touch a live config.
 * (Field-found defect: binding this at import time let the selftest's
 * set_target_thread overwrite the live bridge.config.json.)
 */
export function configPath() {
  return process.env.BRIDGE_CONFIG_PATH || path.join(REPO_ROOT, "bridge.config.json");
}

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
  default_mission_cwd: "",
  default_mission_sandbox: "danger-full-access",
  webhookUrl: "" // optional: Hyperagent webhook to ping on turn-complete / long idle (not required for v1)
};

export function loadConfig() {
  const p = configPath();
  let fileCfg = {};
  if (fs.existsSync(p)) {
    fileCfg = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  if (!cfg.token) {
    throw new Error(`No auth token configured. Run: node setup/init.mjs (config expected at ${p})`);
  }
  return cfg;
}

export function saveConfig(cfg) {
  const persisted = { ...cfg };
  fs.writeFileSync(configPath(), JSON.stringify(persisted, null, 2) + "\n", "utf8");
}
