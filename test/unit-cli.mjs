#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeCodexVersion, resolveCodexCli } from "../src/codex-cli.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cli-"));
const shim = path.join(tmp, "codex");
fs.writeFileSync(shim, "#!/bin/sh\necho codex-cli test\n", { mode: 0o755 });

assert.equal(resolveCodexCli({ cfg: { codex_cli_path: shim } }), shim);
assert.equal(resolveCodexCli({ env: { PATH: tmp } }), shim);
assert.equal(probeCodexVersion({ codex_cli_path: shim }), "codex-cli test");
fs.writeFileSync(shim, "#!/bin/sh\necho changed\n", { mode: 0o755 });
assert.equal(probeCodexVersion({ codex_cli_path: shim }), "codex-cli test");
assert.throws(() => resolveCodexCli({ env: { PATH: "" } }), /not found/);

console.log("CLI TEST PASS");
