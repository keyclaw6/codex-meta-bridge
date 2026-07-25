#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeCodexVersion,
  resolveCodexCli
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

console.log("\n[cli-2] direct visible console path is absent");
const cliModule = await import("../src/codex-cli.mjs");
check("module exposes diagnostics only", !("spawnVisibleCodexWindow" in cliModule) && !("launchVisibleCliMission" in cliModule));

console.log("");
if (failures === 0) { console.log("CLI TEST PASS"); process.exit(0); }
console.error(`CLI TEST FAIL (${failures})`); process.exit(1);
