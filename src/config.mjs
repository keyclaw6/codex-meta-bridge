import fs from "node:fs";
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
  port: 8788,
  token: "",
  targetThreadId: "",
  deliveryMode: "owned",
  codexHome: "/var/lib/codex-root",
  bridgeDir: path.join(REPO_ROOT, "bridge"),
  pollMs: 2000,
  truncateUser: 2000,
  truncateAssistant: 4000,
  maxTailers: 100,
  default_mission_cwd: "",
  default_mission_sandbox: "danger-full-access",
  hyperagentMcpUrl: "https://hyperagent.com/api/mcp",
  hyperagentThreadId: "",
  hyperagentWakeLeaseMs: 5 * 60 * 1000
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
  if (cfg.deliveryMode !== "owned") {
    throw new Error("Only deliveryMode=owned is supported on this Linux bridge.");
  }
  return cfg;
}

export function saveConfig(cfg) {
  const persisted = { ...cfg };
  const target = configPath();
  fs.writeFileSync(target, JSON.stringify(persisted, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(target, 0o600);
}
