import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalPayloadHash } from "./start-coordinator.mjs";
import {
  appServerReady,
  appServerCompletedTurn,
  appServerResume,
  appServerRunTurn,
  appServerStartThread,
  waitForAppServer
} from "./codex-app-server.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

export class NativeCliSessionManager {
  constructor({ cfg, repoRoot, audit = () => {}, spawnProcess = spawn }) {
    this.cfg = cfg;
    this.repoRoot = repoRoot;
    this.audit = audit;
    this.spawnProcess = spawnProcess;
    this.root = path.join(cfg.bridgeDir, "state", "native-cli");
    this.activePath = path.join(this.root, "active.json");
    this.appServerEndpoint = "ws://127.0.0.1:43855";
    this.startPromise = null;
    fs.mkdirSync(this.root, { recursive: true });
  }

  state() { return readJson(this.activePath); }

  owns(threadId) {
    const state = this.state();
    if (!state?.thread_id || state.thread_id !== threadId) return false;
    if (state.adapter === "app-server") return state.status !== "failed";
    return processExists(state.worker_pid);
  }

  summary() {
    const state = this.state();
    if (!state) return null;
    return {
      request_key: state.request_key,
      thread_id: state.thread_id || null,
      status: state.status,
      worker_pid: state.worker_pid || null,
      app_server_endpoint: state.app_server_endpoint || null,
      tui_title: state.tui_title || null,
      reply_count: Array.isArray(state.replies) ? state.replies.length : 0,
      live: state.adapter === "app-server" ? state.status !== "failed" : processExists(state.worker_pid),
      surface: state.adapter === "app-server" ? "codex-cli-tui" : "native-cli-terminal"
    };
  }

  async waitFor(predicate, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.state();
      if (state?.status === "failed") throw new Error(state.error || "native CLI session failed");
      if (predicate(state)) return state;
      await sleep(250);
    }
    throw new Error("native CLI session timed out");
  }

  async start({ requestKey, prompt, workingDirectory, sandboxMode, model = null }) {
    if (this.startPromise) return this.startPromise;
    const operation = this.startInternal({ requestKey, prompt, workingDirectory, sandboxMode, model });
    this.startPromise = operation;
    try { return await operation; }
    finally { if (this.startPromise === operation) this.startPromise = null; }
  }

  async startInternal({ requestKey, prompt, workingDirectory, sandboxMode, model }) {
    const payloadHash = canonicalPayloadHash({ prompt, workingDirectory, sandboxMode, model });
    const current = this.state();
    if (current && (current.adapter === "app-server" || processExists(current.worker_pid))) {
      if (current.request_key !== requestKey) throw new Error("one native CLI session is already active");
      if (current.payload_hash !== payloadHash) throw new Error("request key was already used with a different payload");
      if (current.adapter !== "app-server") {
        const migrated = await this.migrateToInteractiveTui(current, { workingDirectory, sandboxMode, model });
        return this.result(migrated, true);
      }
      if (current.status === "tui-starting" && (current.replies?.length || 0) === 0) {
        const turn = await appServerCompletedTurn(current.app_server_endpoint, { threadId: current.thread_id, message: prompt }) || await appServerRunTurn(current.app_server_endpoint, {
          threadId: current.thread_id,
          message: prompt,
          cwd: current.working_directory || workingDirectory,
          sandbox: current.sandbox_mode || sandboxMode,
          model: current.model || model,
          resume: false
        });
        const replied = this.recordReply(this.state(), { ticket: "initial", text: turn.reply, status: "tui-starting" });
        await this.launchTui(replied, {
          workingDirectory: replied.working_directory || workingDirectory,
          sandboxMode: replied.sandbox_mode || sandboxMode
        });
        const ready = { ...this.state(), status: "idle" };
        writeJson(this.activePath, ready);
        return this.result(ready, true);
      }
      const ready = await this.waitFor((state) => state?.thread_id && (state.replies?.length || 0) >= 1);
      return this.result(ready, true);
    }

    if (process.platform !== "win32") {
      throw new Error("automatic visible terminal launch is Windows-smoke-only; run scripts/native-cli-worker.mjs manually on Linux");
    }

    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(this.root, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJson(path.join(sessionDir, "launch.json"), {
      request_key: requestKey,
      payload_hash: payloadHash,
      working_directory: workingDirectory,
      sandbox_mode: sandboxMode,
      model
    });
    writeJson(this.activePath, {
      request_key: requestKey,
      payload_hash: payloadHash,
      session_id: sessionId,
      session_dir: sessionDir,
      adapter: "app-server",
      status: "starting",
      thread_id: null,
      worker_pid: null,
      app_server_endpoint: this.appServerEndpoint,
      working_directory: workingDirectory,
      sandbox_mode: sandboxMode,
      model,
      replies: [],
      created_at: new Date().toISOString()
    });
    const appServer = await this.ensureAppServer();
    const startedThread = await appServerStartThread(appServer.endpoint, { cwd: workingDirectory, sandbox: sandboxMode, model });
    const threadId = startedThread?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    const state = this.state();
    writeJson(this.activePath, {
      ...state,
      status: "turn-starting",
      thread_id: threadId,
      app_server_endpoint: appServer.endpoint,
      app_server_pid: appServer.pid || null
    });
    const turn = await appServerRunTurn(appServer.endpoint, { threadId, message: prompt, cwd: workingDirectory, sandbox: sandboxMode, model, resume: false });
    const replied = this.recordReply(this.state(), { ticket: "initial", text: turn.reply, status: "tui-starting" });
    await this.launchTui(replied, { workingDirectory, sandboxMode });
    const ready = { ...this.state(), status: "idle" };
    writeJson(this.activePath, ready);
    this.audit("codex_cli_tui_started", { request_key: requestKey, session_id: sessionId, thread_id: threadId }, true);
    return this.result(ready, false);
  }

  codexBinary() {
    return path.join(this.repoRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  }

  async ensureAppServer() {
    try {
      await appServerReady(this.appServerEndpoint);
      return { endpoint: this.appServerEndpoint, pid: null };
    } catch { /* start the local loopback server below */ }
    const child = this.spawnProcess(this.codexBinary(), ["app-server", "--listen", this.appServerEndpoint], {
      cwd: this.repoRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref?.();
    await waitForAppServer(this.appServerEndpoint);
    return { endpoint: this.appServerEndpoint, pid: child.pid || null };
  }

  async launchTui(state, { workingDirectory, sandboxMode }) {
    const title = `Codex CLI ${state.thread_id.slice(0, 8)}`;
    const terminal = this.spawnProcess("wt.exe", [
      "-w", "new", "new-tab",
      "--title", title,
      "--startingDirectory", workingDirectory,
      this.codexBinary(),
      "--remote", state.app_server_endpoint,
      "-C", workingDirectory,
      "-s", sandboxMode,
      "resume", state.thread_id
    ], {
      cwd: this.repoRoot,
      detached: true,
      windowsHide: false,
      stdio: "ignore"
    });
    terminal.unref?.();
    writeJson(this.activePath, {
      ...this.state(),
      tui_title: title,
      tui_launcher_pid: terminal.pid || null,
      status: "tui-starting"
    });
    await sleep(1000);
    return title;
  }

  recordReply(state, { ticket, text, status = "idle" }) {
    const replies = Array.isArray(state?.replies) ? state.replies : [];
    const next = { ...state, status, current_ticket: null, replies: [...replies, { ticket, text, at: new Date().toISOString() }] };
    writeJson(this.activePath, next);
    return next;
  }

  async migrateToInteractiveTui(current, { workingDirectory, sandboxMode, model }) {
    const appServer = await this.ensureAppServer();
    await appServerResume(appServer.endpoint, current.thread_id, { cwd: workingDirectory, sandbox: sandboxMode, model });
    const migrated = {
      ...current,
      adapter: "app-server",
      status: "tui-starting",
      worker_pid: null,
      app_server_endpoint: appServer.endpoint,
      app_server_pid: appServer.pid || null,
      working_directory: workingDirectory,
      sandbox_mode: sandboxMode,
      model,
      migrated_at: new Date().toISOString()
    };
    writeJson(this.activePath, migrated);
    await this.launchTui(migrated, { workingDirectory, sandboxMode });
    try { process.kill(Number(current.worker_pid)); } catch { /* old wrapper may already be gone */ }
    const ready = { ...this.state(), status: "idle" };
    writeJson(this.activePath, ready);
    this.audit("native_cli_tui_migrated", { thread_id: current.thread_id, request_key: current.request_key }, true);
    return ready;
  }

  result(state, reused) {
    const replies = Array.isArray(state.replies) ? state.replies : [];
    return {
      ok: true,
      request_key: state.request_key,
      thread_id: state.thread_id,
      state: state.status,
      reused,
      worker_pid: state.worker_pid,
      reply: replies.at(-1)?.text || null,
      surface: state.adapter === "app-server" ? "codex-cli-tui" : "native-cli-terminal",
      tui_title: state.tui_title || null
    };
  }

  async send({ threadId, message }) {
    const state = this.state();
    if (!state?.thread_id || state.thread_id !== threadId || !this.owns(threadId)) {
      throw new Error("native CLI session is not active for this thread");
    }
    const ticket = `native-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    if (state.adapter === "app-server") {
      const running = { ...state, status: "running", current_ticket: ticket };
      writeJson(this.activePath, running);
      try {
        const turn = await appServerRunTurn(state.app_server_endpoint, {
          threadId,
          message,
          cwd: state.working_directory || null,
          sandbox: state.sandbox_mode || null,
          model: state.model || null
        });
        const delivered = this.recordReply(this.state(), { ticket, text: turn.reply, status: "idle" });
        return { ok: true, ticket, target_thread_id: threadId, reply: turn.reply, surface: "codex-cli-tui", tui_title: delivered.tui_title || null };
      } catch (error) {
        writeJson(this.activePath, { ...this.state(), status: "failed", error: String(error?.message || error) });
        throw error;
      }
    }
    const queueDir = path.join(state.session_dir, "queue");
    writeJson(path.join(queueDir, `${ticket}.json`), { ticket, thread_id: threadId, message });
    const delivered = await this.waitFor((next) => next?.replies?.some((reply) => reply.ticket === ticket));
    const reply = delivered.replies.find((entry) => entry.ticket === ticket);
    return { ok: true, ticket, target_thread_id: threadId, reply: reply?.text || null, surface: "native-cli-terminal" };
  }
}
