import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadCodex, missionResumeOptions, startOwnedMission } from "./owned.mjs";
import { listBusyDescendants } from "./proc.mjs";
import {
  inspectVisibleViewerWindow,
  launchVisibleRolloutViewer,
  visibleViewerTitle
} from "./rollout-viewer.mjs";
import { StartCoordinator } from "./start-coordinator.mjs";
import { findRolloutFile } from "./tailer.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processExists(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

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
 * In owned mode the daemon is the sole logical writer. Both start tools and
 * legacy queued commands enter one durable coordinator, while the first SDK
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
    visibleViewerLauncher = launchVisibleRolloutViewer,
    viewerInspector = inspectVisibleViewerWindow,
    rolloutResolver = (threadId) => findRolloutFile(cfg.codexHome, threadId),
    writerProcesses = () => listBusyDescendants(process.pid, { cacheMs: 0 }),
    processExistsImpl = processExists,
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
    this.visibleViewerLauncher = visibleViewerLauncher;
    this.viewerInspector = viewerInspector;
    this.rolloutResolver = rolloutResolver;
    this.writerProcesses = writerProcesses;
    this.processExists = processExistsImpl;
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
    const completedHeadless = (
      binding?.visibility === "headless" &&
      binding.state === "terminal" &&
      binding.history.some((entry) => entry.state === "active")
    );
    if (binding && binding.state !== "active" && !completedHeadless) {
      return `${binding.visibility} binding ${binding.request_key} is ${binding.state}; steering is allowed only while active`;
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
    startType,
    prompt,
    threadOptions = {}
  }) {
    if (this.recovery) await this.recovery;
    const visibility = startType === "start_visible_cli_mission" ? "visible" : "headless";
    const reserved = await this.startCoordinator.reserve({
      requestKey,
      normalizedPayload: normalizedStartPayload({ prompt, threadOptions }),
      type: startType,
      visibility
    });
    if (reserved.reused) {
      const inFlight = this.startOperations.get(requestKey);
      if (inFlight) return { ...(await inFlight), reused: true };
      return this.startResult(reserved.record, true);
    }

    const operation = this.startReservedMission({
      requestKey,
      startType,
      visibility,
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
    startType,
    visibility,
    prompt,
    threadOptions
  }) {
    let sideEffectBoundary = false;
    let initialWriterPid = null;
    let releasePublication = null;
    try {
      const before = await this.writerProcesses();
      const beforePids = new Set(before.filter((row) => /codex/i.test(row.name || "")).map((row) => Number(row.pid)));
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
        visibility,
        controller,
        threadPromise: started.threadPromise,
        publicationReady
      });
      const rolloutPath = await this.waitForRollout(threadId);
      const after = await this.writerProcesses();
      const newWriters = after.filter(
        (row) => /codex/i.test(row.name || "") && !beforePids.has(Number(row.pid))
      );
      if (newWriters.length === 1) initialWriterPid = Number(newWriters[0].pid);

      const threadBinding = {
        thread_id: threadId,
        rollout_path: rolloutPath,
        writer_owner_pid: process.pid,
        ...(initialWriterPid ? { writer_pid: initialWriterPid } : {})
      };
      await this.startCoordinator.transition(requestKey, "thread-bound", { binding: threadBinding });
      if (visibility === "visible" && !initialWriterPid) {
        throw new Error("visible activation requires exactly one newly observed native Codex writer PID");
      }

      const missionOptions = {
        thread_id: threadId,
        cwd: threadOptions.workingDirectory || null,
        sandbox_mode: threadOptions.sandboxMode || this.cfg.default_mission_sandbox,
        approval_policy: threadOptions.approvalPolicy || "never"
      };
      this.inbox.recordMissionOptions(missionOptions);
      this.setTarget?.(threadId, {
        cwd: missionOptions.cwd,
        sandbox_mode: missionOptions.sandbox_mode,
        visible_cli: visibility === "visible",
        request_key: requestKey
      });

      if (visibility === "headless") {
        const active = await this.startCoordinator.transition(requestKey, "active");
        releasePublication();
        this.audit("start_mission_active", { request_key: requestKey, thread_id: threadId }, true);
        return this.startResult(active, false);
      }

      const viewerLaunchId = crypto.randomUUID();
      const receiptNonce = crypto.randomUUID();
      const receiptPath = path.join(
        this.cfg.bridgeDir,
        "state",
        "viewer-receipts",
        `${viewerLaunchId}.json`
      );
      const viewerTitle = visibleViewerTitle(viewerLaunchId);
      await this.startCoordinator.transition(requestKey, "viewer-starting", {
        binding: {
          viewer_launch_id: viewerLaunchId,
          viewer_title: viewerTitle,
          receipt_path: receiptPath,
          receipt_nonce: receiptNonce
        }
      });
      const launched = await this.visibleViewerLauncher({
        bindingId: viewerLaunchId,
        threadId,
        codexHome: this.cfg.codexHome,
        receiptPath,
        receiptNonce,
        cwd: threadOptions.workingDirectory || process.cwd()
      });
      if (
        launched.binding_id !== viewerLaunchId ||
        launched.thread_id !== threadId ||
        launched.receipt_nonce !== receiptNonce ||
        path.resolve(launched.rollout_path) !== rolloutPath ||
        launched.viewer_title !== viewerTitle
      ) {
        throw new Error("viewer receipt did not bind to the exact launch, SDK thread, rollout, nonce, and title");
      }
      const active = await this.startCoordinator.transition(requestKey, "active", {
        binding: {
          viewer_pid: Number(launched.viewer_pid),
          viewer_window_pid: Number(launched.window_pid),
          viewer_hwnd: String(launched.window_handle),
          viewer_window_session_id: Number(launched.session_id)
        }
      });
      releasePublication();
      this.audit("visible_cli_started", {
        request_key: requestKey,
        thread_id: threadId,
        writer_owner_pid: process.pid,
        writer_pid: initialWriterPid,
        viewer_pid: launched.viewer_pid,
        viewer_window_pid: launched.window_pid,
        viewer_hwnd: String(launched.window_handle),
        viewer_window_session_id: launched.session_id
      }, true);
      return this.startResult(active, false);
    } catch (error) {
      if (sideEffectBoundary) {
        const current = this.startCoordinator.get(requestKey);
        if (current && current.state !== "uncertain" && current.state !== "terminal") {
          await this.startCoordinator.markUncertain(
            requestKey,
            `start failed after a side-effect boundary: ${String(error?.message || error)}`,
            initialWriterPid ? { writer_pid: initialWriterPid } : {}
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
        start_type: startType
      }, String(error?.message || error));
      throw error;
    }
  }

  trackInitialTurn({ requestKey, threadId, visibility, controller, threadPromise, publicationReady }) {
    this.activeTurns.set(threadId, controller);
    const initial = Promise.resolve(threadPromise);
    this.threadQueues.set(threadId, initial);
    const finish = async (failure = null) => {
      await publicationReady;
      if (this.activeTurns.get(threadId) === controller) this.activeTurns.delete(threadId);
      if (this.threadQueues.get(threadId) === initial) this.threadQueues.delete(threadId);
      if (visibility !== "headless") return;
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
      visible: record.visibility === "visible",
      thread_id: record.binding.thread_id || null,
      rollout_path: record.binding.rollout_path || null,
      writer_owner_pid: record.binding.writer_owner_pid || null,
      writer_pid: record.binding.writer_pid || null,
      viewer_launch_id: record.binding.viewer_launch_id || null,
      viewer_pid: record.binding.viewer_pid || null,
      viewer_window_pid: record.binding.viewer_window_pid || null,
      viewer_hwnd: record.binding.viewer_hwnd || null,
      viewer_window_session_id: record.binding.viewer_window_session_id ?? null,
      viewer_title: record.binding.viewer_title || null
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
      if (record.visibility !== "visible") continue;

      const evidence = await this.inspectViewerBinding(record);
      const threadId = record.binding.thread_id;
      const writerPid = Number(record.binding.writer_pid);
      const noWriter = writerPid > 0 && !this.processExists(writerPid);
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
      if (evidence.active && noWriter && noTurn && noUncertainDelivery && rolloutIdle) {
        await this.startCoordinator.reconcile(record.request_key, {
          state: "active",
          positive_evidence: true,
          binding: evidence.binding
        });
        this.audit("visible_binding_reconciled", {
          request_key: record.request_key,
          thread_id: record.binding.thread_id
        }, "active");
        continue;
      }

      const enteredAt = Date.parse(record.state_entered_at);
      if (!Number.isFinite(enteredAt) || Date.now() - enteredAt < this.staleReleaseMs) continue;
      const noViewer = (
        !evidence.viewer_process_alive &&
        !evidence.window &&
        !evidence.identity_contradiction
      );
      if (noWriter && noViewer && noTurn && noUncertainDelivery && rolloutIdle) {
        await this.startCoordinator.reconcile(record.request_key, {
          state: "terminal",
          positive_evidence: true,
          reason: "stale viewer release: writer and viewer absent, rollout idle, no queued or uncertain delivery"
        });
        this.audit("visible_binding_reconciled", {
          request_key: record.request_key,
          thread_id: threadId
        }, "terminal");
      }
    }
  }

  async inspectViewerBinding(record) {
    const binding = record.binding;
    const previouslyActive = record.history.some((entry) => entry.state === "active");
    let receipt = null;
    try {
      receipt = JSON.parse(fs.readFileSync(binding.receipt_path, "utf8"));
    } catch { /* missing or incomplete receipt */ }
    let window = null;
    if (binding.viewer_title) {
      try {
        window = await this.viewerInspector(binding.viewer_title);
      } catch { /* inspection failure is not positive evidence */ }
    }
    const receiptCoreMatches = (
      receipt?.binding_id === binding.viewer_launch_id &&
      receipt?.thread_id === binding.thread_id &&
      receipt?.rollout_path &&
      path.resolve(receipt.rollout_path) === path.resolve(binding.rollout_path || "") &&
      receipt?.receipt_nonce === binding.receipt_nonce &&
      receipt?.viewer_title === binding.viewer_title
    );
    const receiptViewerPid = Number(receipt?.viewer_pid);
    const receiptViewerPidValid = Number.isSafeInteger(receiptViewerPid) && receiptViewerPid > 0;
    const receiptViewerMatches = receiptViewerPidValid && (
      !previouslyActive || receiptViewerPid === binding.viewer_pid
    );
    const receiptMatches = receiptCoreMatches && receiptViewerMatches;
    const viewerProcessAlive = receiptMatches && this.processExists(receiptViewerPid);
    const windowPid = Number(window?.window_pid);
    const windowHandle = String(window?.window_handle || "");
    const windowSessionId = Number(window?.session_id);
    const windowEvidenceValid = (
      window?.title === binding.viewer_title &&
      Number.isSafeInteger(windowPid) &&
      windowPid > 0 &&
      /^[1-9]\d*$/.test(windowHandle) &&
      Number.isSafeInteger(windowSessionId) &&
      windowSessionId >= 0
    );
    const windowMatches = windowEvidenceValid && (
      !previouslyActive || (
        windowPid === binding.viewer_window_pid &&
        windowHandle === binding.viewer_hwnd &&
        windowSessionId === binding.viewer_window_session_id
      )
    );
    const identityContradiction = (
      (receipt !== null && !receiptMatches) ||
      (window !== null && !windowMatches)
    );
    return {
      active: Boolean(receiptMatches && viewerProcessAlive && windowMatches),
      viewer_process_alive: Boolean(viewerProcessAlive),
      identity_contradiction: identityContradiction,
      window,
      binding: receiptMatches && windowMatches ? {
        viewer_pid: receiptViewerPid,
        viewer_window_pid: windowPid,
        viewer_hwnd: windowHandle,
        viewer_window_session_id: windowSessionId
      } : {}
    };
  }
}
