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
   tails ~/.codex/sessions/**/          │   owned mode: one durable coordinator
   rollout-*-<threadId>.jsonl           │   serializes SDK start + steering
   (append-only; never written)         │   inbox mode: Desktop liaison delivers
                                        ▼
                                 status digest + recovery tools
                                        ▲
   Per-user watchdog (Windows HKCU Run loop / systemd timer) ── restarts the
   daemon on crash OR hang, independently, every ~1 min
```

## Reverse channel (orchestrator → meta)

The orchestrator talks back to the meta agent by writing a marker anywhere in
its output:

```
[[CALLBACK:PLAN_READY]] acceptance matrix + architecture ready for approval
[[CALLBACK:BLOCKED]] need provider credentials
[[CALLBACK:CANDIDATE_READY]] completion candidate frozen at <sha>
```

The bridge detects these, surfaces them via `list_callbacks` (unacked by
default), counts them in `bridge_health`, and — if a webhook is configured —
POSTs a wake so the meta reacts immediately instead of waiting for the next
heartbeat. The meta `ack_callback`s once handled; acks persist across restarts.
This carries the callback kinds from the `meta-agent` / `orchestrate-mission`
doctrine (PLAN_READY, MILESTONE_COMPLETE, LONG_COMMAND_STARTED/FINISHED,
BLOCKED, CANDIDATE_READY).

## Multiple meta sessions (no interference)

One daemon supervises many orchestrators at once. Every tool is **thread-addressed**:
pass `thread_id` (or `target_thread_id` for `send_steering`) and each Hyperagent meta
session operates only on its own orchestrator. The daemon keeps an independent rollout
tail + digest per thread (a `TailerPool`, LRU-evicted, with the default target pinned),
so session A steering orchestrator X never affects session B on orchestrator Y.

- Each session should pass its orchestrator's `thread_id` on every call (a dedicated
  meta agent records its target in its own context).
- `set_target_thread` sets only a *shared default* used when `thread_id` is omitted —
  fine for a single session; multi-session should always pass `thread_id`.
- Both start tools require a caller-stable `request_key` and return the bound
  `thread_id` directly. Same key + same normalized payload reuses the result;
  same key + different payload rejects.

## Delivery modes

- **`owned` (CLI, default going forward):** the daemon owns the orchestrator via
  `@openai/codex-sdk`. It delivers steering within seconds and can start missions.
  Use on Linux and CLI-based Windows. A safety guard refuses to run turns against
  a Codex Desktop-owned thread (dual-writer protection). The initial turn and
  later busy/idle steering use one FIFO per thread.
- **`inbox` (Codex Desktop):** the daemon queues steering tickets; a small Desktop
  liaison thread delivers them via `send_message_to_thread` on a heartbeat. Required
  when the orchestrator is a Desktop-owned thread. See `docs/liaison-heartbeat-prompt.md`.

Same rollout-tail read plane and `[HYPERAGENT-STEERING <ticket>]` confirmation in both.

## MCP tools

| Tool | Purpose |
|---|---|
| `bridge_health` | Liveness, mode, candidate identity, start bindings, pending/delivering counts, consumer error |
| `orchestrator_status` | Digest: active command, best-effort child-process liveness, subagent threads, messages, tokens, idle |
| `read_transcript` | Recent parsed rollout events (`last_n`, `kinds`, optional `max_chars_per_event` up to 4000) |
| `get_event` | One full recent event by timestamp or id (up to 8000 chars) |
| `send_steering` | Queue a steering message (owned: seconds; inbox: liaison heartbeat) |
| `list_steering` | Pending / delivering / delivered / failed + rollout confirmations |
| `list_callbacks` | Orchestrator→meta callbacks (PLAN_READY, BLOCKED, CANDIDATE_READY…); unacked by default |
| `ack_callback` | Mark a callback handled (persists across restarts) |
| `set_target_thread` | Set the shared default target thread |
| `start_mission` | **owned only** — idempotently start a headless bridge-owned CLI thread; requires `request_key` |
| `start_visible_cli_mission` | **Windows + owned only** — idempotently start one SDK/native-CLI-owned thread and exactly one read-only Windows Terminal live view; requires `request_key` and returns its thread/viewer binding |
| `interrupt_turn` | **recovery only, owned only** — abort an in-flight SDK turn; requires `confirm: true` |
| `get_diagnostics` | Machine + bridge diagnostics for recovery |
| `get_logs` | Tail audit / daemon / watchdog logs |
| `restart_bridge` | Forced clean restart (relauncher frees the port) |

## Live rollout viewer

Watch any Codex session, including headless SDK sessions, in a readable terminal:

```bash
npm run viewer -- <thread-id>
```

The viewer follows the rollout live and prints user messages, assistant messages,
tool calls, and callbacks without changing or steering the session. It is a
read-only live view, not an interactive Codex TUI and not the writer process.
The bridge-owned SDK/native CLI session owns writes. See
[`docs/visible-cli-runbook.md`](docs/visible-cli-runbook.md) for the one-window
launch, steering, recovery, and update flow.

## Self-recovery

Two tiers, so a dead daemon comes back on its own and the meta-agent has hands to
fix a degraded one. See `docs/recovery-runbook.md`.

- **Windows watchdog:** the `CodexMetaBridgeWatchdog` `REG_SZ` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` launches
  `wscript.exe //B //Nologo "<bridgeDir>\watchdog-supervisor-hidden.vbs"` at
  user logon. The VBS starts one hidden resident Node loop and exits; a Windows
  named pipe admits exactly one logical watchdog. The loop checks immediately,
  then every 60 seconds without overlapping checks.
  Recovery first classifies the complete same-port listener snapshot. It will
  replace a listener only when that snapshot contains one configured-loopback
  endpoint and a fresh daemon-start receipt plus OS process evidence bind its
  PID, Node executable, exact Windows creation file-time, candidate, repository,
  port, and process instance. The public `/healthz` response contains only this
  sanitized identity; a missing or mismatched identity is not healthy.
  Ownership is revalidated immediately before termination. Wildcard, foreign,
  protected, reused, unparsable, or multiple listeners fail closed. If
  hidden bounded `taskkill /T` fails, an in-process root kill is permitted only
  after a second child-free tree proof and final identity revalidation; any
  descendant (including a native Codex writer), unknown tree, or failed absence
  proof blocks both the kill claim and replacement spawn.
- **Linux watchdog:** the systemd user service/timer provides the equivalent
  crash and hang recovery.
- **Recovery tools** (`interrupt_turn`, `get_diagnostics`, `get_logs`, `restart_bridge`) let Hyperagent
  diagnose and restart without a human, whenever the daemon is reachable.

## Quickstart

```bash
git clone https://github.com/keyclaw6/codex-meta-bridge.git
cd codex-meta-bridge
npm install
npm test                                             # deterministic suites; must PASS
npm run selftest                                       # full MCP transport; must PASS

node setup/init.mjs --mode owned --target <threadId>   # or omit --target and use start_mission
# Windows: install the exact per-user Run value + hidden resident watchdog:
#           node setup/windows-persistence.mjs install
#           node setup/windows-persistence.mjs status
# Linux:    sh install-service.sh
curl http://127.0.0.1:8787/healthz
tailscale funnel --bg 8787                             # note the public https hostname
```

Windows persistence management is idempotent and secret-free:

```powershell
node setup/windows-persistence.mjs install
node setup/windows-persistence.mjs status
node setup/windows-persistence.mjs uninstall
node setup/windows-persistence.mjs rollback
```

`install` and `status` require exact Run-value, VBS, named-pipe, candidate, port,
and a completed immediate cycle whose current-instance result explicitly reports
identity-verified healthy success. A failed, partial, stale, mismatched, or
ambiguous cycle result never qualifies as `RUN`. A foreign or changed Run value, VBS, or pipe is
reported as `AMBIGUOUS` and is never overwritten, stopped, or deleted.
`uninstall` removes only an exact owned Run/VBS pair and stops only its
positively identified loop. Before an exact old loop acknowledges its
instance-bound `STOP`, a failure restores the prior state. After that
acknowledgment, a launch, pipe, health, or commit failure keeps the exact owned
Run/VBS pair and reports sanitized `cutover-failed` / `repairable-no-loop`—never
`RUN` or `rollback-success`. A later `install`, or the exact VBS at a later logon,
may retry the current candidate. Foreign contradictions remain `AMBIGUOUS` and
untouched. None of these commands prints or stores the capability token or URL.

The Windows loop requires a user logon. Sleep pauses its cadence. If the
resident watchdog itself is forcibly terminated, recovery resumes at the next
logon or after another idempotent `install`; there is intentionally no second
supervisor. If HKCU registry access is denied, installation fails closed and
requires user intervention.
Actual execution of the Run value at logon remains an ACCEPT residual unless a
controlled sign-out/sign-in or equivalent logon trace is separately authorized.

On Windows, keep install scripts enabled. `postinstall` verifies the exact
pinned Codex SDK runtime and applies the reviewed hidden native-spawn flag; it
fails instead of silently accepting an unrecognized SDK version or source
shape.

Register `https://<funnel-host>/mcp/<token>` as a custom MCP server in Hyperagent
(Settings → Integrations). The token lives only in `bridge.config.json` (gitignored).
Full scripted setup for a Codex agent: `docs/setup-agent-prompt.md`.

## Auth

Two ways in, same 256-bit capability token as the gate:

- **OAuth 2.1 (for the Hyperagent Integrations UI).** The bridge implements the MCP
  auth spec — Protected Resource + Authorization Server metadata (append and
  path-insertion discovery), Dynamic Client Registration, authorization_code +
  PKCE (S256). All OAuth endpoints and discovery are scoped under `/mcp/<token>/…`
  and validate the token, so nothing is exposed to anyone without the URL.
  Authorization is auto-approved (single-user, trusted machine) — no consent page.
  Register by pasting `https://<funnel-host>/mcp/<token>` as a custom MCP server;
  DCR + auto-approve complete the flow with no extra input.
- **Capability URL / static bearer (for scripts + `curl`).** `/mcp/<token>` or
  `Authorization: Bearer <token>` also authorize directly.

## Security

- Daemon binds `127.0.0.1`; only ingress is the Tailscale Funnel (public HTTPS + TLS).
- Tokens (capability + issued OAuth bearers) constant-time compared; OAuth codes are
  one-time and PKCE-bound. Rotate the capability token: `node setup/init.mjs --rotate-token`
  then restart (issued OAuth tokens persist across restarts in `bridge/state/`).
- No arbitrary shell is exposed — the recovery surface is a fixed allowlist of tools.
- Every tool call + delivery is appended to `bridge/logs/audit.jsonl`.
- The daemon never writes a rollout file; owned mode writes only via the Codex SDK
  against threads it owns, guarded against Desktop-owned targets.

## Tests

- `npm test` — deterministic suites for the coordinator crash boundaries,
  concurrent/legacy start paths, restart/viewer-death reconciliation, stale
  delivering behavior, the owned consumer, hidden Windows process launchers,
  exact SDK spawn patch, viewer receipt/PID/HWND/session binding, OAuth,
  callbacks, diagnostics, and config isolation.
- `npm run selftest` — full stack over real Streamable HTTP MCP (needs `npm install`).
- `npm run test:live` — spawns the **real daemon process** and drives it over HTTP:
  live OAuth flow, MCP tools, owned-mode delivery (via `BRIDGE_CODEX_FAKE` sim),
  and the reverse channel. The true integration test.
- `test/smoke.mjs` — client for a running bridge: `health|status|transcript|send|list|diag|logs|restart|mission|visible|retarget`; start commands require `--request-key`.

**Simulation mode:** set `BRIDGE_CODEX_FAKE=<CODEX_HOME>` to make owned delivery
append to the target rollout instead of spawning a real Codex — smoke-test the
whole loop without spending a mission turn. Never set it in production.
