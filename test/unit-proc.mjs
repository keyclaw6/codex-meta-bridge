#!/usr/bin/env node
import { listBusyDescendants } from "../src/proc.mjs";

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

console.log("");
if (failures === 0) { console.log("PROC TEST PASS"); process.exit(0); }
console.error(`PROC TEST FAIL (${failures})`); process.exit(1);
