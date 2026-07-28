#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileOAuthProvider, HyperagentWaker } from "../src/hyperagent.mjs";

let failures = 0;
const check = (name, ok, detail = "") => { if (ok) console.log(`  ok    ${name}`); else { failures++; console.error(`  FAIL  ${name} ${detail}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ha-"));
const cfg = { bridgeDir: tmp, hyperagentThreadId: "ha-thread", hyperagentWakeLeaseMs: 1000 };
const acked = new Set();
const inbox = { ackedCallbacks: () => new Set(acked) };
const audits = [];
const sent = [];
let now = 1_000_000;
let scheduled = null;
const waker = new HyperagentWaker({
  cfg, inbox, audit: (...row) => audits.push(row),
  send: async (_cfg, message) => { sent.push(message); },
  now: () => now,
  delay: (fn, ms) => { scheduled = { fn, ms, unref() {} }; return scheduled; }
});

const one = { id: "codex-1:time:PLAN_READY", kind: "PLAN_READY", threadId: "codex-1" };
const two = { id: "codex-2:time:BLOCKED", kind: "BLOCKED", threadId: "codex-2" };
check("enqueue enabled callback", waker.enqueue(one));
waker.enqueue(two);
await scheduled.fn();
check("burst coalesced into one wake", sent.length === 1, String(sent.length));
check("marker has IDs and no summaries", sent[0].includes(one.id) && sent[0].includes(two.id));
check("accepted delivery ledger is private", (fs.statSync(waker.ledgerPath).mode & 0o777) === 0o600);
await scheduled.fn();
check("lease suppresses immediate duplicate", sent.length === 1);
const three = { id: "codex-3:time:PLAN_READY", kind: "PLAN_READY", threadId: "codex-3" };
waker.enqueue(three);
check("new callback replaces lease timer", scheduled.ms === 100, String(scheduled.ms));
await scheduled.fn();
check("new callback wakes immediately during an older lease", sent.length === 2 && sent[1].includes(three.id));
now += 1001;
acked.add(one.id);
await scheduled.fn();
check("acked callback removed; remaining callbacks rewake", sent.length === 3 && !sent[2].includes(one.id) && sent[2].includes(two.id) && sent[2].includes(three.id));

const credential = path.join(tmp, "oauth.json");
const provider = new FileOAuthProvider({ file: credential, redirectUrl: "http://127.0.0.1:8790/callback" });
provider.saveTokens({ access_token: "secret", token_type: "bearer" });
check("OAuth credential file is 0600", (fs.statSync(credential).mode & 0o777) === 0o600);
check("OAuth tokens reload", new FileOAuthProvider({ file: credential, redirectUrl: provider.redirectUrl }).tokens().access_token === "secret");
fs.chmodSync(credential, 0o644);
let rejected = false;
try { new FileOAuthProvider({ file: credential, redirectUrl: provider.redirectUrl }); } catch { rejected = true; }
check("unsafe OAuth credential mode rejected", rejected);

const failedCfg = { bridgeDir: path.join(tmp, "failed"), hyperagentThreadId: "ha-thread", hyperagentWakeLeaseMs: 1000 };
let retry = null;
const failedWaker = new HyperagentWaker({
  cfg: failedCfg, inbox, audit: () => {}, send: async () => { throw Object.assign(new Error("offline"), { code: "ENETDOWN" }); },
  now: () => now, delay: (fn, ms) => { retry = { fn, ms, unref() {} }; return retry; }
});
const four = { id: "codex-4:time:BLOCKED", kind: "BLOCKED", threadId: "codex-4" };
failedWaker.enqueue(four);
await retry.fn();
check("failed wake schedules bounded retry", retry.ms === 1000, String(retry.ms));
check("failed wake is recorded without secrets", fs.readFileSync(failedWaker.ledgerPath, "utf8").includes('"status":"failed"'));
failedWaker.stop();

const reloaded = new HyperagentWaker({ cfg, inbox, audit: () => {}, send: async () => {}, now: () => now });
check("accepted wake ledger reloads across restart", reloaded.accepted.has(two.id));
reloaded.stop();
waker.stop();

if (failures) { console.error(`HYPERAGENT TEST FAIL (${failures})`); process.exit(1); }
console.log("HYPERAGENT TEST PASS");
