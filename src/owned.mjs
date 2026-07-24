import { STEERING_MARKER } from "./tailer.mjs";

/**
 * EXPERIMENTAL delivery mode: the daemon itself runs the turn via
 * @openai/codex-sdk (resumeThread + run). Safe ONLY for threads the bridge
 * owns (created headless / not loaded in Codex Desktop). Never point this at
 * a live Desktop-owned thread: rollout files have no cross-process locking.
 *
 * Delivery is fire-and-forget: the returned promise is not awaited by the MCP
 * tool (a full agent turn can take minutes). Confirmation is observed by the
 * tailer via the steering marker, same as inbox mode.
 */
export async function deliverOwned({ targetThreadId, message, ticket, log }) {
  let CodexMod;
  try {
    CodexMod = await import("@openai/codex-sdk");
  } catch (e) {
    throw new Error(`@openai/codex-sdk not installed (owned mode unavailable): ${e?.message || e}`);
  }
  const Codex = CodexMod.Codex ?? CodexMod.default;
  const codex = new Codex();
  const thread = codex.resumeThread(targetThreadId, { skipGitRepoCheck: true });
  const tagged = `${STEERING_MARKER} ${ticket}]\n\n${message}`;
  const turn = await thread.run(tagged);
  log?.(`owned delivery ${ticket} completed: ${String(turn?.finalResponse ?? "").slice(0, 200)}`);
  return turn;
}
