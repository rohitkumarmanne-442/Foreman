import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendEvent } from "../journal.js";
import { BASELINES_DIR, ensureDirs } from "../paths.js";
import { sha256, canonical, signReceipt, type ReceiptBody } from "./receipts.js";

/**
 * `foreman wrap --name <server> -- <command...>`
 *
 * Transparent attestation proxy for stdio MCP servers. Sits between the agent
 * (our stdin/stdout) and the real server (child process), passes every byte
 * through untouched, and journals a signed receipt for every JSON-RPC
 * request/response pair. Also fingerprints tools/list results against a
 * trusted baseline to catch tool-definition rug pulls.
 */
export function runProxy(serverName: string, command: string[], journal = appendEvent): void {
  ensureDirs();
  const runId = `mcp-${crypto.randomUUID().slice(0, 8)}`;
  // On Windows, .cmd shims (npx, etc.) need a shell — but shell mode does not
  // quote args, so build a correctly quoted command line ourselves.
  const child =
    process.platform === "win32"
      ? spawn(
          command
            .map((c) => (/[\s"^&|<>]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
            .join(" "),
          { stdio: ["pipe", "pipe", "inherit"], shell: true }
        )
      : spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });

  interface Pending {
    method: string;
    params: unknown;
    t0: number;
  }
  const pending = new Map<string | number, Pending>();

  // agent -> server: pass through, parse a copy for requests
  let inBuf = "";
  process.stdin.on("data", (chunk: Buffer) => {
    child.stdin.write(chunk);
    inBuf += chunk.toString("utf8");
    let idx;
    while ((idx = inBuf.indexOf("\n")) >= 0) {
      const line = inBuf.slice(0, idx).trim();
      inBuf = inBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && typeof msg.method === "string") {
          pending.set(msg.id, { method: msg.method, params: msg.params, t0: Date.now() });
        }
      } catch {
        // partial/non-JSON — ignore
      }
    }
  });
  process.stdin.on("end", () => child.stdin.end());

  // server -> agent: pass through, parse a copy for responses
  let outBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    outBuf += chunk.toString("utf8");
    let idx;
    while ((idx = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const req = pending.get(msg.id);
          if (!req) continue;
          pending.delete(msg.id);
          recordExchange(serverName, runId, req, msg, journal);
        }
      } catch {
        // ignore
      }
    }
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

function recordExchange(
  server: string,
  runId: string,
  req: { method: string; params: unknown; t0: number },
  resp: { result?: unknown; error?: unknown },
  journal: typeof appendEvent
): void {
  const ms = Date.now() - req.t0;
  const ok = resp.error === undefined;

  // Attest tool calls and the tool-list handshake; skip protocol chatter.
  const interesting =
    req.method === "tools/call" || req.method === "tools/list" || req.method === "resources/read";
  if (!interesting) return;

  const tool =
    req.method === "tools/call"
      ? String((req.params as any)?.name ?? "")
      : undefined;

  const body: ReceiptBody = {
    receipt_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    server,
    method: req.method,
    ...(tool ? { tool } : {}),
    params_hash: sha256(canonical(req.params ?? null)),
    result_hash: sha256(canonical(resp.result ?? resp.error ?? null)),
    ms,
    ok,
  };
  const { sig, pk } = signReceipt(body);

  journal({
    agent: "mcp-proxy",
    session: runId,
    cwd: process.cwd(),
    kind: "mcp_call",
    data: { ...body, sig, pk },
  });

  if (req.method === "tools/list" && ok) {
    checkDrift(server, runId, resp.result, journal);
  }
}

interface ToolFingerprint {
  name: string;
  hash: string; // hash of description + input schema
}

function fingerprintTools(result: unknown): ToolFingerprint[] {
  const tools: any[] = (result as any)?.tools ?? [];
  return tools
    .map((t) => ({
      name: String(t.name ?? ""),
      hash: sha256(canonical({ d: t.description ?? "", s: t.inputSchema ?? null })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function baselinePath(server: string): string {
  const safe = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(BASELINES_DIR(), `${safe}.json`);
}

function checkDrift(server: string, runId: string, result: unknown, journal: typeof appendEvent): void {
  const current = fingerprintTools(result);
  const currentHash = sha256(canonical(current));
  const file = baselinePath(server);

  if (!fs.existsSync(file)) {
    // First sighting becomes the trusted baseline (trust-on-first-use).
    fs.writeFileSync(
      file,
      JSON.stringify({ server, hash: currentHash, tools: current, trusted_at: new Date().toISOString() }, null, 2)
    );
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  if (baseline.hash === currentHash) return;

  const baseNames = new Map<string, string>(baseline.tools.map((t: ToolFingerprint) => [t.name, t.hash]));
  const currNames = new Map<string, string>(current.map((t) => [t.name, t.hash]));
  const added = [...currNames.keys()].filter((n) => !baseNames.has(n));
  const removed = [...baseNames.keys()].filter((n) => !currNames.has(n));
  const changed = [...currNames.keys()].filter((n) => baseNames.has(n) && baseNames.get(n) !== currNames.get(n));

  journal({
    agent: "mcp-proxy",
    session: runId,
    cwd: process.cwd(),
    kind: "mcp_drift",
    data: {
      server,
      baseline_hash: baseline.hash,
      current_hash: currentHash,
      added,
      removed,
      changed,
    },
  });
}

/** `foreman trust <server>` — accept the current tool definitions as the new baseline. */
export function trustServer(server: string): boolean {
  const file = baselinePath(server);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file); // next tools/list re-baselines via trust-on-first-use
  return true;
}
