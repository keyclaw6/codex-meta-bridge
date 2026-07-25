# One-window visible CLI mission

This Windows flow gives HyperAgent one bridge-owned Codex thread and one
intentional Windows Terminal surface. The terminal is a read-only live view of
that thread's rollout. It is not an interactive Codex TUI. The bridge daemon,
through the Codex SDK/native CLI process, is the only writer.

## Install or update

From this repository:

```powershell
npm install
npm test
npm run selftest
npm run test:live
node setup/init.mjs --mode owned
node setup/windows-persistence.mjs install
node setup/windows-persistence.mjs status
```

Do not use `npm install --ignore-scripts` on Windows. The repository pins
`@openai/codex-sdk` to `0.145.0` and its `postinstall` verifies that exact
runtime before adding the SDK native spawn's `windowsHide` flag. Installation
fails closed if the installed version or spawn source no longer matches, so an
SDK update requires an explicit patch review and test update.

`init` preserves existing configuration and credentials unless token rotation
is explicitly requested. On Windows, `install` creates exactly one per-user
persistence mechanism: the `CodexMetaBridgeWatchdog` `REG_SZ` value under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. It invokes
`wscript.exe //B //Nologo "<bridgeDir>\watchdog-supervisor-hidden.vbs"`. The VBS
starts one hidden resident Node loop and exits; a deterministic named pipe
prevents duplicate logical watchdogs. The loop checks immediately and then on a
non-overlapping 60-second cadence.

Forced recovery is fail closed: only one exact configured-loopback listener may
be terminated, and only after daemon receipt plus OS process evidence binds its
PID, Node executable, exact Windows creation file-time, candidate, repository,
port, and process instance. The complete same-port snapshot and sanitized JSON
`/healthz` identity must agree; an arbitrary or identity-free HTTP 200 is not
healthy. The watchdog revalidates that identity immediately before a hidden,
bounded tree kill. Every post-kill snapshot must show the root absent and zero
old or newly observed descendants. If the tree kill fails, an in-process root kill is allowed
only after a second child-free tree proof and final revalidation. Wildcard,
foreign, protected, reused, multiple, descendant-bearing, or otherwise
ambiguous processes are left untouched and no replacement daemon is spawned.

For an update, fetch the intended repository state, run the three checks above,
rerun `node setup/init.mjs --mode owned`, then rerun the idempotent persistence
`install` and `status` commands.
Refresh the custom MCP integration schema after the daemon has restarted.
Never paste the capability URL or OAuth material into logs or support messages.

To remove or recover the owned persistence transaction:

```powershell
node setup/windows-persistence.mjs uninstall
node setup/windows-persistence.mjs rollback
```

`uninstall` removes only an exact owned Run/VBS pair and stops only its exact
named-pipe owner. Before that loop acknowledges its instance-bound `STOP`, a
failure restores the prior state. After acknowledgment, launch, pipe, health,
or commit failure leaves the exact owned Run/VBS pair as sanitized
`cutover-failed` / `repairable-no-loop`; it is never `RUN` or `rollback-success`.
A later `install`, or the exact VBS at a later logon, may retry the current
candidate. Foreign contradictions remain `AMBIGUOUS` and untouched.
Configuration, state, history, callbacks, OAuth data, audit, and logs are
preserved.

## Start exactly one visible mission

Call `start_visible_cli_mission` with:

- a caller-stable, unique `request_key`;
- the initial `prompt`;
- optional `model`, `working_directory`, and `sandbox_mode`.

The call reserves the key before creating a thread, binds the SDK thread and
rollout, opens one named Windows Terminal viewer, verifies its nonce-bound
receipt and exact viewer PID, Terminal PID, HWND, title, and Windows session,
and then returns `thread_id`.

Idempotency is strict:

- same key and same normalized payload returns the existing binding;
- same key and different payload rejects;
- a different start key rejects while the visible binding is nonterminal;
- legacy `start_mission` uses the same coordinator and cannot bypass that lease.

Keep the returned `request_key` and `thread_id`. Use the `thread_id` explicitly
for all status, transcript, steering, and callback calls.

## Steering and callbacks

Call `send_steering` with `target_thread_id`. If the initial or another turn is
busy, the ticket waits in the same per-thread FIFO. Idle steering starts next.
The bridge never writes a Desktop-owned rollout through the SDK.

Use `list_steering` to observe `pending`, `delivering`, `delivered`, and
`failed`. A ticket left in `delivering` by a crash is reported as uncertain and
is never replayed automatically. Use `read_transcript` for the visible
conversation and `list_callbacks` / `ack_callback` for the reverse channel.

## Recovery

Use `bridge_health`, `orchestrator_status`, `get_diagnostics`, and `get_logs`
first. They run internal Windows probes with hidden/no-window process flags.
`bridge_health` reports the process-bound candidate identity and durable start
state.

After a daemon restart, every nonterminal binding first fails closed. A visible
binding becomes active again only when the previously recorded writer has
exited, the rollout is idle, and its thread/rollout, nonce receipt, viewer
process, exact Terminal PID, HWND, title, and Windows session reconcile. While
uncertain, both start tools and steering for that thread reject. The bridge
never relaunches a viewer, replays a turn, or guesses ownership.

If the viewer has died, the lease can become terminal only after a settle
interval proves the recorded writer and viewer are absent, the rollout is idle,
no turn is queued/in flight, and no uncertain delivery exists. Otherwise it
remains uncertain for manual diagnosis. `restart_bridge` and the watchdog keep
the same configuration and state files.

## Limits

- Only one bridge-owned visible binding is supported at a time.
- Windows Terminal is required; there is no PowerShell/cmd console fallback.
- The hidden watchdog requires a user logon. Sleep pauses its cadence. A forcibly
  terminated watchdog loop returns only at the next logon or after another
  idempotent persistence `install`; there is no second supervisor.
- If access to the exact HKCU Run value is denied, installation fails closed and
  requires user intervention.
- The visible surface is read-only and may outlive individual native CLI worker
  PIDs. It does not accept keyboard steering.
- This bridge exposes fixed MCP actions, not a general remote shell.
- Real visual correctness and absence of transient window flashes require a
  live continuous process/HWND witness; simulated daemon tests do not prove it.
- Actual Run-value execution at logon remains an ACCEPT residual unless a
  controlled sign-out/sign-in or equivalent logon trace is separately authorized.
