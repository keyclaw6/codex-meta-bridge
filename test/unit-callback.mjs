#!/usr/bin/env node
/**
 * Reverse channel: the tailer detects [[CALLBACK:KIND]] markers the orchestrator
 * writes, surfaces them in the digest, fires onCallback once per id per process,
 * and ack state persists via the inbox.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RolloutTailer } from "../src/tailer.mjs";
import { Inbox } from "../src/inbox.mjs";

let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ok    ${n}`); else { failures++; console.error(`  FAIL  ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cb-"));
const codexHome = path.join(tmp, ".codex");
const dir = path.join(codexHome, "sessions", "2026", "07", "24");
fs.mkdirSync(dir, { recursive: true });
const TID = "019f0000-0000-7000-0000-0000000000cb";
const rollout = path.join(dir, `rollout-2026-07-24T10-00-00-${TID}.jsonl`);
fs.writeFileSync(rollout, JSON.stringify({ timestamp: "2026-07-24T10:00:00.000Z", type: "session_meta", payload: { id: TID, originator: "codex exec" } }) + "\n");

const fired = [];
const tailer = new RolloutTailer({ codexHome, threadId: TID, pollMs: 150, onCallback: (cb) => fired.push(cb) });
tailer.start();
await sleep(250);

console.log("\n[cb-1] detect a callback the orchestrator emits");
{
  const t = "2026-07-24T10:01:00.000Z";
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: t, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Working.\n[[CALLBACK:PLAN_READY]] plan ready for approval" }] } }) + "\n");
  await sleep(350);
  const cbs = tailer.digest().callbacks;
  check("callback in digest", cbs.length === 1 && cbs[0].kind === "PLAN_READY", JSON.stringify(cbs));
  check("summary captured", cbs[0].summary.includes("approval"));
  check("onCallback fired once", fired.length === 1 && fired[0].kind === "PLAN_READY");
  check("deterministic id includes thread + ts + kind", fired[0].id === `${TID}:${t}:PLAN_READY`);
}

console.log("\n[cb-2] multiple kinds + no duplicate fire on re-read");
{
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: "2026-07-24T10:02:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[[CALLBACK:BLOCKED]] need provider credentials\n[[CALLBACK:MILESTONE_COMPLETE]] BUILD done" }] } }) + "\n");
  await sleep(350);
  const kinds = tailer.digest().callbacks.map((c) => c.kind).sort();
  check("all three kinds present", JSON.stringify(kinds) === JSON.stringify(["BLOCKED", "MILESTONE_COMPLETE", "PLAN_READY"]), kinds.join(","));
  check("fired once per callback (3 total)", fired.length === 3, String(fired.length));
}

console.log("\n[cb-3] ack persistence via inbox");
{
  const inbox = new Inbox(path.join(tmp, "bridge"));
  const first = tailer.digest().callbacks[0];
  check("not acked initially", !inbox.ackedCallbacks().has(first.id));
  inbox.markCallbackAcked(first.id);
  check("acked after mark", inbox.ackedCallbacks().has(first.id));
  const inbox2 = new Inbox(path.join(tmp, "bridge"));
  check("ack persists across inbox reload", inbox2.ackedCallbacks().has(first.id));
}

console.log("\n[cb-4] non-callback assistant text does not trigger");
{
  const before = fired.length;
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: "2026-07-24T10:03:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Just a normal status update, no markers here." }] } }) + "\n");
  await sleep(300);
  check("no spurious callbacks", fired.length === before);
}

tailer.stop();
console.log("");
if (failures === 0) { console.log("CALLBACK TEST PASS"); process.exit(0); }
console.error(`CALLBACK TEST FAIL (${failures})`); process.exit(1);
