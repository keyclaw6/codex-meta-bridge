# codex-meta-bridge

Connects a remote meta-agent (Hyperagent) to a local Codex orchestrator session
so the meta-agent can **watch** the orchestrator and **steer** it — without ever
double-writing a Codex Desktop-owned thread.

```
Hyperagent (meta agent, cloud)
   │  MCP tool calls over HTTPS (Streamable HTTP), on a heartbeat
   ▼
Tailscale Funnel  ──►  127.0.0.1:8787  bridge daemon (this repo, Node)
                                        │
             READ PLANE                 │                WRITE PLANE
   tails ~/.codex/sessions/**/          │      writes bridge/inbox/pending/*.json
   rollout-*-<threadId>.jsonl           │                │
   (safe: file is append-only,          │                ▼
   we never write it)                   │      Codex Desktop "liaison" thread
                                        │      (heartbeat automation, every 10 min)
                                        │      delivers via send_message_to_thread
                                        ▼                │
                                   status digest         ▼
                                                 orchestrator thread (Desktop-owned)
```

**Why this shape:** Codex rollout files have no cross-process locking, so only
the process that owns a session may write to it. The Desktop app owns the
orchestrator → injection goes through Desktop's own supported surfaces (a
liaison thread + `send_message_to_thread`), and reading goes through the
append-only rollout file. Delivery is verified end-to-end: every steering
message carries a `[HYPERAGENT-STEERING <ticket>]` marker, and the daemon
confirms the ticket when the marker appears in the target rollout.

## MCP tools

| Tool | What it does |
|---|---|
| `bridge_health` | Daemon uptime, mode, target, rollout status, pending count |
| `orchestrator_status` | Digest: last user/assistant msgs, tokens vs context window, rate limits, subagents, idle time |
| `read_transcript` | Recent parsed rollout events (`last_n`, `kinds` filter) |
| `send_steering` | Queue a steering message (ticket-tracked; `priority`, optional `target_thread_id`, optional `delivery` override) |
| `list_steering` | Pending / delivered / failed tickets + rollout confirmations |
| `set_target_thread` | Re-point the bridge at another thread (new mission) |

## Delivery modes

- **`inbox` (default):** daemon writes a ticket file; a Desktop liaison thread
  pumps it via `send_message_to_thread` on a heartbeat. Safe for Desktop-owned
  threads. See `docs/liaison-heartbeat-prompt.md`.
- **`owned` (experimental):** daemon runs the turn itself via
  `@openai/codex-sdk` (`resumeThread` → `run`). ONLY for threads the bridge
  owns. Never point it at a thread Codex Desktop has loaded.

## Quickstart (Windows)

```powershell
git clone https://github.com/<owner>/codex-meta-bridge.git
cd codex-meta-bridge
npm install
npm run selftest                         # must print SELFTEST PASS
node setup/init.mjs --target <orchestratorThreadId>
start-bridge.cmd                         # or: npm start
curl.exe http://127.0.0.1:8787/healthz
schtasks /Create /SC ONLOGON /TN "CodexMetaBridge" /TR "\"<abs path>\start-bridge.cmd\"" /F
tailscale funnel --bg 8787               # note the public https hostname
```

Then register `https://<funnel-host>/mcp/<token>` as a custom MCP server in
Hyperagent (Settings → Integrations). The token is in `bridge.config.json`
(never committed). Full machine setup is scripted for a Codex agent in
`docs/setup-agent-prompt.md`.

## Security model

- Daemon binds to `127.0.0.1` only; the only ingress is Tailscale Funnel (TLS).
- Auth: 256-bit token via capability URL (`/mcp/<token>`) or `Authorization: Bearer`.
  Constant-time comparison; rotate with `node setup/init.mjs --rotate-token`.
- `bridge.config.json`, `bridge/` (inbox + logs), and `start-bridge.cmd` are gitignored.
- Every tool call and delivery is appended to `bridge/logs/audit.jsonl`.
- The daemon never writes to any rollout file, ever.

## Selftest

`npm run selftest` simulates a rollout in a temp dir and drives the full stack
(tailer → digest → MCP over Streamable HTTP → auth → inbox → delivery
confirmation → retarget). No Codex needed. `test/smoke.mjs` is a tiny client
for poking a *running* bridge locally or through the funnel.
