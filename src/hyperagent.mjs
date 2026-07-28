import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const HYPERAGENT_MCP_URL = "https://hyperagent.com/api/mcp";
export const HYPERAGENT_RESOURCE_METADATA_URL = "https://hyperagent.com/.well-known/oauth-protected-resource";
export const HYPERAGENT_SCOPES = "threads:read threads:write offline_access";

function atomicPrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export class FileOAuthProvider {
  constructor({ file, redirectUrl, onRedirect = null }) {
    this.file = file;
    this._redirectUrl = redirectUrl;
    this.onRedirect = onRedirect;
    this.data = this.read();
    const storedRedirect = this.data.redirectUrl;
    if (storedRedirect && storedRedirect !== String(redirectUrl) && (this.data.clientInformation || this.data.tokens)) {
      throw new Error(`OAuth redirect URL changed from ${storedRedirect}; reuse that URL or remove ${file} and authorize again.`);
    }
    this.data.redirectUrl = String(redirectUrl);
  }

  read() {
    if (!fs.existsSync(this.file)) return {};
    const stat = fs.statSync(this.file);
    if ((stat.mode & 0o077) !== 0) throw new Error(`OAuth credential file must have mode 0600: ${this.file}`);
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }

  save() { atomicPrivateJson(this.file, this.data); }
  get redirectUrl() { return this._redirectUrl; }
  get clientMetadata() {
    return {
      client_name: "Codex Meta Bridge",
      redirect_uris: [String(this._redirectUrl)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: HYPERAGENT_SCOPES
    };
  }
  clientInformation() { return this.data.clientInformation; }
  saveClientInformation(value) { this.data.clientInformation = value; this.save(); }
  tokens() { return this.data.tokens; }
  saveTokens(value) { this.data.tokens = value; this.save(); }
  saveCodeVerifier(value) { this.data.codeVerifier = value; this.save(); }
  codeVerifier() {
    if (!this.data.codeVerifier) throw new Error("OAuth code verifier is missing; restart authorization.");
    return this.data.codeVerifier;
  }
  state() {
    if (!this.data.state) { this.data.state = crypto.randomBytes(24).toString("base64url"); this.save(); }
    return this.data.state;
  }
  resetState() { delete this.data.state; delete this.data.codeVerifier; this.save(); }
  redirectToAuthorization(url) {
    this.authorizationUrl = url;
    this.onRedirect?.(url);
  }
  invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") delete this.data.tokens;
    if (scope === "all" || scope === "client") delete this.data.clientInformation;
    if (scope === "all" || scope === "verifier") delete this.data.codeVerifier;
    this.save();
  }
}

export function hyperagentCredentialPath(cfg) {
  return cfg.hyperagentCredentialsPath || path.join(cfg.bridgeDir, "state", "hyperagent-oauth.json");
}

export async function authorizeHyperagent(provider, cfg, authorizationCode) {
  return auth(provider, {
    serverUrl: new URL(cfg.hyperagentMcpUrl || HYPERAGENT_MCP_URL),
    resourceMetadataUrl: new URL(HYPERAGENT_RESOURCE_METADATA_URL),
    scope: HYPERAGENT_SCOPES,
    ...(authorizationCode ? { authorizationCode } : {})
  });
}

export async function sendHyperagentMessage(cfg, message, { provider = null } = {}) {
  const oauth = provider || new FileOAuthProvider({
    file: hyperagentCredentialPath(cfg),
    redirectUrl: "http://127.0.0.1:8790/callback"
  });
  if (!oauth.tokens()?.access_token) {
    throw Object.assign(new Error("Hyper Agent OAuth authorization is required."), { code: "EAUTH" });
  }

  const client = new Client({ name: "codex-meta-bridge", version: "0.9.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.hyperagentMcpUrl || HYPERAGENT_MCP_URL), { authProvider: oauth });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "send_message",
      arguments: { threadId: cfg.hyperagentThreadId, message }
    });
    if (result.isError) throw Object.assign(new Error("Hyper Agent send_message returned an error."), { code: "ETOOL" });
    return result;
  } finally {
    await client.close().catch(() => {});
  }
}

function safeError(error) {
  return { code: error?.code || null, message: String(error?.message || error).slice(0, 300) };
}

export class HyperagentWaker {
  constructor({ cfg, inbox, audit, send = sendHyperagentMessage, now = Date.now, delay = setTimeout }) {
    this.cfg = cfg;
    this.inbox = inbox;
    this.audit = audit;
    this.send = send;
    this.now = now;
    this.delay = delay;
    this.pending = new Map();
    this.accepted = this.loadAccepted();
    this.timer = null;
    this.timerDueAt = 0;
    this.running = false;
    this.failures = 0;
  }

  get enabled() { return Boolean(this.cfg.hyperagentThreadId); }
  get ledgerPath() { return path.join(this.cfg.bridgeDir, "state", "hyperagent-wakes.jsonl"); }
  get leaseMs() { return Math.max(1000, Number(this.cfg.hyperagentWakeLeaseMs) || 5 * 60 * 1000); }

  loadAccepted() {
    const accepted = new Map();
    if (!fs.existsSync(this.ledgerPath)) return accepted;
    for (const line of fs.readFileSync(this.ledgerPath, "utf8").split("\n")) {
      try {
        const row = JSON.parse(line);
        if (row.status === "accepted" && row.callback_id) accepted.set(row.callback_id, Date.parse(row.at));
      } catch { /* skip */ }
    }
    return accepted;
  }

  append(row) {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    fs.appendFileSync(this.ledgerPath, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...row })}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(this.ledgerPath, 0o600);
  }

  enqueue(callback) {
    if (!this.enabled || this.inbox.ackedCallbacks().has(callback.id)) return false;
    this.pending.set(callback.id, callback);
    this.schedule(100);
    return true;
  }

  schedule(ms) {
    const dueAt = this.now() + ms;
    if (this.timer && this.timerDueAt <= dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = this.delay(() => {
      this.timer = null;
      this.timerDueAt = 0;
      return this.drain().catch(() => {});
    }, ms);
    this.timer.unref?.();
  }

  marker(callbacks) {
    const rows = callbacks.map((cb) => `${cb.id} | ${cb.kind} | Codex task ${cb.threadId}`);
    return `[[CODEX_BRIDGE_WAKE]]\nPending callback receipts:\n${rows.join("\n")}\n\nUse the Codex bridge to fetch authoritative unacknowledged callbacks for these explicit task IDs. Process oldest-first, inspect raw tool evidence when required, act before acknowledging, and finish only with no required callback or steering ticket unresolved. This wake message is not evidence.`;
  }

  async drain() {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      const acked = this.inbox.ackedCallbacks();
      for (const id of this.pending.keys()) if (acked.has(id)) this.pending.delete(id);
      const now = this.now();
      const due = [...this.pending.values()].filter((cb) => now - (this.accepted.get(cb.id) || 0) >= this.leaseMs);
      if (!due.length) {
        if (this.pending.size) this.schedule(this.leaseMs);
        return;
      }
      await this.send(this.cfg, this.marker(due));
      this.failures = 0;
      for (const cb of due) {
        this.accepted.set(cb.id, now);
        this.append({ status: "accepted", callback_id: cb.id, kind: cb.kind, thread_id: cb.threadId });
      }
      this.audit("hyperagent_wake_accepted", { count: due.length, callback_ids: due.map((cb) => cb.id) }, true);
      this.schedule(this.leaseMs);
    } catch (error) {
      this.failures++;
      const retryMs = Math.min(60_000, 1000 * (2 ** Math.min(this.failures - 1, 6)));
      this.append({ status: "failed", ...safeError(error), retry_ms: retryMs });
      this.audit("hyperagent_wake_failed", { ...safeError(error), retry_ms: retryMs }, false);
      this.schedule(retryMs);
    } finally {
      this.running = false;
    }
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.timerDueAt = 0; }
}
