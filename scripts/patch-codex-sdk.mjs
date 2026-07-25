#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.145.0";
const ORIGINAL_SPAWN = `    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal
    });`;
const PATCHED_SPAWN = `    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
      windowsHide: process.platform === "win32"
    });`;
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

export function patchCodexSdk({ repoRoot = DEFAULT_REPO_ROOT, platform = process.platform } = {}) {
  const sdkDir = path.join(repoRoot, "node_modules", "@openai", "codex-sdk");
  if (!fs.existsSync(sdkDir)) {
    if (platform === "win32") {
      throw new Error(`required @openai/codex-sdk@${EXPECTED_VERSION} is not installed`);
    }
    console.log(`[codex-sdk patch] optional SDK is not installed on ${platform}; skipped`);
    return "skipped";
  }

  const manifestPath = path.join(sdkDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`installed SDK is incomplete: missing ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`refusing to patch @openai/codex-sdk@${manifest.version ?? "unknown"}; expected exactly ${EXPECTED_VERSION}`);
  }

  const runtimePath = path.join(sdkDir, "dist", "index.js");
  if (!fs.existsSync(runtimePath)) {
    throw new Error(`installed @openai/codex-sdk@${EXPECTED_VERSION} is missing dist/index.js`);
  }
  const source = fs.readFileSync(runtimePath, "utf8");
  const originalCount = occurrenceCount(source, ORIGINAL_SPAWN);
  const patchedCount = occurrenceCount(source, PATCHED_SPAWN);

  if (originalCount === 0 && patchedCount === 1) {
    console.log(`[codex-sdk patch] @openai/codex-sdk@${EXPECTED_VERSION} already patched`);
    return "already-patched";
  }
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error(
      `refusing to patch unexpected @openai/codex-sdk@${EXPECTED_VERSION} runtime shape ` +
      `(unpatched blocks: ${originalCount}, patched blocks: ${patchedCount})`,
    );
  }

  const patchedSource = source.replace(ORIGINAL_SPAWN, PATCHED_SPAWN);
  fs.writeFileSync(runtimePath, patchedSource, "utf8");
  const verifiedSource = fs.readFileSync(runtimePath, "utf8");
  if (occurrenceCount(verifiedSource, ORIGINAL_SPAWN) !== 0 || occurrenceCount(verifiedSource, PATCHED_SPAWN) !== 1) {
    throw new Error(`failed to verify @openai/codex-sdk@${EXPECTED_VERSION} runtime patch`);
  }
  console.log(`[codex-sdk patch] patched @openai/codex-sdk@${EXPECTED_VERSION}`);
  return "patched";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    patchCodexSdk();
  } catch (error) {
    console.error(`[codex-sdk patch] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
