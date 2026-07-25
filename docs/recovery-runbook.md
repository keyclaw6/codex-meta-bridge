# Recovery runbook

How the bridge stays up, and how Hyperagent (the meta agent) recovers it.

## Two-tier supervision

**Tier 1 — OS watchdog (recovers crashes AND hangs, even when the daemon is fully dead).**
- Windows: the exact `CodexMetaBridgeWatchdog` `REG_SZ` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` invokes
  `wscript.exe //B //Nologo "<bridgeDir>\watchdog-supervisor-hidden.vbs"` at
  user logon. The VBS starts one hidden resident Node watchdog loop with
   `Run(..., 0, False)` and exits. A deterministic Windows named pipe permits one
   logical loop, runs an immediate cycle, and then runs non-overlapping cycles at
   60-second cadence. Client disconnects and malformed control requests are
   contained per socket. `CHECK` coalesces, at most one `FORCE` queues behind an
   active cycle, and only an exact instance-bound `STOP` intentionally releases
   the loop. A transient delegation failure is revalidated against the kernel
   pipe; no contender runs recovery without first becoming its sole owner.
- Linux: `codex-meta-bridge.service` (`Restart=always`) recovers crashes; `codex-meta-bridge-health.timer` runs `setup/watchdog.mjs` every minute for hang detection (`install-service.sh`). `enable-linger` keeps it running without a login.

The watchdog probes `http://127.0.0.1:<port>/healthz`. If unhealthy, it starts a
fresh daemon directly only when the port has no listener. It replaces a wedged
listener only when exactly one configured loopback listener is bound by a
fresh daemon-start receipt and OS process evidence to the expected Node
executable, exact Windows creation file-time, candidate, repository, port, and
process instance. The complete same-port snapshot is authoritative; wildcard,
non-loopback, duplicate, contradictory, or unparsable rows cannot be filtered
away. The sanitized JSON `/healthz` identity must match the same receipt and OS
authority before a 200 response is healthy. Missing, stale-candidate, or foreign
identity is ambiguous and is neither killed nor replaced. Ownership is
revalidated at each kill boundary. Protected or PID-reused listeners also fail
closed. The primary termination is hidden,
bounded `taskkill /T`. If that fails, the watchdog may root-kill in process only
after an immediate second proof that the exact daemon has no descendants and a
final instance revalidation. Every post-kill proof requires the root absent and
zero descendants, including newly observed children; a native Codex child,
changing or unknown tree, remaining PID,
or failed kill prevents replacement spawn. This is independent of daemon
health, so it can recover a down or positively identified wedged daemon. Max
downtime is approximately the 60-second watchdog interval.

**Tier 2 — recovery MCP tools (Hyperagent's hands, when the daemon is up but degraded).**
- `bridge_health` — quick liveness + mode + target + pending count + consumer error.
- `get_diagnostics` — platform, node/codex versions, daemon pid/uptime/memory, port holders, target rollout state, disk, recent restarts.
- `get_logs` — tail of audit / daemon / watchdog logs.
- `interrupt_turn({thread_id, confirm:true})` — recovery-only cancellation of an in-flight bridge-owned SDK turn. It is unavailable for Desktop-owned sessions and requires explicit confirmation.
- `restart_bridge` — clean, forced restart (spawns a detached relauncher that frees the port and starts fresh).

## Decision tree (what Hyperagent does)

1. Tool call fails with **502 / connection refused** → the daemon or funnel is down.
   - Wait ~90 s for the OS watchdog, retry `bridge_health`.
   - Still down after ~3 min → the machine is off, asleep, logged out, the
     funnel is down, or the watchdog is not installed. On Windows, run
     `node setup/windows-persistence.mjs status`. `NONE` may be repaired with
     `install`; `AMBIGUOUS` requires human inspection and must not be overwritten.
     On Linux, use `systemctl --user restart codex-meta-bridge`.
2. `bridge_health` returns but `rollout_found:false` or `tailer_error` set → call `get_diagnostics`. Usually the target thread id is wrong or the session was never created. Fix with `set_target_thread` / `start_mission`.
3. `bridge_health` shows `consumer_error` (owned mode) → `get_logs` to see the SDK error. Common: codex auth expired, or target is Desktop-owned (guard). Escalate auth to human; fix target with `set_target_thread`.
4. Steering `delivered` but never `confirmed_in_rollout_at` → the message was sent but the target didn't record it, or you're tailing the wrong thread. Check `orchestrator_status` target vs the steered target.
5. `orchestrator_status` shows an `active_command` that is wedged → in owned mode use `interrupt_turn({thread_id,confirm:true})`, then confirm the turn returned with `orchestrator_status`. This is a recovery lever, not routine control.
6. Bridge behaving erratically after a config change → `restart_bridge({confirm:true})`, reconnect, `bridge_health`.
7. `bridge_health.start_bindings` reports `uncertain` → stop. Do not retry a
   start key, launch another mission, or resend steering. Read diagnostics and
   logs. The daemon will restore `active` only after the recorded writer exits,
   the rollout is idle, and matching nonce-receipt plus exact viewer PID,
   Terminal PID, HWND, title, and Windows-session evidence remains. It releases
   to `terminal` only after it proves both the recorded writer and viewer
   absent, the rollout idle, and all queues and uncertain deliveries empty.
8. `list_steering.delivering` reports `uncertain:true` → do not replay it. Its
   write outcome is unknown after restart; inspect the rollout for its ticket
   marker and resolve operationally before any later steering. Ownership is
   bound to a per-daemon-instance ID, not only a reusable numeric PID.

## What Hyperagent canNOT self-recover (escalate to human)
- Machine powered off. On Windows, user logoff stops the resident loop and a
  user logon is required to start it again; sleep pauses the 60-second cadence.
- A forcibly terminated Windows watchdog loop does not have a second
  supervisor. It returns at the next user logon or after an idempotent
  `node setup/windows-persistence.mjs install`.
- Denied access to the exact HKCU Run value. Installation stops without changing
  foreign or ambiguous artifacts and requires user intervention.
- Tailscale funnel down or hostname changed.
- Codex CLI auth expired (needs interactive login).
- Token rotation (breaks the registered integration until the new URL is registered).

## Windows persistence commands

Run these from the repository. They report sanitized state and never print a
capability token or URL.

```powershell
node setup/windows-persistence.mjs install
node setup/windows-persistence.mjs status
node setup/windows-persistence.mjs uninstall
node setup/windows-persistence.mjs rollback
```

- `install` is idempotent. It atomically verifies the VBS and Run value, launches
  the loop immediately, and succeeds only after matching pipe identity,
  candidate, port, and a completed immediate cycle prove state `RUN`. That
  cycle's STATUS result must belong to the current loop process instance and
  explicitly report identity-verified healthy success. Failed, partial, stale,
  mismatched, or ambiguous results never qualify as `RUN`.
- `status` reports `NONE`, `RUN`, or fail-closed `AMBIGUOUS`.
- `uninstall` stops only the positively identified owned loop and removes only
  the exact owned Run value and VBS. It preserves configuration, state, history,
  callbacks, OAuth data, audit, and logs.
- Before an exact old loop acknowledges its instance-bound `STOP`, a failed
  transaction restores the prior state. After that acknowledgment, a launch,
  pipe, health, or commit failure leaves the exact owned Run/VBS pair in
  sanitized `cutover-failed` / `repairable-no-loop`; it is never reported as
  `RUN` or `rollback-success`. A later `install`, or the exact VBS at a later
  logon, may retry the current candidate. Foreign contradictions remain
  `AMBIGUOUS` and untouched.

If Run/VBS/pipe type, value, marker, hash, identity, candidate, or port evidence
does not match exactly, stop. Do not edit the registry value or VBS by hand and
do not kill a process by PID alone.

## Other manual recovery commands

```
# Windows
node setup\windows-persistence.mjs status
node setup\windows-persistence.mjs install
curl.exe http://127.0.0.1:8787/healthz

# Linux
systemctl --user restart codex-meta-bridge
node setup/watchdog.mjs --force
curl http://127.0.0.1:8787/healthz
```

Actual execution of the Run value at logon is a live ACCEPT residual unless a
controlled sign-out/sign-in or equivalent logon trace is separately authorized.
Manual launch plus registry inspection does not by itself prove logon execution.

## Optional hardening (future)
- Have the daemon push a heartbeat/status line to a private GitHub gist every N min, so Hyperagent can read last-known state even when the funnel is down (turns a blind 502 into "died at 14:03, last mtime 14:01").
- Cloudflare Access service token in front of the funnel for a second auth factor.
