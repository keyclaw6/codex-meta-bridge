import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPidsOnPort } from "./proc.mjs";
import { probeCodexVersion } from "./codex-cli.mjs";

function safe(fn, fallback = null) {
  try { return fn(); } catch (e) { return fallback ?? { error: String(e?.message || e) }; }
}

function tailFile(file, lines, maxBytes = 262144) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    const arr = text.split(/\r?\n/).filter(Boolean);
    return { file, size: st.size, mtime: st.mtime.toISOString(), lines: arr.slice(-lines) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Tail the bridge's own logs (audit + daemon stdout). */
export function tailLogs(bridgeDir, lines = 60) {
  const logDir = path.join(bridgeDir, "logs");
  return {
    audit: tailFile(path.join(logDir, "audit.jsonl"), lines),
    daemon: tailFile(path.join(logDir, "daemon.log"), lines),
    watchdog: tailFile(path.join(logDir, "watchdog.log"), lines)
  };
}

/**
 * Machine + bridge diagnostics for remote recovery. Every probe is wrapped;
 * this function never throws.
 */
export function gatherDiagnostics({ cfg, tailer, startedAt, restartsLogPath, candidateId = null }) {
  const d = tailer?.digest?.() ?? {};
  let disk = null;
  disk = safe(() => {
    const s = fs.statfsSync(cfg.bridgeDir);
    return { freeGB: Math.round((s.bsize * s.bavail) / 1e9 * 10) / 10, totalGB: Math.round((s.bsize * s.blocks) / 1e9 * 10) / 10 };
  });
  const codexVersion = safe(() => probeCodexVersion(cfg), { error: "codex not found or timed out" });
  const restarts = safe(() => {
    if (!restartsLogPath || !fs.existsSync(restartsLogPath)) return [];
    return fs.readFileSync(restartsLogPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-10).map((l) => safe(() => JSON.parse(l), l));
  }, []);

  return {
    ok: true,
    now: new Date().toISOString(),
    platform: { type: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname() },
    node: process.version,
    codexVersion,
    daemon: {
      pid: process.pid,
      candidateId,
      startedAt,
      uptimeSec: Math.round(process.uptime()),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      port: cfg.port,
      pidsOnPort: findPidsOnPort(cfg.port),
      deliveryMode: cfg.deliveryMode
    },
    target: {
      threadId: cfg.targetThreadId || null,
      rolloutFound: d.rolloutFound ?? false,
      rolloutPath: d.rolloutPath ?? null,
      idleSeconds: d.idleSeconds ?? null,
      originator: d.sessionMeta?.originator ?? null,
      tailerError: d.tailerError ?? null
    },
    disk,
    recentRestarts: restarts
  };
}
