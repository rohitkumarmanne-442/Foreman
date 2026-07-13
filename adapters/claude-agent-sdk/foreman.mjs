// Foreman adapter for the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
//
// SDK hook payloads carry the same fields as Claude Code's CLI hooks
// (tool_name, tool_input, session_id, cwd, hook_event_name…), so this adapter
// simply forwards each payload to `foreman hook claude-code` — the same
// battle-tested ingestion path the CLI uses. Fire-and-forget: your agent is
// never slowed down or blocked.
//
//   import { query } from "@anthropic-ai/claude-agent-sdk";
//   import { foremanHooks } from "./foreman.mjs";
//
//   for await (const msg of query({ prompt: "fix the bug", options: { hooks: foremanHooks() } })) { … }
//
// Override the binary with FOREMAN_BIN (e.g. a full path) if `foreman`
// isn't on PATH for the process running your agent.
import { spawn } from "node:child_process";

const BIN = process.env.FOREMAN_BIN || "foreman";

/** A single SDK-compatible hook callback that journals the event in Foreman. */
export function foremanForward() {
  return async (input) => {
    try {
      const payload = JSON.stringify(input);
      await new Promise((resolve) => {
        const p = spawn(BIN, ["hook", "claude-code"], {
          stdio: ["pipe", "ignore", "ignore"],
          shell: process.platform === "win32",
        });
        p.on("exit", resolve);
        p.on("error", resolve); // foreman missing must never break the agent
        p.stdin.write(payload);
        p.stdin.end();
      });
    } catch { /* never block the agent */ }
    return {}; // no behavior change — observe only
  };
}

/** Ready-made hooks object for query({ options: { hooks: foremanHooks() } }). */
export function foremanHooks() {
  const fwd = foremanForward();
  return {
    PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [fwd] }],
    PostToolUse: [{ hooks: [fwd] }],
    Stop: [{ hooks: [fwd] }],
    SessionStart: [{ hooks: [fwd] }],
  };
}
