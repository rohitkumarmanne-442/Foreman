/**
 * Foreman adapter for OpenCode — https://opencode.ai/docs/plugins/
 *
 * Auto-loaded from .opencode/plugins/ (project) or ~/.config/opencode/plugins/
 * (global). Translates OpenCode tool events onto `foreman ingest`, Foreman's
 * normalized adapter API — every session becomes a risk-ranked review card.
 *
 * Installed by `foreman init --agent opencode`. No configuration needed.
 */
import { spawn } from "node:child_process";

const BIN = process.env.FOREMAN_BIN || "foreman"; // tests point this at the local CLI

function send(event) {
  return new Promise((resolve) => {
    try {
      const child = spawn(`${BIN} ingest`, { shell: true, stdio: ["pipe", "ignore", "ignore"] });
      child.on("exit", resolve);
      child.on("error", resolve); // foreman missing? never disturb the agent
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
    } catch {
      resolve();
    }
  });
}

const FAILURE = /(^|\n)\s*(error[:\s]|fatal:|npm ERR!|Traceback \(most recent call last\)|FAILED|command not found)/i;

export const ForemanPlugin = async ({ directory }) => {
  const cwd = directory || process.cwd();
  const argsByCall = new Map(); // callID -> tool args (captured before execution)
  let session = `opencode-${Date.now().toString(36)}`;

  const base = () => ({ agent: "opencode", session, cwd });

  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input?.sessionID) session = `opencode-${input.sessionID}`;
        if (input?.callID) argsByCall.set(input.callID, output?.args ?? {});
        if (argsByCall.size > 500) argsByCall.clear(); // bounded memory
      } catch { /* never disturb the agent */ }
    },

    "tool.execute.after": async (input, output) => {
      try {
        if (input?.sessionID) session = `opencode-${input.sessionID}`;
        const args = argsByCall.get(input?.callID) ?? output?.args ?? {};
        argsByCall.delete(input?.callID);
        const tool = String(input?.tool ?? "");
        const resultText = typeof output?.output === "string" ? output.output.slice(0, 8000) : "";

        if (tool === "bash") {
          await send({
            ...base(), kind: "command",
            command: String(args.command ?? args.cmd ?? "").slice(0, 2000),
            ok: !FAILURE.test(resultText),
          });
        } else if (tool === "edit") {
          await send({
            ...base(), kind: "file",
            file: String(args.filePath ?? args.file_path ?? ""),
            edits: [{
              old: String(args.oldString ?? args.old_string ?? "").slice(0, 4000),
              new: String(args.newString ?? args.new_string ?? "").slice(0, 4000),
            }],
          });
        } else if (tool === "write") {
          const content = String(args.content ?? "");
          await send({
            ...base(), kind: "file",
            file: String(args.filePath ?? args.file_path ?? ""),
            lines_after: content ? content.split("\n").length : 0,
            content: content.slice(0, 20000),
          });
        }
      } catch { /* never disturb the agent */ }
    },

    event: async ({ event }) => {
      try {
        if (event?.type === "session.idle" || event?.type === "session.deleted") {
          await send({ ...base(), kind: "end", message: "" });
        }
      } catch { /* never disturb the agent */ }
    },
  };
};
