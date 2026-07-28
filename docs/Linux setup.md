# Linux VPS setup

This repository has one supported deployment: a headless bridge on this VPS,
owned by the system-level `codex-meta-bridge.service`.

## Initialize and install

```sh
cd /home/vpsdesktop/codex-meta-bridge
npm install
npm test
npm run selftest
npm run test:live
node setup/init.mjs --port 8788
sudo sh install-service.sh
```

The initializer preserves existing configuration and credentials. On a fresh
checkout it selects owned delivery and port 8788. The installer requires root
authority because it installs `/etc/systemd/system/codex-meta-bridge.service`.
It enables and starts only that unit. Port 8787 is unrelated and must remain
untouched.

Verify the local service:

```sh
systemctl is-enabled codex-meta-bridge
systemctl is-active codex-meta-bridge
systemctl show codex-meta-bridge -p User -p UMask -p Environment
curl http://127.0.0.1:8788/healthz
```

The service check must report `User=root`, `UMask=0077`, `HOME=/root`, and
`CODEX_HOME=/var/lib/codex-root`. Codex native tools stay root-owned. Electron
and the Browser backend stay under the desktop UID; the root Codex launcher
selects that backend's socket directory and trusts the bundled Browser client.
Do not run Electron as root.

```sh
/usr/local/libexec/codex-root-launcher mcp get node_repl --json
```

The effective node-repl environment must include root
`CODEX_HOME=/var/lib/codex-root`, socket directory
`/tmp/codex-browser-use-1002`, and the bundled Browser plugin trust path.

## Publish with Tailscale Funnel

```sh
tailscale funnel --bg 8788
tailscale funnel status
curl https://agent-ops.tail991b71.ts.net/healthz
```

Funnel should route the public host to `127.0.0.1:8788`. If Tailscale asks for
tailnet approval, complete that approval and rerun the commands. Do not change
the listener to a public interface; Funnel is the public transport.

## Register Hyper Agent

In Hyper Agent, open Settings > Integrations and add an MCP server whose URL is:

```text
https://agent-ops.tail991b71.ts.net/mcp/<token from bridge.config.json>
```

Do not print, paste into chat, or commit the token. After registration, ask
Hyper Agent to list the bridge tools. It should discover 14 tools, including
`bridge_health`, `start_mission`, `send_steering`, `orchestrator_status`, and
`read_transcript`.

## Authorize unattended wakes

Authorize the bridge to send callback receipts to the existing Hyper Agent
supervisor task:

```sh
cd /home/vpsdesktop/codex-meta-bridge
npm run hyperagent:auth -- --thread cms3pl8ce03qc07adbuwhevcd
```

Open the printed URL in the logged-in Hyper Agent browser on this VPS and wait
for `Authorization complete`. The command verifies the remote `send_message`
schema and stores OAuth material only in the private `0600` credential file
`bridge/state/hyperagent-oauth.json`. Do not display that file. Restart the
service so the daemon loads the configured supervisor task and credentials:

```sh
sudo systemctl restart codex-meta-bridge
systemctl is-active codex-meta-bridge
```

For every fresh, unacknowledged callback the daemon sends a receipt to that
same Hyper Agent task. Hyper Agent then reads the callback from the bridge,
uses its explicit Codex task ID for every read and steering call, waits for
`confirmed_in_rollout_at`, acts before `ack_callback`, and verifies that no
required callback or steering ticket remains unresolved. An accepted wake is
stored in `bridge/state/hyperagent-wakes.jsonl`; if the service restarts while
the callback is still unacknowledged, it is eligible for the same-task wake
again after the lease.

## End-to-end proof

1. Call `bridge_health`; require `ok: true` and `delivery_mode: owned`.
2. Call `start_mission` with a unique `request_key` and a prompt that asks for a
   short unique reply. Record the returned `thread_id`.
3. Repeat the same call with the same key and payload; require the same task and
   a reused result. Do not retry with altered input under the same key.
4. Call `send_steering` with a second unique message and the returned
   `target_thread_id`.
5. Poll `orchestrator_status` and use `read_transcript` for that exact task until
   both user messages and the assistant reply appear.
6. Use `list_steering` to confirm the steering ticket. Read and acknowledge any
   callback emitted by the task.

For an unattended wake proof, end the active Hyper Agent turn before the Codex
task emits a unique callback. Require all of the following without another user
message:

1. `bridge/logs/audit.jsonl` records `hyperagent_wake_accepted` for the exact
   callback ID.
2. The configured Hyper Agent task calls `list_callbacks`, then sends exactly
   one steering ticket to the callback's Codex task.
3. `list_steering` reports that ticket as delivered with a non-null
   `confirmed_in_rollout_at`, and `read_transcript` shows the expected reply in
   the same Codex task.
4. `ack_callback` occurs after the action, and a final `list_callbacks` reports
   it acknowledged with no required callback left unresolved.

Inspect only the non-secret receipts:

```sh
tail -n 20 bridge/state/hyperagent-wakes.jsonl
rg 'hyperagent_wake_accepted|send_steering|steering_confirmed|owned_delivered|ack_callback' bridge/logs/audit.jsonl | tail -n 30
```

This proves authenticated discovery, idempotent task creation, same-task
steering, the rollout read channel, unattended same-task wake delivery, and
action-before-ack closure without a second writer.
