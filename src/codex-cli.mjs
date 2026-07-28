import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const codexVersionCache = new Map();

function pathCandidates({ cfg = {}, env = process.env } = {}) {
  const explicit = cfg.codex_cli_path || cfg.codexPath || env.CODEX_PATH;
  const candidates = explicit ? [explicit] : [];
  candidates.push(...String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "codex")));
  return candidates;
}

export function resolveCodexCli(options = {}) {
  const seen = new Set();
  for (const candidate of pathCandidates(options)) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch { /* try the next candidate */ }
  }
  throw new Error("codex CLI not found on PATH or in config");
}

export function probeCodexVersion(cfg = {}, { executable = null, execute = execFileSync, useCache = true } = {}) {
  const cacheKey = executable || cfg.codex_cli_path || cfg.codexPath || process.env.CODEX_PATH || "<default>";
  if (useCache && codexVersionCache.has(cacheKey)) return codexVersionCache.get(cacheKey);
  const command = executable || resolveCodexCli({ cfg });
  const version = execute(command, ["--version"], {
    encoding: "utf8",
    timeout: 8000
  }).trim();
  if (useCache) codexVersionCache.set(cacheKey, version);
  return version;
}
