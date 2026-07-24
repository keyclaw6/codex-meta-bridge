# Setup-agent prompt

Paste the block below into a NEW Codex Desktop thread on the target machine
(so it has both shell access and the `codex_app` tools). It installs, wires,
and end-to-end-tests the bridge, then prints a final report for the human.

---

```
You are setting up codex-meta-bridge on this Windows machine. It connects a
remote meta-agent ("Hyperagent") to local Codex sessions: a Node daemon tails
rollout files (read plane) and a liaison Desktop thread delivers steering
messages from an inbox (write plane). An environment recon has already been
done; trust the facts below and verify only what a phase tells you to verify.

KNOWN FACTS
- Windows 11, Node v24.14.0, Tailscale 1.98.4 installed, cloudflared absent.
- Codex npm CLI 0.144.6; Codex Desktop runs its own app-server (0.145.0-alpha.30).
- The live orchestrator is Desktop thread 019f9315-fc11-7c90-b7ae-304ca4d8f127
  (mission: ZynexGroup Memory Extraction v2.1), rollout under
  C:\Users\Kristian Bilstrup\.codex\sessions\2026\07\24\.
- Trusted project dir: C:\Users\Kristian Bilstrup\Documents\agent-ops
- gh CLI auth is broken. The repo below is public; clone anonymously over https.

HARD GUARDRAILS (non-negotiable)
- NEVER run codex exec / codex exec resume against thread
  019f9315-fc11-7c90-b7ae-304ca4d8f127 or any other Desktop-owned thread.
  Rollout files have no cross-process locking; Desktop is the only writer.
- Never write to, move, or edit anything under ~\.codex\sessions\.
- The bridge auth token (in bridge.config.json and the final URL) is a secret:
  it may appear ONLY in bridge.config.json and in your final report to the
  user. Never commit it, never put it in logs you write elsewhere.
- If a phase's acceptance check fails: attempt at most TWO minimal local fixes
  (log every file you touch and why in your report), then if still failing,
  STOP and report the blocker. Do not redesign the system.
- Work through ALL phases in order. Do not stop after an early phase; you are
  done only when you print the Phase 7 report (or hit a hard blocker).

PHASE 1 — clone, install, selftest
  cd "C:\Users\Kristian Bilstrup\Documents\agent-ops"
  git clone https://github.com/keyclaw6/codex-meta-bridge.git
  cd codex-meta-bridge
  npm install        (optionalDependencies failing is acceptable; note it)
  node test/unit-core.mjs       -> must print CORE TEST PASS
  npm run selftest              -> must print SELFTEST PASS
  ACCEPTANCE: both PASS lines printed. If selftest fails on an
  @modelcontextprotocol/sdk API mismatch, you may patch src/mcp.mjs or the
  tests minimally to match the installed SDK version — document every change.

PHASE 2 — configure + start + local smoke
  node setup/init.mjs --target 019f9315-fc11-7c90-b7ae-304ca4d8f127
  (If a NEWER rollout whose first user message contains "$orchestrate-mission"
  exists under ~\.codex\sessions\, use that thread id instead and say so.)
  Start the daemon:  Start-Process -WindowStyle Hidden .\start-bridge.cmd
  curl.exe http://127.0.0.1:8787/healthz          -> "ok codex-meta-bridge"
  Read the token from bridge.config.json, then:
  node test/smoke.mjs --token <TOKEN> health      -> JSON with ok:true
  node test/smoke.mjs --token <TOKEN> status      -> digest; rollout_found /
     rolloutFound must be true and lastAssistantMessage non-empty
  ACCEPTANCE: healthz ok + status digest shows the orchestrator session.

PHASE 3 — persistence (Task Scheduler)
  schtasks /Create /SC ONLOGON /TN "CodexMetaBridge" /TR "\"C:\Users\Kristian Bilstrup\Documents\agent-ops\codex-meta-bridge\start-bridge.cmd\"" /F
  schtasks /Query /TN "CodexMetaBridge"
  ACCEPTANCE: task exists. (The daemon tolerates double-start: second instance
  exits because the port is taken — that is fine.)

PHASE 4 — Tailscale Funnel
  tailscale funnel --bg 8787
  If the command prints an approval URL (funnel not yet enabled on the
  tailnet): STOP, show the URL to the user, ask them to approve it, and
  continue once they confirm.
  tailscale funnel status        -> note the public https hostname
  curl.exe https://<funnel-host>/healthz          -> "ok codex-meta-bridge"
  ACCEPTANCE: public healthz responds over the funnel URL.

PHASE 5 — liaison thread + heartbeat
  Read docs/liaison-heartbeat-prompt.md. Substitute {{BRIDGE_DIR}} with
  C:\Users\Kristian Bilstrup\Documents\agent-ops\codex-meta-bridge\bridge
  a) codex_app__list_projects -> find the project whose path ends in agent-ops.
  b) codex_app__create_thread with that projectId, environment local, model
     gpt-5.4-mini, prompt = the "Initial prompt" from the doc (substituted).
     Record the returned liaison threadId. Wait for "LIAISON READY"
     (codex_app__wait_threads or codex_app__read_thread).
  c) Create the heartbeat: codex_app__automation_update mode=create,
     kind=heartbeat, destination=thread, targetThreadId=<liaison threadId>,
     name="bridge-liaison-pump", rrule="FREQ=MINUTELY;INTERVAL=10",
     status=ACTIVE, prompt = the "Heartbeat automation prompt" from the doc.
     If cross-thread creation is rejected, use the fallback in the doc
     (ask the liaison thread to create its own heartbeat) and note which
     path worked.
  ACCEPTANCE: liaison replied LIAISON READY + automation exists (view it).

PHASE 6 — end-to-end steering test (do NOT touch the orchestrator)
  a) codex_app__create_thread (same project, model gpt-5.4-mini, prompt:
     "You are bridge-test-target. When you receive any message, reply with
     one short acknowledgement line quoting any [HYPERAGENT-STEERING ...]
     marker you see. Reply READY now.") Record testThreadId.
  b) node test/smoke.mjs --token <TOKEN> send "E2E bridge test: reply with the
     ticket marker." --target <testThreadId>
     -> note the ticket id; verify bridge\inbox\pending\<ticket>.json exists.
  c) Trigger the pump immediately (don't wait 10 min):
     codex_app__send_message_to_thread to the LIAISON: "Run your pump
     procedure now, exactly as defined in your first message."
  d) Verify: the pending file moved to delivered\; codex_app__read_thread on
     testThreadId shows the [HYPERAGENT-STEERING <ticket>] message arrived and
     was acknowledged.
  e) node test/smoke.mjs --token <TOKEN> list -> ticket shows status delivered.
     (confirmed_in_rollout_at stays null here — the daemon only tails the
     ORCHESTRATOR rollout, not the test thread. That is expected, not a bug.)
  ACCEPTANCE: d) and e) both hold.

PHASE 7 — final report (print all of this for the user)
  - Phase-by-phase checklist with the key evidence lines (PASS outputs, task
    query, funnel status line, liaison/test thread ids, automation id).
  - Any files you modified beyond the documented setup, and why.
  - The registration URL, printed once, clearly labeled:
      https://<funnel-host>/mcp/<TOKEN>
    with instruction: "Paste this into Hyperagent -> Settings -> Integrations
    -> Add custom MCP server (name it codex-bridge). Do not share it anywhere
    else. Rotate with: node setup/init.mjs --rotate-token"
  - Remind the user: after registering, reply in the Hyperagent thread with
    the funnel HOSTNAME ONLY (never the token) so Hyperagent can verify the
    connection end to end.
  - List anything left for the human (e.g. funnel approval done during
    Phase 4, gh auth still broken, meta thread retirement pending).
```
