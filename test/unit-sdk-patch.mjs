#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchCodexSdk } from "../scripts/patch-codex-sdk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = "0.145.0";
const originalSpawn = `    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal
    });`;
const patchedSpawn = `    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
      windowsHide: process.platform === "win32"
    });`;

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const lockfile = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
assert.equal(manifest.optionalDependencies?.["@openai/codex-sdk"], expectedVersion);
assert.equal(lockfile.packages?.[""]?.optionalDependencies?.["@openai/codex-sdk"], expectedVersion);
assert.equal(lockfile.packages?.["node_modules/@openai/codex-sdk"]?.version, expectedVersion);
assert.equal(manifest.scripts?.postinstall, "node scripts/patch-codex-sdk.mjs");
assert.match(manifest.scripts?.test ?? "", /(?:^|&& )node test\/unit-sdk-patch\.mjs(?: &&|$)/);

const installedSdkDir = path.join(repoRoot, "node_modules", "@openai", "codex-sdk");
if (fs.existsSync(installedSdkDir)) {
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedSdkDir, "package.json"), "utf8"));
  const installedRuntime = fs.readFileSync(path.join(installedSdkDir, "dist", "index.js"), "utf8");
  assert.equal(installedManifest.version, expectedVersion);
  assert.equal(installedRuntime.split(originalSpawn).length - 1, 0);
  assert.equal(installedRuntime.split(patchedSpawn).length - 1, 1);
} else {
  assert.notEqual(process.platform, "win32", "Windows requires the pinned SDK to be installed and patched");
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sdk-patch-"));
const fixtureSdkDir = path.join(fixtureRoot, "node_modules", "@openai", "codex-sdk");
const fixtureRuntimePath = path.join(fixtureSdkDir, "dist", "index.js");
try {
  fs.mkdirSync(path.dirname(fixtureRuntimePath), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureSdkDir, "package.json"),
    JSON.stringify({ name: "@openai/codex-sdk", version: expectedVersion }),
  );
  fs.writeFileSync(fixtureRuntimePath, `before\n${originalSpawn}\nafter\n`);

  assert.equal(patchCodexSdk({ repoRoot: fixtureRoot, platform: "win32" }), "patched");
  const firstPatch = fs.readFileSync(fixtureRuntimePath, "utf8");
  assert.equal(firstPatch, `before\n${patchedSpawn}\nafter\n`);
  assert.equal(patchCodexSdk({ repoRoot: fixtureRoot, platform: "win32" }), "already-patched");
  assert.equal(fs.readFileSync(fixtureRuntimePath, "utf8"), firstPatch);

  fs.writeFileSync(fixtureRuntimePath, "unexpected runtime shape\n");
  assert.throws(
    () => patchCodexSdk({ repoRoot: fixtureRoot, platform: "win32" }),
    /refusing to patch unexpected .* runtime shape/,
  );

  fs.writeFileSync(
    path.join(fixtureSdkDir, "package.json"),
    JSON.stringify({ name: "@openai/codex-sdk", version: "0.145.1" }),
  );
  assert.throws(
    () => patchCodexSdk({ repoRoot: fixtureRoot, platform: "win32" }),
    /expected exactly 0\.145\.0/,
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

assert.throws(
  () => patchCodexSdk({ repoRoot: fixtureRoot, platform: "win32" }),
  /required @openai\/codex-sdk@0\.145\.0 is not installed/,
);

console.log("SDK PATCH TEST PASS");
