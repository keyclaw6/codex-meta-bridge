import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

/**
 * Minimal MCP-spec OAuth 2.1 (authorization_code + PKCE) so clients like
 * Hyperagent's custom MCP registration can connect. The bridge's capability
 * token (in the URL path / resource) is the human gate: OAuth endpoints and
 * discovery are all scoped under /mcp/<token>/... and validate that token, so
 * nothing is exposed to anyone who doesn't already hold the URL. Authorization
 * is auto-approved (single-user, trusted machine) — no consent page needed.
 *
 * Pure Node (no MCP SDK dependency) so it is unit-testable in isolation.
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_S = 30 * 24 * 3600;

function b64urlSha256(v) { return crypto.createHash("sha256").update(v).digest("base64url"); }
function rnd(n = 32) { return crypto.randomBytes(n).toString("hex"); }
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b));
  });
}
function parseBody(raw, contentType = "") {
  if (!raw) return {};
  if (contentType.includes("application/json")) { try { return JSON.parse(raw); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

export class OAuthProvider {
  constructor({ cfg }) {
    this.cfg = cfg;
    this.codes = new Map();   // code -> {client_id, redirect_uri, code_challenge, exp}
    this.tokens = new Map();  // access_token -> {client_id, exp}
    this.tokenStore = path.join(cfg.bridgeDir, "state", "oauth-tokens.json");
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.tokenStore, "utf8"));
      const now = Date.now();
      for (const [t, meta] of Object.entries(raw)) if (meta.exp > now) this.tokens.set(t, meta);
    } catch { /* no store yet */ }
  }
  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.tokenStore), { recursive: true });
      fs.writeFileSync(this.tokenStore, JSON.stringify(Object.fromEntries(this.tokens), null, 2));
    } catch { /* best effort */ }
  }

  /** True if the bearer is a live OAuth access token. */
  validateBearer(token) {
    const t = this.tokens.get(token);
    if (!t) return false;
    if (Date.now() > t.exp) { this.tokens.delete(token); return false; }
    return true;
  }

  /** WWW-Authenticate value pointing at protected-resource metadata. */
  challenge(baseUrl) {
    return `Bearer resource_metadata="${baseUrl}/mcp/${this.cfg.token}/.well-known/oauth-protected-resource", error="invalid_token"`;
  }

  _tokenFromResourcePath(rest) {
    // rest like "mcp/<token>" (RFC 9728 path-insertion style)
    const p = rest.split("/").filter(Boolean);
    return p[0] === "mcp" ? p[1] : null;
  }

  /**
   * Handle an OAuth/discovery request. Returns true if handled (response sent).
   * Recognizes both discovery conventions:
   *   /mcp/<token>/.well-known/oauth-(protected-resource|authorization-server)
   *   /.well-known/oauth-(protected-resource|authorization-server)/mcp/<token>
   *   /mcp/<token>/oauth/(register|authorize|token)
   */
  async handle(req, res, baseUrl) {
    const url = new URL(req.url, baseUrl);
    const pathname = url.pathname;
    const tokenOk = (t) => t && t.length === this.cfg.token.length &&
      crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.cfg.token));

    // --- discovery: path-insertion style ---
    let m = pathname.match(/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server)\/(.+)$/);
    if (m) {
      const token = this._tokenFromResourcePath(m[2]);
      if (!tokenOk(token)) { sendJson(res, 404, { error: "not_found" }); return true; }
      return this._serveMetadata(res, baseUrl, token, m[1]);
    }
    // --- discovery: append style + oauth endpoints (under /mcp/<token>/) ---
    m = pathname.match(/^\/mcp\/([^/]+)\/(.+)$/);
    if (m) {
      const token = m[1], sub = m[2];
      if (sub === ".well-known/oauth-protected-resource" || sub === ".well-known/oauth-authorization-server") {
        if (!tokenOk(token)) { sendJson(res, 404, { error: "not_found" }); return true; }
        return this._serveMetadata(res, baseUrl, token, sub.split("/").pop());
      }
      if (sub === "oauth/register") { if (!tokenOk(token)) { sendJson(res, 404, { error: "not_found" }); return true; } return this._register(req, res); }
      if (sub === "oauth/authorize") { if (!tokenOk(token)) { sendJson(res, 404, { error: "not_found" }); return true; } return this._authorize(req, res, url); }
      if (sub === "oauth/token") { if (!tokenOk(token)) { sendJson(res, 404, { error: "not_found" }); return true; } return this._token(req, res); }
    }
    return false;
  }

  _serveMetadata(res, baseUrl, token, kind) {
    const issuer = `${baseUrl}/mcp/${token}`;
    if (kind === "oauth-protected-resource") {
      sendJson(res, 200, { resource: issuer, authorization_servers: [issuer], bearer_methods_supported: ["header"] });
    } else {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    return true;
  }

  async _register(req, res) {
    const body = parseBody(await readBody(req), req.headers["content-type"] || "");
    const client_id = "cmb_" + rnd(8);
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    sendJson(res, 201, {
      client_id,
      redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000)
    });
    return true;
  }

  _authorize(req, res, url) {
    const q = url.searchParams;
    const client_id = q.get("client_id") || "unknown";
    const redirect_uri = q.get("redirect_uri");
    const state = q.get("state");
    const code_challenge = q.get("code_challenge");
    const method = q.get("code_challenge_method") || "plain";
    if (!redirect_uri) { sendJson(res, 400, { error: "invalid_request", error_description: "redirect_uri required" }); return true; }
    if (!code_challenge || method !== "S256") { sendJson(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" }); return true; }
    const code = rnd(24);
    this.codes.set(code, { client_id, redirect_uri, code_challenge, exp: Date.now() + CODE_TTL_MS });
    const loc = new URL(redirect_uri);
    loc.searchParams.set("code", code);
    if (state != null) loc.searchParams.set("state", state);
    res.writeHead(302, { location: loc.toString(), "cache-control": "no-store" });
    res.end();
    return true;
  }

  async _token(req, res) {
    const body = parseBody(await readBody(req), req.headers["content-type"] || "");
    if (body.grant_type !== "authorization_code") { sendJson(res, 400, { error: "unsupported_grant_type" }); return true; }
    const rec = this.codes.get(body.code);
    if (!rec || rec.exp < Date.now()) { sendJson(res, 400, { error: "invalid_grant", error_description: "code invalid or expired" }); return true; }
    this.codes.delete(body.code); // one-time use
    if (rec.redirect_uri !== body.redirect_uri) { sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" }); return true; }
    if (!body.code_verifier || b64urlSha256(body.code_verifier) !== rec.code_challenge) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" }); return true;
    }
    const access_token = "cmbt_" + rnd(32);
    this.tokens.set(access_token, { client_id: rec.client_id, exp: Date.now() + TOKEN_TTL_S * 1000 });
    this._persist();
    sendJson(res, 200, { access_token, token_type: "Bearer", expires_in: TOKEN_TTL_S });
    return true;
  }
}
