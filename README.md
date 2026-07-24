# codex-meta-bridge

Connects a remote meta-agent (Hyperagent) to a local Codex orchestrator so the
meta-agent can **watch**, **steer**, **launch**, and **recover** it — over
HTTPS, on a heartbeat, without ever double-writing a Codex session.

```
Hyperagent (meta agent, cloud)
   │  MCP tool calls over HTTPS (Streamable HTTP), on a heartbeat
   ▼
Tailscale Funnel  ──►  127.0.0.1:8787  bridge daemon (Node)
                                        │
             READ PLANE                 │        WRITE / CONTROL PLANE
   tails ~/.codex/sessions/**/          │   owned mode: daemon delivers steering
   rollout-*-<threadId>.jsonl           │   + start_mission via @openai/codex-sdk
   (append-only; never written)         │   inbox mode: Desktop liaison delivers
                                        ▼
                                 status digest + recovery tools
                                        ▲
   OS watchdog (scheduled task / systemd timer) ── restarts the daemon on
   crash OR hang, independently, every ~1 min
```

## Delivery modes

- **`owned` (CLI, default going forward):** the daemon owns the orchestrator via
  `@openai/codex-sdk`. It delivers steering within seconds and can `start_mission`.
  Use on Linux and CLI-based Windows. A safety guard refuses to run turns against
  a Codex Desktop-owned thread (dual-writer protection).
- **`inbox` (Codex Desktop):** the daemon queues steering tickets; a small Desktop
  liaison thread delivers them via `send_message_to_thread` on a heartbeat. Required
  when the orchestrator is a Desktop-owned thread. See `docs/liaison-heartbeat-prompt.md`.

Same rollout-tail read plane and `[HYPERAGENT-STEERING <ticket>]` confirmation in both.

## MCP tools

| Tool | Purpose |
|---|---|
| `bridge_health` | Liveness, mode, target, pending count, consumer error |
| `orchestrator_status` | Digest: last messages, tokens vs window, rate limits, subagents, idle |
| `read_transcript` | Recent parsed rollout events (`last_n`, `kinds`) |
| `send_steering` | Queue a steering message (owned: seconds; inbox: liaison heartbeat) |
| `list_steering` | Pending / delivering / delivered / failed + rollout confirmations |
| `set_target_thread` | Re-point the bridge at another thread |
| `start_mission` | **owned only** — launch a new bridge-owned orchestrator; it becomes the target |
| `get_diagnostics` | Machine + bridge diagnostics for recovery |
| `get_logs` | Tail audit / daemon / watchdog logs |
| `restart_bridge` | Forced clean restart (relauncher frees the port) |

## Self-recovery

Two tiers, so a dead daemon comes back on its own and the meta-agent has hands to
fix a degraded one. See `docs/recovery-runbook.md`.

- **OS watchdog** probes `/healthz` every minute and kill-restarts on crash or hang.
- **Recovery tools** (`get_diagnostics`, `get_logs`, `restart_bridge`) let Hyperagent
  diagnose and restart without a human, whenever the daemon is reachable.

## Quickstart

```bash
git clone https://github.com/keyclaw6/codex-meta-bridge.git
cd codex-meta-bridge
npm install
node test/unit-core.mjs && node test/unit-owned.mjs   # dep-free; must PASS
npm run selftest                                       # full MCP transport; must PASS

node setup/init.mjs --mode owned --target <threadId>   # or omit --target and use start_mission
# Windows:  powershell -ExecutionPolicy Bypass -File install-service.ps1
# Linux:    sh install-service.sh
curl http://127.0.0.1:8787/healthz
tailscale funnel --bg 8787                             # note the public https hostname
```

Register `https://<funnel-host>/mcp/<token>` as a custom MCP server in Hyperagent
(Settings → Integrations). The token lives only in `bridge.config.json` (gitignored).
Full scripted setup for a Codex agent: `docs/setup-agent-prompt.md`.

## Security

- Daemon binds `127.0.0.1`; only ingress is the Tailscale Funnel (public HTTPS + TLS).
- Auth: 256-bit token via capability URL (`/mcp/<token>`) or `Authorization: Bearer`,
  constant-time compared. Rotate: `node setup/init.mjs --rotate-token` then restart.
- No arbitrary shell is exposed — the recovery surface is a fixed allowlist of tools.
- Every tool call + delivery is appended to `bridge/logs/audit.jsonl`.
- The daemon never writes a rollout file; owned mode writes only via the Codex SDK
  against threads it owns, guarded against Desktop-owned targets.

## Tests

- `test/unit-core.mjs`, `test/unit-owned.mjs` — dependency-free (tailer, inbox,
  owned consumer with a mocked SDK, Desktop guard, diagnostics, config isolation).
- `test/selftest.mjs` — full stack over real Streamable HTTP MCP (needs `npm install`).
- `test/smoke.mjs` — client for a running bridge: `health|status|transcript|send|list|diag|logs|restart|mission|retarget`.
