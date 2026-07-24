import { STEERING_MARKER } from "./tailer.mjs";

/**
 * Owned-mode Codex control via @openai/codex-sdk. Used ONLY for threads the
 * bridge itself created/owns (CLI sessions), never a Codex Desktop-owned
 * thread — rollout files have no cross-process locking.
 *
 * The SDK is imported lazily and can be dependency-injected for tests via
 * `codexFactory`.
 */
export async function loadCodex(codexFactory) {
  if (codexFactory) return codexFactory();
  // Simulation mode (test / smoke only): when BRIDGE_CODEX_FAKE points at a
  // CODEX_HOME, deliver by appending the turn to the target's rollout instead
  // of spawning a real Codex. Never set this in production.
  if (process.env.BRIDGE_CODEX_FAKE) return makeSimCodex(process.env.BRIDGE_CODEX_FAKE);
  const mod = await import("@openai/codex-sdk");
  const Codex = mod.Codex ?? mod.default;
  if (!Codex) throw new Error("@openai/codex-sdk present but no Codex export found");
  return new Codex();
}

async function makeSimCodex(codexHome) {
  const fs = await import("node:fs");
  const { findRolloutFile } = await import("./tailer.mjs");
  const append = (id, role, text) => {
    const p = findRolloutFile(codexHome, id);
    if (!p) throw new Error(`sim codex: no rollout for ${id}`);
    fs.appendFileSync(p, JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } }) + "\n");
  };
  return {
    resumeThread(id) {
      return { id, async run(text) { append(id, "user", text); append(id, "assistant", "[sim] acknowledged"); return { finalResponse: "[sim] acknowledged" }; } };
    },
    startThread() {
      const id = "019f5100-0000-7000-0000-" + Date.now().toString(16).padStart(12, "0").slice(-12);
      return { id, async runStreamed() { async function* g() { yield { type: "thread.started", thread_id: id }; yield { type: "turn.completed" }; } return { events: g() }; } };
    }
  };
}

export function tag(message, ticket) {
  return `${STEERING_MARKER} ${ticket}]\n\n${message}`;
}

export function missionResumeOptions({ cfg = {}, inbox, threadId }) {
  const stored = inbox?.missionOptions?.(threadId) || null;
  const cwd = stored ? stored.cwd : (cfg.default_mission_cwd || null);
  const sandboxMode = stored ? stored.sandbox_mode : (cfg.default_mission_sandbox || "danger-full-access");
  const approvalPolicy = stored ? stored.approval_policy : "never";
  return {
    skipGitRepoCheck: true,
    ...(cwd ? { workingDirectory: cwd } : {}),
    sandboxMode,
    approvalPolicy
  };
}

/** Resume an owned thread and run one steering turn to completion. */
export async function deliverOwned({ targetThreadId, message, ticket, cfg, inbox, codexFactory, log, signal }) {
  const codex = await loadCodex(codexFactory);
  const thread = codex.resumeThread(targetThreadId, missionResumeOptions({ cfg, inbox, threadId: targetThreadId }));
  const turn = await thread.run(tag(message, ticket), { signal });
  log?.(`owned delivery ${ticket} done: ${String(turn?.finalResponse ?? "").slice(0, 160)}`);
  return { threadId: targetThreadId, finalResponse: turn?.finalResponse ?? null };
}

/**
 * Start a brand-new owned mission. Streams the first turn, resolves the new
 * threadId as soon as it is known (via onThreadId), and keeps draining the
 * turn to completion in the background so the caller isn't blocked for the
 * whole (possibly minutes-long) first turn.
 */
export async function startOwnedMission({ prompt, threadOptions = {}, codexFactory, onThreadId, log, signal }) {
  const codex = await loadCodex(codexFactory);
  const thread = codex.startThread({ skipGitRepoCheck: true, ...threadOptions });
  const { events } = await thread.runStreamed(prompt, { signal });
  let announced = false;
  const drain = (async () => {
    try {
      for await (const ev of events) {
        const id = thread.id || ev?.thread_id || ev?.threadId;
        if (id && !announced) { announced = true; onThreadId?.(id); }
      }
      log?.(`owned mission first turn complete (thread ${thread.id})`);
    } catch (e) {
      log?.(`owned mission stream error: ${String(e?.message || e)}`);
    }
  })();
  // Give the SDK a moment to surface thread.id even if no event exposes it.
  if (!announced && thread.id) { announced = true; onThreadId?.(thread.id); }
  return { threadPromise: drain, getThreadId: () => thread.id };
}
