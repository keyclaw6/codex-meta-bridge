import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STEERING_MARKER } from "./tailer.mjs";

/**
 * Steering inbox on disk. The daemon writes tickets to pending/; the Desktop
 * liaison thread delivers each via codex_app__send_message_to_thread and moves
 * the file to delivered/ (or failed/). Confirmation is observed independently
 * by the tailer when the tagged message appears in the target rollout.
 */
export class Inbox {
  constructor(bridgeDir) {
    this.deliveryOwnerId = crypto.randomUUID();
    this.root = path.join(bridgeDir, "inbox");
    this.pending = path.join(this.root, "pending");
    this.delivering = path.join(this.root, "delivering");
    this.delivered = path.join(this.root, "delivered");
    this.failed = path.join(this.root, "failed");
    this.confirmationsPath = path.join(this.root, "confirmations.jsonl");
    this.callbacksAckPath = path.join(this.root, "callbacks-acked.jsonl");
    this.missionOptionsPath = path.join(this.root, "mission-options.jsonl");
    for (const d of [this.pending, this.delivering, this.delivered, this.failed]) fs.mkdirSync(d, { recursive: true });
  }

  recordMissionOptions({ thread_id, cwd = null, sandbox_mode, approval_policy = "never", at = new Date().toISOString() }) {
    fs.appendFileSync(this.missionOptionsPath, JSON.stringify({ thread_id, cwd, sandbox_mode, approval_policy, at }) + "\n", "utf8");
  }

  missionOptions(threadId) {
    if (!fs.existsSync(this.missionOptionsPath)) return null;
    let found = null;
    for (const line of fs.readFileSync(this.missionOptionsPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const options = JSON.parse(t);
        if (options.thread_id === threadId) found = options;
      } catch { /* skip */ }
    }
    return found;
  }

  markCallbackAcked(id) {
    fs.appendFileSync(this.callbacksAckPath, JSON.stringify({ id, acked_at: new Date().toISOString() }) + "\n", "utf8");
  }

  ackedCallbacks() {
    const set = new Set();
    if (!fs.existsSync(this.callbacksAckPath)) return set;
    for (const line of fs.readFileSync(this.callbacksAckPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { set.add(JSON.parse(t).id); } catch { /* skip */ }
    }
    return set;
  }

  /** Write a control command (e.g. start_mission) for the owned consumer. */
  createCommand(cmd) {
    const commandsDir = path.join(this.root, "..", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
    const file = path.join(commandsDir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, created_at: new Date().toISOString(), ...cmd }, null, 2) + "\n", "utf8");
    return { id, file };
  }

  createTicket({ message, targetThreadId, priority = "normal" }) {
    const ticket = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
    const payload = {
      ticket,
      created_at: new Date().toISOString(),
      priority,
      target_thread_id: targetThreadId,
      message: `${STEERING_MARKER} ${ticket}]\n\n${message}`
    };
    const file = path.join(this.pending, `${ticket}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return payload;
  }

  markConfirmed(ticket, at) {
    fs.appendFileSync(this.confirmationsPath, JSON.stringify({ ticket, confirmed_at: at }) + "\n", "utf8");
  }

  confirmedTickets() {
    if (!fs.existsSync(this.confirmationsPath)) return new Map();
    const map = new Map();
    for (const line of fs.readFileSync(this.confirmationsPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        map.set(o.ticket, o.confirmed_at);
      } catch { /* skip */ }
    }
    return map;
  }

  listState() {
    const confirmed = this.confirmedTickets();
    const read = (dir, status) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            return {
              ticket: o.ticket,
              status,
              created_at: o.created_at,
              priority: o.priority,
              target_thread_id: o.target_thread_id,
              confirmed_in_rollout_at: confirmed.get(o.ticket) || null,
              preview: (o.message || "").slice(0, 160),
              ...(status === "delivering" ? {
                delivery_started_at: o.delivery_started_at || null,
                delivery_owner_pid: Number(o.delivery_owner_pid) || null,
                uncertain: o.delivery_owner_id !== this.deliveryOwnerId,
                uncertainty_reason: o.delivery_owner_id === this.deliveryOwnerId
                  ? null
                  : "delivery outcome is unknown after process restart; it will not be replayed"
              } : {}),
              ...(o.failure ? { failure: o.failure } : {})
            };
          } catch {
            return { ticket: f, status, error: "unreadable" };
          }
        });
    };
    return {
      pending: read(this.pending, "pending"),
      delivering: read(this.delivering, "delivering"),
      delivered: read(this.delivered, "delivered"),
      failed: read(this.failed, "failed")
    };
  }
}
