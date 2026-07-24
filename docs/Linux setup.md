# Linux setup

Paste the block below into a **Codex CLI agent on the Linux machine** (start it
in a working directory; it has shell access). It installs the bridge from
scratch in **owned mode** (the daemon owns CLI orchestrators via the Codex SDK —
no Desktop, no liaison), proves it with a live end-to-end smoke test, installs a
self-healing systemd user service, exposes it via Tailscale Funnel, and prints
the registration URL for Hyperagent.

Prereqs on the box: Node ≥ 20, `git`, `codex` CLI logged in, `tailscale` up.

```
Set up codex-meta-bridge on this Linux machine, in order. Trust these notes;
verify only what a step checks. Do not print the auth token anywhere.

GUARDRAILS
- Never write under ~/.codex/sessions. The daemon only reads rollouts.
- The token lives only in bridge.config.json and the final registration URL.
- Service/tunnel steps may need your interaction; if a command needs sudo or a
  Tailscale approval you can't do headless, stop and tell the human the exact
  command.
- At most two minimal fixes per failing step, documented; else stop and report.
- Do every step; you're done at the STEP 8 report.

STEP 1 — clone + deps + tests
  git clone https://github.com/keyclaw6/codex-meta-bridge.git
  cd codex-meta-bridge
  npm install
  npm test                 -> CORE / POOL / OWNED / OAUTH / CALLBACK all PASS
  npm run selftest         -> SELFTEST PASS
  npm run test:live        -> LIVE DAEMON TEST PASS
  (test:live spawns the real daemon and exercises OAuth + owned delivery + the
  reverse channel with a simulated Codex — it proves the whole stack on Linux.)

STEP 2 — verify collaboration tools exist in a CLI session (mission harness gate)
  cd /tmp
  codex exec --skip-git-repo-check "List the names of every tool you have access to, grouped by namespace. Reply with the list only."
  Confirm a `collaboration` namespace (spawn_agent, wait_agent, send_message)
  appears. Return here to the repo dir afterward: cd -

STEP 3 — initialize in owned mode
  node setup/init.mjs --mode owned
  (no --target yet; the meta agent will start missions with start_mission, or
  you can set one later. This writes bridge.config.json + a systemd unit +
  install-service.sh.)

STEP 4 — install the self-healing service (systemd --user)
  sh install-service.sh
  systemctl --user status codex-meta-bridge --no-pager | head -5
  loginctl enable-linger "$USER"     (so it runs without an active login; may need sudo)
  curl -s http://127.0.0.1:8787/healthz     -> ok codex-meta-bridge 0.5.0

STEP 5 — prove self-healing
  PID=$(systemctl --user show -p MainPID --value codex-meta-bridge)
  kill -9 "$PID"
  sleep 6
  curl -s http://127.0.0.1:8787/healthz     -> ok (Restart=always brought it back)

STEP 6 — expose via Tailscale Funnel
  tailscale funnel --bg 8787
  tailscale funnel status                   (note the public https hostname)
  curl -s https://<funnel-host>/healthz     -> ok codex-meta-bridge 0.6.0
  (If Funnel needs enabling on the tailnet, it prints an approval URL — stop and
  ask the human to approve, then continue.)

STEP 7 — live owned-delivery smoke over the funnel (optional but recommended)
  Read the token from bridge.config.json (do not print it).
  node test/smoke.mjs --url https://<funnel-host> --token <TOKEN> health
  -> ok:true, delivery_mode owned
  (A full owned steering test needs a real orchestrator thread; start one from
  Hyperagent with start_mission once registered.)

STEP 8 — report
  - PASS lines from STEP 1; collaboration yes/no from STEP 2; healthz from 4/6;
    self-heal proof from STEP 5; funnel hostname from STEP 6.
  - The registration URL, labeled secret (build it locally, don't echo the token
    in prose):
      https://<funnel-host>/mcp/<TOKEN>
    "Register in Hyperagent -> Settings -> Integrations -> Add MCP server
    (name: codex-bridge-linux). Leave 'Bring my own OAuth app' unchecked. Then
    reply to Hyperagent with the hostname only."
  - Anything left for the human (linger/sudo, funnel approval).
```

## Notes

- **Two machines, two registrations.** Register the Windows bridge as
  `codex-bridge` and this one as `codex-bridge-linux` (distinct funnel
  hostnames, same tailnet). A meta session targets whichever machine runs its
  orchestrator.
- **Rotate the token** anytime: `node setup/init.mjs --rotate-token` then
  `systemctl --user restart codex-meta-bridge`, and re-register the new URL.
- **Recovery:** see `docs/recovery-runbook.md`. On Linux the watchdog timer +
  `Restart=always` handle crashes and hangs; `get_diagnostics` / `get_logs` /
  `restart_bridge` give the meta agent hands remotely.
