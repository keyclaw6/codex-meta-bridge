#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  StartCoordinator,
  StartCoordinatorError,
  canonicalPayloadHash
} from "../src/start-coordinator.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-start-coordinator-"));
const statePath = path.join(tmp, "start-bindings.json");
const payload = { prompt: "secret", nested: { b: 2, a: 1 } };
assert.equal(
  canonicalPayloadHash(payload),
  canonicalPayloadHash({ nested: { a: 1, b: 2 }, prompt: "secret" })
);

const coordinator = new StartCoordinator({ statePath });
const first = await coordinator.reserve({
  requestKey: "mission-1",
  normalizedPayload: payload,
  type: "start_mission"
});
assert.equal(first.reused, false);
assert.equal((await coordinator.reserve({
  requestKey: "mission-1",
  normalizedPayload: payload,
  type: "start_mission"
})).reused, true);
await assert.rejects(
  coordinator.reserve({ requestKey: "mission-1", normalizedPayload: { prompt: "other" }, type: "start_mission" }),
  (error) => error instanceof StartCoordinatorError && error.code === "REQUEST_KEY_CONFLICT"
);
assert.equal(fs.readFileSync(statePath, "utf8").includes("secret"), false);

await coordinator.transition("mission-1", "thread-starting");
await assert.rejects(
  coordinator.transition("mission-1", "active"),
  (error) => error.code === "INVALID_TRANSITION"
);
await coordinator.transition("mission-1", "thread-bound", {
  binding: { thread_id: "thread-1", rollout_path: "/tmp/rollout.jsonl" }
});
await coordinator.transition("mission-1", "active");
await coordinator.transition("mission-1", "terminal", { reason: "complete" });
assert.equal(new StartCoordinator({ statePath }).get("mission-1").state, "terminal");

const uncertain = new StartCoordinator({ statePath: path.join(tmp, "uncertain.json") });
await uncertain.reserve({ requestKey: "u", normalizedPayload: payload, type: "start_mission" });
await uncertain.markUncertain("u", "unknown outcome");
await assert.rejects(
  uncertain.reserve({ requestKey: "blocked", normalizedPayload: payload, type: "start_mission" }),
  (error) => error.code === "UNCERTAIN_BINDING"
);
await uncertain.reconcile("u", { state: "terminal", positive_evidence: true, reason: "no side effect" });
assert.equal(uncertain.get("u").state, "terminal");

console.log("START COORDINATOR TEST PASS");
