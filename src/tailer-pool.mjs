import { RolloutTailer } from "./tailer.mjs";

/**
 * Manages one RolloutTailer per orchestrator thread so a single daemon can
 * supervise many orchestrators concurrently. This is what lets multiple
 * Hyperagent meta sessions run side by side without interfering: each session
 * addresses its own thread_id, and the pool keeps an independent tail + digest
 * per thread. Idle tailers are evicted (LRU) so the pool stays bounded; the
 * configured default target is pinned and never evicted.
 */
export class TailerPool {
  constructor({ codexHome, pollMs = 2000, truncateUser = 2000, truncateAssistant = 4000,
                onSteeringConfirmed = null, onTurnComplete = null, maxTailers = 12, idleEvictMs = 30 * 60 * 1000 }) {
    this.baseOpts = { codexHome, pollMs, truncateUser, truncateAssistant, onSteeringConfirmed, onTurnComplete };
    this.maxTailers = maxTailers;
    this.idleEvictMs = idleEvictMs;
    this.pinned = null; // default target threadId, never evicted
    this.entries = new Map(); // threadId -> { tailer, lastAccess }
    this._sweep = setInterval(() => this.evictIdle(), 60 * 1000);
    this._sweep.unref?.();
  }

  pin(threadId) { this.pinned = threadId || null; if (threadId) this.get(threadId); }

  get(threadId) {
    if (!threadId) return null;
    let e = this.entries.get(threadId);
    if (!e) {
      const tailer = new RolloutTailer({ ...this.baseOpts, threadId });
      tailer.start();
      e = { tailer, lastAccess: Date.now() };
      this.entries.set(threadId, e);
      this.enforceCap();
    }
    e.lastAccess = Date.now();
    return e.tailer;
  }

  has(threadId) { return this.entries.has(threadId); }

  list() {
    return [...this.entries.entries()].map(([threadId, e]) => {
      const d = e.tailer.digest();
      return { threadId, pinned: threadId === this.pinned, lastAccess: new Date(e.lastAccess).toISOString(),
               rolloutFound: d.rolloutFound, idleSeconds: d.idleSeconds, originator: d.sessionMeta?.originator ?? null };
    });
  }

  evictIdle() {
    const now = Date.now();
    for (const [threadId, e] of this.entries) {
      if (threadId === this.pinned) continue;
      if (now - e.lastAccess > this.idleEvictMs) { e.tailer.stop(); this.entries.delete(threadId); }
    }
  }

  enforceCap() {
    if (this.entries.size <= this.maxTailers) return;
    const sorted = [...this.entries.entries()]
      .filter(([id]) => id !== this.pinned)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    while (this.entries.size > this.maxTailers && sorted.length) {
      const [id, e] = sorted.shift();
      e.tailer.stop();
      this.entries.delete(id);
    }
  }

  stopAll() {
    clearInterval(this._sweep);
    for (const e of this.entries.values()) e.tailer.stop();
    this.entries.clear();
  }
}
