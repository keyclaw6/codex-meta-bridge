import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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

function rolloutFiles(codexHome) {
  const sessions = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessions)) return [];
  try {
    return fs.readdirSync(sessions, { recursive: true })
      .map(String)
      .filter((rel) => rel.includes("rollout-") && rel.endsWith(".jsonl"))
      .map((rel) => path.join(sessions, rel));
  } catch {
    return [];
  }
}

function threadIdFromRollout(rolloutPath) {
  return path.basename(rolloutPath).match(/([0-9a-fA-F-]{36})\.jsonl$/)?.[1] || null;
}

function rolloutContainsPrompt(rolloutPath, prompt) {
  try {
    return fs.readFileSync(rolloutPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line);
        return event?.type === "event_msg"
          && event?.payload?.type === "user_message"
          && event.payload.message === prompt;
      });
  } catch {
    return false;
  }
}

const psEncoded = (script) => Buffer.from(script, "utf16le").toString("base64");
const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64");

export function spawnVisibleCodexWindow({ command, args, cwd, spawnProcess = spawn, terminalPath: configuredTerminalPath }) {
  if (process.platform !== "win32") throw new Error("visible Codex CLI launch is currently supported only on win32");
  const spec = b64(JSON.stringify({ command, args, cwd }));
  const inner = [
    `$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${spec}')) | ConvertFrom-Json`,
    "Set-Location -LiteralPath $spec.cwd",
    "$cliArgs = @($spec.args | ForEach-Object { [string]$_ })",
    "& $spec.command @cliArgs",
    "exit $LASTEXITCODE"
  ].join("; ");
  const innerEncoded = psEncoded(inner);
  let terminalPath = configuredTerminalPath;
  if (terminalPath === undefined) {
    try {
      terminalPath = execFileSync("where.exe", ["wt.exe"], {
        encoding: "utf8", timeout: 3000, windowsHide: true
      }).split(/\r?\n/).find(Boolean) || null;
    } catch { terminalPath = null; /* fall back to a separate PowerShell console */ }
  }
  if (terminalPath) {
    const terminal = spawnProcess(terminalPath, [
      "-w", "new", "new-tab",
      "--title", "Codex Orchestrator",
      "--startingDirectory", cwd,
      "powershell.exe", "-NoProfile", "-EncodedCommand", innerEncoded
    ], {
      detached: true,
      windowsHide: false,
      stdio: "ignore"
    });
    terminal.unref?.();
    return { pid: null };
  }

  const receiptPath = path.join(os.tmpdir(), `codex-visible-${randomUUID()}.pid`);
  const receipt = b64(receiptPath);
  const outer = [
    `$receipt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${receipt}'))`,
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand','${innerEncoded}') -WorkingDirectory '${cwd.replaceAll("'", "''")}' -WindowStyle Normal -PassThru`,
    "[IO.File]::WriteAllText($receipt, [string]$p.Id)"
  ].join("; ");
  const child = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", psEncoded(outer)], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref?.();
  return { receiptPath };
}

export async function launchVisibleCliMission({
  cfg,
  prompt,
  workingDirectory,
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
  model,
  timeoutMs = 30000,
  pollMs = 200,
  launchWindow = spawnVisibleCodexWindow
}) {
  const command = resolveCodexCli({ cfg });
  const cwd = workingDirectory || cfg.default_mission_cwd || process.cwd();
  const before = new Set(rolloutFiles(cfg.codexHome));
  const args = ["--cd", cwd, "--sandbox", sandboxMode, "--ask-for-approval", approvalPolicy, "--no-alt-screen"];
  if (model) args.push("--model", model);
  args.push(prompt);
  const { receiptPath = null, pid: launchedPid = null } = launchWindow({ command, args, cwd });
  const deadline = Date.now() + timeoutMs;
  let pid = launchedPid;
  try {
    while (Date.now() < deadline) {
      if (!pid && receiptPath && fs.existsSync(receiptPath)) {
        pid = Number(fs.readFileSync(receiptPath, "utf8")) || null;
      }
      const candidates = rolloutFiles(cfg.codexHome)
        .filter((file) => !before.has(file))
        .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { file } of candidates) {
        const threadId = threadIdFromRollout(file);
        if (threadId && rolloutContainsPrompt(file, prompt)) {
          return { threadId, rolloutPath: file, pid, codexPath: command };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    if (receiptPath) {
      try { fs.rmSync(receiptPath, { force: true }); } catch { /* best effort */ }
    }
  }
  throw new Error(`visible Codex CLI started but no new rollout appeared within ${timeoutMs}ms`);
}
