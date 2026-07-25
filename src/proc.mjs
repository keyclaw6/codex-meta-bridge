import http from "node:http";
import net from "node:net";
import { spawn, execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const PROCESS_HELPER_TIMEOUT_MS = 5000;
let descendantCpuSnapshot = new Map();
let descendantSampleAt = 0;
const descendantCache = new Map();

const canonicalProcessPath = (value, { platform = process.platform, realpathSyncImpl = fs.realpathSync.native } = {}) => {
  let resolved = path.resolve(String(value || ""));
  try { resolved = realpathSyncImpl(resolved); } catch { /* fail closed at the equality check */ }
  resolved = path.normalize(resolved);
  if (platform === "win32") {
    if (resolved.startsWith("\\\\?\\UNC\\")) resolved = `\\\\${resolved.slice(8)}`;
    else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
    resolved = resolved.toLowerCase();
  }
  return resolved;
};

export function buildBridgeProcessIdentity(repoRoot, options = {}) {
  const canonical = canonicalProcessPath(repoRoot, options);
  return crypto.createHash("sha256").update(`codex-meta-bridge-daemon-v1\0${canonical}`).digest("hex").slice(0, 32);
}

const parseEndpoint = (value) => {
  const text = String(value || "");
  const bracketed = text.match(/^\[([^\]]+)\]:(\d+)$/);
  const plain = bracketed || text.match(/^(.*):(\d+)$/);
  if (!plain) return null;
  return { address: plain[1].split("%")[0].toLowerCase(), port: Number(plain[2]) };
};

const endpointMatches = (value, port, host) => {
  const endpoint = parseEndpoint(value);
  if (!endpoint || endpoint.port !== Number(port)) return false;
  if (!host) return true;
  const expected = String(host).toLowerCase();
  if (expected === "localhost") return endpoint.address === "127.0.0.1" || endpoint.address === "::1";
  return endpoint.address === expected;
};

export function findWindowsListenersOnPort(port, {
  execFileSyncImpl = execFileSync,
  platform = process.platform,
  timeoutMs = PROCESS_HELPER_TIMEOUT_MS
} = {}) {
  if (platform !== "win32") return [];
  const out = execFileSyncImpl("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024
  });
  const listeners = [];
  for (const line of out.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || !/^TCP$/i.test(columns[0]) || !/^LISTENING$/i.test(columns[3])) continue;
    const localEndpoint = columns[1];
    const endpoint = parseEndpoint(localEndpoint);
    const textualSamePort = new RegExp(`:${Number(port)}$`).test(String(localEndpoint || ""));
    if (endpoint?.port !== Number(port) && !(endpoint == null && textualSamePort)) continue;
    const pid = Number(columns.at(-1));
    listeners.push({
      address: endpoint?.address || null,
      port: endpoint?.port ?? Number(port),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      parseable: endpoint != null && Number.isInteger(pid) && pid > 0,
    });
  }
  return listeners;
}

/** GET http://127.0.0.1:<port>/healthz. Resolves sanitized identity when present — never throws. */
export function probeHealth(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let identity = null;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) identity = parsed;
        } catch { /* a foreign/non-JSON 200 is handled as missing identity */ }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, body: body.trim(), identity });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: String(e?.code || e?.message || e) }));
  });
}

/** Best-effort: PIDs listening on a TCP port. Returns number[] (empty on failure). */
export function findPidsOnPort(port, {
  execFileSyncImpl = execFileSync,
  platform = process.platform,
  host = null,
  timeoutMs = PROCESS_HELPER_TIMEOUT_MS
} = {}) {
  try {
    if (platform === "win32") {
      const pids = new Set();
      for (const listener of findWindowsListenersOnPort(port, { execFileSyncImpl, platform, timeoutMs })) {
        if (!listener.parseable || !endpointMatches(`${listener.address}:${listener.port}`, port, host)) continue;
        pids.add(listener.pid);
      }
      return [...pids].filter((p) => p > 0);
    }
    // posix: try lsof, then ss
    try {
      const out = execFileSyncImpl("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN`], {
        encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024
      });
      return out.split(/\s+/).map(Number).filter(Boolean);
    } catch {
      const out = execFileSyncImpl("sh", ["-c", `ss -ltnp 'sport = :${port}' 2>/dev/null`], {
        encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024
      });
      const pids = new Set();
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      return [...pids].filter(Boolean);
    }
  } catch {
    return [];
  }
}

export function inspectWindowsProcess(pid, {
  execFileSyncImpl = execFileSync,
  timeoutMs = PROCESS_HELPER_TIMEOUT_MS
} = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 4) return null;
  const script = [
    `$bridgeProcess = Get-Process -Id ${numericPid} -ErrorAction Stop`,
    "$bridgeProcessPath = [string]$bridgeProcess.Path",
    "$bridgeProcessStarted = $bridgeProcess.StartTime.ToUniversalTime().ToString('o')",
    "$bridgeProcessCreationFileTime = [string]$bridgeProcess.StartTime.ToFileTimeUtc()",
    "[pscustomobject]@{ pid = [int]$bridgeProcess.Id; executable_path = $bridgeProcessPath; started_at = $bridgeProcessStarted; creation_time_filetime_utc = $bridgeProcessCreationFileTime } | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const out = execFileSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(String(out || ""));
    return Number(parsed?.pid) === numericPid
      && typeof parsed?.executable_path === "string"
      && typeof parsed?.started_at === "string"
      && /^[1-9]\d+$/.test(parsed?.creation_time_filetime_utc)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function inspectWindowsProcessTree(rootPid, {
  trackedPids = [],
  execFileSyncImpl = execFileSync,
  timeoutMs = PROCESS_HELPER_TIMEOUT_MS
} = {}) {
  const numericRoot = Number(rootPid);
  const tracked = [...new Set(trackedPids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!Number.isInteger(numericRoot) || numericRoot <= 4) return null;
  const script = `
$bridgeSnapshotSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class BridgeProcessSnapshot {
  private const uint TH32CS_SNAPPROCESS = 0x00000002;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  public static string Read() {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("snapshot failed");
    try {
      PROCESSENTRY32 entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      StringBuilder output = new StringBuilder();
      if (Process32First(snapshot, ref entry)) {
        do {
          output.Append(entry.th32ProcessID).Append(',').Append(entry.th32ParentProcessID).Append('\\n');
          entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        } while (Process32Next(snapshot, ref entry));
      }
      return output.ToString();
    } finally {
      CloseHandle(snapshot);
    }
  }
}
'@
Add-Type -TypeDefinition $bridgeSnapshotSource -ErrorAction Stop
[BridgeProcessSnapshot]::Read()
`;
  try {
    const out = execFileSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rows = String(out || "").split(/\r?\n/).filter(Boolean).map((line) => line.split(",").map(Number));
    if (!rows.length || rows.some(([pid, parentPid]) => !Number.isInteger(pid) || !Number.isInteger(parentPid))) return null;
    const ids = new Set(rows.map(([pid]) => pid));
    const byParent = new Map();
    for (const [pid, parentPid] of rows) {
      if (!byParent.has(parentPid)) byParent.set(parentPid, []);
      byParent.get(parentPid).push(pid);
    }
    const descendants = [];
    const seen = new Set([numericRoot]);
    const queue = [numericRoot];
    while (queue.length) {
      const parentPid = queue.shift();
      for (const childPid of byParent.get(parentPid) || []) {
        if (seen.has(childPid)) continue;
        seen.add(childPid);
        descendants.push(childPid);
        queue.push(childPid);
      }
    }
    return {
      root_present: ids.has(numericRoot),
      descendants,
      tracked_present: tracked.filter((pid) => ids.has(pid)),
    };
  } catch {
    return null;
  }
}

export function findOwnedBridgePidsOnPort(port, {
  host,
  repoRoot,
  bridgeDir,
  candidateId,
  nodePath = process.execPath,
  platform = process.platform,
  processPid = process.pid,
  findWindowsListenersOnPortImpl = findWindowsListenersOnPort,
  inspectWindowsProcessImpl = inspectWindowsProcess,
  readFileSyncImpl = fs.readFileSync,
  realpathSyncImpl = fs.realpathSync.native,
} = {}) {
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (platform !== "win32" || !loopback.has(String(host || "").toLowerCase())) {
    return { ok: false, owned: [], authority: [], ambiguous: [], listener_count: 0, error: "LOOPBACK_OWNERSHIP_UNAVAILABLE" };
  }

  let listenerRows;
  try { listenerRows = findWindowsListenersOnPortImpl(port, { platform }); }
  catch {
    return { ok: false, owned: [], authority: [], ambiguous: [], listener_count: 0, error: "LISTENER_SNAPSHOT_UNAVAILABLE" };
  }
  if (!Array.isArray(listenerRows)) {
    return { ok: false, owned: [], authority: [], ambiguous: [], listener_count: 0, error: "LISTENER_SNAPSHOT_UNAVAILABLE" };
  }
  if (listenerRows.length === 0) return { ok: true, owned: [], authority: [], ambiguous: [], listener_count: 0 };

  const expectedHost = String(host).toLowerCase();
  const addressMatches = (address) => expectedHost === "localhost"
    ? address === "127.0.0.1" || address === "::1"
    : address === expectedHost;
  const unsafeRows = listenerRows.filter((listener) => !listener?.parseable
    || !addressMatches(String(listener.address || "").toLowerCase())
    || Number(listener.port) !== Number(port));
  if (unsafeRows.length || listenerRows.length !== 1) {
    return {
      ok: false,
      owned: [],
      authority: [],
      ambiguous: listenerRows.map((listener) => ({
        pid: Number.isInteger(Number(listener?.pid)) ? Number(listener.pid) : null,
        reason: !listener?.parseable ? "unparseable-listener" : "listener-set-ambiguous",
      })),
      listener_count: listenerRows.length,
      error: "PORT_OWNER_AMBIGUOUS",
    };
  }
  const listeners = [Number(listenerRows[0].pid)];

  let rows = [];
  try {
    rows = String(readFileSyncImpl(path.join(bridgeDir, "logs", "restarts.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-200)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { /* missing ownership receipt fails closed below */ }

  const expectedRepoIdentity = buildBridgeProcessIdentity(repoRoot, { platform, realpathSyncImpl });
  const expectedNodePath = canonicalProcessPath(nodePath, { platform, realpathSyncImpl });
  const expectedCandidate = String(candidateId || "").trim() || null;
  const owned = [];
  const authority = [];
  const ambiguous = [];

  for (const pid of listeners) {
    if (!Number.isInteger(pid) || pid <= 4 || pid === processPid) {
      ambiguous.push({ pid, reason: "protected-pid" });
      continue;
    }
    const receipt = [...rows].reverse().find((row) => Number(row?.pid) === pid && row?.event === "start");
    if (!receipt
      || receipt.repo_identity !== expectedRepoIdentity
      || (receipt.candidate_id || null) !== expectedCandidate
      || Number(receipt.port) !== Number(port)
      || String(receipt.host || "").toLowerCase() !== String(host).toLowerCase()
      || typeof receipt.process_creation_time_filetime_utc !== "string"
      || !/^[1-9]\d+$/.test(receipt.process_creation_time_filetime_utc)
      || typeof receipt.process_instance !== "string"
      || receipt.process_instance.length < 16) {
      ambiguous.push({ pid, reason: "receipt-mismatch" });
      continue;
    }
    const processInfo = inspectWindowsProcessImpl(pid);
    const observedCreationFileTime = processInfo?.creation_time_filetime_utc;
    const observedStartedMs = Date.parse(processInfo?.started_at || "");
    const receiptAtMs = Date.parse(receipt.t || "");
    const observedNodePath = processInfo?.executable_path
      ? canonicalProcessPath(processInfo.executable_path, { platform, realpathSyncImpl })
      : null;
    if (!processInfo
      || observedNodePath !== expectedNodePath
      || !/^[1-9]\d+$/.test(observedCreationFileTime || "")
      || observedCreationFileTime !== receipt.process_creation_time_filetime_utc
      || !Number.isFinite(observedStartedMs)
      || !Number.isFinite(receiptAtMs)
      || receiptAtMs < observedStartedMs
      || receiptAtMs > observedStartedMs + 60_000) {
      ambiguous.push({ pid, reason: "process-identity-mismatch" });
      continue;
    }
    owned.push(pid);
    authority.push({
      pid,
      process_instance: receipt.process_instance,
      process_creation_time_filetime_utc: receipt.process_creation_time_filetime_utc,
      repo_identity: receipt.repo_identity,
      candidate_id: receipt.candidate_id || null,
    });
  }

  const ok = owned.length === 1 && ambiguous.length === 0 && listeners.length === 1;
  return { ok, owned, authority, ambiguous, listener_count: listeners.length, ...(ok ? {} : { error: "PORT_OWNER_AMBIGUOUS" }) };
}

/** Best-effort force-kill. Returns {killed:number[], errors:string[]}. */
export function killPids(pids, {
  excludeSelf = true,
  execFileSyncImpl = execFileSync,
  processKillImpl = process.kill,
  inspectProcessTreeImpl = inspectWindowsProcessTree,
  revalidatePidImpl = () => false,
  verifiedPids = [],
  platform = process.platform,
  timeoutMs = PROCESS_HELPER_TIMEOUT_MS
} = {}) {
  const killed = [], errors = [];
  const verified = new Set(verifiedPids.map(Number));
  const treeShapeKnown = (tree) => typeof tree?.root_present === "boolean"
    && Array.isArray(tree.descendants)
    && Array.isArray(tree.tracked_present);
  const completeTreeAbsent = (tree) => tree?.root_present === false
    && Array.isArray(tree.descendants) && tree.descendants.length === 0
    && Array.isArray(tree.tracked_present) && tree.tracked_present.length === 0;
  const exactChildFreeRoot = (tree, rootPid) => tree?.root_present === true
    && Array.isArray(tree.descendants) && tree.descendants.length === 0
    && Array.isArray(tree.tracked_present)
    && tree.tracked_present.length === 1
    && Number(tree.tracked_present[0]) === Number(rootPid);
  for (const pid of pids) {
    if (platform === "win32" && (!verified.has(Number(pid)) || Number(pid) <= 4 || Number(pid) === process.pid)) {
      errors.push(`${pid}: unverified-or-protected`);
      continue;
    }
    if (excludeSelf && pid === process.pid) continue;
    if (platform === "win32") {
      const beforeTree = inspectProcessTreeImpl(pid, { trackedPids: [] });
      if (!treeShapeKnown(beforeTree) || beforeTree.root_present !== true) {
        errors.push(`${pid}: process-tree-unverified`);
        continue;
      }
      const trackedPids = [...new Set([Number(pid), ...(beforeTree.descendants || []).map(Number)])];
      if (revalidatePidImpl(pid) !== true) {
        errors.push(`${pid}: ownership-revalidation-failed`);
        continue;
      }
      try {
        execFileSyncImpl("taskkill", ["/PID", String(pid), "/F", "/T"], {
          stdio: "ignore", windowsHide: true, timeout: timeoutMs
        });
        const afterTree = inspectProcessTreeImpl(pid, { trackedPids });
        if (completeTreeAbsent(afterTree)) killed.push(pid);
        else errors.push(`${pid}: taskkill-tree-remains`);
        continue;
      } catch {
        const afterTaskkill = inspectProcessTreeImpl(pid, { trackedPids });
        if (completeTreeAbsent(afterTaskkill)) {
          killed.push(pid);
          continue;
        }
        const noDescendants = beforeTree.descendants.length === 0
          && treeShapeKnown(afterTaskkill)
          && afterTaskkill?.root_present === true
          && afterTaskkill.descendants.length === 0;
        if (!noDescendants || revalidatePidImpl(pid) !== true) {
          errors.push(`${pid}: taskkill-failed-tree-ambiguous`);
          continue;
        }
        const beforeFallback = inspectProcessTreeImpl(pid, { trackedPids: [Number(pid)] });
        if (!exactChildFreeRoot(beforeFallback, pid)) {
          errors.push(`${pid}: fallback-tree-changed`);
          continue;
        }
        if (revalidatePidImpl(pid) !== true) {
          errors.push(`${pid}: fallback-ownership-revalidation-failed`);
          continue;
        }
        try { processKillImpl(pid, "SIGKILL"); }
        catch { /* final absence proof below is authoritative */ }
        const afterFallback = inspectProcessTreeImpl(pid, { trackedPids: [Number(pid)] });
        if (completeTreeAbsent(afterFallback)) killed.push(pid);
        else errors.push(`${pid}: fallback-failed`);
        continue;
      }
    }
    try {
      processKillImpl(pid, "SIGKILL");
      killed.push(pid);
    } catch (e) {
      errors.push(`${pid}: ${String(e?.message || e)}`);
    }
  }
  return { killed, errors };
}

/** Best-effort daemon descendant snapshot. Empty means none found or unknown. */
export function listBusyDescendants(rootPid = process.pid, {
  execFileImpl = execFile,
  now = Date.now,
  cacheMs = 5000
} = {}) {
  if (!IS_WIN) return Promise.resolve([]);
  const cacheKey = Number(rootPid);
  const cached = descendantCache.get(cacheKey);
  const requestedAt = now();
  if (cached?.promise) return cached.promise;
  if (cached && requestedAt - cached.at < cacheMs) return Promise.resolve(cached.value);
  const script = `
$bridgeRootPid = ${Number(rootPid)}
$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$byParent = @{}
foreach ($proc in $all) {
  $parent = [int]$proc.ParentProcessId
  if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = @() }
  $byParent[$parent] += $proc
}
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue($bridgeRootPid)
$out = @()
while ($queue.Count -gt 0) {
  $parent = $queue.Dequeue()
  foreach ($child in @($byParent[$parent])) {
    $pidValue = [int]$child.ProcessId
    if ($pidValue -eq $PID) { continue }
    $queue.Enqueue($pidValue)
    $ticks = [double]$child.KernelModeTime + [double]$child.UserModeTime
    $out += [pscustomobject]@{ pid = $pidValue; name = [string]$child.Name; cpu_ticks = $ticks }
  }
}
@($out) | ConvertTo-Json -Compress
`;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  descendantCache.set(cacheKey, { at: 0, value: [], promise });
  const finish = (value) => {
    descendantCache.set(cacheKey, { at: now(), value, promise: null });
    resolvePromise(value);
  };
  execFileImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true
  }, (error, stdout) => {
      if (error || !stdout.trim()) return finish([]);
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const sampledAt = now();
        const elapsed = descendantSampleAt ? (sampledAt - descendantSampleAt) / 1000 : 0;
        const cores = Math.max(os.cpus().length, 1);
        const next = new Map();
        const result = rows.map((row) => {
          const ticks = Number(row.cpu_ticks);
          const prior = descendantCpuSnapshot.get(row.pid);
          const cpu = elapsed > 0 && Number.isFinite(ticks) && Number.isFinite(prior)
            ? Math.max(0, Math.round((((ticks - prior) / 1e7) / elapsed / cores) * 1000) / 10)
            : null;
          next.set(row.pid, ticks);
          return { pid: row.pid, name: row.name, cpu_percent: cpu };
        });
        descendantCpuSnapshot = next;
        descendantSampleAt = sampledAt;
        finish(result);
      } catch { finish([]); }
    });
  return promise;
}

/** Launch a fresh daemon, fully detached, logging to logPath. Returns child pid. */
export function spawnDaemonDetached(repoRoot, logPath, extraEnv = {}, {
  spawnImpl = spawn,
  mkdirSyncImpl = fs.mkdirSync,
  openSyncImpl = fs.openSync,
  closeSyncImpl = fs.closeSync
} = {}) {
  mkdirSyncImpl(path.dirname(logPath), { recursive: true });
  const fd = openSyncImpl(logPath, "a");
  let child;
  try {
    child = spawnImpl(process.execPath, [path.join("src", "daemon.mjs")], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...extraEnv },
      windowsHide: true
    });
  } finally {
    closeSyncImpl(fd);
  }
  child.unref();
  return child.pid;
}

export function waitFor(fn, { timeoutMs = 15000, intervalMs = 500 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      if (await fn()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function waitForHealth(port, timeoutMs = 15000, {
  probeHealthImpl = probeHealth,
  validateHealth = (health) => health.ok,
} = {}) {
  return waitFor(async () => validateHealth(await probeHealthImpl(port)), { timeoutMs });
}

export function waitForPortFree(port, timeoutMs = 10000) {
  const free = () => new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(true));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(true); });
  });
  return waitFor(free, { timeoutMs, intervalMs: 400 });
}
