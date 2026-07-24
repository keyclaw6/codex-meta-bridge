#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  launchVisibleCliMission,
  probeCodexVersion,
  resolveCodexCli,
  spawnVisibleCodexWindow
} from "../src/codex-cli.mjs";

let failures = 0;
const check = (name, condition, extra = "") => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${extra}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cli-"));
const shimDir = path.join(tmp, "npm");
fs.mkdirSync(shimDir, { recursive: true });
const shim = path.join(shimDir, process.platform === "win32" ? "codex.cmd" : "codex");
fs.writeFileSync(shim, process.platform === "win32" ? "@echo codex-cli test\n" : "#!/bin/sh\necho codex-cli test\n");
if (process.platform !== "win32") fs.chmodSync(shim, 0o755);

console.log("\n[cli-1] path resolution + version probe");
check("explicit config path wins", resolveCodexCli({ cfg: { codex_cli_path: shim } }) === shim);
if (process.platform === "win32") {
  check("npm global fallback resolves .cmd", resolveCodexCli({
    platform: "win32",
    env: { APPDATA: tmp, PATH: "" }
  }) === shim);
}
check("version probe executes shim", probeCodexVersion({ codex_cli_path: shim }) === "codex-cli test");
fs.writeFileSync(shim, process.platform === "win32" ? "@echo codex-cli changed\n" : "#!/bin/sh\necho codex-cli changed\n");
check("version probe is cached for process lifetime", probeCodexVersion({ codex_cli_path: shim }) === "codex-cli test");
let versionProbeOptions = null;
probeCodexVersion({}, {
  executable: path.join(tmp, "uncached-codex.cmd"),
  useCache: false,
  execute: (_command, _args, options) => {
    versionProbeOptions = options;
    return "codex-cli injected\n";
  }
});
check("version probe helper is hidden", versionProbeOptions?.windowsHide === true);

console.log("\n[cli-2] visible launcher flags + rollout discovery");
if (process.platform === "win32") {
  const captured = [];
  const fakeSpawn = (command, args, options) => {
    captured.push({ command, args, options });
    return { unref() {} };
  };
  spawnVisibleCodexWindow({
    command: shim,
    args: ["test prompt"],
    cwd: tmp,
    spawnProcess: fakeSpawn,
    terminalPath: "C:\\Windows\\System32\\wt.exe"
  });
  check("Windows Terminal orchestrator window is visible", captured[0]?.options?.detached === true && captured[0]?.options?.windowsHide === false);
  const fallback = spawnVisibleCodexWindow({
    command: shim,
    args: ["test prompt"],
    cwd: tmp,
    spawnProcess: fakeSpawn,
    terminalPath: null
  });
  check("fallback outer PowerShell wrapper is hidden", captured[1]?.command === "powershell.exe" && captured[1]?.options?.windowsHide === true);
  const outerScript = Buffer.from(captured[1].args.at(-1), "base64").toString("utf16le");
  check("fallback inner Codex console stays visible", outerScript.includes("-WindowStyle Normal"));
  try { fs.rmSync(fallback.receiptPath, { force: true }); } catch { /* ignore */ }
}

const codexHome = path.join(tmp, ".codex");
const sessions = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(sessions, { recursive: true });
const threadId = "019f9999-aaaa-7bbb-cccc-000000000123";
const rolloutPath = path.join(sessions, `rollout-2026-07-24T20-00-00-${threadId}.jsonl`);
const launched = await launchVisibleCliMission({
  cfg: { codexHome, codex_cli_path: shim, default_mission_cwd: tmp },
  prompt: "test",
  workingDirectory: tmp,
  timeoutMs: 1000,
  pollMs: 10,
  launchWindow: ({ args }) => {
    check("interactive launch keeps alternate-screen TUI enabled", !args.includes("--no-alt-screen"));
    setTimeout(() => fs.writeFileSync(rolloutPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: threadId, originator: "codex_cli_rs" }
    }) + "\n" + JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: "test" }
    }) + "\n"), 25);
    return {};
  }
});
check("new visible rollout returns thread id", launched.threadId === threadId, JSON.stringify(launched));
check("new visible rollout path returned", launched.rolloutPath === rolloutPath);

console.log("");
if (failures === 0) { console.log("CLI TEST PASS"); process.exit(0); }
console.error(`CLI TEST FAIL (${failures})`); process.exit(1);
