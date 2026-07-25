#!/usr/bin/env node
import {
  buildBridgeProcessIdentity,
  findOwnedBridgePidsOnPort,
  findPidsOnPort,
  findWindowsListenersOnPort,
  inspectWindowsProcess,
  inspectWindowsProcessTree,
  killPids,
  listBusyDescendants,
  spawnDaemonDetached
} from "../src/proc.mjs";

let failures = 0;
const check = (name, condition, extra = "") => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${extra}`); }
};

console.log("\n[proc-1] hidden and throttled descendant probe");
if (process.platform === "win32") {
  let calls = 0;
  let options = null;
  let clock = 1000;
  const execFileImpl = (_command, _args, receivedOptions, callback) => {
    calls++;
    options = receivedOptions;
    queueMicrotask(() => callback(null, "[]"));
  };
  const probeOptions = { execFileImpl, now: () => clock, cacheMs: 5000 };
  await listBusyDescendants(987654, probeOptions);
  await listBusyDescendants(987654, probeOptions);
  check("PowerShell helper is hidden", options?.windowsHide === true);
  check("repeated status probe reuses cache", calls === 1, `calls=${calls}`);
  clock += 5001;
  await listBusyDescendants(987654, probeOptions);
  check("probe refreshes after throttle interval", calls === 2, `calls=${calls}`);
} else {
  check("non-Windows descendant probe is shell-free", (await listBusyDescendants())?.length === 0);
}

console.log("\n[proc-2] port helpers are hidden and bounded");
{
  const calls = [];
  const execFileSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "netstat") return [
      "  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    4242",
      "  TCP    0.0.0.0:8787        0.0.0.0:0    LISTENING    4343",
      "  TCP    127.0.0.1:9999    127.0.0.1:8787 ESTABLISHED 4444",
      "",
    ].join("\r\n");
    return "";
  };
  const found = findPidsOnPort(8787, { execFileSyncImpl, platform: "win32", host: "127.0.0.1", timeoutMs: 4321 });
  check("netstat parser finds only the configured loopback listener PID", found.length === 1 && found[0] === 4242);
  const completeListeners = findWindowsListenersOnPort(8787, { execFileSyncImpl, platform: "win32", timeoutMs: 4321 });
  check("complete same-port snapshot preserves the wildcard listener", completeListeners.length === 2 && completeListeners.some((row) => row.address === "0.0.0.0" && row.pid === 4343));
  check("netstat helper is hidden", calls[0]?.options?.windowsHide === true);
  check("netstat helper has the supplied timeout", calls[0]?.options?.timeout === 4321);

  let treeCall = 0;
  let revalidations = 0;
  const killed = killPids([4242], {
    execFileSyncImpl,
    inspectProcessTreeImpl: () => treeCall++ === 0
      ? { root_present: true, descendants: [], tracked_present: [] }
      : { root_present: false, descendants: [], tracked_present: [] },
    revalidatePidImpl: (pid) => { revalidations++; return pid === 4242; },
    platform: "win32",
    timeoutMs: 3210,
    excludeSelf: false,
    verifiedPids: [4242]
  });
  check("taskkill reports the exact requested PID", killed.killed.length === 1 && killed.killed[0] === 4242);
  check("ownership is revalidated immediately before tree kill", revalidations === 1);
  const taskkillCall = calls.find((call) => call.command === "taskkill");
  check("taskkill helper is hidden", taskkillCall?.options?.windowsHide === true);
  check("taskkill helper is bounded", taskkillCall?.options?.timeout === 3210);

  let lateChildRootKills = 0;
  let lateChildTreeCall = 0;
  const lateChild = killPids([4243], {
    execFileSyncImpl: () => {},
    processKillImpl: () => { lateChildRootKills++; },
    inspectProcessTreeImpl: () => ++lateChildTreeCall === 1
      ? { root_present: true, descendants: [], tracked_present: [] }
      : { root_present: false, descendants: [7243], tracked_present: [] },
    revalidatePidImpl: () => true,
    platform: "win32",
    excludeSelf: false,
    verifiedPids: [4243]
  });
  check("a new descendant after taskkill blocks success and replacement authority", lateChild.killed.length === 0 && lateChild.errors.length === 1 && lateChildRootKills === 0);

  const fallbacks = [];
  let fallbackTreeCall = 0;
  let fallbackRevalidations = 0;
  const fallback = killPids([4322], {
    execFileSyncImpl: () => { throw new Error("taskkill unavailable"); },
    processKillImpl: (pid, signal) => fallbacks.push({ pid, signal }),
    inspectProcessTreeImpl: () => {
      fallbackTreeCall++;
      if (fallbackTreeCall === 1) return { root_present: true, descendants: [], tracked_present: [] };
      if (fallbackTreeCall === 2) return { root_present: true, descendants: [], tracked_present: [4322] };
      if (fallbackTreeCall === 3) return { root_present: true, descendants: [], tracked_present: [4322] };
      return { root_present: false, descendants: [], tracked_present: [] };
    },
    revalidatePidImpl: (pid) => { fallbackRevalidations++; return pid === 4322; },
    platform: "win32",
    excludeSelf: false,
    verifiedPids: [4322]
  });
  check("Windows recovery falls back to the exact PID without another helper", fallback.killed[0] === 4322 && fallback.errors.length === 0);
  check("fallback uses an in-process force kill", JSON.stringify(fallbacks) === JSON.stringify([{ pid: 4322, signal: "SIGKILL" }]));
  check("fallback rechecks an exact child-free tree immediately before root kill", fallbackTreeCall === 4);
  check("fallback revalidates the same daemon instance at the final kill boundary", fallbackRevalidations === 3);

  let reusedPidDestructiveCalls = 0;
  let reusedPidRevalidations = 0;
  const reusedPid = killPids([4323], {
    execFileSyncImpl: () => { reusedPidDestructiveCalls++; },
    processKillImpl: () => { reusedPidDestructiveCalls++; },
    inspectProcessTreeImpl: () => ({ root_present: true, descendants: [], tracked_present: [] }),
    revalidatePidImpl: () => { reusedPidRevalidations++; return false; },
    platform: "win32",
    excludeSelf: false,
    verifiedPids: [4323]
  });
  check("PID reuse at the kill boundary fails before taskkill or root kill", reusedPid.killed.length === 0 && reusedPid.errors.length === 1 && reusedPidRevalidations === 1 && reusedPidDestructiveCalls === 0);

  let childFallbackCalls = 0;
  const childBlocked = killPids([4333], {
    execFileSyncImpl: () => { throw new Error("taskkill unavailable"); },
    processKillImpl: () => { childFallbackCalls++; },
    inspectProcessTreeImpl: (_pid, { trackedPids }) => trackedPids.length === 0
      ? { root_present: true, descendants: [7333], tracked_present: [] }
      : { root_present: true, descendants: [7333], tracked_present: [4333, 7333] },
    revalidatePidImpl: () => true,
    platform: "win32",
    verifiedPids: [4333]
  });
  check("failed tree kill never root-kills past a native child writer", childBlocked.killed.length === 0 && childBlocked.errors.length === 1 && childFallbackCalls === 0);

  let changingTreeCalls = 0;
  let changingTreeRootKills = 0;
  const changingTree = killPids([4334], {
    execFileSyncImpl: () => { throw new Error("taskkill unavailable"); },
    processKillImpl: () => { changingTreeRootKills++; },
    inspectProcessTreeImpl: () => {
      changingTreeCalls++;
      if (changingTreeCalls === 1) return { root_present: true, descendants: [], tracked_present: [] };
      if (changingTreeCalls === 2) return { root_present: true, descendants: [], tracked_present: [4334] };
      return { root_present: true, descendants: [7334], tracked_present: [4334] };
    },
    revalidatePidImpl: () => true,
    platform: "win32",
    verifiedPids: [4334]
  });
  check("a changing tree at the root-fallback boundary fails closed", changingTree.killed.length === 0 && changingTree.errors.length === 1 && changingTreeRootKills === 0);

  let unknownTreeKills = 0;
  const unknownTree = killPids([4335], {
    execFileSyncImpl: () => { unknownTreeKills++; },
    processKillImpl: () => { unknownTreeKills++; },
    inspectProcessTreeImpl: () => ({ root_present: true }),
    revalidatePidImpl: () => true,
    platform: "win32",
    verifiedPids: [4335]
  });
  check("an incomplete tree snapshot blocks every destructive helper", unknownTree.killed.length === 0 && unknownTree.errors.length === 1 && unknownTreeKills === 0);

  let failedFallbackTreeCall = 0;
  const failedFallback = killPids([4344], {
    execFileSyncImpl: () => { throw new Error("taskkill unavailable"); },
    processKillImpl: () => { throw new Error("process kill failed"); },
    inspectProcessTreeImpl: () => {
      failedFallbackTreeCall++;
      return { root_present: true, descendants: [], tracked_present: failedFallbackTreeCall === 1 ? [] : [4344] };
    },
    revalidatePidImpl: () => true,
    platform: "win32",
    verifiedPids: [4344]
  });
  check("processKill failure leaves the exact root unclaimed and blocks replacement", failedFallback.killed.length === 0 && failedFallback.errors.length === 1);

  let destructiveCalls = 0;
  const blocked = killPids([4, process.pid, 5555], {
    execFileSyncImpl: () => { destructiveCalls++; },
    processKillImpl: () => { destructiveCalls++; },
    platform: "win32",
    verifiedPids: [4, process.pid]
  });
  check("system, self, and unverified PIDs are never targeted", blocked.killed.length === 0 && blocked.errors.length === 3 && destructiveCalls === 0);
}

console.log("\n[proc-2b] listener ownership requires exact receipt and process identity");
{
  const repoRoot = "C:\\repo";
  const bridgeDir = "C:\\bridge";
  const nodePath = "C:\\node\\node.exe";
  const candidateId = "worktree-sha256:test";
  const processStartMs = Date.UTC(2026, 6, 25, 3, 0, 0);
  const processCreationFileTime = "134136108000000000";
  const exactListener = (pid = 4242) => [{ address: "127.0.0.1", port: 8787, pid, parseable: true }];
  const realpathSyncImpl = (value) => value;
  const receipt = {
    t: new Date(processStartMs + 50).toISOString(),
    event: "start",
    pid: 4242,
    candidate_id: candidateId,
    host: "127.0.0.1",
    port: 8787,
    process_instance: "12345678-1234-1234-1234-123456789abc",
    process_creation_time_filetime_utc: processCreationFileTime,
    repo_identity: buildBridgeProcessIdentity(repoRoot, { platform: "win32", realpathSyncImpl }),
  };
  const owned = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    nodePath,
    platform: "win32",
    processPid: 9000,
    findWindowsListenersOnPortImpl: () => exactListener(),
    inspectWindowsProcessImpl: () => ({ pid: 4242, executable_path: nodePath, started_at: new Date(processStartMs).toISOString(), creation_time_filetime_utc: processCreationFileTime }),
    readFileSyncImpl: () => JSON.stringify(receipt) + "\n",
    realpathSyncImpl,
  });
  check("one exact loopback listener receipt and OS process identity is owned", owned.ok === true && owned.owned[0] === 4242);

  const stale = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    nodePath,
    platform: "win32",
    processPid: 9000,
    findWindowsListenersOnPortImpl: () => exactListener(),
    inspectWindowsProcessImpl: () => ({
      pid: 4242,
      executable_path: nodePath,
      started_at: new Date(processStartMs + 500).toISOString(),
      creation_time_filetime_utc: (BigInt(processCreationFileTime) + 5_000_000n).toString(),
    }),
    readFileSyncImpl: () => JSON.stringify(receipt) + "\n",
    realpathSyncImpl,
  });
  check("a Node PID reused 500 ms later is ambiguous and not owned", stale.ok === false && stale.owned.length === 0 && stale.ambiguous[0]?.reason === "process-identity-mismatch");

  for (const badCreationValue of [Number(processCreationFileTime), `0${processCreationFileTime}`]) {
    const rounded = findOwnedBridgePidsOnPort(8787, {
      host: "127.0.0.1",
      repoRoot,
      bridgeDir,
      candidateId,
      nodePath,
      platform: "win32",
      processPid: 9000,
      findWindowsListenersOnPortImpl: () => exactListener(),
      inspectWindowsProcessImpl: () => ({ pid: 4242, executable_path: nodePath, started_at: new Date(processStartMs).toISOString(), creation_time_filetime_utc: processCreationFileTime }),
      readFileSyncImpl: () => JSON.stringify({ ...receipt, process_creation_time_filetime_utc: badCreationValue }) + "\n",
      realpathSyncImpl,
    });
    check("rounded or noncanonical creation-time receipts fail closed", rounded.ok === false && rounded.ambiguous[0]?.reason === "receipt-mismatch");
  }

  const foreign = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    nodePath,
    platform: "win32",
    processPid: 9000,
    findWindowsListenersOnPortImpl: () => exactListener(),
    inspectWindowsProcessImpl: () => ({ pid: 4242, executable_path: nodePath, started_at: new Date(processStartMs).toISOString(), creation_time_filetime_utc: processCreationFileTime }),
    readFileSyncImpl: () => JSON.stringify({ ...receipt, candidate_id: "foreign" }) + "\n",
    realpathSyncImpl,
  });
  check("foreign candidate receipt is ambiguous and untouched", foreign.ok === false && foreign.owned.length === 0 && foreign.ambiguous[0]?.reason === "receipt-mismatch");

  const multipleReceipt = { ...receipt, pid: 4243, process_instance: "87654321-4321-4321-4321-cba987654321" };
  const multiple = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    nodePath,
    platform: "win32",
    processPid: 9000,
    findWindowsListenersOnPortImpl: () => [...exactListener(4242), ...exactListener(4243)],
    inspectWindowsProcessImpl: (pid) => ({ pid, executable_path: nodePath, started_at: new Date(processStartMs).toISOString(), creation_time_filetime_utc: processCreationFileTime }),
    readFileSyncImpl: () => `${JSON.stringify(receipt)}\n${JSON.stringify(multipleReceipt)}\n`,
    realpathSyncImpl,
  });
  check("multiple exact-looking listeners are ambiguous and none may be killed", multiple.ok === false && multiple.owned.length === 0 && multiple.error === "PORT_OWNER_AMBIGUOUS");

  const exactPlusWildcard = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    platform: "win32",
    findWindowsListenersOnPortImpl: () => [...exactListener(), { address: "0.0.0.0", port: 8787, pid: 4343, parseable: true }],
  });
  check("an exact listener plus same-port wildcard makes the complete snapshot ambiguous", exactPlusWildcard.ok === false && exactPlusWildcard.listener_count === 2 && exactPlusWildcard.error === "PORT_OWNER_AMBIGUOUS");

  const wildcardOnly = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    platform: "win32",
    findWindowsListenersOnPortImpl: () => [{ address: "0.0.0.0", port: 8787, pid: 4343, parseable: true }],
  });
  check("a wildcard-only same-port snapshot is ambiguous rather than empty", wildcardOnly.ok === false && wildcardOnly.listener_count === 1 && wildcardOnly.error === "PORT_OWNER_AMBIGUOUS");

  const nonLoopback = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    platform: "win32",
    findWindowsListenersOnPortImpl: () => [{ address: "192.168.1.20", port: 8787, pid: 4344, parseable: true }],
  });
  check("a non-loopback same-port listener is ambiguous", nonLoopback.ok === false && nonLoopback.error === "PORT_OWNER_AMBIGUOUS");

  const unparsable = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    platform: "win32",
    findWindowsListenersOnPortImpl: () => [{ address: null, port: 8787, pid: null, parseable: false }],
  });
  check("an unparsable same-port listener row is ambiguous", unparsable.ok === false && unparsable.ambiguous[0]?.reason === "unparseable-listener");

  const protectedListeners = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    nodePath,
    platform: "win32",
    processPid: 9000,
    findWindowsListenersOnPortImpl: () => exactListener(4),
    readFileSyncImpl: () => "",
    realpathSyncImpl,
  });
  check("a system listener is protected ambiguity", protectedListeners.ok === false && protectedListeners.ambiguous.every((row) => row.reason === "protected-pid"));

  const selfListener = findOwnedBridgePidsOnPort(8787, {
    host: "127.0.0.1",
    repoRoot,
    bridgeDir,
    candidateId,
    platform: "win32",
    processPid: 9000,
    findWindowsListenersOnPortImpl: () => exactListener(9000),
    readFileSyncImpl: () => "",
    realpathSyncImpl,
  });
  check("the watchdog self listener is protected ambiguity", selfListener.ok === false && selfListener.ambiguous[0]?.reason === "protected-pid");

  const wildcard = findOwnedBridgePidsOnPort(8787, {
    host: "0.0.0.0",
    repoRoot,
    bridgeDir,
    candidateId,
    platform: "win32",
    findWindowsListenersOnPortImpl: () => { throw new Error("must fail before enumeration"); },
  });
  check("wildcard/non-loopback configuration has no recovery kill authority", wildcard.ok === false && wildcard.error === "LOOPBACK_OWNERSHIP_UNAVAILABLE");

  const helperCalls = [];
  const inspected = inspectWindowsProcess(4242, {
    timeoutMs: 222,
    execFileSyncImpl: (command, args, options) => {
      helperCalls.push({ command, args, options });
      return JSON.stringify({ pid: 4242, executable_path: nodePath, started_at: new Date(processStartMs).toISOString(), creation_time_filetime_utc: processCreationFileTime });
    },
  });
  check("process identity helper returns no command line", inspected?.pid === 4242 && !Object.hasOwn(inspected, "command_line"));
  check("process identity helper is hidden and bounded", helperCalls[0]?.options?.windowsHide === true && helperCalls[0]?.options?.timeout === 222);

  const treeCalls = [];
  const tree = inspectWindowsProcessTree(4242, {
    trackedPids: [4242, 5252],
    timeoutMs: 333,
    execFileSyncImpl: (command, args, options) => {
      treeCalls.push({ command, args, options });
      return "4242,100\n5252,4242\n";
    },
  });
  check("process tree helper returns PID topology only", tree?.root_present === true && tree.descendants[0] === 5252 && !Object.hasOwn(tree, "command_line"));
  check("process tree helper is hidden and bounded", treeCalls[0]?.options?.windowsHide === true && treeCalls[0]?.options?.timeout === 333);
}

console.log("\n[proc-3] detached daemon launch closes the parent's log descriptor");
{
  let opened = false;
  let closed = false;
  let spawnOptions = null;
  let unrefed = false;
  const pid = spawnDaemonDetached("C:\\repo", "C:\\logs\\daemon.log", { TEST_ONLY: "1" }, {
    mkdirSyncImpl: () => {},
    openSyncImpl: () => { opened = true; return 77; },
    closeSyncImpl: (fd) => { closed = fd === 77; },
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return { pid: 5252, unref: () => { unrefed = true; } };
    }
  });
  check("detached launch returns child PID", pid === 5252);
  check("daemon log descriptor was opened", opened);
  check("parent closes inherited log descriptor after spawn", closed);
  check("daemon child is detached and hidden", spawnOptions?.detached === true && spawnOptions?.windowsHide === true);
  check("daemon child is unrefed", unrefed);
}

console.log("");
if (failures === 0) { console.log("PROC TEST PASS"); process.exit(0); }
console.error(`PROC TEST FAIL (${failures})`); process.exit(1);
