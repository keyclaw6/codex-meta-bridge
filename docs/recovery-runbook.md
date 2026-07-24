# Recovery runbook

How the bridge stays up, and how Hyperagent (the meta agent) recovers it.

## Two-tier supervision

**Tier 1 — OS watchdog (recovers crashes AND hangs, even when the daemon is fully dead).**
- Windows: one scheduled task `CodexMetaBridge` runs `setup/watchdog.mjs` at logon and every minute (`install-service.ps1`).
- Linux: `codex-meta-bridge.service` (`Restart=always`) recovers crashes; `codex-meta-bridge-health.timer` runs `setup/watchdog.mjs` every minute for hang detection (`install-service.sh`). `enable-linger` keeps it running without a login.

The watchdog probes `http://127.0.0.1:<port>/healthz`. If unhealthy, it frees the port (kills the wedged PID) and starts a fresh daemon, then confirms health. This is independent of the daemon, so it works when the daemon is gone. Max downtime ≈ the watchdog interval (1 min).

**Tier 2 — recovery MCP tools (Hyperagent's hands, when the daemon is up but degraded).**
- `bridge_health` — quick liveness + mode + target + pending count + consumer error.
- `get_diagnostics` — platform, node/codex versions, daemon pid/uptime/memory, port holders, target rollout state, disk, recent restarts.
- `get_logs` — tail of audit / daemon / watchdog logs.
- `interrupt_turn({thread_id, confirm:true})` — recovery-only cancellation of an in-flight bridge-owned SDK turn. It is unavailable for Desktop-owned sessions and requires explicit confirmation.
- `restart_bridge` — clean, forced restart (spawns a detached relauncher that frees the port and starts fresh).

## Decision tree (what Hyperagent does)

1. Tool call fails with **502 / connection refused** → the daemon or funnel is down.
   - Wait ~90 s for the OS watchdog, retry `bridge_health`.
   - Still down after ~3 min → the machine is off / asleep, the funnel is down, or the watchdog is not installed. Escalate to the human with: "bridge unreachable since <time>; please confirm the machine is on and run `Start-ScheduledTask CodexMetaBridge` (Win) / `systemctl --user restart codex-meta-bridge` (Linux)."
2. `bridge_health` returns but `rollout_found:false` or `tailer_error` set → call `get_diagnostics`. Usually the target thread id is wrong or the session was never created. Fix with `set_target_thread` / `start_mission`.
3. `bridge_health` shows `consumer_error` (owned mode) → `get_logs` to see the SDK error. Common: codex auth expired, or target is Desktop-owned (guard). Escalate auth to human; fix target with `set_target_thread`.
4. Steering `delivered` but never `confirmed_in_rollout_at` → the message was sent but the target didn't record it, or you're tailing the wrong thread. Check `orchestrator_status` target vs the steered target.
5. `orchestrator_status` shows an `active_command` that is wedged → in owned mode use `interrupt_turn({thread_id,confirm:true})`, then confirm the turn returned with `orchestrator_status`. This is a recovery lever, not routine control.
6. Bridge behaving erratically after a config change → `restart_bridge({confirm:true})`, reconnect, `bridge_health`.

## What Hyperagent canNOT self-recover (escalate to human)
- Machine powered off / asleep / logged out without linger.
- Tailscale funnel down or hostname changed.
- Codex CLI auth expired (needs interactive login).
- Token rotation (breaks the registered integration until the new URL is registered).

## Manual commands (for the human)
```
# Windows
Start-ScheduledTask -TaskName "CodexMetaBridge"
node setup\watchdog.mjs --force        # force kill+restart
curl.exe http://127.0.0.1:8787/healthz

# Linux
systemctl --user restart codex-meta-bridge
node setup/watchdog.mjs --force
curl http://127.0.0.1:8787/healthz
```

## Optional hardening (future)
- Have the daemon push a heartbeat/status line to a private GitHub gist every N min, so Hyperagent can read last-known state even when the funnel is down (turns a blind 502 into "died at 14:03, last mtime 14:01").
- Cloudflare Access service token in front of the funnel for a second auth factor.
