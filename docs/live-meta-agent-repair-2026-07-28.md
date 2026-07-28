# Live Meta-Agent Repair — 2026-07-28

## Result

The Linux bridge now has a proven outbound wake path to one retained Hyper
Agent supervisor task. It uses Hyper Agent OAuth and `send_message`; the wake
contains callback receipts, while the supervisor retrieves authoritative
bridge evidence and keeps the exact Codex task for steering. This repairs the
unattended-liveness failure documented in
`docs/live-meta-agent-evaluation-2026-07-27.md`.

The configured Hyper Agent task was `cms3pl8ce03qc07adbuwhevcd`. Authorization
was performed with:

```sh
npm run hyperagent:auth -- --thread cms3pl8ce03qc07adbuwhevcd
```

`setup/hyperagent-auth.mjs` performs the localhost OAuth callback, validates
the remote `send_message` schema, saves only private `0600` credentials, and
persists the supervisor task. `src/hyperagent.mjs` sends wakes to that retained
task, records accepted callback IDs in a private lease ledger, retries bounded
failures, suppresses immediate duplicates, and removes acknowledged callbacks
from its pending set. The supervisor contract in
`docs/hyperagent-supervisor-prompt.md` requires raw evidence, explicit task IDs,
rollout-confirmed steering, action before acknowledgement, and zero unresolved
required work at closure.

A final independent review found that the generic 30-minute tailer idle sweep
could stop watching a quiet restored task before it emitted a callback. Idle
eviction is now opt-in; the daemon keeps quiet tasks watched and relies on its
100-tailer LRU capacity bound. The regression appends a callback after forcing
an arbitrarily old last-access time and observes it without another bridge
request.

## Restart recovery proof

After the root system service restarted, the tailer rediscovered the earlier
unacknowledged callback
`019fa59a-445a-7751-9a43-23a80cb40a57:2026-07-27T22:03:34.947Z:CANDIDATE_READY`.
The daemon accepted its wake at `2026-07-28T08:09:27.929Z`; the retained Hyper
Agent supervisor handled it with response `LIVE_WAKE_HANDLED`, acknowledged it
at `2026-07-28T08:09:48.456Z`, and the final unacknowledged count for that
Codex task was zero. This demonstrates restart recovery from durable callback
and wake state, not only an in-process unit path.

## Fresh same-task unattended proof

- Hyper Agent task: `cms3pl8ce03qc07adbuwhevcd`.
- Codex task: `019fa7c6-5e0b-7d20-8968-41ff65a99593`.
- Callback: `019fa7c6-5e0b-7d20-8968-41ff65a99593:2026-07-28T08:10:34.683Z:STEER_REQUIRED`.
- The bridge accepted the unattended wake at `2026-07-28T08:10:36.882Z`.
- Hyper Agent fetched the callback and sent ticket
  `2026-07-28T08-10-56-427Z-e2755791` to that same Codex task.
- The retained rollout confirmed the tagged steering at
  `2026-07-28T08:10:58.518Z`.
- The same Codex task replied exactly
  `LIVE_STEER_CONFIRMED_20260728_0810`.
- Hyper Agent acknowledged the callback after the action at
  `2026-07-28T08:11:09.105Z`; the closure read found one acknowledged callback
  and no unresolved steering.

The durable sources agree: `bridge/state/hyperagent-wakes.jsonl` records the
accepted wake, `bridge/inbox/confirmations.jsonl` records rollout confirmation,
the delivered ticket targets the same Codex task, `bridge/logs/audit.jsonl`
records the ordered wake, steering, response, and acknowledgement, and the
retained rollout contains both the tagged steering and exact response. No
credential contents were read or recorded in this report.

## Verification and runtime state

On 2026-07-28, the current checkout passed all three package scripts:

- `npm test` — exit 0, including `HYPERAGENT TEST PASS`.
- `npm run selftest` — exit 0, `SELFTEST PASS (all checks green)`.
- `npm run test:live` — exit 0, `LIVE DAEMON TEST PASS`.

The system-level `codex-meta-bridge.service` was enabled and active as root on
`127.0.0.1:8788`; `/healthz` returned `ok: true`. The Codex app-server and its
native code-mode host were also running as root, while Electron remained under
the desktop user. Port `127.0.0.1:8787` remained owned by its pre-existing
Python process and was not stopped, rebound, or reconfigured.

The Browser environment repair is installed in
`/usr/local/libexec/codex-root-launcher`: root Codex selects the desktop UID's
socket directory while trusting the bundled Browser client. A fresh root
Browser process connected to the in-app browser, emitted the complete Browser
documentation, and interacted with the logged-in Hyper Agent task. The current
long-lived app-server predates the launcher change and was deliberately not
killed, so its built-in Browser tool will inherit the durable fix at the next
normal Codex Desktop restart. Electron remains non-root by design.

## Verdict

The repaired Linux path passes the targeted rerun: a callback can wake the
retained Hyper Agent task without a user turn, the supervisor can steer the
explicit originating Codex task, rollout confirmation and exact worker output
are visible, acknowledgement occurs only after action, and durable state
supports restart recovery and lease-based retry. The prior
independent-verification failure is also addressed in the supervisor protocol;
this run proves the wake/steer/ack path, not a new broad capability score.
