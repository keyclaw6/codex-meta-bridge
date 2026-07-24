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
    this.root = path.join(bridgeDir, "inbox");
    this.pending = path.join(this.root, "pending");
    this.delivered = path.join(this.root, "delivered");
    this.failed = path.join(this.root, "failed");
    this.confirmationsPath = path.join(this.root, "confirmations.jsonl");
    this.callbacksAckPath = path.join(this.root, "callbacks-acked.jsonl");
    for (const d of [this.pending, this.delivered, this.failed]) fs.mkdirSync(d, { recursive: true });
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
              preview: (o.message || "").slice(0, 160)
            };
          } catch {
            return { ticket: f, status, error: "unreadable" };
          }
        });
    };
    return {
      pending: read(this.pending, "pending"),
      delivered: read(this.delivered, "delivered"),
      failed: read(this.failed, "failed")
    };
  }
}
