import fs from "node:fs";
import path from "node:path";

export const STEERING_MARKER = "[HYPERAGENT-STEERING";
// Reverse channel: the orchestrator emits callbacks to the meta agent by
// writing a marker anywhere in its output, e.g.
//   [[CALLBACK:PLAN_READY]] plan is ready for approval
// The tailer detects these and surfaces them so the meta can read/wake on them.
export const CALLBACK_RE = /\[\[CALLBACK:([A-Z_]{2,40})\]\]([^\n]*)/g;

/** Find the rollout .jsonl for a thread id under codexHome/sessions (dated subdirs). */
export function findRolloutFile(codexHome, threadId) {
  const sessionsDir = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { recursive: true });
  } catch {
    return null;
  }
  const matches = [];
  for (const rel of entries) {
    const s = String(rel);
    if (s.endsWith(`${threadId}.jsonl`) && s.includes("rollout-")) {
      matches.push(path.join(sessionsDir, s));
    }
  }
  if (matches.length === 0) return null;
  // Newest by mtime wins (there should only ever be one per thread id).
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

function textFromContent(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((c) => (c && typeof c === "object" ? c.text ?? c.content ?? "" : String(c ?? "")))
    .filter(Boolean)
    .join("\n");
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + ` …[truncated ${s.length - n} chars]`;
}

/**
 * Incrementally tails one rollout file and maintains a digest of the session.
 * Tolerant parser: unknown event shapes are counted, never fatal.
 */
export class RolloutTailer {
  constructor({ codexHome, threadId, pollMs = 2000, truncateUser = 2000, truncateAssistant = 4000, onSteeringConfirmed = null, onTurnComplete = null, onCallback = null }) {
    this.codexHome = codexHome;
    this.threadId = threadId;
    this.pollMs = pollMs;
    this.truncateUser = truncateUser;
    this.truncateAssistant = truncateAssistant;
    this.onSteeringConfirmed = onSteeringConfirmed;
    this.onTurnComplete = onTurnComplete;
    this.onCallback = onCallback;
    this.seenCallbacks = new Set(); // per-process, so onCallback fires once per id per run

    this.rolloutPath = null;
    this.offset = 0;
    this.remainder = "";
    this.timer = null;
    this.lastError = null;

    this.state = {
      meta: null,
      eventCounts: {},
      lineCount: 0,
      lastEventAt: null,
      lastUserMessage: null,
      lastAssistantMessage: null,
      tokens: null,
      rateLimit: null,
      subagents: [],
      compactions: 0,
      confirmedTickets: [],
      callbacks: []
    };
    this.recent = []; // ring buffer of compact events
  }

  start() {
    this.discover();
    if (this.rolloutPath) this.readNew();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  retarget(threadId) {
    this.threadId = threadId;
    this.rolloutPath = null;
    this.offset = 0;
    this.remainder = "";
    this.state = { ...this.state, meta: null, eventCounts: {}, lineCount: 0, lastEventAt: null, lastUserMessage: null, lastAssistantMessage: null, tokens: null, rateLimit: null, subagents: [], compactions: 0, callbacks: [] };
    this.seenCallbacks = new Set();
    this.recent = [];
    this.discover();
    if (this.rolloutPath) this.readNew();
  }

  discover() {
    try {
      this.rolloutPath = findRolloutFile(this.codexHome, this.threadId);
      this.lastError = this.rolloutPath ? null : `No rollout file found for thread ${this.threadId}`;
    } catch (e) {
      this.lastError = String(e?.message || e);
    }
  }

  tick() {
    try {
      if (!this.rolloutPath) {
        this.discover();
        if (!this.rolloutPath) return;
      }
      this.readNew();
    } catch (e) {
      this.lastError = String(e?.message || e);
    }
  }

  readNew() {
    let st;
    try {
      st = fs.statSync(this.rolloutPath);
    } catch {
      // File moved/compressed; rediscover next tick.
      this.rolloutPath = null;
      return;
    }
    if (st.size < this.offset) {
      // Truncated/replaced: re-read from scratch.
      this.offset = 0;
      this.remainder = "";
    }
    if (st.size === this.offset) return;
    const fd = fs.openSync(this.rolloutPath, "r");
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      const chunk = this.remainder + buf.toString("utf8");
      const lines = chunk.split("\n");
      this.remainder = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t) this.ingestLine(t);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  ingestLine(line) {
    this.state.lineCount++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      this.bump("unparseable");
      return;
    }
    const ts = obj.timestamp || null;
    if (ts) this.state.lastEventAt = ts;
    const kind = obj.type || "unknown";
    this.bump(kind);
    const p = obj.payload || {};

    if (kind === "session_meta") {
      this.state.meta = {
        cwd: p.cwd, originator: p.originator, cli_version: p.cli_version,
        source: p.source, thread_source: p.thread_source, started: p.timestamp
      };
      this.pushRecent(ts, "session_meta", `originator=${p.originator} cli=${p.cli_version} cwd=${p.cwd}`);
      return;
    }
    if (kind === "compacted") {
      this.state.compactions++;
      this.pushRecent(ts, "compacted", "history compacted");
      return;
    }
    if (kind === "event_msg") {
      const et = p.type;
      this.bump(`event_msg.${et}`);
      if (et === "token_count" && p.info) {
        const total = p.info.total_token_usage || {};
        const last = p.info.last_token_usage || {};
        const win = p.info.model_context_window || null;
        this.state.tokens = {
          window: win,
          last_turn_input: last.input_tokens ?? null,
          last_turn_total: last.total_tokens ?? null,
          cumulative_total: total.total_tokens ?? null,
          window_used_pct: win && last.input_tokens ? Math.round((last.input_tokens / win) * 1000) / 10 : null
        };
        const rl = p.rate_limits?.primary;
        if (rl) {
          this.state.rateLimit = {
            plan: p.rate_limits?.plan_type ?? null,
            used_percent: rl.used_percent ?? null,
            window_minutes: rl.window_minutes ?? null,
            resets_at: rl.resets_at ? new Date(rl.resets_at * 1000).toISOString() : null
          };
        }
      }
      return;
    }
    if (kind === "response_item") {
      const it = p.type;
      this.bump(`response_item.${it}`);
      if (it === "message") {
        const role = p.role || "unknown";
        const text = textFromContent(p.content);
        if (role === "user") {
          this.state.lastUserMessage = { at: ts, text: truncate(text, this.truncateUser) };
          this.pushRecent(ts, "user_message", truncate(text, 400));
          if (text.includes(STEERING_MARKER)) {
            const m = text.match(/\[HYPERAGENT-STEERING\s+([^\]\s]+)\]/);
            if (m) {
              this.state.confirmedTickets.push({ ticket: m[1], at: ts });
              this.onSteeringConfirmed?.(m[1], ts);
            }
          }
        } else if (role === "assistant") {
          this.state.lastAssistantMessage = { at: ts, text: truncate(text, this.truncateAssistant) };
          this.pushRecent(ts, "assistant_message", truncate(text, 400));
          this.detectCallbacks(text, ts);
          this.onTurnComplete?.(ts);
        } else {
          this.pushRecent(ts, `message.${role}`, truncate(text, 200));
        }
      } else if (it === "function_call") {
        let summary = `${p.namespace ? p.namespace + "." : ""}${p.name}`;
        if (p.name === "spawn_agent") {
          try {
            const args = JSON.parse(p.arguments || "{}");
            if (args.task_name) {
              summary += ` task=${args.task_name}`;
              if (!this.state.subagents.includes(args.task_name)) this.state.subagents.push(args.task_name);
            }
          } catch { /* opaque args */ }
        }
        this.pushRecent(ts, "tool_call", summary);
      } else if (it === "function_call_output") {
        this.pushRecent(ts, "tool_output", truncate(String(p.output ?? ""), 200));
      } else {
        this.pushRecent(ts, `response_item.${it}`, "");
      }
      return;
    }
    this.pushRecent(ts, kind, "");
  }

  detectCallbacks(text, ts) {
    if (typeof text !== "string" || !text.includes("[[CALLBACK:")) return;
    CALLBACK_RE.lastIndex = 0;
    let m;
    while ((m = CALLBACK_RE.exec(text)) !== null) {
      const kind = m[1];
      const summary = (m[2] || "").trim().slice(0, 500);
      // Deterministic id: same rollout line yields the same id across restarts,
      // so acks persist and re-reads don't duplicate.
      const id = `${this.threadId}:${ts}:${kind}`;
      if (this.state.callbacks.some((c) => c.id === id)) continue;
      const cb = { id, kind, at: ts, summary, threadId: this.threadId };
      this.state.callbacks.push(cb);
      if (this.state.callbacks.length > 200) this.state.callbacks.shift();
      this.pushRecent(ts, "callback", `${kind} ${summary}`.trim());
      if (!this.seenCallbacks.has(id)) { this.seenCallbacks.add(id); this.onCallback?.(cb); }
    }
  }

  bump(k) {
    this.state.eventCounts[k] = (this.state.eventCounts[k] || 0) + 1;
  }

  pushRecent(t, kind, summary) {
    this.recent.push({ t, kind, summary });
    if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
  }

  digest() {
    let fileSize = null, fileMtime = null;
    if (this.rolloutPath) {
      try {
        const st = fs.statSync(this.rolloutPath);
        fileSize = st.size;
        fileMtime = st.mtime.toISOString();
      } catch { /* gone */ }
    }
    const lastAt = this.state.lastEventAt ? Date.parse(this.state.lastEventAt) : null;
    return {
      threadId: this.threadId,
      rolloutPath: this.rolloutPath,
      rolloutFound: !!this.rolloutPath,
      fileSize,
      fileMtime,
      lastEventAt: this.state.lastEventAt,
      idleSeconds: lastAt ? Math.round((Date.now() - lastAt) / 1000) : null,
      sessionMeta: this.state.meta,
      lineCount: this.state.lineCount,
      eventCounts: this.state.eventCounts,
      lastUserMessage: this.state.lastUserMessage,
      lastAssistantMessage: this.state.lastAssistantMessage,
      tokens: this.state.tokens,
      rateLimit: this.state.rateLimit,
      subagents: this.state.subagents,
      compactions: this.state.compactions,
      confirmedSteeringTickets: this.state.confirmedTickets.slice(-20),
      callbacks: this.state.callbacks.slice(-40),
      tailerError: this.lastError
    };
  }

  recentEvents(lastN = 20, kinds = null) {
    let evs = this.recent;
    if (kinds && kinds.length) {
      const set = new Set(kinds);
      evs = evs.filter((e) => set.has(e.kind));
    }
    return evs.slice(-Math.min(lastN, 200));
  }
}
