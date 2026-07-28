#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildBridgeProcessIdentity,
  findPidsOnPort,
  waitForHealth
} from "../src/proc.mjs";

const lsof = findPidsOnPort(8788, {
  execFileSyncImpl(command) {
    assert.equal(command, "lsof");
    return "12\n34\n";
  }
});
assert.deepEqual(lsof, [12, 34]);

const ss = findPidsOnPort(8788, {
  execFileSyncImpl(command) {
    if (command === "lsof") throw new Error("missing");
    assert.equal(command, "ss");
    return 'LISTEN users:(("node",pid=56,fd=7),("node",pid=56,fd=8))';
  }
});
assert.deepEqual(ss, [56]);
assert.deepEqual(findPidsOnPort(0), []);
assert.equal(buildBridgeProcessIdentity("/tmp/repo"), buildBridgeProcessIdentity("/tmp/repo"));
assert.notEqual(buildBridgeProcessIdentity("/tmp/repo"), buildBridgeProcessIdentity("/tmp/other"));

let probes = 0;
assert.equal(await waitForHealth(8788, 100, {
  probeHealthImpl: async () => ({ ok: ++probes === 2 })
}), true);

console.log("PROC TEST PASS");
