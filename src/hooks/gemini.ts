import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendEvent } from "../journal.js";
import { extractClaims } from "../claims.js";

/**
 * Gemini CLI adapter — native hooks per
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
 *
 * Events arrive on stdin with shared base fields (session_id, cwd,
 * hook_event_name, transcript_path). Gemini requires stdout to be pure JSON,
 * so this handler always prints exactly one JSON object.
 *
 * SessionStart also carries the feedback loop: outstanding human flags are
 * returned as `additionalContext`, the documented way to inject context.
 */
interface GeminiPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { llmContent?: unknown; returnDisplay?: unknown; error?: unknown };
  reason?: string;
}

const STDIN_MAX = 10 * 1024 * 1024;
const SAMPLE_MAX = 20000;

function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}

function emit(json: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(json));
}

function lastText(transcriptPath: string): string {
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    const matches = [...text.matchAll(/"(?:text|content)"\s*:\s*"((?:[^"\\]|\\.){20,4000})"/g)];
    if (matches.length) return JSON.parse(`"${matches[matches.length - 1][1]}"`);
  } catch { /* transcript unreadable */ }
  return "";
}

export async function handleGeminiHook(): Promise<void> {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      if (raw.length < STDIN_MAX) raw += chunk;
    }
    const p: GeminiPayload = JSON.parse(raw);
    const session = p.session_id || "gemini-unknown";
    const cwd = p.cwd || process.cwd();
    const event = p.hook_event_name || "";
    const tool = p.tool_name || "";
    const input = p.tool_input || {};

    if (event === "SessionStart") {
      const { buildBrief } = await import("../feedback.js");
      const brief = buildBrief(cwd);
      emit(brief ? { hookSpecificOutput: { additionalContext: brief } } : {});
      return;
    }

    if (event === "BeforeTool" && (tool === "write_file" || tool === "replace")) {
      const file = String(input.file_path ?? input.path ?? "");
      let exists = false, lines = 0, content_sample = "";
      if (file) {
        try {
          const content = fs.readFileSync(file, "utf8");
          exists = true;
          lines = countLines(content);
          if (tool === "write_file") content_sample = content.slice(0, SAMPLE_MAX);
        } catch { exists = false; }
      }
      appendEvent({
        agent: "gemini", session, cwd, kind: "pre_tool",
        data: { tool: "Write", file, exists, lines, ...(content_sample ? { content_sample } : {}) },
      });
      emit({});
      return;
    }

    if (event === "AfterTool") {
      const ok = !p.tool_response?.error;
      if (tool === "run_shell_command") {
        appendEvent({
          agent: "gemini", session, cwd, kind: "tool",
          data: { tool: "Shell", ok, command: String(input.command ?? "").slice(0, 2000) },
        });
      } else if (tool === "write_file") {
        const content = String(input.content ?? "");
        appendEvent({
          agent: "gemini", session, cwd, kind: "tool",
          data: {
            tool: "Write", ok, file: String(input.file_path ?? ""),
            lines_after: countLines(content), content_sample: content.slice(0, SAMPLE_MAX),
          },
        });
      } else if (tool === "replace") {
        appendEvent({
          agent: "gemini", session, cwd, kind: "tool",
          data: {
            tool: "Edit", ok, file: String(input.file_path ?? ""),
            content_sample: String(input.new_string ?? "").slice(0, SAMPLE_MAX),
            edits: [{
              old: String(input.old_string ?? "").slice(0, 4000),
              new: String(input.new_string ?? "").slice(0, 4000),
            }],
          },
        });
      }
      emit({});
      return;
    }

    if (event === "SessionEnd") {
      const msg = p.transcript_path ? lastText(p.transcript_path) : "";
      appendEvent({
        agent: "gemini", session, cwd, kind: "session_end",
        data: { transcript: p.transcript_path || "", last_message: msg.slice(0, 4000), claims: extractClaims(msg) },
      });
      emit({});
      return;
    }

    emit({});
  } catch {
    try { emit({}); } catch { /* stdout gone */ }
  }
}

/** Install Foreman into Gemini CLI settings (project .gemini/ or user ~/.gemini/). */
export function installGeminiHooks(opts: { global: boolean }): string {
  const settingsPath = opts.global
    ? path.join(os.homedir(), ".gemini", "settings.json")
    : path.join(process.cwd(), ".gemini", "settings.json");

  const hookCmd = `"${process.execPath}" "${cliPath()}" hook gemini`;
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      throw new Error(`Could not parse ${settingsPath} — fix it first.`);
    }
  }
  settings.hooks = settings.hooks || {};

  const entries: Array<[string, string]> = [
    ["SessionStart", ".*"],
    ["BeforeTool", "write_file|replace"],
    ["AfterTool", ".*"],
    ["SessionEnd", ".*"],
  ];
  for (const [eventName, matcher] of entries) {
    const list: any[] = (settings.hooks[eventName] = settings.hooks[eventName] || []);
    const already = list.some((m: any) =>
      (m.hooks || []).some((h: any) => typeof h.command === "string" && h.command.includes("hook gemini"))
    );
    if (!already) {
      list.push({
        matcher,
        hooks: [{ type: "command", command: hookCmd, name: "Foreman", timeout: 15000 }],
      });
    }
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settingsPath;
}

export function uninstallGeminiHooks(opts: { global: boolean }): boolean {
  const settingsPath = opts.global
    ? path.join(os.homedir(), ".gemini", "settings.json")
    : path.join(process.cwd(), ".gemini", "settings.json");
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    let removed = false;
    for (const key of Object.keys(settings.hooks || {})) {
      const before = settings.hooks[key].length;
      settings.hooks[key] = settings.hooks[key].filter(
        (m: any) => !(m.hooks || []).some(
          (h: any) => typeof h.command === "string" && h.command.includes("hook gemini")
        )
      );
      if (settings.hooks[key].length !== before) removed = true;
      if (settings.hooks[key].length === 0) delete settings.hooks[key];
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return removed;
  } catch {
    return false;
  }
}

function cliPath(): string {
  const here = new URL(import.meta.url).pathname;
  const decoded = decodeURIComponent(here.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.join(path.dirname(path.dirname(decoded)), "cli.js");
}
