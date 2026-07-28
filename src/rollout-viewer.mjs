import { RolloutTailer } from "./tailer.mjs";

const VIEW_KINDS = [
  "session_meta",
  "user_message",
  "assistant_message",
  "tool_call",
  "callback",
  "compacted"
];

const LABELS = {
  session_meta: "SESSION",
  user_message: "USER",
  assistant_message: "ASSISTANT",
  tool_call: "TOOL",
  callback: "CALLBACK",
  compacted: "SYSTEM"
};

const COLORS = {
  session_meta: "\x1b[90m",
  user_message: "\x1b[36m",
  assistant_message: "\x1b[32m",
  tool_call: "\x1b[33m",
  callback: "\x1b[35m",
  compacted: "\x1b[90m"
};

const RESET = "\x1b[0m";

export function formatViewerEvent(event, { color = true } = {}) {
  const time = event.t && !Number.isNaN(Date.parse(event.t))
    ? new Date(event.t).toLocaleTimeString()
    : "--:--:--";
  const label = LABELS[event.kind] || event.kind.toUpperCase();
  const prefix = `[${time}] ${label}`;
  const header = color ? `${COLORS[event.kind] || ""}${prefix}${RESET}` : prefix;
  const body = String(event.summary || "").trim();
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

export function startRolloutViewer({
  codexHome,
  threadId,
  pollMs = 500,
  history = 30,
  color = process.stdout.isTTY,
  output = process.stdout,
  onReady = null
}) {
  if (!codexHome) throw new Error("codexHome is required");
  if (!threadId) throw new Error("threadId is required");
  const tailer = new RolloutTailer({ codexHome, threadId, pollMs });
  const seen = new Set();
  let announcedPath = false;
  let waiting = false;
  let ready = false;

  const render = (initial = false) => {
    tailer.tick();
    if (tailer.rolloutPath && !announcedPath) {
      output.write(`Codex live rollout\nThread: ${threadId}\nFile: ${tailer.rolloutPath}\n\n`);
      announcedPath = true;
      if (!ready) {
        ready = true;
        onReady?.({ threadId, rolloutPath: tailer.rolloutPath });
      }
    } else if (!tailer.rolloutPath && !waiting) {
      output.write(`Waiting for rollout ${threadId}...\n`);
      waiting = true;
    }
    const events = tailer.recentEvents(200, VIEW_KINDS, 4000);
    const candidates = initial ? events.slice(-Math.max(0, history)) : events;
    for (const event of candidates) {
      const key = `${event.t || ""}|${event.id || ""}|${event.kind}|${event.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.write(`${formatViewerEvent(event, { color })}\n`);
    }
  };

  render(true);
  const timer = setInterval(() => render(false), Math.max(100, pollMs));
  return {
    threadId,
    get rolloutPath() { return tailer.rolloutPath; },
    stop() { clearInterval(timer); tailer.stop(); }
  };
}
