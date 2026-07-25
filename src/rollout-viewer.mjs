import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function psEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function visibleViewerTitle(bindingId) {
  if (!bindingId) throw new Error("bindingId is required");
  return `Codex Meta ${String(bindingId).slice(0, 12)}`;
}

export function writeViewerReceipt(receiptPath, receipt) {
  if (!receiptPath) throw new Error("receiptPath is required");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temp = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  fs.renameSync(temp, receiptPath);
}

export async function waitForViewerReceipt({
  receiptPath,
  bindingId,
  threadId,
  receiptNonce,
  timeoutMs = 15000,
  pollMs = 100
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      if (
        receipt.binding_id === bindingId &&
        receipt.thread_id === threadId &&
        receipt.receipt_nonce === receiptNonce &&
        Number(receipt.viewer_pid) > 0 &&
        receipt.rollout_path
      ) {
        return receipt;
      }
    } catch { /* receipt not ready */ }
    await sleep(pollMs);
  }
  throw new Error(`viewer receipt was not ready within ${timeoutMs}ms`);
}

export function inspectVisibleViewerWindow(title, execFileSyncImpl = execFileSync) {
  if (process.platform !== "win32") {
    throw new Error("visible viewer window inspection is currently supported only on win32");
  }
  const encodedTitle = Buffer.from(String(title), "utf8").toString("base64");
  const script = [
    `$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))`,
    "$row = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq $expected } | Select-Object -First 1",
    "if ($row) { [pscustomobject]@{ Id = [int]$row.Id; MainWindowHandle = [string][int64]$row.MainWindowHandle; SessionId = [int]$row.SessionId; MainWindowTitle = [string]$row.MainWindowTitle } | ConvertTo-Json -Compress }"
  ].join("; ");
  const stdout = execFileSyncImpl("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", psEncoded(script)
  ], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  }).trim();
  if (!stdout) return null;
  const row = JSON.parse(stdout);
  return {
    window_pid: Number(row.Id) || null,
    window_handle: row.MainWindowHandle ? String(row.MainWindowHandle) : null,
    session_id: Number.isSafeInteger(Number(row.SessionId)) ? Number(row.SessionId) : null,
    title: row.MainWindowTitle || title
  };
}

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

export async function launchVisibleRolloutViewer({
  bindingId,
  threadId,
  codexHome,
  receiptPath,
  receiptNonce,
  cwd = process.cwd(),
  terminalPath: configuredTerminalPath,
  spawnProcess = spawn,
  nodePath = process.execPath,
  scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "view-rollout.mjs"),
  waitForReceipt = waitForViewerReceipt,
  inspectWindow = inspectVisibleViewerWindow
}) {
  if (process.platform !== "win32") {
    throw new Error("visible rollout viewer launch is currently supported only on win32");
  }
  let terminalPath = configuredTerminalPath;
  if (terminalPath === undefined) {
    terminalPath = execFileSync("where.exe", ["wt.exe"], {
      encoding: "utf8", timeout: 3000, windowsHide: true
    }).split(/\r?\n/).find(Boolean);
  }
  if (!terminalPath) throw new Error("Windows Terminal (wt.exe) was not found");
  if (!receiptPath) throw new Error("receiptPath is required");
  if (!receiptNonce) throw new Error("receiptNonce is required");
  const title = visibleViewerTitle(bindingId);
  const child = spawnProcess(terminalPath, [
    "-w", bindingId, "new-tab",
    "--title", title,
    "--startingDirectory", cwd,
    nodePath, scriptPath, threadId,
    "--codex-home", codexHome,
    "--binding-id", bindingId,
    "--receipt", receiptPath,
    "--receipt-nonce", receiptNonce,
    "--viewer-title", title
  ], {
    detached: true,
    windowsHide: false,
    stdio: "ignore"
  });
  child.unref?.();
  const receipt = await waitForReceipt({ receiptPath, bindingId, threadId, receiptNonce });
  if (
    receipt?.binding_id !== bindingId ||
    receipt?.thread_id !== threadId ||
    receipt?.receipt_nonce !== receiptNonce ||
    receipt?.viewer_title !== title ||
    !receipt?.rollout_path ||
    !Number.isSafeInteger(Number(receipt?.viewer_pid)) ||
    Number(receipt.viewer_pid) <= 0
  ) {
    throw new Error("viewer receipt did not bind to the exact launch, thread, nonce, title, and process");
  }
  const window = await inspectWindow(title);
  if (
    !Number.isSafeInteger(Number(window?.window_pid)) ||
    Number(window.window_pid) <= 0 ||
    !/^[1-9]\d*$/.test(String(window?.window_handle || "")) ||
    !Number.isSafeInteger(Number(window?.session_id)) ||
    Number(window.session_id) < 0 ||
    window?.title !== title
  ) {
    throw new Error("viewer started but its exact Windows Terminal window was not proven");
  }
  return {
    binding_id: receipt.binding_id,
    thread_id: receipt.thread_id,
    receipt_nonce: receipt.receipt_nonce,
    rollout_path: receipt.rollout_path,
    viewer_pid: Number(receipt.viewer_pid),
    viewer_started_at: receipt.started_at,
    launcher_pid: child.pid || null,
    viewer_title: title,
    window_pid: Number(window.window_pid),
    window_handle: String(window.window_handle),
    session_id: Number(window.session_id),
    title: window.title
  };
}
