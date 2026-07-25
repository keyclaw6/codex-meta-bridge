# HyperAgent Linux-First Codex CLI Bridge Mission

Date: 2026-07-25
Repository: `C:\Users\Kristian Bilstrup\Documents\agent-ops\codex-meta-bridge`
Remote: `https://github.com/keyclaw6/codex-meta-bridge.git`
Intake state: `main` at `66d050a7655443e2bb23c2e25dc1d6aea67a485b`, clean and tracking `origin/main`
Meta Agent callback task: `019f962a-804b-73b0-9a0a-9c34332903b1`

## Authoritative Mission Reset

This section supersedes every Windows-viewer, persistence, watchdog, freeze, and
acceptance requirement later in this file. The later record is retained only as
historical evidence and is not a current implementation or verification gate.

Make the already authenticated HyperAgent **Codex Meta** thread orchestrate one
SDK-owned Codex CLI session through the bridge's MCP endpoint. HyperAgent must
discover and call the bridge, idempotently start one session, send one follow-up,
and read a reply/status bound to the returned `thread_id`. The bridge launches no
viewer, terminal, shell window, or interactive Codex TUI. Linux is the target
runtime; Windows is only a local smoke environment.

Current phase: `RESET_PLAN` is awaiting Meta Agent approval. No implementation,
live config/service change, HyperAgent schema refresh, or authenticated live call
is authorized before approval.

### Reset acceptance

| ID | Required proof |
| --- | --- |
| L-01 Authenticated tool plane | The existing authenticated HyperAgent integration discovers and successfully calls `bridge_health`, `start_mission`, `send_steering`, `orchestrator_status`, and `read_transcript`. |
| L-02 One idempotent CLI session | One `start_mission` call with a unique request key starts one SDK/native-Codex-owned thread and returns its `thread_id`. Same key plus same normalized payload returns that binding with `reused:true`; same key plus a different payload rejects. No second thread or writer is created. |
| L-03 Same-session follow-up | `send_steering` targets the returned `thread_id`; the owned consumer delivers it through the per-thread FIFO after the initial turn, and its unique marker appears in that rollout. |
| L-04 Readable reply and status | `read_transcript` returns the initial prompt, follow-up, and a unique assistant reply from the same `thread_id`; `orchestrator_status` reports that same thread and rollout. Local proof reads the same rollout/output without opening another terminal. |
| L-05 Linux-first/no UI | A source-backed Linux run (prefer local WSL when available) exercises the core flow. Windows smoke may confirm the same headless path but is not persistence or UI acceptance. Neither run invokes `start_visible_cli_mission`, the rollout viewer, Windows Terminal, or any supervisor. |

### Minimal architecture

`HyperAgent -> authenticated MCP -> start_mission -> OwnedConsumer ->
StartCoordinator -> OpenAI Codex SDK/native Codex -> rollout`, then
`send_steering -> Inbox -> OwnedConsumer per-thread FIFO -> same SDK thread`;
`TailerPool` supplies `read_transcript` and `orchestrator_status` from that same
rollout. The returned `thread_id` is the end-to-end correlation key.

The existing headless path already contains the needed request-key/payload-hash
idempotency and initial-turn/FIFO publication boundary. Windows viewer and
supervisor modules are outside the flow. They remain untouched unless a
source-backed Linux run proves that an import or unconditional call blocks the
core path; only that blocking edge may then be platform-guarded or bypassed.

### Approved-plan candidate

1. Establish a read-only baseline and trace only the core symbols in
   `src/mcp.mjs`, `src/owned-consumer.mjs`, `src/owned.mjs`,
   `src/start-coordinator.mjs`, `src/inbox.mjs`, `src/tailer.mjs`, and
   `src/tailer-pool.mjs`.
2. Add or narrow one isolated end-to-end test that drives the five MCP tools in
   L-01 and asserts L-02 through L-04. Do not exercise the visible-start or
   recovery tools. First run it on the existing code; change production code
   only for a reproduced blocker.
3. Run the same core test under Linux/WSL with temporary config, state, port,
   Codex home, and fake or bounded authenticated SDK input. Prove no viewer or
   terminal launcher is called. Run the ordinary unit/selftest checks affected
   by any actual edit; the Windows recovery ladder is retired.
4. Freeze only the small core diff. Start or refresh the live bridge once only
   after approval, preserving config/token/history. Use the existing signed-in
   HyperAgent browser session to enumerate tools and perform one nonce-bound
   start/follow-up/read/status round trip.
5. Bind the HyperAgent calls, local rollout observations, and returned reply to
   one request key and `thread_id`; report exact limitations and leave the
   headless session available for further steering.

### Explicit non-goals

- Registry, Task Scheduler, Startup-folder, watchdog, 60-second recovery, named
  pipes, Windows service persistence, or UAC.
- Windows Terminal, HWND/process-window witnessing, rollout viewers, interactive
  Codex TUI, or any extra terminal window.
- Sign-in or credential changes, process-tree/kill hardening, a multi-platform
  service installer, general remote shell, arbitrary command execution, or
  unrelated cleanup.
- Removing dormant Windows machinery merely to reduce file count. Bypass or
  remove only a demonstrated blocker on the core Linux flow.

### Verification order and bounds

1. Core graph/source trace and isolated deterministic test: 10-20 minutes.
2. Linux/WSL source-backed core run plus affected regressions: 15-30 minutes.
3. Exact-state read-only review: 10-15 minutes.
4. Approved live bridge + authenticated HyperAgent round trip: 15-30 minutes.

Expected completion after approval: 50-95 minutes. Stop immediately on secret
exposure risk, ambiguous thread identity, a duplicate writer/thread, or any need
to broaden into the retired Windows/persistence scope.

---

# Superseded Windows Mission History

Everything below this marker is historical and non-normative after the mission
reset above.

## Safety and Scope

- Work only inside the nested repository named above, except for authorized
  local-service/one-Run watchdog, Tailscale funnel, authenticated
  HyperAgent integration, and temporary/ignored evidence operations required by
  acceptance.
- Preserve every file and Git state outside the nested repository. Never stage,
  modify, move, delete, clean, push, publish, merge, release, or open a pull
  request unless separately authorized.
- Preserve local configuration, state, tokens, callback history, OAuth data, and
  credentials. Never rotate or reveal secrets or secret URLs in output, logs,
  screenshots, tests, evidence, commits, or callbacks.
- Prefer reversible changes and the smallest design that meets current
  requirements. Do not add a general remote shell, arbitrary command execution,
  multi-visible-session UI, a cross-platform UI rewrite, billing changes, or
  unrelated cleanup.
- Existing local bridge/Tailscale/HyperAgent configuration may be inspected and
  refreshed only as needed for acceptance. Real external actions remain limited
  to this user's local bridge, Tailscale funnel, and authenticated HyperAgent
  integration.
- No implementation begins until the Meta Agent approves `PLAN_READY`.

## Intake Evidence

- The running bridge reports version `0.9.0`, PID `5528`, delivery mode `owned`,
  and healthy. A secret-safe direct local MCP `tools/list` call to that exact
  daemon returns all 15 source-registered tools, including
  `start_visible_cli_mission`.
- The authenticated HyperAgent integration discovers only 14 tools and can call
  `bridge_health`, but `start_visible_cli_mission` is absent. Because the daemon
  constructs its MCP server per request and returns 15 locally, the remaining
  AC-01 defect is stale HyperAgent integration/schema state.
- Previous handoff notes describe the readable rollout viewer as the only proven
  workaround; a vendored Codex black window was unreadable, a fresh TUI lacked a
  thread ID until prompted, and status probes flashed PowerShell windows.
- The codebase-memory graph was freshly rebuilt and now contains 517 nodes and
  1,053 edges, including `src/codex-cli.mjs`, viewer code, handoff documents,
  and relevant tests.
- The source and selftest expect 15 tools. The baseline `npm test` and
  `npm run selftest` pass, but `npm run test:live` exits 1 because its stale
  manifest assertion still expects exactly 14.
- No installed `CodexMetaBridge` scheduled task was found from this execution
  context. The running daemon therefore does not yet have proven watchdog
  recovery.
- This mission record is the sole requirements and acceptance authority for this
  repository mission. No second specification system will be introduced.

These are hypotheses/evidence inputs, not immutable architecture decisions.

## Acceptance Matrix

| Criterion | Required observable proof | Status |
| --- | --- | --- |
| AC-01 Discovery | Against the refreshed live integration, enumerate the documented `start_visible_cli_mission` tool and the existing health, status, read, steering, callback, and recovery tools; call the start tool and at least one representative tool in every other required group successfully. | Pending |
| AC-02 One visible CLI | From a controlled pre-launch process/window baseline, one HyperAgent start call creates exactly one intentional readable Windows Terminal surface and no separate unreadable Codex console or duplicate viewer/CLI window. The sole visible surface is accurately identified as a read-only live view of one CLI-owned thread—not an interactive Codex TUI or a promise of one permanent CLI PID. Evidence identifies the SDK/native CLI session and the process/session owning each write. | Pending |
| AC-03 Round trip | In one fresh mission, record a unique HyperAgent message appearing in the same visible local session and reaching the orchestrator, plus a unique orchestrator reply/callback readable by HyperAgent. Bind the start result, both unique messages, all four observations, and callback read to one `thread_id`. | Pending |
| AC-04 Single writer/session | Process/session, durable coordinator state, and tests show exactly one Codex writer for the rollout. Both bridge-owned start tools use one request-key/payload-hash coordinator; duplicate/conflicting/concurrent starts cannot create another writer or session; legacy `start_mission` cannot bypass an active visible binding; Desktop-owned sessions are never double-written; initial, busy, and idle turns share the documented safe queue. Crash-boundary uncertainty fails closed until reconciled. | Corrected BUILD proof green; independent/live proof pending |
| AC-05 No window noise | A continuous, timestamped process and HWND creation/destruction witness covers launch, health/status polling, steering, callback reads, bridge restart, and watchdog checks through settle intervals. PID ancestry, session, exact nonce title, and viewer receipt identify the one allowed terminal; no incidental PowerShell/cmd/conhost/OpenConsole/terminal surface may flash or remain. | Pending |
| AC-06 Regression/recovery | On the exact candidate, `npm test`, `npm run selftest`, `npm run test:live`, and focused coordinator/Windows launcher/process/viewer tests pass with real exit codes. Failure injection covers every durable transition, both start tools, daemon restart during an active turn, viewer death/release, watchdog recovery, callback/interrupt behavior, and stale `delivering` reconciliation without replay. Configuration and state survive recovery. | Corrected BUILD suites green; independent review and frozen-candidate rerun pending |
| AC-07 Live deployment | Freeze the candidate identity, refresh the actual local service from that exact state without secret rotation/exposure, refresh HyperAgent schema as needed, and rerun AC-01 through AC-05 against the live daemon. | Pending |
| AC-08 Operability | Concise authoritative docs cover install/update, one-window launch, thread-ID capture, steering/callback use, recovery, and exact limitations, without speculative abstractions or general remote execution. | BUILD docs complete; independent review pending |

No simulated live-daemon test counts as visual proof. AC-02, AC-03, AC-05, and
the live portion of AC-07 require real Windows process/window and authenticated
HyperAgent evidence.

## Proposed Minimal Architecture for PLAN Approval

The read-only scouts and intake reviewer independently selected the same smallest
design. It reuses the existing bridge, owned-mode SDK path, rollout/tailer,
viewer, callback store, watchdog, and MCP surface without adding a service,
transport, PTY, shell, or interactive input broker:

1. One authoritative start coordinator owns both `start_mission` and
   `start_visible_cli_mission`. Each requires an explicit request key and hashes a
   canonical normalized payload after defaults are applied. Same key/same hash
   reuses; same key/different hash rejects; a different key cannot start while
   the one visible binding is nonterminal. The legacy start path cannot bypass
   or compete with that binding.
2. `OwnedConsumer` starts one Codex SDK session and remains the logical writer
   owner. The SDK-spawned native `codex.exe exec --experimental-json` child is
   the physical writer for a turn. The SDK-provided `thread_id` is the only
   stable session identity.
3. The initial turn and every later steering turn share the existing per-thread
   serialization chain. Immediately after the SDK exposes the thread ID, the
   initial turn becomes the queue head before any later await or target
   publication. Coordinator-bound steering stays pending until durable
   activation. Busy steering is accepted FIFO behind the active turn; idle
   steering begins immediately. A headless binding that durably passed through
   `active` may accept normal later steering after its initial turn terminalizes;
   visible terminal, pre-active, conflicting, and uncertain bindings fail
   closed and are never retried silently.
4. After the real `thread_id` and rollout binding exist, the bridge launches
   exactly one nonce-titled Windows Terminal containing the existing read-only
   rollout viewer. The viewer has no input or steering path and emits a
   non-secret receipt binding its PID, launch ID, `thread_id`, and rollout.
5. Identical concurrent/repeated start requests share one reservation and return
   the same persisted binding with `reused:true`; a conflicting request is
   explicitly rejected. Restart never launches, steers, or replays an uncertain
   binding.
6. Remove the direct visible Codex/encoded-PowerShell path, prompt-substring
   rollout discovery, and normal-console fallback from this tool. Windows
   Terminal becomes mandatory for the visible flow.
7. Steering, callbacks, status, and recovery continue through the existing MCP
   paths using the returned `thread_id`. Preserve the Desktop-originator
   dual-writer guard.
8. Health/diagnostics expose a non-secret process-bound candidate fingerprint so
   the live daemon can be tied to the frozen Git/worktree state.
9. Every non-viewer child/helper launch uses hidden/no-window semantics. Windows
   persistence is one exact HKCU Run value whose `wscript.exe //B //Nologo`
   launcher starts the resident loop hidden; the shared named-pipe singleton is
   the `IgnoreNew`-equivalent authority. Continuous window-event evidence, not
   source flags alone, proves AC-05.

This still satisfies "Codex CLI orchestrator": the OpenAI Codex SDK invokes the
native Codex CLI in `exec --experimental-json` mode against the one returned
thread, while the sole visible terminal is a read-only live view of that
CLI-owned rollout. It is not an interactive Codex TUI, and native CLI turn PIDs
may change. AC-02 and AC-04 must bind the viewer, rollout, SDK/native writer, and
HyperAgent observations to the same thread before this claim can pass.

## Durable Start Coordinator State Machine

The coordinator record stores no prompt or secret. It stores the request key,
SHA-256 of a canonical payload (`start tool kind`, prompt, normalized working
directory, effective model/sandbox/approval settings, and visibility), binding
type, timestamps, state, non-secret identities/receipts, and terminal reason.
State changes use atomic durable writes.

Required states and crash boundaries:

1. `reserved`: persisted before any process/session side effect. Concurrent calls
   for the same key/hash join this reservation; key/hash conflicts reject. A
   daemon restart at this known-safe boundary transitions the abandoned record
   directly to `terminal` with an explicit pre-side-effect recovery reason.
2. `thread-starting`: persisted immediately before asking the SDK to create the
   native CLI thread.
3. `thread-bound`: persisted immediately after the SDK surfaces the real
   `thread_id` and the matching rollout is positively identified.
4. `viewer-starting`: visible starts only; persisted before spawning Windows
   Terminal, including the nonce title and receipt location/nonce.
5. `active`: persisted only after the viewer receipt plus live PID/HWND/title
   evidence binds that viewer to the exact thread/rollout. For legacy headless
   starts, the initial turn is active through the same coordinator/queue without
   a viewer.
6. `terminal`: a durable completed, failed, or safely released outcome with a
   reason and end time. Only terminal bindings release the start lease.
7. `uncertain`: explicit fail-closed state for a crash, missing after-side
   receipt, contradictory identity, abandoned in-flight write, or any condition
   where a duplicate side effect cannot be disproved.

The record is therefore persisted on both sides of native thread creation and
viewer creation. At daemon startup, every nonterminal record is reconciled
before control-plane writes are enabled:

- A `reserved` record is safely terminalized because it precedes all external
  side effects; a fresh request key may then start normally.
- Positive thread/rollout and viewer PID/HWND/receipt evidence restores `active`.
- `thread-starting` and every later ambiguous state move to or remain
  `uncertain`; missing or contradictory evidence never releases them.
- While `uncertain`, both start tools, steering for that thread, viewer launch,
  and replay are rejected with the binding/reason surfaced in health/status.
- Reconciliation is read-only except for durable state transitions. It may run
  on startup and on same-key/status inspection; it never creates a session,
  viewer, or turn.
- A dead viewer does not block forever: after a settle interval, the coordinator
  may safely release to `terminal` only when the expected viewer PID/HWND is
  absent, the exact rollout is idle/terminal, and no bridge-owned native writer
  or queued/in-flight turn exists. Ambiguity stays `uncertain`. A later launch
  requires a new request key.
- Existing and future files in `inbox/delivering` are reported as
  `delivering/uncertain` after restart and are never auto-replayed. Their target,
  ticket, and uncertainty are visible through `list_steering`; resolution is
  fail-closed.

Failure injection must stop immediately before and after every transition,
restart the daemon, and prove the reconciled state and absence of duplicate SDK
threads, viewers, steering runs, or ticket replay.

## Controlled Workflow

### PLAN

Target: 20 minutes. Maximum before reassessment: 40 minutes.

- Create this record before implementation.
- Reindex and inspect source-of-truth specs, architecture, launcher/session/viewer
  flows, tests, scripts, handoff evidence, and live configuration without
  revealing secrets.
- Use fresh read-only scouts to challenge current assumptions and identify the
  smallest viable architecture and proof harness.
- Map every criterion to implementation surfaces and observable evidence.
- Send only `PLAN_READY` to the verified callback task, then wait for approval.

### BUILD

Target: 90 minutes. Maximum before reassessment: 3 hours. Depends on PLAN
approval.

- Implement the coordinator state machine and failure-injection harness first,
  then route both start tools and `OwnedConsumer` through that one boundary.
- Implement the smallest correct SDK/session/viewer/tool-refresh/no-window
  changes, with one writer per file or external system surface.
- Add focused deterministic tests and concise operability documentation.
- Run structural, diff, secret, protected-path, and focused unit checks.
- Update this record with actual decisions and criterion evidence.
- Send `MILESTONE_COMPLETE` for BUILD before SIMULATE.

### SIMULATE

Target: 60 minutes. Maximum before reassessment: 2 hours. Depends on BUILD.

- Run focused integration and adversarial tests for every state transition,
  concurrent/conflicting starts through both tools, ownership, initial/busy/idle
  steering, restart during an active turn, viewer death/release, stale
  `delivering` reconciliation, callbacks, watchdog, and hidden process flags.
- Run `npm test`, `npm run selftest`, and `npm run test:live`.
- Gather deterministic process/session evidence without claiming visual proof.
- Obtain a fresh read-only `$review-elegance` review of the precise candidate
  state; adjudicate every finding and re-review material fixes.
- Send `MILESTONE_COMPLETE` for SIMULATE before FREEZE.

### FREEZE

Target: 30 minutes. Maximum before reassessment: 1 hour. Depends on successful
SIMULATE.

- Inspect the complete diff, secrets/protected paths, graph blast radius, and
  repository status.
- Record an exact commit/tree identity or a complete HEAD plus worktree
  fingerprint, test hashes, and reviewed state.
- Prohibit candidate edits after freeze. Any edit invalidates the freeze and
  requires re-verification and a new fingerprint.
- Send `MILESTONE_COMPLETE` for FREEZE before ACCEPT.

### ACCEPT

Target: 60 minutes. Maximum before reassessment: 2 hours. Depends on FREEZE.

- Refresh the local bridge/service and HyperAgent schema from the exact frozen
  candidate without rotating or exposing secrets.
- Run the once-only canonical live gate: AC-01 through AC-05, including real
  process/window evidence and a unique one-`thread_id` round trip.
- Verify restart/watchdog recovery and configuration preservation.
- Return `CANDIDATE_READY` with criterion-bound evidence. Final acceptance stays
  with the Meta Agent.

Soft total forecast: 4 hours. Hard overall reassessment: 8 hours.

## Critical Path and Dependencies

1. Current graph index and source/spec discovery.
2. Existing tool registration/deployment mismatch diagnosis.
3. Session/writer ownership and visible-surface control-flow trace.
4. Minimal design and proof-harness decision.
5. PLAN approval.
6. Durable coordinator/state-machine implementation, tests, and docs.
7. Deterministic regression/adversarial simulation.
8. Independent correctness/elegance review and disposition.
9. Candidate fingerprint freeze.
10. Exact-candidate service/schema refresh.
11. Once-only authenticated HyperAgent and Windows visual/process acceptance.

## Adversarial Failure Modes

- Deployed daemon or HyperAgent schema comes from a different source/version than
  the repository candidate.
- Start registration exists in source but is omitted by a stale integration
  schema or a running old service.
- A viewer is readable but is not bound to the real writer/thread, or UI input
  writes through a second path.
- A spawned CLI and viewer both own or steer the same rollout.
- Repeated or concurrent launch requests race and create duplicate missions,
  processes, terminals, or writers.
- The same request key is reused with a different normalized payload, or the two
  start tools bypass each other's reservation.
- Daemon failure between a side effect and its after-side durable receipt leaves
  a thread or viewer whose ownership cannot be proven.
- A dead viewer leaves a permanent lease, or an eager stale-release rule frees a
  binding while a native writer/turn is still alive.
- Restart replays an abandoned `delivering` ticket whose write outcome is
  uncertain.
- Steering a busy turn races with queued input, retries on uncertainty, or
  double-writes a Desktop-owned session.
- A fresh CLI has no stable `thread_id` before first prompt, causing callbacks or
  steering to bind to the wrong session.
- Hidden status/recovery/watchdog probes still cause transient PowerShell, cmd,
  conhost, or Windows Terminal flashes.
- Parent launchers hide themselves but grandchildren inherit a visible console.
- Restart loses mission bindings/configuration or watchdog starts a second bridge.
- Process-name counts mistake unrelated terminals for bridge-owned windows; proof
  must use PID ancestry, window handles/titles, session bindings, and timestamps.
- Logs, screenshots, callback payloads, command lines, or evidence accidentally
  expose capability tokens, OAuth data, credentials, or secret URLs.
- Simulated daemon tests pass while the real authenticated integration or visual
  Windows behavior fails.

## Verification Order

Run checks from cheapest to most expensive:

1. Repository-boundary, diff, formatting, structural, secret, and protected-path
   checks.
2. Durable state-machine invariants, transition failure injection, and focused
   unit regressions.
3. Focused Windows launcher/process/viewer and tool-schema tests.
4. Integration/adversarial simulations, then canonical npm suites.
5. Fresh independent `$review-elegance`; correct and re-review as required.
6. Exact candidate fingerprint and freeze.
7. Once-only live service/schema refresh and authenticated Windows/HyperAgent
   end-to-end acceptance.

Before any command expected to exceed 15 minutes, send
`LONG_COMMAND_STARTED` with the exact command, purpose, command-bound repository
identity, start time, PID/process, maximum runtime, timeout, combined-log path,
and exit-receipt path. Afterward send `LONG_COMMAND_FINISHED` with end time, real
exit code, output/receipt hashes, and unchanged command-bound identity.

## Independent Review Points

- PLAN: fresh read-only scouts separately inspect architecture/control flow and
  tests/operational evidence; the orchestrator reconciles their reports.
- SIMULATE: a fresh read-only `$review-elegance` verifier tests the exact
  implementation state against this record.
- After any correctness fix or material design change: a fresh verifier reviews
  the updated precise state.
- FREEZE: the orchestrator independently inspects diff, graph blast radius,
  secrets, protected paths, repository identity, and evidence.
- ACCEPT: live evidence is criterion-bound and reviewed by the Meta Agent; this
  orchestrator does not claim caller approval.

## Evidence Ledger

Record only redacted, reproducible evidence. Bulky transient output belongs in
temporary or ignored files and is referenced here by sanitized path/hash.

| Phase | State/fingerprint | Command or observation | Result | Criteria |
| --- | --- | --- | --- | --- |
| Intake | `66d050a7655443e2bb23c2e25dc1d6aea67a485b` | `git status --short --branch` | Clean `main...origin/main` | Scope gate |
| PLAN | `66d050a` + mission record | Fresh codebase-memory full index | 517 nodes / 1,053 edges; omitted CLI/viewer/tests now indexed | Discovery gate |
| PLAN | Running PID `5528` | Secret-safe local MCP `tools/list` | Exact 15-tool source manifest, including `start_visible_cli_mission` | AC-01 diagnosis |
| PLAN | Authenticated HyperAgent integration | Remote diagnostic `tools/list` | 14 tools; start tool absent while health succeeds | AC-01 gap |
| PLAN | Intake tree `7ab1b090e3d295ddcf9b8de1169b29403497e618` | `npm test`; `npm run selftest`; `npm run test:live` | Exit 0; exit 0; exit 1 at stale 14-tool assertion | AC-06 baseline |
| PLAN | Local service | Health/listener/task inspection | Healthy PID 5528 on 8787; no queryable `CodexMetaBridge` task | AC-07 gap |
| PLAN | Exact intake state | Fresh read-only `$review-elegance` | `FIX`; six criterion-bound findings recorded in PLAN synthesis | Review gate |
| BUILD | HEAD `66d050a` + recorded worktree | `npm test` | Exit 0; coordinator 35 checks, start-flow 31 checks, owned/CLI/process/viewer/Windows-service/OAuth/callback suites pass | AC-04, AC-05 support, AC-06 |
| BUILD | Same worktree | `npm run selftest` | Exit 0; exact 15-tool MCP schema and start handlers pass over real Streamable HTTP | AC-01 support, AC-06 |
| BUILD | Same worktree | `npm run test:live` | Exit 0; isolated real daemon, OAuth, exact 15 tools, owned steering/callbacks, candidate identity, and hidden watchdog restart pass | AC-01 support, AC-06 |
| BUILD | Same worktree | `node test/unit-start-coordinator.mjs`; `node test/unit-start-flow.mjs` | Exit 0 / exit 0; 35 coordinator and 31 flow checks cover every durable commit boundary, concurrent/legacy starts, the headless publication race, strict one-writer FIFO order, restart-from-`reserved`, active-turn restart, viewer release, and stale delivering fail-closed behavior | AC-04, AC-06 |
| BUILD | Same worktree | Fresh full codebase-memory index `codex-meta-bridge-build-final-20260725` | 673 nodes / 1,407 edges; inbound traces classify start/reconciliation as critical and confirm intended daemon/consumer paths | Blast-radius gate |
| BUILD | Same worktree | `git diff --check`; scoped status | Exit 0; only intended nested-repository files changed; no service/config/state/token file written | Scope/structure gate |
| BUILD correction | HEAD `66d050a` + corrected worktree | Focused start-flow, owned, and coordinator checks | Exit 0; 31 / pass / 35 checks. Exact writer order is `initial:start -> initial:end -> steering:start -> steering:end`; restarted `reserved` terminalizes pre-side-effect and a fresh start succeeds | AC-04, AC-06 |
| BUILD correction | Same corrected worktree | First canonical `npm test` rerun | Exit 1 in owned persisted-options steering: the initial correction over-blocked a headless binding after safe `active -> terminal`; predicate and focused assertions were corrected before final verification | Regression disposition |
| BUILD correction | Same corrected worktree | `npm test`; `npm run selftest`; `npm run test:live` | Final exit 0 / 0 / 0 in 17.1 s / 9.3 s / 9.1 s; exact 15-tool schema and isolated daemon/watchdog recovery remain green; test port 8951 absent afterward | AC-01 support, AC-04, AC-06 |
| SIMULATE | Integrated 29-path worktree before final fingerprint | `git diff --check`; staged/outside/protected/secret/OpenSpec checks | Exit 0; counts `0 / 0 / 0 / 0 / 0`; all writes remain inside the named nested repository | Scope/structure gate |
| SIMULATE | Same integrated source | Focused SDK/coordinator/start-flow/owned/CLI/process/viewer/Windows-service/callback ladder | Exit 0 throughout; coordinator 37 checks and start-flow 38 checks cover every durable boundary, concurrent MCP and legacy ingress, initial/busy/idle FIFO, restart-from-reserved, later fail-closed restart, exact viewer identity mismatches, safe release, stale delivering/no replay, bounded interrupt, and ack persistence | AC-01 support, AC-04, AC-05 support, AC-06 |
| SIMULATE | Isolated SDK state and fake-daemon port/state only | Continuous Toolhelp32/`EnumWindows` descendant witness around real SDK native spawn and `npm run test:live` | Native SDK: exit 0, 16 samples, 8 observed processes including `codex.exe`, 0 top-level/visible HWNDs, 0 survivors. Isolated daemon/watchdog: exit 0, 16 samples, 13 observed descendants, 0 top-level/visible HWNDs, 0 survivors. Sampling is best-effort and does not replace ACCEPT's real viewer/HyperAgent witness. | AC-05 support, AC-06 |
| SIMULATE | Integrated source plus runbook updates | Initial canonical ladder, then focused correction | `npm test` exit 0 in 16.407 s; first `npm run selftest` exposed one fake-viewer fixture missing the newly required session ID and exited 1 in 8.338 s; the fixture-only correction passed `npm run selftest` in 8.526 s and `npm run test:live` in 7.167 s | Regression disposition, AC-01 support, AC-04, AC-06 |
| SIMULATE review | 29-path manifest `C1AA2755A4A7190837014C35A91E72DAC053ADDE5A62338D8C6BA0E94206341F` | Fresh read-only `$review-elegance`; focused and canonical suites plus graph/source tracing | `FIX`: numeric PID reuse could make a preexisting `delivering` ticket appear current and permit later steering | AC-04, AC-06 correction gate |
| SIMULATE correction | Corrected worktree before new fingerprint | Same-PID restart injection; focused start-flow/owned/core suites | Exit 0 / 0 / 0 in 0.660 s / 5.480 s / 3.184 s; a per-daemon-instance delivery owner ID now makes every preexisting delivery uncertain even when the OS reuses the same PID | AC-04, AC-06 |
| SIMULATE corrected review | 29-path, 2,546-byte manifest `FFC58AA58C749C48E5B8E27D4E9EC869A8A82399FFDF38EDE56F580117C4B64A` | Fresh exact-state `$review-elegance`; before/after fingerprint, graph/source trace, focused and canonical suites | `APPROVE`, findings none. Reviewer exits: start-flow 0, owned 0, `npm test` 0, selftest 0, test:live 0. Remaining evidence is explicitly ACCEPT-only. | SIMULATE gate |
| FREEZE pre-declaration | Accepted SIMULATE source before this ledger edit | Parent corrected canonical receipts | `npm test` exit 0 / 16.487 s / output SHA-256 `062B9BFA39D140535C060D4A86E80931D217D10C9FB3A5BB391FD90EFA3E7D87`; selftest exit 0 / 8.395 s / `C56A32AB4FADEAB85F9F295605053D4BA7AFE9C1B216F5D3BC74E20888B2D424`; test:live exit 0 / 7.573 s / `876E376E09D268F86F14211491B7EFD821BCD1C7B9361BEA20FCB82308BB245E` | AC-01 support, AC-04, AC-06 |
| FREEZE declaration | Exact repository bytes after this row at `2026-07-25T01:32:25.430Z` | Canonical manifest and runtime identity rule | Freeze the sorted unique tracked-diff plus untracked manifest. Candidate ID is `worktree-sha256:<lowercase manifest SHA-256>` supplied through `BRIDGE_CANDIDATE_ID`; the daemon trims and exposes that exact value unchanged. Final fingerprint and post-freeze receipts belong in the FREEZE callback because this file cannot contain its own final hash. | Freeze gate |
| FREEZE witness index | Supporting SIMULATE witness before the immutable point | Isolated real SDK and isolated daemon/watchdog process/HWND sampling | Native SDK: exit 0, 16 samples, 8 observed processes including `codex.exe`, zero top-level/visible HWNDs and survivors. Isolated daemon/watchdog output SHA-256 `FBB516F7BD3651ED651EED2DBDEB97CA9752A48245101CCAC4B1E14FE25278F9`, stderr SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`, 16 samples, 13 descendants, zero top-level/visible HWNDs and survivors. Polling cannot exclude a sub-sample flash and does not replace ACCEPT's real viewer witness. | AC-05 support |
| ACCEPT rejected input | HEAD `66d050a`, tree `7ab1b090e3d295ddcf9b8de1169b29403497e618`, 29-path/2,546-byte manifest `48989A2958087358FB0C234214ABE74B96D9FD135318FA93F0DE2CAB12CBE593`; mission `D299F5AB8FE87FB55426763BE860D6C9386F2BF3E2688FE80D3285D39140EF61` | Controlled live install preflight and bounded consent attempt | Restricted backup was created and preserved. Continuous 100 ms witness ran from `2026-07-25T02:01:44Z` through `02:10:14Z`; final JSONL SHA-256 `285973D95D4917309EA428EF10EF984DF6A712953E305D704FC12ACA899E620D`, 2,924 events, zero relevant visible windows and zero witness errors. Existing daemon PID 5528/config/source remained unchanged; HyperAgent and the visible mission were never launched. | Rejected ACCEPT evidence |
| ACCEPT blocker | Same rejected input | Terminating scheduled-task registration, direct task commands, and bounded elevated helper | Per-user registration failed with access denied (`0x80070005`); the UAC helper produced no task or receipt and exited. No persistence mechanism was installed, no daemon was restarted, and ACCEPT failed closed before visible launch. | AC-05, AC-07 blocker |
| RECOVERY PLAN v2 | Reopened BUILD input; old candidate ID rejected | Meta Agent-approved one-Run recovery contract | Windows persistence is exactly one `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run` `REG_SZ` value named `CodexMetaBridgeWatchdog`, invoking `wscript.exe //B //Nologo \"<bridgeDir>\\watchdog-supervisor-hidden.vbs\"`. The VBS starts one hidden resident Node watchdog loop and exits. One shared named-pipe authority serializes loop/default/CHECK/FORCE/STOP; a separate short installer singleton serializes registry/VBS transactions. Stable states are `NONE`, `RUN`, and fail-closed `AMBIGUOUS`. No Task Scheduler, UAC, Startup-folder, or dual-selector machinery remains in scope. | Reopened BUILD_RECOVERY gate |
| BUILD_RECOVERY | Integrated recovery source | `node test/unit-watchdog.mjs`; `node test/unit-windows-service.mjs`; `node test/unit-proc.mjs`; `node test/unit-viewer.mjs` | Final exits `0 / 0 / 0 / 0`. Persistence reports 120 checks covering exact Run/VBS ownership, concurrent install, foreign collisions, exact transaction rollback, instance-bound STOP, every injected post-STOP launch/pipe/health/final-inspection failure, repair, and sanitized output. Watchdog covers immediate/non-overlapping cadence, cycle-error survival, CHECK/FORCE coalescing, instance-bound STOP, and foreign/nonresponsive pipes. | AC-05 support, AC-06 recovery |
| BUILD_RECOVERY | Integrated recovery source | Final `npm test`; `npm run selftest`; `npm run test:live` | Exit `0 / 0 / 0` in 18.1 s / 9.4 s / 10.6 s. Unit tests include the 37-check coordinator, 38-check start flow, 120-check persistence suite, process fallback, viewer, SDK patch, OAuth, and callbacks. Selftest exposes the exact 15 tools. The isolated live daemon proves down recovery, duplicate-loop delegation, default CHECK delegation, FORCE delegation with a later daemon-start receipt, ack persistence, bounded STOP, and zero surviving test listener/pipe. | AC-01 support, AC-04, AC-05 support, AC-06 |
| BUILD_RECOVERY correction (rejected intermediate) | Isolated port/state only | Expanded `npm run test:live` forced-recovery probe | The expanded run showed hidden `taskkill /T` could fail for the detached isolated daemon. The first root-kill fallback used listener PID text as authority and did not preserve tree semantics; an independent scout injected system/foreign rows and rejected that state. Its prior suite and review receipts are stale and cannot support the BUILD gate. | Recovery safety blocker |
| BUILD_RECOVERY process-authority correction | Corrected isolated source/tests only | Receipt/process/tree injection and focused process/watchdog/persistence suites | Recovery now requires exactly one configured-loopback listener bound to the exact daemon candidate, repository, Node executable, OS start time, random process instance, host, and port. It revalidates immediately before termination. Wildcard, foreign, system, self, multiple, and PID-reused listeners fail closed. Hidden bounded `taskkill /T` remains primary; root-only fallback requires a second child-free tree proof plus final identity revalidation and post-kill absence. A descendant/native writer, uncertain tree, revalidation failure, or failed kill blocks replacement spawn. Final canonical exact-state reruns and fresh review follow this ledger update. | AC-04, AC-05 support, AC-06 recovery |
| BUILD_RECOVERY exact-state review (rejected) | 36-path, 3,169-byte manifest `7F70158B22B7597EDD8381AEEBA47B4CE0D35EEA846ADB246187D409C1F47F5C`; mission `3E8D3B1D8C7D72AFD5563AE2E36C5DC13499AF202799253D4D34593FEBF22F04` | Fresh read-only `$review-elegance`, exact before/after fingerprint, focused suites, and independent injected probes | `FIX`: host-filtered enumeration hid same-port wildcard rows; a Node PID reused 500 ms later passed the five-second start tolerance; and a new descendant outside the pre-kill tracked set could survive while termination reported success. A second scout found arbitrary same-port HTTP 200 responses bypassed ownership and were reported healthy. All prior fingerprints, suites, and review inputs are stale. | Recovery safety blocker |
| BUILD_RECOVERY complete-authority correction | Corrected isolated source/tests/docs only | Complete listener, exact OS file-time, health identity, and complete post-kill tree probes | Recovery now classifies every same-port LISTENING row before selecting authority; any wildcard/all-interface, non-loopback, duplicate, contradictory, or unparsable row makes the target ambiguous. The daemon records the OS-derived Windows creation file-time string and returns the same sanitized PID/candidate/repository/instance/host/port identity from `/healthz`; exact normalized equality is required at ownership and destructive revalidation boundaries. A missing, stale, or foreign 200 is ambiguous and untouched. Every taskkill/fallback absence proof requires root absent plus zero descendants, including newly observed children; changing or unknown trees block replacement. Final focused/canonical reruns and fresh exact-state review follow this row. | AC-04, AC-05 support, AC-06 recovery |
| BUILD_RECOVERY graph | `codex-meta-bridge-build-recovery-final-20260725` | Fresh full codebase-memory index and inbound risk traces | Final integrated index contains 881 nodes / 1,915 edges. Persistence, watchdog scheduler/control, and process recovery entry points are classified critical/high and remain limited to the installer/watchdog plus injected tests. | Blast-radius gate |
| BUILD_RECOVERY nonmutation | `2026-07-25T03:16:54.3594804Z` | Read-only isolated-survivor and intake-PID checks | Test port 8951 has zero listeners and no matching test watchdog/installer pipe remains. Intake PID 5528 still exists as `node`; a read-only check found no current listener on port 8787. No live control request, registry read/write, daemon restart, config/state/history read/write, HyperAgent/Tailscale action, or visible launch was performed; the missing listener is preserved as external live state for the next authorized gate rather than repaired in BUILD. | Scope/nonmutation gate |
| SIMULATE_RECOVERY finding | Approved 36-path manifest `F5F07E33EF8F5AADC05BEA44D4C4B9B975C54F36A1207D1BC59E0AAC542C8FA4` | Injected persistence transaction review | `FIX`: presence of any non-null immediate-cycle result could qualify an exact loop as `RUN`, including `{ok:false, healthy:false}`. All prior simulation receipts became stale. | AC-05, AC-06 recovery blocker |
| SIMULATE_RECOVERY correction | Corrected isolated source/tests before final evidence | Semantic loop STATUS and transaction injection | `RUN` now requires an idle completed result with `ok:true`, `healthy:true`, status 200, explicit exact-identity proof, and a result process instance equal to the current pipe owner. Failed, null, partial, stale, mismatched, or contradictory results fail closed. Fresh-install failure restores `NONE`; current/upgrade failure after committed STOP retains exact Run/VBS as `repairable-no-loop`, never `RUN` or rollback success. Persistence now passes 147 checks; final real-VBS/canonical/review evidence follows this row. | AC-05 support, AC-06 recovery |
| SIMULATE_RECOVERY concurrency finding | Rejected corrected intermediate manifest `8191893B5491068F8B1E1808E3B5EAEEB893436530DF9B69474465D52D92A293` | Isolated real VBS/HWND witness and concurrent `CHECK` + `FORCE` probe | `FIX`: a client timeout/disconnect during synchronous forced recovery could deliver `EPIPE`/`ECONNRESET` to an accepted socket with no error listener, terminate the resident loop, release the pipe, and let multiple one-shot contenders start overlapping daemon replacements. The 313,941.7 ms witness itself recorded zero visible HWNDs, but its control/recovery result is negative and cannot support acceptance. | AC-04, AC-05, AC-06 recovery blocker |
| SIMULATE_RECOVERY concurrency correction | Corrected isolated source/tests before final evidence | Scheduler, per-socket lifecycle, and kernel-authority retry injection | Every accepted socket now contains disconnect, timeout, malformed-input, and response-write failures; only an exact instance-bound `STOP` requests loop shutdown. `CHECK` coalesces behind active work; at most one pending `FORCE` is retained and it dominates pending checks without overlap. A contender that observes `EADDRINUSE` plus transient delegation failure boundedly retries the pipe acquisition/delegation sequence, never runs locally without first winning the kernel pipe, and fails closed on foreign or unresolved authority. Deterministic mixed-client stress proves one pipe owner, one cycle writer, and one queued forced cycle; final real-VBS/canonical/review evidence follows this row. | AC-04, AC-05 support, AC-06 recovery |

## Decisions and Deviations

- Approved and implemented for BUILD: SDK/`OwnedConsumer` is the only writer, and
  one read-only rollout viewer is the only visible terminal. Direct visible CLI,
  encoded-PowerShell launch, and console fallback are removed from the start
  path.
- One request-key/normalized-payload-hash coordinator governs both bridge-owned
  start tools. Same key/same payload reuses; same key/different payload rejects;
  conflicting starts and the legacy path cannot bypass the visible lease.
- The durable crash states are `reserved`, `thread-starting`, `thread-bound`,
  `viewer-starting`, `active`, `uncertain`, and `terminal`. All uncertainty
  blocks launch, steering, and replay until positive reconciliation or safe
  terminal release.
- The busy contract is FIFO queueing behind the current turn; idle steering
  starts immediately. Restart and uncertain delivery fail closed rather than
  double-writing.
- A claimed delivery persists both the diagnostic PID and a per-daemon-instance
  owner ID. Only the current instance ID is treated as live; every preexisting,
  missing, or nonmatching owner is uncertain and blocks later steering even if
  Windows has reused the same numeric PID.
- The corrected publication contract installs the initial SDK turn as the
  per-thread queue head immediately after thread-ID resolution and before any
  later await or target publication. A publication gate prevents queue cleanup
  and headless terminalization until durable `active`. All coordinator-bound
  pre-active states block steering. Normal later steering remains available
  only for a headless terminal binding whose durable history proves it reached
  `active`; visible terminal and all uncertain states remain blocked.
- Startup now treats `reserved` as the one known-safe crash boundary: it is
  terminalized with a pre-side-effect recovery reason. `thread-starting` and
  later ambiguous boundaries remain fail-closed as `uncertain`.
- HyperAgent's missing start tool is treated as stale authenticated integration
  schema because the same live daemon returns 15 tools locally. A daemon restart
  alone is not accepted as AC-01 proof.
- Continuous HWND/process event capture is required for AC-05; snapshots and
  `windowsHide` unit assertions are supporting evidence only.
- The PLAN baseline exposed six abandoned `delivering` tickets. BUILD must define
  deterministic fail-closed restart handling and make `list_steering` report the
  delivering state; BUILD now does so and never scans that directory for replay.
- Visible activation now persists the SDK thread/rollout and observed native
  writer identity, then requires a nonce-bound viewer receipt plus exact
  viewer PID, Terminal PID, HWND, title, and Windows-session evidence. Restart
  during an active writer turn stays uncertain; it can restore active only after
  the recorded writer exits and the rollout is idle while the same viewer
  evidence remains.
- The exact installed `@openai/codex-sdk@0.145.0` runtime omitted a Windows
  hidden-spawn option. The candidate pins that version and uses one idempotent,
  exact-source `postinstall` patch to add `windowsHide`; installation fails
  closed on a version or source-shape mismatch rather than generalizing into a
  dependency fork.
- The original scheduled-task ACCEPT input is rejected. Recovery BUILD v2 uses
  one Windows persistence mechanism only: the exact HKCU Run value
  `CodexMetaBridgeWatchdog` points to a generated
  `watchdog-supervisor-hidden.vbs` through `wscript.exe //B //Nologo`. The VBS
  starts one hidden resident Node loop with `Run(..., 0, False)` and exits.
- One deterministic named-pipe owner serializes the resident loop, default
  one-shot, `CHECK`, `FORCE`, and `STOP` paths. It runs an immediate cycle and
  non-overlapping 60-second cadence, survives cycle errors, and fails closed on
  foreign or nonresponsive holders. Per-client disconnects, timeouts, malformed
  messages, and response-write errors cannot close the server. `CHECK` coalesces;
  only one `FORCE` queues behind active work and dominates pending checks. A
  contender never runs a recovery cycle unless it first wins the kernel pipe
  after bounded owner revalidation; only instance-bound `STOP` intentionally
  releases a live loop. A separate short-lived kernel singleton
  serializes exact Run/VBS install, rollback, and uninstall transactions.
- Persistence ownership has only `NONE`, `RUN`, and `AMBIGUOUS`. `RUN` requires
  exact Run type/data, exact VBS marker/hash, one matching pipe identity,
  candidate and port, and a completed immediate cycle whose result belongs to
  the current loop instance and explicitly reports identity-verified healthy
  success. Failed, partial, stale, mismatched, or ambiguous results never
  qualify. Foreign Run/VBS/pipe
  evidence is never overwritten, stopped, or deleted.
- The instance-bound `STOP` acknowledgment is the candidate/port upgrade commit
  boundary. Every failure before `STOP` restores the prior exact state. After
  `STOP`, a current-loop launch, pipe, health, or commit failure leaves the
  exact owned Run/VBS set as sanitized `cutover-failed` /
  `repairable-no-loop`; it is never reported as `RUN` or rollback success.
  Explicit reinstall or a later exact VBS/logon launch may retry the current
  candidate. Foreign or contradictory evidence remains `AMBIGUOUS` and
  untouched.
- Daemon restart authority is separate from watchdog pipe authority. A port
  number or listener PID is never sufficient. The complete same-port LISTENING
  snapshot must contain exactly one configured-loopback endpoint; wildcard,
  non-loopback, duplicate, contradictory, or unparsable rows make the whole
  target ambiguous. That listener must match a fresh daemon-start receipt and
  OS-observed Node path plus exact normalized Windows creation file-time for the
  exact candidate, repository, host, port, and random process instance.
- The public `/healthz` response contains only the same sanitized identity. A
  200 with missing, stale-candidate, or foreign identity is ambiguous, not
  healthy, and cannot authorize a kill. Identity is revalidated at every
  destructive boundary and after replacement before recovery reports success.
- Hidden bounded `taskkill /T` is the primary Windows termination. If it fails,
  root-only in-process termination is allowed solely when repeated process-tree
  evidence proves no descendants immediately before the kill and the exact
  instance revalidates. Every post-kill snapshot must prove the root absent and
  zero descendants, including children not present before the kill. Any native
  Codex child, unknown or changing tree,
  system/self/foreign/reused/multiple listener, failed kill, or remaining PID
  fails closed and prevents a replacement spawn.
- Task Scheduler, UAC, Startup-folder persistence, a dual-mode selector, PID or
  file locks, and a second supervisor are explicitly out of scope. A denied
  HKCU Run write/read/launch fails closed and requires user intervention.
- The daemon reads a non-secret frozen candidate identity once at startup and
  exposes it in health, diagnostics, and restart history for later FREEZE/ACCEPT
  binding.
- FREEZE computes that identity from the complete canonical worktree manifest,
  not HEAD or version alone: `worktree-sha256:<lowercase manifest SHA-256>`.
  Runtime precedence is the trimmed `BRIDGE_CANDIDATE_ID` environment value,
  then the isolated `state/candidate-id` file, then `null`.
- This mission record remains the single requirements/acceptance authority. No
  second specification layer will be added.
- BUILD and BUILD_RECOVERY made only nested-repository changes plus isolated
  temporary-daemon, pipe, port, and injected-adapter test operations. No live
  daemon/service restart, HKCU Run read/write, scheduled-task attempt,
  HyperAgent schema mutation, token rotation, config/state/history mutation,
  Tailscale change, or real visible launch occurred.

## Completion Contract

Completion requires every acceptance row to have criterion-bound observable
evidence, canonical commands with real exit codes, a precise independently
reviewed repository state, an exact freeze fingerprint, live deployment from
that same fingerprint, repository status, review dispositions, and residual
risk. `CANDIDATE_READY` is a completion candidate only; the Meta Agent retains
final acceptance.
