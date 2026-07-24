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
  const mod = await import("@openai/codex-sdk");
  const Codex = mod.Codex ?? mod.default;
  if (!Codex) throw new Error("@openai/codex-sdk present but no Codex export found");
  return new Codex();
}

export function tag(message, ticket) {
  return `${STEERING_MARKER} ${ticket}]\n\n${message}`;
}

/** Resume an owned thread and run one steering turn to completion. */
export async function deliverOwned({ targetThreadId, message, ticket, codexFactory, log }) {
  const codex = await loadCodex(codexFactory);
  const thread = codex.resumeThread(targetThreadId, { skipGitRepoCheck: true });
  const turn = await thread.run(tag(message, ticket));
  log?.(`owned delivery ${ticket} done: ${String(turn?.finalResponse ?? "").slice(0, 160)}`);
  return { threadId: targetThreadId, finalResponse: turn?.finalResponse ?? null };
}

/**
 * Start a brand-new owned mission. Streams the first turn, resolves the new
 * threadId as soon as it is known (via onThreadId), and keeps draining the
 * turn to completion in the background so the caller isn't blocked for the
 * whole (possibly minutes-long) first turn.
 */
export async function startOwnedMission({ prompt, threadOptions = {}, codexFactory, onThreadId, log }) {
  const codex = await loadCodex(codexFactory);
  const thread = codex.startThread({ skipGitRepoCheck: true, ...threadOptions });
  const { events } = await thread.runStreamed(prompt);
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
