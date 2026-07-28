#!/usr/bin/env node
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { FileOAuthProvider, authorizeHyperagent, hyperagentCredentialPath } from "../src/hyperagent.mjs";

const cfg = loadConfig();
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const port = Number(value("port") || 8790);
const requestedThread = value("thread") || cfg.hyperagentThreadId;
const redirectUrl = `http://127.0.0.1:${port}/callback`;
let callbackResolve;
let callbackReject;
const callback = new Promise((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });

const provider = new FileOAuthProvider({
  file: hyperagentCredentialPath(cfg),
  redirectUrl,
  onRedirect: (url) => console.log(`\nAuthorize Codex Meta Bridge in the logged-in Hyper Agent browser:\n${url}\n`)
});

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", redirectUrl);
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (error || !code || state !== provider.data.state) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Authorization failed. Return to the terminal.");
    callbackReject(new Error(error || "OAuth callback state/code validation failed."));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Authorization complete. You can close this tab.");
  callbackResolve(code);
});

await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
try {
  let result = await authorizeHyperagent(provider, cfg);
  if (result === "REDIRECT") result = await authorizeHyperagent(provider, cfg, await callback);
  if (result !== "AUTHORIZED") throw new Error(`Unexpected OAuth result: ${result}`);
  provider.resetState();

  const client = new Client({ name: "codex-meta-bridge-setup", version: "0.9.0" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.hyperagentMcpUrl), { authProvider: provider }));
    const tools = await client.listTools();
    const sendMessage = tools.tools.find((tool) => tool.name === "send_message");
    if (!sendMessage) throw new Error("Hyper Agent MCP does not expose send_message.");
    const properties = sendMessage.inputSchema?.properties || {};
    if (!properties.threadId || !properties.message) {
      throw new Error(`Unexpected send_message schema: ${JSON.stringify(sendMessage.inputSchema)}`);
    }
    console.log(`send_message schema: ${JSON.stringify(sendMessage.inputSchema)}`);
  } finally {
    await client.close().catch(() => {});
  }
  if (requestedThread) cfg.hyperagentThreadId = requestedThread;
  delete cfg.webhookUrl;
  saveConfig(cfg);
  console.log(`OAuth credentials saved privately at ${hyperagentCredentialPath(cfg)}`);
  console.log(`Supervisor task: ${cfg.hyperagentThreadId || "not configured; rerun with --thread <id>"}`);
} finally {
  server.close();
}
