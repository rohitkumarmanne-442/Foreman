import { execFileSync } from "node:child_process";
import { assessRisk } from "./risk.js";
import type { Finding, ReviewCard, RiskLevel } from "./types.js";

export interface ScanResult {
  base: string;
  files: Array<{ path: string; added: number; deleted: number }>;
  findings: Finding[];
  score: number;
  level: RiskLevel;
}

/**
 * foreman scan — zero-setup CI mode. No journal, no hooks, no team packs:
 * runs the risk rules directly against a git diff, so a pipeline can catch
 * rogue agent commits even when nobody ever ran foreman locally.
 * Covers the diff-visible rules: secrets in added lines, sensitive paths,
 * and mass deletions. (Claims/commands need a live session to observe.)
 */
export function scanDiff(base = "HEAD^", cwd = process.cwd()): ScanResult {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  const files = git(["diff", "--numstat", base, "--"]).split("\n").filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split("\t");
    return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d) };
  });

  // added lines per file → the secret rules see exactly what the diff introduces
  const samples: Array<{ file: string; sample: string }> = [];
  let cur = "";
  const lines: string[] = [];
  const flush = () => { if (cur && lines.length) samples.push({ file: cur, sample: lines.join("\n").slice(0, 20000) }); lines.length = 0; };
  for (const l of git(["diff", "-U0", base, "--"]).split("\n")) {
    if (l.startsWith("+++ b/")) { flush(); cur = l.slice(6); }
    else if (l.startsWith("+") && !l.startsWith("+++")) lines.push(l.slice(1));
  }
  flush();

  const risk = assessRisk({
    files: files.map((f) => ({
      path: f.path,
      action: "write" as const,
      lines_before: f.deleted,
      lines_after: f.added,
    })),
    commands: [],
    claims: [],
    contentSamples: samples,
    mcpDrifts: 0,
  });

  return { base, files, findings: risk.findings, score: risk.score, level: risk.level };
}

/** Shape a scan as a card so buildSarif / buildPrComment can render it. */
export function scanAsCard(scan: ScanResult, cwd = process.cwd()): ReviewCard {
  const ts = new Date().toISOString();
  return {
    session: `scan-${ts.slice(0, 19)}`, review: "pending", agent: "ci-scan", cwd,
    started: ts, open: false, last_activity: ts,
    files: scan.files.map((f) => ({ path: f.path, action: "write" as const, lines_before: f.deleted, lines_after: f.added })),
    commands: [], claims: [], verified_claims: false,
    findings: scan.findings, score: scan.score, level: scan.level,
    mcp_calls: 0, mcp_drifts: 0,
  };
}
