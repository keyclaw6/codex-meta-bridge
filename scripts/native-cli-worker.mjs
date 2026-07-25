#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const optionValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const sessionDir = optionValue("--session-dir");
const activePath = optionValue("--active-state");
if (!sessionDir || !activePath) throw new Error("--session-dir and --active-state are required");

const launchPath = path.join(sessionDir, "launch.json");
const queueDir = path.join(sessionDir, "queue");
const initialPath = path.join(sessionDir, "initial.txt");
const launch = JSON.parse(fs.readFileSync(launchPath, "utf8"));
const codexScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@openai", "codex", "bin", "codex.js");

const readState = () => {
  try { return JSON.parse(fs.readFileSync(activePath, "utf8")); }
  catch { return {}; }
};
const writeState = (patch) => {
  const next = { ...readState(), ...patch, updated_at: new Date().toISOString() };
  const temp = `${activePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(temp, activePath);
  return next;
};

const print = (text = "") => process.stdout.write(String(text) + "\n");
print("Codex Meta native CLI session");
print("This terminal runs the real Codex CLI. Close it to end the session.");
writeState({ worker_pid: process.pid, status: "starting" });

async function runTurn({ prompt, ticket = "initial" }) {
  const state = readState();
  const args = [codexScript, "--sandbox", launch.sandbox_mode, "--ask-for-approval", "never", "--cd", launch.working_directory];
  if (launch.model) args.push("--model", launch.model);
  args.push("exec");
  if (state.thread_id) args.push("resume", "--json", state.thread_id, prompt);
  else args.push("--json", prompt);

  print("");
  print(`HyperAgent> ${prompt}`);
  writeState({ status: "running", current_ticket: ticket });
  const child = spawn(process.execPath, args, {
    cwd: launch.working_directory,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  writeState({ codex_pid: child.pid });
  let buffer = "";
  let reply = "";
  const handleLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) writeState({ thread_id: event.thread_id });
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        reply = String(event.item.text || "");
        print(`Codex> ${reply}`);
      } else if (event.type === "error" || event.type === "turn.failed") {
        print(`Codex error> ${event.message || event.error?.message || "turn failed"}`);
      }
    } catch { print(line); }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (buffer) handleLine(buffer);
  if (code !== 0 || !reply) throw new Error(`Codex CLI turn failed with exit ${code}`);
  const next = readState();
  const replies = Array.isArray(next.replies) ? next.replies : [];
  replies.push({ ticket, text: reply, at: new Date().toISOString() });
  writeState({ status: "idle", current_ticket: null, codex_pid: null, replies });
  print("Waiting for HyperAgent…");
}

try {
  const initial = fs.readFileSync(initialPath, "utf8");
  fs.rmSync(initialPath, { force: true });
  await runTurn({ prompt: initial, ticket: "initial" });
  for (;;) {
    const files = fs.readdirSync(queueDir).filter((name) => name.endsWith(".json")).sort();
    if (!files.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    const file = path.join(queueDir, files[0]);
    const item = JSON.parse(fs.readFileSync(file, "utf8"));
    await runTurn({ prompt: item.message, ticket: item.ticket });
    fs.rmSync(file, { force: true });
  }
} catch (error) {
  writeState({ status: "failed", error: String(error?.message || error), codex_pid: null });
  print(`Session failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
}
