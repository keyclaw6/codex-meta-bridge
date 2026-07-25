import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const codexVersionCache = new Map();

function pathCandidates({ cfg = {}, env = process.env, platform = process.platform } = {}) {
  const explicit = cfg.codex_cli_path || cfg.codexPath || env.CODEX_PATH;
  const candidates = explicit ? [explicit] : [];
  try {
    const lookup = platform === "win32"
      ? execFileSync("where.exe", ["codex.cmd"], { encoding: "utf8", timeout: 3000, windowsHide: true, env })
      : execFileSync("which", ["codex"], { encoding: "utf8", timeout: 3000, env });
    candidates.push(...lookup.split(/\r?\n/).filter(Boolean));
  } catch { /* fall through to known install locations */ }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(path.join(appData, "npm", "codex.cmd"));
  }
  return candidates;
}

export function resolveCodexCli(options = {}) {
  const seen = new Set();
  for (const candidate of pathCandidates(options)) {
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error("codex CLI not found on PATH, in config, or in the npm global location");
}

export function probeCodexVersion(cfg = {}, { executable = null, execute = execFileSync, useCache = true } = {}) {
  const cacheKey = executable || cfg.codex_cli_path || cfg.codexPath || process.env.CODEX_PATH || "<default>";
  if (useCache && codexVersionCache.has(cacheKey)) return codexVersionCache.get(cacheKey);
  const command = executable || resolveCodexCli({ cfg });
  const isCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const runner = isCmdShim ? "powershell.exe" : command;
  const args = isCmdShim
    ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command, "utf8").toString("base64")}')); & $p --version`,
      "utf16le"
    ).toString("base64")]
    : ["--version"];
  const version = execute(runner, args, {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true
  }).trim();
  if (useCache) codexVersionCache.set(cacheKey, version);
  return version;
}
