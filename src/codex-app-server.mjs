const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TURN_TIMEOUT_MS = 25 * 60 * 1000;

function turnSandboxPolicy(mode, cwd) {
  if (!mode) return undefined;
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "workspace-write") return { type: "workspaceWrite", writableRoots: cwd ? [cwd] : [], networkAccess: false };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  throw new CodexAppServerError(`Unsupported Codex sandbox mode: ${mode}`);
}

export class CodexAppServerError extends Error {}

class Connection {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
  }

  async open() {
    this.socket = new WebSocket(this.endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexAppServerError("Codex app-server connection timed out")), 10000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new CodexAppServerError("Codex app-server connection failed")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("error", () => this.fail(new CodexAppServerError("Codex app-server socket error")));
    await this.request("initialize", { clientInfo: { name: "codex-meta-bridge", version: "0.9.0" } });
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch { return; }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexAppServerError(message.error.message || "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(message)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  waitFor(match, timeoutMs = 180000) {
    const known = this.notifications.find(match);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new CodexAppServerError("Codex turn timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  fail(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters = [];
  }

  close() {
    try { this.socket?.close(); } catch { /* best effort */ }
  }
}

async function withConnection(endpoint, action) {
  const connection = new Connection(endpoint);
  try {
    await connection.open();
    return await action(connection);
  } finally {
    connection.close();
  }
}

export async function appServerReady(endpoint) {
  return withConnection(endpoint, async () => true);
}

export async function appServerResume(endpoint, threadId, options = {}) {
  return withConnection(endpoint, (connection) => connection.request("thread/resume", {
    threadId,
    cwd: options.cwd || undefined,
    sandbox: options.sandbox || undefined,
    model: options.model || undefined,
    approvalPolicy: "never"
  }));
}

export async function appServerStartThread(endpoint, { cwd, sandbox, model }) {
  return withConnection(endpoint, (connection) => connection.request("thread/start", {
    cwd,
    sandbox,
    model: model || undefined,
    approvalPolicy: "never",
    threadSource: "user"
  }));
}

function completedReply(turn) {
  const reply = [...(turn?.items || [])].reverse().find((item) => item.type === "agentMessage" && item.phase === "final_answer")?.text || null;
  return reply ? { turnId: turn.id, reply } : null;
}

function hasExactUserMessage(turn, message) {
  return (turn?.items || []).some((item) => item.type === "userMessage" && item.content?.some((part) => part.type === "text" && part.text === message));
}

export async function appServerCompletedTurn(endpoint, { threadId, message }) {
  return withConnection(endpoint, async (connection) => {
    const read = await connection.request("thread/read", { threadId, includeTurns: true });
    const turn = [...(read?.thread?.turns || [])].reverse().find((entry) => hasExactUserMessage(entry, message) && completedReply(entry));
    return turn ? completedReply(turn) : null;
  });
}

export async function appServerRunTurn(endpoint, { threadId, message, cwd, sandbox, model, resume = true }) {
  return withConnection(endpoint, async (connection) => {
    if (resume) {
      await connection.request("thread/resume", {
        threadId,
        cwd: cwd || undefined,
        sandbox: sandbox || undefined,
        model: model || undefined,
        approvalPolicy: "never"
      });
    }
    const started = await connection.request("turn/start", {
      threadId,
      cwd: cwd || undefined,
      sandboxPolicy: turnSandboxPolicy(sandbox, cwd),
      model: model || undefined,
      input: [{ type: "text", text: message }]
    });
    const turnId = started?.turn?.id;
    if (!turnId) throw new CodexAppServerError("Codex app-server did not return a turn id");
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const read = await connection.request("thread/read", { threadId, includeTurns: true });
      const turn = read?.thread?.turns?.find((entry) => entry.id === turnId);
      const reply = completedReply(turn);
      if (reply) return reply;
      if (turn?.status?.type === "failed" || turn?.status === "failed") {
        throw new CodexAppServerError(turn?.error?.message || "Codex turn failed");
      }
      await sleep(300);
    }
    throw new CodexAppServerError("Codex turn timed out");
  });
}

export async function waitForAppServer(endpoint, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { await appServerReady(endpoint); return; }
    catch (error) { lastError = error; await sleep(150); }
  }
  throw lastError || new CodexAppServerError("Codex app-server did not start");
}
