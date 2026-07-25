# v0.2 upgrade prompt (run on the machine already running v0.1)

Paste into a Codex thread on the Windows box that has the bridge installed.
This makes the bridge self-recovering, rotates the exposed token, and checks
whether plain Codex CLI exposes the collaboration tools (the gate for switching
missions to CLI/owned mode). It does NOT disturb the live ZynexGroup mission:
the current target stays Desktop-owned + inbox mode.

```
You are upgrading codex-meta-bridge (already installed on this machine) to v0.2
and validating CLI viability. Trust these facts; verify only what a step says to.

FACTS
- Repo: C:\Users\Kristian Bilstrup\Documents\agent-ops\codex-meta-bridge (public,
  origin https://github.com/keyclaw6/codex-meta-bridge.git). Clone anon over https.
- The live orchestrator 019f9315-fc11-7c90-b7ae-304ca4d8f127 is Desktop-owned and
  RUNNING. Do not touch it. Keep the bridge in inbox mode pointed at it.
- Node v24, Tailscale funnel already up at desktop-ktoi63d.tail991b71.ts.net.

GUARDRAILS
- NEVER run codex exec / codex exec resume against 019f9315-... or any Desktop
  thread. Never write under ~\.codex\sessions.
- The auth token is secret: only in bridge.config.json and your final report.
- At most TWO minimal local fixes per failing step, documented; else STOP + report.
- Do all steps in order; you are done only at the STEP 6 report.

STEP 1 — pull v0.3 + tests
  cd "C:\Users\Kristian Bilstrup\Documents\agent-ops\codex-meta-bridge"
  git pull
  npm install
  npm test                     -> CORE / POOL / OWNED / OAUTH all PASS
  npm run selftest             -> SELFTEST PASS
  IMPORTANT: run the selftest with an isolated config so it can never touch the
  live one:  (PowerShell)  $env:BRIDGE_CONFIG_PATH="$env:TEMP\bt-selftest.json"; npm run selftest; Remove-Item Env:\BRIDGE_CONFIG_PATH
  (v0.2 resolves the config path lazily so this is belt-and-suspenders.)

STEP 2 — keep current config, rotate the exposed token
  Confirm bridge.config.json still has deliveryMode "inbox" and targetThreadId
  019f9315-... (leave both as-is; the live mission needs inbox mode).
  node setup/init.mjs --rotate-token
  (init preserves target + mode, only rotates the token.) Read the NEW token
  from bridge.config.json for later steps.
  TOKEN TIMING: the running daemon still holds the OLD token until it is
  restarted in STEP 3c — the NEW token works only after that restart.

STEP 3 — install the exact per-user self-healing watchdog
  node setup/windows-persistence.mjs install
  node setup/windows-persistence.mjs status
  The required RUN state is exactly one `CodexMetaBridgeWatchdog` REG_SZ value
  under HKCU\Software\Microsoft\Windows\CurrentVersion\Run. It invokes
  wscript.exe //B //Nologo "<bridgeDir>\watchdog-supervisor-hidden.vbs". The VBS
  starts one hidden resident Node loop and exits. A deterministic named pipe
  admits one logical watchdog, which checks immediately and then every 60
  seconds without overlap.
  If status reports AMBIGUOUS, STOP. Never overwrite, stop, or delete a foreign
  or changed Run value, VBS, or pipe. If HKCU read/write/launch is denied, STOP
  for user intervention.
  Then prove self-healing (this restart also activates the rotated token):
    a) old pid (token-independent):
       Get-NetTCPConnection -LocalPort 8787 -State Listen | Select -Expand OwningProcess -Unique
    b) kill it:  Stop-Process -Id <OLD_PID> -Force
    c) wait up to ~75s, then:  curl.exe http://127.0.0.1:8787/healthz   -> ok
       re-run the Get-NetTCPConnection from a): the pid MUST differ from OLD_PID
    d) node test/smoke.mjs --token <NEW_TOKEN> logs 40   -> watchdog restart entry
  ACCEPTANCE: health returns after the kill with a NEW pid, no manual start.
  Management and recovery commands:
    node setup/windows-persistence.mjs uninstall
    node setup/windows-persistence.mjs rollback
  uninstall removes only the exact owned Run/VBS pair and exact pipe owner.
  Before that loop acknowledges its instance-bound STOP, failure restores the
  prior state. After acknowledgment, launch/pipe/health/commit failure keeps
  exact owned Run/VBS as sanitized cutover-failed / repairable-no-loop, never
  RUN or rollback-success. A later install, or the exact VBS at a later logon,
  may retry the current candidate. Foreign contradictions remain AMBIGUOUS and
  untouched. All paths preserve config, state, history, callbacks, OAuth data,
  audit, and logs, and never print the token or capability URL.
  LIMITS: user logon is required, sleep pauses cadence, and forcible termination
  of the watchdog loop is recovered only at the next logon or another idempotent
  install. Actual Run execution at logon is an ACCEPT residual unless a
  controlled logon test is separately authorized.

STEP 4 — re-verify the live read plane still works (NEW token)
  node test/smoke.mjs --token <NEW_TOKEN> status
  ACCEPTANCE: rolloutFound:true for 019f9315-..., recent lastAssistantMessage.

STEP 5 — CLI collaboration-tools check (the gate for owned mode)
  In a scratch dir (NOT a mission dir), run ONE throwaway session:
    codex exec --skip-git-repo-check "List the names of every tool you have
    access to, grouped by namespace. Reply with the list only."
  Record whether a `collaboration` namespace with spawn_agent / wait_agent /
  send_message appears. This decides whether CLI sessions can run the
  $orchestrate-mission subagent harness. Do not delete ~\.codex\sessions files.

STEP 6 — report
  - PASS lines for STEP 1; token rotated (do NOT print the token here, just
    confirm rotation + that you will hand the new URL separately/securely);
  - self-healing proof from STEP 3 (old pid, killed, new pid, watchdog log line);
  - STEP 4 status confirmation;
  - STEP 5: the exact tool namespaces returned, verbatim, especially whether
    `collaboration` is present in a CLI session;
  - the new registration URL, labeled secret:
      https://desktop-ktoi63d.tail991b71.ts.net/mcp/<NEW_TOKEN>
    "Re-register this in Hyperagent (Settings -> Integrations -> codex-bridge,
    replace the old one). Then reply to Hyperagent with the hostname only."
  - anything left for the human.
```
