import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promises as fsp } from "node:fs";

const SCHEMA_VERSION = 1;
const START_TYPES = new Set(["start_mission", "start_visible_cli_mission"]);
const VISIBILITIES = new Set(["headless", "visible"]);
const STATES = new Set([
  "reserved",
  "thread-starting",
  "thread-bound",
  "viewer-starting",
  "active",
  "terminal",
  "uncertain"
]);
const BINDING_FIELDS = new Set([
  "thread_id",
  "rollout_path",
  "writer_owner_pid",
  "writer_pid",
  "viewer_launch_id",
  "viewer_pid",
  "viewer_window_pid",
  "viewer_hwnd",
  "viewer_window_session_id",
  "viewer_title",
  "receipt_path",
  "receipt_nonce"
]);
const NEXT_STATES = {
  reserved: new Set(["thread-starting", "terminal", "uncertain"]),
  "thread-starting": new Set(["thread-bound", "terminal", "uncertain"]),
  "thread-bound": new Set(["viewer-starting", "active", "terminal", "uncertain"]),
  "viewer-starting": new Set(["active", "terminal", "uncertain"]),
  active: new Set(["terminal", "uncertain"]),
  uncertain: new Set(),
  terminal: new Set()
};

const SNAPSHOT_FIELDS = new Set(["schema_version", "records"]);
const RECORD_FIELDS = new Set([
  "request_key",
  "payload_hash",
  "start_type",
  "visibility",
  "state",
  "created_at",
  "updated_at",
  "state_entered_at",
  "ended_at",
  "reason",
  "binding",
  "history"
]);
const HISTORY_FIELDS = new Set(["state", "at"]);

export class StartCoordinatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StartCoordinatorError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new StartCoordinatorError(code, message, details);
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_STATE_FILE", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_STATE_FILE", `${label} contains unsupported field ${key}`);
  }
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_PAYLOAD", "Normalized payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail("INVALID_PAYLOAD", `Normalized payload contains unsupported ${typeof value}`);
  }
  if (seen.has(value)) fail("INVALID_PAYLOAD", "Normalized payload must not be cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INVALID_PAYLOAD", "Normalized payload must contain only plain objects and arrays");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail("INVALID_PAYLOAD", "Normalized payload must not contain symbol keys");
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Hash a caller-normalized payload. Defaults and path normalization belong to the caller. */
export function canonicalPayloadHash(normalizedPayload) {
  if (!normalizedPayload || typeof normalizedPayload !== "object" || Array.isArray(normalizedPayload)) {
    fail("INVALID_PAYLOAD", "Normalized payload must be an object");
  }
  return crypto.createHash("sha256").update(canonicalJson(normalizedPayload), "utf8").digest("hex");
}

/** Atomically replace a JSON snapshot after flushing the replacement file. */
export async function atomicWriteJson(statePath, snapshot) {
  const directory = path.dirname(statePath);
  await fsp.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(statePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temporaryPath, statePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporaryPath).catch(() => {});
    throw error;
  }

  // File data is already flushed before the atomic rename. Directory syncing is
  // unsupported on some platforms (notably Windows), so it is best-effort.
  let directoryHandle;
  try {
    directoryHandle = await fsp.open(directory, "r");
    await directoryHandle.sync();
  } catch {
    // The committed file remains authoritative.
  } finally {
    if (directoryHandle) await directoryHandle.close().catch(() => {});
  }
}

function clone(value) {
  return structuredClone(value);
}

function assertString(value, label, { nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && value.trim() === "")) {
    fail("INVALID_ARGUMENT", `${label} must be ${nonempty ? "a non-empty" : "a"} string`);
  }
}

function sanitizeBinding(binding = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("INVALID_ARGUMENT", "binding must be an object");
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(binding)) {
    if (!BINDING_FIELDS.has(key)) fail("INVALID_ARGUMENT", `binding contains unsupported field ${key}`);
    if (["writer_owner_pid", "writer_pid", "viewer_pid", "viewer_window_pid"].includes(key)) {
      if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_ARGUMENT", `${key} must be a positive safe integer`);
    } else if (key === "viewer_window_session_id") {
      if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_ARGUMENT", `${key} must be a non-negative safe integer`);
    } else {
      assertString(value, key);
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function mergeBinding(current, supplied) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(sanitizeBinding(supplied))) {
    if (merged[key] !== undefined && merged[key] !== value) {
      fail("BINDING_CONFLICT", `${key} cannot change once bound`, { field: key });
    }
    merged[key] = value;
  }
  return merged;
}

function requireBinding(record, fields, state) {
  const missing = fields.filter((field) => record.binding[field] === undefined);
  if (missing.length > 0) {
    fail("INCOMPLETE_BINDING", `${state} requires ${missing.join(", ")}`, { state, missing });
  }
}

function validateStateRequirements(record, { allowLegacyViewerEvidence = false } = {}) {
  if (["thread-bound", "viewer-starting", "active"].includes(record.state)) {
    requireBinding(record, ["thread_id", "rollout_path"], record.state);
  }
  if (record.state === "viewer-starting") {
    if (record.visibility !== "visible") fail("INVALID_TRANSITION", "Only visible starts may enter viewer-starting");
    requireBinding(record, ["viewer_launch_id", "viewer_title", "receipt_path", "receipt_nonce"], record.state);
  }
  if (record.state === "active" && record.visibility === "visible") {
    const required = [
      "viewer_launch_id",
      "viewer_pid",
      "viewer_hwnd",
      "viewer_title",
      "receipt_path",
      "receipt_nonce"
    ];
    if (!allowLegacyViewerEvidence) {
      required.push("viewer_window_pid", "viewer_window_session_id");
    }
    requireBinding(record, required, record.state);
  }
}

function validateLoadedSnapshot(snapshot) {
  assertExactKeys(snapshot, SNAPSHOT_FIELDS, "snapshot");
  if (snapshot.schema_version !== SCHEMA_VERSION || !Array.isArray(snapshot.records)) {
    fail("INVALID_STATE_FILE", "Unsupported start coordinator snapshot");
  }
  const keys = new Set();
  for (const record of snapshot.records) {
    assertExactKeys(record, RECORD_FIELDS, "record");
    assertString(record.request_key, "request_key");
    if (keys.has(record.request_key)) fail("INVALID_STATE_FILE", `Duplicate request key ${record.request_key}`);
    keys.add(record.request_key);
    if (!/^[a-f0-9]{64}$/.test(record.payload_hash || "")) fail("INVALID_STATE_FILE", "Invalid payload hash");
    if (!START_TYPES.has(record.start_type) || !VISIBILITIES.has(record.visibility) || !STATES.has(record.state)) {
      fail("INVALID_STATE_FILE", "Invalid start coordinator record enum");
    }
    for (const field of ["created_at", "updated_at", "state_entered_at"]) assertString(record[field], field);
    if (record.ended_at !== null) assertString(record.ended_at, "ended_at");
    if (record.reason !== null) assertString(record.reason, "reason");
    assertExactKeys(record.binding, BINDING_FIELDS, "binding");
    sanitizeBinding(record.binding);
    if (!Array.isArray(record.history) || record.history.length === 0) fail("INVALID_STATE_FILE", "Record history is required");
    for (const entry of record.history) {
      assertExactKeys(entry, HISTORY_FIELDS, "history entry");
      if (!STATES.has(entry.state)) fail("INVALID_STATE_FILE", "Invalid history state");
      assertString(entry.at, "history timestamp");
    }
    if (record.history.at(-1).state !== record.state) fail("INVALID_STATE_FILE", "History does not match current state");
    if (record.state === "terminal" && (!record.ended_at || !record.reason)) {
      fail("INVALID_STATE_FILE", "Terminal records require ended_at and reason");
    }
    if (record.state === "uncertain" && !record.reason) fail("INVALID_STATE_FILE", "Uncertain records require a reason");
    // Schema v1 records created before window-session binding remain readable.
    // Reconciliation treats their missing after-side evidence as non-positive.
    validateStateRequirements(record, { allowLegacyViewerEvidence: true });
  }
  return snapshot;
}

export class StartCoordinator {
  constructor({ statePath, now = () => new Date().toISOString(), persistSnapshot = atomicWriteJson }) {
    assertString(statePath, "statePath");
    if (typeof now !== "function" || typeof persistSnapshot !== "function") {
      fail("INVALID_ARGUMENT", "now and persistSnapshot must be functions");
    }
    this.statePath = path.resolve(statePath);
    this.now = now;
    this.persistSnapshot = persistSnapshot;
    this._tail = Promise.resolve();
    const snapshot = fs.existsSync(this.statePath)
      ? validateLoadedSnapshot(JSON.parse(fs.readFileSync(this.statePath, "utf8")))
      : { schema_version: SCHEMA_VERSION, records: [] };
    this._records = new Map(snapshot.records.map((record) => [record.request_key, clone(record)]));
  }

  get(requestKey) {
    const record = this._records.get(requestKey);
    return record ? clone(record) : null;
  }

  list() {
    return [...this._records.values()].map(clone);
  }

  async reserve({ requestKey, normalizedPayload, type, visibility }) {
    return this._exclusive(async () => {
      assertString(requestKey, "requestKey");
      if (requestKey.length > 200) fail("INVALID_ARGUMENT", "requestKey must be at most 200 characters");
      if (!START_TYPES.has(type)) fail("INVALID_ARGUMENT", `Unsupported start type ${type}`);
      if (!VISIBILITIES.has(visibility)) fail("INVALID_ARGUMENT", `Unsupported visibility ${visibility}`);
      if ((type === "start_visible_cli_mission") !== (visibility === "visible")) {
        fail("INVALID_ARGUMENT", `${type} requires ${type === "start_visible_cli_mission" ? "visible" : "headless"} visibility`);
      }
      const payloadHash = canonicalPayloadHash({ start_tool_kind: type, visibility, payload: normalizedPayload });

      const uncertain = [...this._records.values()].find((record) => record.state === "uncertain");
      if (uncertain) {
        fail("UNCERTAIN_BINDING", "A start binding is uncertain and all starts fail closed", {
          request_key: uncertain.request_key,
          state: uncertain.state,
          reason: uncertain.reason
        });
      }

      const existing = this._records.get(requestKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.start_type !== type || existing.visibility !== visibility) {
          fail("REQUEST_KEY_CONFLICT", "Request key was already used with a different normalized payload", {
            request_key: requestKey,
            existing_payload_hash: existing.payload_hash,
            supplied_payload_hash: payloadHash
          });
        }
        return { reused: true, record: clone(existing) };
      }

      const visibleLease = [...this._records.values()].find(
        (record) => record.visibility === "visible" && record.state !== "terminal"
      );
      if (visibleLease) {
        fail("VISIBLE_LEASE_CONFLICT", "A nonterminal visible start binding already owns the lease", {
          request_key: visibleLease.request_key,
          state: visibleLease.state
        });
      }

      const at = this._timestamp();
      const record = {
        request_key: requestKey,
        payload_hash: payloadHash,
        start_type: type,
        visibility,
        state: "reserved",
        created_at: at,
        updated_at: at,
        state_entered_at: at,
        ended_at: null,
        reason: null,
        binding: {},
        history: [{ state: "reserved", at }]
      };
      const next = new Map(this._records);
      next.set(requestKey, record);
      await this._commit(next);
      return { reused: false, record: clone(record) };
    });
  }

  async transition(requestKey, nextState, details = {}) {
    return this._exclusive(() => this._transition(requestKey, nextState, details, false));
  }

  async markUncertain(requestKey, reason, binding = {}) {
    return this.transition(requestKey, "uncertain", { reason, binding });
  }

  async reconcile(requestKey, decision) {
    return this._exclusive(async () => {
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        fail("INVALID_ARGUMENT", "decision must be an object");
      }
      for (const key of Object.keys(decision)) {
        if (!new Set(["state", "positive_evidence", "reason", "binding"]).has(key)) {
          fail("INVALID_ARGUMENT", `decision contains unsupported field ${key}`);
        }
      }
      if (decision.positive_evidence !== true) {
        fail("RECONCILE_EVIDENCE_REQUIRED", "Reconciliation requires an explicit positive evidence decision");
      }
      if (!new Set(["active", "terminal"]).has(decision.state)) {
        fail("INVALID_ARGUMENT", "Reconciliation may decide only active or terminal");
      }
      const current = this._records.get(requestKey);
      if (!current) fail("BINDING_NOT_FOUND", `Unknown request key ${requestKey}`);
      if (current.state !== "uncertain") {
        fail("INVALID_TRANSITION", "Only an uncertain binding may be reconciled", {
          request_key: requestKey,
          state: current.state
        });
      }
      return this._transition(requestKey, decision.state, {
        reason: decision.reason,
        binding: decision.binding || {}
      }, true);
    });
  }

  async _transition(requestKey, nextState, details, reconciling) {
    assertString(requestKey, "requestKey");
    if (!STATES.has(nextState)) fail("INVALID_ARGUMENT", `Unknown state ${nextState}`);
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      fail("INVALID_ARGUMENT", "transition details must be an object");
    }
    for (const key of Object.keys(details)) {
      if (!new Set(["reason", "binding"]).has(key)) fail("INVALID_ARGUMENT", `details contains unsupported field ${key}`);
    }
    const current = this._records.get(requestKey);
    if (!current) fail("BINDING_NOT_FOUND", `Unknown request key ${requestKey}`);
    if (!reconciling && !NEXT_STATES[current.state].has(nextState)) {
      fail("INVALID_TRANSITION", `${current.state} cannot transition to ${nextState}`, {
        request_key: requestKey,
        from: current.state,
        to: nextState
      });
    }
    if (reconciling && current.state !== "uncertain") {
      fail("INVALID_TRANSITION", "Only uncertain bindings may use reconciliation");
    }
    if (["terminal", "uncertain"].includes(nextState)) assertString(details.reason, `${nextState} reason`);
    if (!["terminal", "uncertain"].includes(nextState) && details.reason !== undefined) {
      fail("INVALID_ARGUMENT", `A reason is not accepted for ${nextState}`);
    }

    const at = this._timestamp();
    const record = {
      ...current,
      state: nextState,
      updated_at: at,
      state_entered_at: at,
      ended_at: nextState === "terminal" ? at : null,
      reason: details.reason ?? null,
      binding: mergeBinding(current.binding, details.binding || {}),
      history: [...current.history, { state: nextState, at }]
    };
    if (nextState === "viewer-starting" && current.visibility !== "visible") {
      fail("INVALID_TRANSITION", "Only visible starts may enter viewer-starting");
    }
    if (nextState === "active" && current.state === "thread-bound" && current.visibility !== "headless" && !reconciling) {
      fail("INVALID_TRANSITION", "Visible starts must pass through viewer-starting before active");
    }
    validateStateRequirements(record);

    const next = new Map(this._records);
    next.set(requestKey, record);
    await this._commit(next);
    return clone(record);
  }

  _timestamp() {
    const at = this.now();
    assertString(at, "timestamp");
    return at;
  }

  async _commit(nextRecords) {
    const snapshot = {
      schema_version: SCHEMA_VERSION,
      records: [...nextRecords.values()].map(clone)
    };
    await this.persistSnapshot(this.statePath, snapshot);
    this._records = nextRecords;
  }

  _exclusive(operation) {
    const result = this._tail.then(operation, operation);
    this._tail = result.catch(() => {});
    return result;
  }
}
