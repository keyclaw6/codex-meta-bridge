# Recovery runbook

systemd is the bridge's only process owner. `Restart=always` recovers daemon
crashes. There is no second watchdog, timer, detached supervisor, or per-user
unit.

## Check the path from inside out

```sh
curl http://127.0.0.1:8788/healthz
systemctl status codex-meta-bridge --no-pager
journalctl -u codex-meta-bridge -n 100 --no-pager
tail -n 100 /home/vpsdesktop/codex-meta-bridge/bridge/logs/daemon.log
tailscale funnel status
curl https://agent-ops.tail991b71.ts.net/healthz
```

Do not stop or reconfigure the unrelated process on port 8787.

## Common failures

| Symptom | Action |
| --- | --- |
| Local health fails and the unit is inactive | `sudo systemctl restart codex-meta-bridge`, then inspect the journal. |
| Unit repeatedly restarts | Check `bridge.config.json`, Node/Codex authentication, and the daemon log. Do not rotate the token as a diagnostic step. |
| Local health works but public health fails | Inspect `tailscale status` and `tailscale funnel status`, then restore Funnel for port 8788. |
| Hyper Agent gets an authentication error | Confirm its integration uses the current secret URL. Rotate only if compromise is suspected. |
| Tools work but a task is missing | Pass the exact returned `thread_id`; inspect `bridge_health` and `orchestrator_status`. |
| Steering is not confirmed | Inspect `list_steering`, task status, and the transcript for the ticket marker before sending anything again. |
| An owned turn is stuck | Call `interrupt_turn` once with the exact task id and `confirm: true`, then recheck status. |
| A start binding or delivery is uncertain | Stop retries. Inspect diagnostics, logs, and the rollout; never create a duplicate writer to guess around uncertain state. |

When the MCP connection is still usable, start with `bridge_health`, then use
`get_diagnostics` and `get_logs`. A service restart is appropriate after a
configuration or deployment change:

```sh
sudo systemctl restart codex-meta-bridge
curl http://127.0.0.1:8788/healthz
```

After token rotation, restart the service and replace the URL in Hyper Agent.
After a Funnel hostname change, replace the integration URL. These are human
recovery steps because both changes invalidate the existing remote endpoint.
