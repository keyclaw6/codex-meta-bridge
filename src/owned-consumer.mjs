import fs from "node:fs";
import path from "node:path";
import { loadCodex, missionResumeOptions, startOwnedMission } from "./owned.mjs";
import { StartCoordinator } from "./start-coordinator.mjs";
import { findRolloutFile } from "./tailer.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizedStartPayload({ prompt, threadOptions }) {
  const cwd = threadOptions.workingDirectory
    ? path.resolve(threadOptions.workingDirectory)
    : null;
  return {
    prompt,
    model: threadOptions.model || null,
    working_directory: cwd,
    sandbox_mode: threadOptions.sandboxMode || null,
    approval_policy: threadOptions.approvalPolicy || "never"
  };
}

/**
 * In owned mode the daemon is the sole logical writer. Starts and legacy
 * queued commands enter one durable coordinator, while the first SDK
 * turn and all later steering share one FIFO queue per thread.
 */
export class OwnedConsumer {
  constructor({
    cfg,
    pool,
    inbox,
    audit,
    codexFactory = null,
    pollMs = 3000,
    setTarget,
    startCoordinator = null,
    rolloutResolver = (threadId) => findRolloutFile(cfg.codexHome, threadId),
    staleReleaseMs = 15000
  }) {
    this.cfg = cfg;
    this.pool = pool;
    this.inbox = inbox;
    this.audit = audit;
    this.codexFactory = codexFactory;
    this.pollMs = pollMs;
    this.setTarget = setTarget;
    this.startCoordinator = startCoordinator || new StartCoordinator({
      statePath: path.join(cfg.bridgeDir, "state", "start-bindings.json")
    });
    this.rolloutResolver = rolloutResolver;
    this.staleReleaseMs = staleReleaseMs;
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    this.commandsDir = path.join(inbox.root, "..", "commands");
    this.skippedForLiaison = new Set();
    this.activeTurns = new Map();
    this.threadQueues = new Map();
    this.startOperations = new Map();
    this.recovery = null;
    this.recovering = false;
    fs.mkdirSync(this.commandsDir, { recursive: true });
    fs.mkdirSync(this.inbox.delivering, { recursive: true });
  }

  async start() {
    this.recovering = true;
    this.recovery = this.reconcileAfterRestart();
    try {
      await this.recovery;
    } catch (error) {
      this.lastError = String(error?.message || error);
      this.audit("owned_reconcile_error", {}, this.lastError);
    } finally {
      this.recovering = false;
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  interruptTurn(threadId) {
    const controller = this.activeTurns.get(threadId);
    if (!controller) return false;
    controller.abort(new Error(`Recovery interruption requested for thread ${threadId}`));
    return true;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.recovery;
      await this.reconcileUncertainBindings();
      await this.processCommands();
      await this.processPending();
    } catch (error) {
      this.lastError = String(error?.message || error);
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

  steeringBlockReason(targetThreadId) {
    if (this.recovering) return "startup reconciliation is still in progress";
    const binding = this.startCoordinator.list().find(
      (record) => record.binding.thread_id === targetThreadId
    );
    if (binding?.state === "uncertain") {
      return `start binding ${binding.request_key} is uncertain; reconcile it before steering`;
    }
    const completed = binding?.state === "terminal" && binding.history.some((entry) => entry.state === "active");
    if (binding && binding.state !== "active" && !completed) {
      return `binding ${binding.request_key} is ${binding.state}; steering is allowed only while active`;
    }
    const uncertainDelivery = this.inbox.listState().delivering.find(
      (ticket) => ticket.target_thread_id === targetThreadId && ticket.uncertain
    );
    if (uncertainDelivery) {
      return `ticket ${uncertainDelivery.ticket} has an uncertain delivery outcome and will not be replayed`;
    }
    return null;
  }

  enqueueThread(threadId, task) {
    const previous = this.threadQueues.get(threadId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.threadQueues.set(threadId, current);
    const cleanup = () => {
      if (this.threadQueues.get(threadId) === current) this.threadQueues.delete(threadId);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async waitForRollout(threadId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rolloutPath = await this.rolloutResolver(threadId);
      if (rolloutPath) return path.resolve(rolloutPath);
      await sleep(100);
    }
    throw new Error(`rollout for thread ${threadId} was not found within ${timeoutMs}ms`);
  }

  async startMission({
    requestKey,
    startType = "start_mission",
    prompt,
    threadOptions = {}
  }) {
    if (this.recovery) await this.recovery;
    const reserved = await this.startCoordinator.reserve({
      requestKey,
      normalizedPayload: normalizedStartPayload({ prompt, threadOptions }),
      type: startType
    });
    if (reserved.reused) {
      const inFlight = this.startOperations.get(requestKey);
      if (inFlight) return { ...(await inFlight), reused: true };
      return this.startResult(reserved.record, true);
    }

    const operation = this.startReservedMission({
      requestKey,
      prompt,
      threadOptions
    });
    this.startOperations.set(requestKey, operation);
    try {
      return await operation;
    } finally {
      if (this.startOperations.get(requestKey) === operation) {
        this.startOperations.delete(requestKey);
      }
    }
  }

  async startReservedMission({
    requestKey,
    prompt,
    threadOptions
  }) {
    let sideEffectBoundary = false;
    let releasePublication = null;
    try {
      await this.startCoordinator.transition(requestKey, "thread-starting");
      sideEffectBoundary = true;

      const controller = new AbortController();
      const started = await startOwnedMission({
        prompt,
        threadOptions,
        codexFactory: this.codexFactory,
        signal: controller.signal,
        log: (message) => this.audit("start_mission_log", { request_key: requestKey }, message)
      });
      const threadId = await started.threadIdPromise;
      const publicationReady = new Promise((resolve) => { releasePublication = resolve; });
      this.trackInitialTurn({
        requestKey,
        threadId,
        controller,
        threadPromise: started.threadPromise,
        publicationReady
      });
      const rolloutPath = await this.waitForRollout(threadId);
      const threadBinding = {
        thread_id: threadId,
        rollout_path: rolloutPath
      };
      await this.startCoordinator.transition(requestKey, "thread-bound", { binding: threadBinding });

      const missionOptions = {
        thread_id: threadId,
        model: threadOptions.model || null,
        cwd: threadOptions.workingDirectory || null,
        sandbox_mode: threadOptions.sandboxMode || this.cfg.default_mission_sandbox,
        approval_policy: threadOptions.approvalPolicy || "never"
      };
      this.inbox.recordMissionOptions(missionOptions);
      this.setTarget?.(threadId, {
        cwd: missionOptions.cwd,
        sandbox_mode: missionOptions.sandbox_mode,
        request_key: requestKey
      });

      const active = await this.startCoordinator.transition(requestKey, "active");
      releasePublication();
      this.audit("start_mission_active", { request_key: requestKey, thread_id: threadId }, true);
      return this.startResult(active, false);
    } catch (error) {
      if (sideEffectBoundary) {
        const current = this.startCoordinator.get(requestKey);
        if (current && current.state !== "uncertain" && current.state !== "terminal") {
          await this.startCoordinator.markUncertain(
            requestKey,
            `start failed after a side-effect boundary: ${String(error?.message || error)}`
          ).catch(() => {});
        }
      } else {
        const current = this.startCoordinator.get(requestKey);
        if (current?.state === "reserved") {
          await this.startCoordinator.transition(requestKey, "terminal", {
            reason: `start failed before side effects: ${String(error?.message || error)}`
          }).catch(() => {});
        }
      }
      releasePublication?.();
      this.audit("start_mission_failed", {
        request_key: requestKey,
        start_type: "start_mission"
      }, String(error?.message || error));
      throw error;
    }
  }

  trackInitialTurn({ requestKey, threadId, controller, threadPromise, publicationReady }) {
    this.activeTurns.set(threadId, controller);
    const initial = Promise.resolve(threadPromise);
    this.threadQueues.set(threadId, initial);
    const finish = async (failure = null) => {
      await publicationReady;
      if (this.activeTurns.get(threadId) === controller) this.activeTurns.delete(threadId);
      if (this.threadQueues.get(threadId) === initial) this.threadQueues.delete(threadId);
      const current = this.startCoordinator.get(requestKey);
      if (current?.state === "active") {
        await this.startCoordinator.transition(requestKey, "terminal", {
          reason: failure ? `initial turn failed: ${String(failure?.message || failure)}` : "initial turn completed"
        }).catch((error) => this.audit("start_terminal_failed", { request_key: requestKey }, String(error?.message || error)));
      }
    };
    initial.then(() => finish(), (error) => finish(error));
  }

  startResult(record, reused) {
    return {
      ok: true,
      reused,
      request_key: record.request_key,
      payload_hash: record.payload_hash,
      state: record.state,
      thread_id: record.binding.thread_id || null,
      rollout_path: record.binding.rollout_path || null
    };
  }

  async processCommands() {
    const files = fs.existsSync(this.commandsDir)
      ? fs.readdirSync(this.commandsDir).filter((file) => file.endsWith(".json")).sort()
      : [];
    for (const file of files) {
      const commandPath = path.join(this.commandsDir, file);
      let command;
      try {
        command = JSON.parse(fs.readFileSync(commandPath, "utf8"));
      } catch {
        fs.renameSync(commandPath, `${commandPath}.bad`);
        continue;
      }
      if (command.type === "start_mission") {
        try {
          await this.startMission({
            requestKey: command.request_key || command.requestKey || command.id,
            startType: "start_mission",
            prompt: command.prompt,
            threadOptions: command.threadOptions || {}
          });
        } catch (error) {
          this.audit("start_mission_command_failed", { file }, String(error?.message || error));
        }
      }
      fs.rmSync(commandPath, { force: true });
    }
  }

  async processPending() {
    const pendingDir = this.inbox.pending;
    if (!fs.existsSync(pendingDir)) return;
    const files = fs.readdirSync(pendingDir).filter((file) => file.endsWith(".json"));
    const withMeta = files.map((file) => {
      let priority = "normal";
      try {
        priority = JSON.parse(fs.readFileSync(path.join(pendingDir, file), "utf8")).priority || "normal";
      } catch { /* unreadable ticket stays pending */ }
      return { file, priority };
    }).sort((a, b) => (
      a.priority === b.priority
        ? a.file.localeCompare(b.file)
        : a.priority === "urgent" ? -1 : 1
    ));

    for (const { file } of withMeta) {
      const from = path.join(pendingDir, file);
      const inflight = path.join(this.inbox.delivering, file);
      let ticket;
      try {
        ticket = JSON.parse(fs.readFileSync(from, "utf8"));
      } catch {
        continue;
      }
      const target = ticket.target_thread_id || this.cfg.targetThreadId;
      if (!target) continue;
      if (this.desktopGuardBlocks(target)) {
        if (!this.skippedForLiaison.has(ticket.ticket)) {
          this.skippedForLiaison.add(ticket.ticket);
          if (this.skippedForLiaison.size > 500) this.skippedForLiaison.clear();
          this.audit("owned_guard_skip", { ticket: ticket.ticket, target }, "Desktop-owned target left pending");
        }
        continue;
      }
      const blocked = this.steeringBlockReason(target);
      if (blocked) {
        this.audit("owned_steering_blocked", { ticket: ticket.ticket, target }, blocked);
        continue;
      }

      ticket = {
        ...ticket,
        delivery_started_at: new Date().toISOString(),
        delivery_owner_pid: process.pid,
        delivery_owner_id: this.inbox.deliveryOwnerId
      };
      try {
        fs.writeFileSync(from, `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
        fs.renameSync(from, inflight);
      } catch {
        continue;
      }
      this.enqueueThread(target, async () => {
        const controller = new AbortController();
        try {
          const codex = await loadCodex(this.codexFactory);
          const thread = codex.resumeThread(
            target,
            missionResumeOptions({ cfg: this.cfg, inbox: this.inbox, threadId: target })
          );
          this.activeTurns.set(target, controller);
          const turn = await thread.run(ticket.message, { signal: controller.signal });
          this.audit("owned_delivered", { ticket: ticket.ticket }, String(turn?.finalResponse ?? "").slice(0, 160));
          fs.renameSync(inflight, path.join(this.inbox.delivered, file));
        } catch (error) {
          const message = String(error?.message || error);
          try {
            fs.writeFileSync(
              path.join(this.inbox.failed, file),
              `${JSON.stringify({ ...ticket, failure: message }, null, 2)}\n`,
              "utf8"
            );
            fs.rmSync(inflight, { force: true });
          } catch { /* best effort */ }
          this.audit("owned_delivery_failed", { ticket: ticket?.ticket }, message);
        } finally {
          if (this.activeTurns.get(target) === controller) this.activeTurns.delete(target);
        }
      });
    }
  }

  async reconcileAfterRestart() {
    for (const record of this.startCoordinator.list()) {
      if (record.state === "terminal") continue;
      if (record.state === "reserved") {
        await this.startCoordinator.transition(record.request_key, "terminal", {
          reason: "daemon restart recovered an abandoned reservation before any side effects"
        });
        continue;
      }
      if (record.state !== "uncertain") {
        await this.startCoordinator.markUncertain(
          record.request_key,
          `daemon restart crossed durable ${record.state} boundary`
        );
      }
    }
    await this.reconcileUncertainBindings();
  }

  async reconcileUncertainBindings() {
    for (const record of this.startCoordinator.list()) {
      if (record.state !== "uncertain") continue;
      const threadId = record.binding.thread_id;
      if (!threadId) continue;
      const noTurn = !this.activeTurns.has(threadId) && !this.threadQueues.has(threadId);
      const noUncertainDelivery = !this.inbox.listState().delivering.some(
        (ticket) => ticket.target_thread_id === threadId
      );
      const digest = threadId ? this.pool?.get(threadId)?.digest?.() : null;
      const rolloutIdle = (
        digest?.rolloutFound === true &&
        digest?.active_command == null &&
        Number(digest?.idleSeconds) * 1000 >= this.staleReleaseMs
      );
      const enteredAt = Date.parse(record.state_entered_at);
      if (!Number.isFinite(enteredAt) || Date.now() - enteredAt < this.staleReleaseMs) continue;
      if (noTurn && noUncertainDelivery && rolloutIdle) {
        await this.startCoordinator.reconcile(record.request_key, {
          state: "terminal",
          positive_evidence: true,
          reason: "restart reconciliation: rollout idle with no active turn or uncertain delivery"
        });
        this.audit("start_binding_reconciled", {
          request_key: record.request_key,
          thread_id: threadId
        }, "terminal");
      }
    }
  }
}
