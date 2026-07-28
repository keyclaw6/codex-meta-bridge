# codex-meta-bridge

`codex-meta-bridge` lets Hyper Agent supervise Codex tasks on this Linux VPS.
The bridge exposes a small authenticated MCP server, starts headless Codex
tasks, reads their rollout files, and delivers steering to the same task.

```text
Hyper Agent -> Tailscale Funnel -> 127.0.0.1:8788 -> bridge daemon -> Codex SDK
                                                        |
                                                        +-> rollout read plane
```

The daemon owns the Codex task writer in `owned` mode. Rollout files under
`/var/lib/codex-root/sessions` are read-only inputs to the bridge. One
root-owned systemd unit runs with `UMask=0077` and restarts the daemon after a
crash.

## Install on this VPS

Requirements: Node.js 20 or newer, an authenticated Codex CLI, and Tailscale
with Funnel enabled.

```sh
npm install
npm test
npm run selftest
npm run test:live
node setup/init.mjs --port 8788
sudo sh install-service.sh
curl http://127.0.0.1:8788/healthz
tailscale funnel --bg 8788
tailscale funnel status
```

Port 8787 belongs to another process on this VPS. Do not stop it or point this
service at it.

Initialization preserves an existing `bridge.config.json` and its token. It
also creates bridge state directories and refreshes the tracked service and
installer for this checkout. The installer places the one unit at
`/etc/systemd/system/codex-meta-bridge.service` and enables it for boot.

Register this MCP URL in Hyper Agent under Settings > Integrations:

```text
https://agent-ops.tail991b71.ts.net/mcp/<token from bridge.config.json>
```

Treat that URL as a secret. Never paste the token into logs, documentation, or
commits. The checked-in config is ignored. To rotate the token, run
`node setup/init.mjs --rotate-token`, restart the service, and update the Hyper
Agent integration.

Authorize the bridge to wake one existing Hyper Agent supervisor task:

```sh
npm run hyperagent:auth -- --thread cms3pl8ce03qc07adbuwhevcd
```

Open the printed authorization URL in the logged-in Hyper Agent browser on this
VPS. The command completes the localhost OAuth callback, verifies that Hyper
Agent exposes `send_message`, records the task ID in `bridge.config.json`, and
saves the OAuth credentials privately under `bridge/state/` with mode `0600`.
The exact file is `bridge/state/hyperagent-oauth.json`; never print or copy it.

After authorization, a new unacknowledged Codex callback wakes that same Hyper
Agent task without a user message or an open bridge request. The wake contains
only callback receipts. The supervisor must fetch the authoritative callback,
act on its explicit Codex task ID, require steering rollout confirmation, and
then acknowledge it. Accepted wakes are durably leased and replay after a
service restart while the callback remains unacknowledged.

## MCP tools

The headless bridge exposes 14 tools:

| Tool | Purpose |
| --- | --- |
| `bridge_health` | Check daemon, delivery, queue, and task state. |
| `orchestrator_status` | Read a compact task activity digest. |
| `read_transcript` | Read recent rollout events. |
| `get_event` | Expand one recent rollout event. |
| `send_steering` | Send a message to a specific Codex task. |
| `list_steering` | Inspect steering delivery state. |
| `list_callbacks` | Read Codex-to-meta callback markers. |
| `ack_callback` | Mark a callback handled. |
| `set_target_thread` | Set the shared default task. |
| `start_mission` | Idempotently start an owned Codex task. |
| `interrupt_turn` | Abort a stuck owned turn with confirmation. |
| `get_diagnostics` | Read machine and bridge diagnostics. |
| `get_logs` | Tail bridge logs. |
| `restart_bridge` | Request a confirmed daemon restart. |

Pass `thread_id` or `target_thread_id` on task-specific calls. The default
target is shared and is only a convenience for single-task use. Every
`start_mission` needs a caller-stable `request_key`: the same key and payload
reuse the existing task; a changed payload is rejected.

Codex can send Hyper Agent a callback by emitting a marker such as
`[[CALLBACK:PLAN_READY]]` or `[[CALLBACK:BLOCKED]]`. Hyper Agent reads these
with `list_callbacks` and acknowledges completed decisions with `ack_callback`.

## Operations

```sh
systemctl status codex-meta-bridge --no-pager
journalctl -u codex-meta-bridge -n 100 --no-pager
tail -n 100 bridge/logs/daemon.log
sudo systemctl restart codex-meta-bridge
curl http://127.0.0.1:8788/healthz
```

See [Linux setup](docs/Linux%20setup.md) for registration and end-to-end
verification, [live repair evidence](docs/live-meta-agent-repair-2026-07-28.md)
for the unattended wake proof, and [recovery runbook](docs/recovery-runbook.md)
for failures.
