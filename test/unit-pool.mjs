#!/usr/bin/env node
/**
 * TailerPool: proves multiple orchestrators are tailed independently (the
 * anti-interference guarantee for concurrent meta sessions), plus LRU eviction
 * with the pinned default protected.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TailerPool } from "../src/tailer-pool.mjs";

let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ok    ${n}`); else { failures++; console.error(`  FAIL  ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pool-"));
const codexHome = path.join(tmp, ".codex");
const dir = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(dir, { recursive: true });

function mkRollout(id, originator, lastMsg) {
  const p = path.join(dir, `rollout-2026-07-24T10-00-00-${id}.jsonl`);
  fs.writeFileSync(p,
    JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, originator } }) + "\n" +
    JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: lastMsg }] } }) + "\n");
  return p;
}
const A = "019f0000-0000-7000-0000-00000000000a";
const B = "019f0000-0000-7000-0000-00000000000b";
const pA = mkRollout(A, "codex exec", "I am orchestrator A. STATUS: phase=A");
mkRollout(B, "codex exec", "I am orchestrator B. STATUS: phase=B");

const pool = new TailerPool({ codexHome, pollMs: 150, maxTailers: 3, idleEvictMs: 400 });

console.log("\n[pool-1] two orchestrators tailed independently (no cross-talk)");
pool.pin(A);
pool.get(B);
await sleep(350);
{
  const da = pool.get(A).digest();
  const db = pool.get(B).digest();
  check("A digest is A", da.lastAssistantMessage?.text?.includes("phase=A") && da.threadId === A, JSON.stringify(da.lastAssistantMessage));
  check("B digest is B", db.lastAssistantMessage?.text?.includes("phase=B") && db.threadId === B);
  check("list shows both", pool.list().length === 2);
  check("A is pinned", pool.list().find((e) => e.threadId === A)?.pinned === true);
}

console.log("\n[pool-2] appending to A does not affect B");
{
  fs.appendFileSync(pA, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "A moved on. STATUS: phase=A2" }] } }) + "\n");
  await sleep(300);
  check("A updated", pool.get(A).digest().lastAssistantMessage?.text?.includes("phase=A2"));
  check("B unchanged", pool.get(B).digest().lastAssistantMessage?.text?.includes("phase=B"));
}

console.log("\n[pool-3] LRU eviction keeps pinned default, drops idle");
{
  const C = "019f0000-0000-7000-0000-00000000000c";
  const D = "019f0000-0000-7000-0000-00000000000d";
  mkRollout(C, "codex exec", "C"); mkRollout(D, "codex exec", "D");
  pool.get(C); pool.get(D); // now 4 > maxTailers(3): LRU (B, oldest non-pinned) evicted
  await sleep(50);
  const ids = pool.list().map((e) => e.threadId);
  check("pinned A retained", ids.includes(A));
  check("pool capped at max", pool.list().length <= 3, `size=${pool.list().length}`);
}

console.log("\n[pool-4] idle eviction (pinned survives)");
{
  await sleep(700); // > idleEvictMs for non-pinned, non-accessed
  pool.evictIdle();
  const ids = pool.list().map((e) => e.threadId);
  check("pinned A survives idle sweep", ids.includes(A));
}

console.log("\n[pool-5] default pool keeps quiet tasks watched for callbacks");
{
  const E = "019f0000-0000-7000-0000-00000000000e";
  const pE = mkRollout(E, "codex exec", "E waiting");
  const callbacks = [];
  const durablePool = new TailerPool({ codexHome, pollMs: 150, maxTailers: 3, onCallback: (callback) => callbacks.push(callback) });
  durablePool.get(E);
  await sleep(300);
  durablePool.entries.get(E).lastAccess = 0;
  durablePool.evictIdle();
  check("quiet task remains watched without MCP access", durablePool.has(E));
  fs.appendFileSync(pE, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[[CALLBACK:PLAN_READY]] durable" }] } }) + "\n");
  await sleep(300);
  check("callback arrives after an arbitrarily old last access", callbacks.length === 1 && callbacks[0].threadId === E);
  durablePool.stopAll();
}

pool.stopAll();
console.log("");
if (failures === 0) { console.log("POOL TEST PASS"); process.exit(0); }
console.error(`POOL TEST FAIL (${failures})`); process.exit(1);
