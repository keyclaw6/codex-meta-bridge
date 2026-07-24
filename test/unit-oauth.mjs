#!/usr/bin/env node
/**
 * Dependency-free test of the MCP OAuth layer: runs a real authorization_code
 * + PKCE flow against src/oauth.mjs mounted on a plain http server, simulating
 * what Hyperagent's MCP client does. No MCP SDK needed.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { OAuthProvider } from "../src/oauth.mjs";

let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ok    ${n}`); else { failures++; console.error(`  FAIL  ${n} ${e}`); } };

const TOKEN = "a".repeat(64); // realistic 64-hex capability token
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-oauth-"));
const cfg = { token: TOKEN, bridgeDir: path.join(tmp, "bridge") };
const oauth = new OAuthProvider({ cfg });

const server = http.createServer(async (req, res) => {
  if (await oauth.handle(req, res, `http://127.0.0.1:${PORT}`)) return;
  // stand-in for the MCP endpoint: enforce bearer like mcp.mjs does
  if (req.url.startsWith(`/mcp/${TOKEN}`)) {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    if (bearer && oauth.validateBearer(bearer)) { res.writeHead(200); res.end("mcp-ok"); return; }
    res.writeHead(401, { "www-authenticate": oauth.challenge(`http://127.0.0.1:${PORT}`) }); res.end("no"); return;
  }
  res.writeHead(404); res.end("nf");
});
const PORT = 8934;
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PORT}`;
const ISSUER = `${BASE}/mcp/${TOKEN}`;

console.log("\n[oauth-1] discovery (both conventions, token-scoped)");
{
  const a = await (await fetch(`${ISSUER}/.well-known/oauth-protected-resource`)).json();
  check("protected-resource append style", a.authorization_servers?.[0] === ISSUER, JSON.stringify(a));
  const b = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp/${TOKEN}`)).json();
  check("protected-resource insertion style", b.resource === ISSUER);
  const as = await (await fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json();
  check("AS advertises endpoints", as.authorization_endpoint === `${ISSUER}/oauth/authorize` && as.token_endpoint === `${ISSUER}/oauth/token`);
  check("AS advertises S256 PKCE", as.code_challenge_methods_supported?.includes("S256"));
}

console.log("\n[oauth-2] wrong capability token is invisible");
{
  const bad = "b".repeat(64);
  const r1 = await fetch(`${BASE}/mcp/${bad}/.well-known/oauth-authorization-server`);
  check("wrong-token discovery 404s", r1.status === 404, `got ${r1.status}`);
  const r2 = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp/${bad}`);
  check("wrong-token insertion 404s", r2.status === 404);
}

console.log("\n[oauth-3] dynamic client registration");
let clientId;
{
  const r = await fetch(`${ISSUER}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://app.example/cb"], client_name: "hyperagent" }) });
  const j = await r.json();
  check("register returns client_id", r.status === 201 && typeof j.client_id === "string", JSON.stringify(j));
  check("public client (auth method none)", j.token_endpoint_auth_method === "none");
  clientId = j.client_id;
}

console.log("\n[oauth-4] authorize -> code, token -> bearer, bearer -> MCP 200");
let accessToken;
{
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirect = "https://app.example/cb";
  const authUrl = `${ISSUER}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(ISSUER)}`;
  const ar = await fetch(authUrl, { redirect: "manual" });
  check("authorize 302 redirect", ar.status === 302, `got ${ar.status}`);
  const loc = new URL(ar.headers.get("location"));
  const code = loc.searchParams.get("code");
  check("redirect carries code + state", !!code && loc.searchParams.get("state") === "xyz");

  const tr = await fetch(`${ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }) });
  const tj = await tr.json();
  check("token exchange returns Bearer", tr.status === 200 && tj.token_type === "Bearer" && typeof tj.access_token === "string", JSON.stringify(tj));
  accessToken = tj.access_token;

  const mcp = await fetch(`${ISSUER}`, { headers: { authorization: `Bearer ${accessToken}` } });
  check("MCP endpoint accepts OAuth bearer", mcp.status === 200 && (await mcp.text()) === "mcp-ok");
  const noAuth = await fetch(`${ISSUER}`);
  check("MCP without bearer 401 + WWW-Authenticate", noAuth.status === 401 && /resource_metadata=/.test(noAuth.headers.get("www-authenticate") || ""));
}

console.log("\n[oauth-5] PKCE + one-time-code enforcement");
{
  const redirect = "https://app.example/cb";
  const mkCode = async () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const ar = await fetch(`${ISSUER}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: "manual" });
    return { code: new URL(ar.headers.get("location")).searchParams.get("code"), verifier };
  };
  const post = (code, code_verifier) => fetch(`${ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier }) });

  // wrong verifier is rejected (and burns that code — anti-brute-force)
  const a = await mkCode();
  check("wrong PKCE verifier rejected", (await post(a.code, "wrong")).status === 400);
  check("code burned after failed attempt", (await post(a.code, a.verifier)).status === 400);

  // fresh code with correct verifier succeeds exactly once
  const b = await mkCode();
  check("correct verifier accepted", (await post(b.code, b.verifier)).status === 200);
  check("code replay rejected (one-time)", (await post(b.code, b.verifier)).status === 400);
}

console.log("\n[oauth-6] token persistence across provider reload");
{
  const oauth2 = new OAuthProvider({ cfg });
  check("persisted access token still valid after reload", oauth2.validateBearer(accessToken) === true);
  check("garbage token invalid", oauth2.validateBearer("cmbt_nope") === false);
}

server.close();
console.log("");
if (failures === 0) { console.log("OAUTH TEST PASS"); process.exit(0); }
console.error(`OAUTH TEST FAIL (${failures})`); process.exit(1);
