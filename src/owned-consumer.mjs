import fs from "node:fs";
import path from "node:path";
import { loadCodex, startOwnedMission } from "./owned.mjs";

/**
 * In owned mode, the daemon delivers steering itself (no Desktop liaison).
 * The consumer polls the inbox pending/ dir, delivers each ticket via the
 * Codex SDK against the owned target, and processes mission-start commands.
 *
 * SAFETY: refuses to run a turn against a thread whose rollout session_meta
 * says it is Codex Desktop-owned, unless cfg.allowOwnedForDesktop is true.
 * This is the guard against dual-writer rollout corruption.
 */
export class OwnedConsumer {
  constructor({ cfg, pool, inbox, audit, codexFactory = null, pollMs = 3000, setTarget }) {
    this.cfg = cfg;
    this.pool = pool;
    this.inbox = inbox;
    this.audit = audit;
    this.codexFactory = codexFactory;
    this.pollMs = pollMs;
    this.setTarget = setTarget; // (threadId, missionOptions) => void  (persist + retarget tailer)
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    this.commandsDir = path.join(inbox.root, "..", "commands");
    this.deliveringDir = path.join(inbox.root, "delivering");
    this.skippedForLiaison = new Set(); // audit-once memory for liaison-routed tickets
    fs.mkdirSync(this.commandsDir, { recursive: true });
    fs.mkdirSync(this.deliveringDir, { recursive: true });
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.processCommands();
      await this.processPending();
    } catch (e) {
      this.lastError = String(e?.message || e);
      this.audit("owned_consumer_error", {}, this.lastError);
    } finally {
      this.busy = false;
    }
  }

  desktopGuardBlocks(targetThreadId) {
    if (this.cfg.allowOwnedForDesktop) return false;
    const originator = this.pool?.get(targetThreadId)?.digest?.().sessionMeta?.originator || "";
    return /desktop/i.test(originator);
  }

  async processCommands() {
    const files = fs.existsSync(this.commandsDir)
      ? fs.readdirSync(this.commandsDir).filter((f) => f.endsWith(".json")).sort()
      : [];
    for (const f of files) {
      const p = path.join(this.commandsDir, f);
      let cmd;
      try { cmd = JSON.parse(fs.readFileSync(p, "utf8")); }
      catch { fs.renameSync(p, p + ".bad"); continue; }
      if (cmd.type === "start_mission") {
        this.audit("start_mission_begin", { file: f }, true);
        try {
          await startOwnedMission({
            prompt: cmd.prompt,
            threadOptions: cmd.threadOptions || {},
            codexFactory: this.codexFactory,
            onThreadId: (id) => {
              this.audit("start_mission_thread", { threadId: id }, true);
              this.setTarget?.(id, {
                cwd: cmd.threadOptions?.workingDirectory || null,
                sandbox_mode: cmd.threadOptions?.sandboxMode
              });
            },
            log: (m) => this.audit("start_mission_log", {}, m)
          });
        } catch (e) {
          this.audit("start_mission_failed", { file: f }, String(e?.message || e));
        }
      }
      fs.rmSync(p, { force: true });
    }
  }

  async processPending() {
    const pendingDir = this.inbox.pending;
    if (!fs.existsSync(pendingDir)) return;
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return;

    // urgent first, then oldest by filename (timestamp-prefixed)
    const withMeta = files.map((f) => {
      let priority = "normal";
      try { priority = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")).priority || "normal"; } catch { /* ignore */ }
      return { f, priority };
    }).sort((a, b) => (a.priority === b.priority ? a.f.localeCompare(b.f) : a.priority === "urgent" ? -1 : 1));
    for (const { f } of withMeta) {
      const from = path.join(pendingDir, f);
      const inflight = path.join(this.deliveringDir, f);
      let ticket;
      try { ticket = JSON.parse(fs.readFileSync(from, "utf8")); }
      catch { continue; }
      const target = ticket.target_thread_id || this.cfg.targetThreadId;
      if (!target) continue;

      // Per-target dual-writer guard (mixed-mode routing): Desktop-owned
      // targets are NOT run via the SDK — the ticket is LEFT IN PENDING for
      // the Desktop liaison pump to deliver. Audited once per ticket.
      if (this.desktopGuardBlocks(target)) {
        if (!this.skippedForLiaison.has(ticket.ticket)) {
          this.skippedForLiaison.add(ticket.ticket);
          if (this.skippedForLiaison.size > 500) this.skippedForLiaison.clear();
          this.audit("owned_guard_skip", { ticket: ticket.ticket, target }, "Desktop-owned target: left in pending for the liaison pump (dual-writer guard)");
        }
        continue;
      }

      try { fs.renameSync(from, inflight); } catch { continue; } // claim it
      try {
        // ticket.message already contains the [HYPERAGENT-STEERING <id>] marker.
        const c = await loadCodex(this.codexFactory);
        const thread = c.resumeThread(target, { skipGitRepoCheck: true });
        const turn = await thread.run(ticket.message);
        this.audit("owned_delivered", { ticket: ticket.ticket }, String(turn?.finalResponse ?? "").slice(0, 160));
        fs.renameSync(inflight, path.join(this.inbox.delivered, f));
      } catch (e) {
        const msg = String(e?.message || e);
        try {
          fs.writeFileSync(path.join(this.inbox.failed, f), JSON.stringify({ ...ticket, failure: msg }, null, 2));
          fs.rmSync(inflight, { force: true });
        } catch { /* ignore */ }
        this.audit("owned_delivery_failed", { ticket: ticket?.ticket }, msg);
      }
    }
  }
}
