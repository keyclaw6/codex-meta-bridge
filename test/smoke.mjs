#!/usr/bin/env node
/**
 * Smoke client for a RUNNING bridge. Examples:
 *   node test/smoke.mjs --token <TOKEN> health
 *   node test/smoke.mjs --token <TOKEN> status
 *   node test/smoke.mjs --token <TOKEN> transcript
 *   node test/smoke.mjs --token <TOKEN> send "Test steering message" --target <threadId>
 *   node test/smoke.mjs --token <TOKEN> list
 *   node test/smoke.mjs --url https://<funnel-host> --token <TOKEN> health
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; }
  return dflt;
}
const url = opt("url", "http://127.0.0.1:8787");
const token = opt("token", "");
const target = opt("target", undefined);
const cmd = args[0] || "health";
const arg1 = args[1];

if (!token) { console.error("Missing --token"); process.exit(2); }

const client = new Client({ name: "bridge-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${url.replace(/\/$/, "")}/mcp/${token}`)));

async function call(name, a = {}) {
  const res = await client.callTool({ name, arguments: a });
  console.log(res.content?.[0]?.text ?? JSON.stringify(res));
}

switch (cmd) {
  case "health": await call("bridge_health"); break;
  case "status": await call("orchestrator_status"); break;
  case "transcript": await call("read_transcript", { last_n: arg1 ? Number(arg1) : 30 }); break;
  case "send": {
    if (!arg1) { console.error('Usage: send "message" [--target <threadId>]'); process.exit(2); }
    await call("send_steering", { message: arg1, ...(target ? { target_thread_id: target } : {}) });
    break;
  }
  case "list": await call("list_steering"); break;
  case "diag": await call("get_diagnostics"); break;
  case "logs": await call("get_logs", { lines: arg1 ? Number(arg1) : 60 }); break;
  case "restart": await call("restart_bridge", { confirm: true }); break;
  case "mission": {
    if (!arg1) { console.error('Usage: mission "prompt"'); process.exit(2); }
    await call("start_mission", { prompt: arg1 });
    break;
  }
  case "retarget": {
    if (!arg1) { console.error("Usage: retarget <threadId>"); process.exit(2); }
    await call("set_target_thread", { thread_id: arg1 });
    break;
  }
  default: console.error(`Unknown command: ${cmd}`); process.exit(2);
}
await client.close();
