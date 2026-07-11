import type { Finding, ReviewCard, RiskLevel } from "./types.js";

const DESTRUCTIVE_SHELL: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, "recursive force delete (rm -rf)"],
  [/\bgit\s+push\s+.*--force\b/i, "git force push"],
  [/\bgit\s+push\s+.*-f\b/, "git force push"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f"],
  [/\bdrop\s+(table|database|schema)\b/i, "SQL DROP statement"],
  [/\btruncate\s+table\b/i, "SQL TRUNCATE statement"],
  [/\bdelete\s+from\s+\w+\s*(;|$)(?![\s\S]*\bwhere\b)/i, "SQL DELETE without WHERE"],
  [/\bRemove-Item\b.*-Recurse\b.*-Force\b/i, "recursive force delete (Remove-Item)"],
  [/\brmdir\s+\/s\b/i, "recursive directory delete"],
  [/\bdel\s+\/[fs]\b/i, "force delete (del /f|/s)"],
  [/\bmkfs\b|\bformat\s+[a-z]:/i, "filesystem format"],
];

const SENSITIVE_PATH = /(^|[\\/])(\.env[^\\/]*|.*secret[^\\/]*|.*credential[^\\/]*|auth[^\\/]*|.*password[^\\/]*|migrations?([\\/]|$)|\.github[\\/]workflows)/i;

const SECRET_CONTENT: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN\s+(RSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY-----/, "private key material"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "API secret key (sk-...)"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "GitHub personal access token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, "hardcoded JWT"],
];

const CODE_FILE = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|c|cpp|h|sql|sh|ps1|vue|svelte)$/i;

export interface RiskInput {
  files: ReviewCard["files"];
  commands: ReviewCard["commands"];
  claims: string[];
  contentSamples: Array<{ file: string; sample: string }>;
  mcpDrifts: number;
}

export function assessRisk(input: RiskInput): {
  findings: Finding[];
  score: number;
  level: RiskLevel;
  verifiedClaims: boolean;
} {
  const findings: Finding[] = [];

  // 1. Destructive shell commands
  for (const c of input.commands) {
    for (const [pattern, label] of DESTRUCTIVE_SHELL) {
      if (pattern.test(c.command)) {
        findings.push({
          rule: "destructive_command",
          severity: 4,
          detail: `${label}: \`${c.command.slice(0, 160)}\``,
        });
        break;
      }
    }
  }

  // 2. Mass rewrite — a large existing file replaced by a much smaller one
  for (const f of input.files) {
    if (
      f.action === "write" &&
      (f.lines_before ?? 0) >= 50 &&
      f.lines_after !== undefined &&
      f.lines_after < (f.lines_before ?? 0) * 0.4
    ) {
      findings.push({
        rule: "mass_rewrite",
        severity: 4,
        detail: `${f.path} rewritten ${f.lines_before}→${f.lines_after} lines (${Math.round(
          (1 - f.lines_after / (f.lines_before || 1)) * 100
        )}% of the file deleted)`,
      });
    }
  }

  // 3. Sensitive paths touched
  for (const f of input.files) {
    if (SENSITIVE_PATH.test(f.path)) {
      findings.push({
        rule: "sensitive_path",
        severity: 3,
        detail: `touched sensitive path: ${f.path}`,
      });
    }
  }

  // 4. Secret material written
  for (const { file, sample } of input.contentSamples) {
    for (const [pattern, label] of SECRET_CONTENT) {
      if (pattern.test(sample)) {
        findings.push({
          rule: "secret_in_code",
          severity: 4,
          detail: `${label} written into ${file}`,
        });
        break;
      }
    }
  }

  // 5. Claims vs evidence
  const verifications = input.commands.filter((c) => c.verification);
  const passingVerifications = verifications.filter((c) => c.ok);
  const verifiedClaims = input.claims.length > 0 && passingVerifications.length > 0;
  if (input.claims.length > 0 && verifications.length === 0) {
    findings.push({
      rule: "unverified_claims",
      severity: 3,
      detail: `agent claimed success (“${input.claims[0].slice(0, 120)}”) but ran zero verification commands`,
    });
  } else if (input.claims.length > 0 && passingVerifications.length === 0) {
    findings.push({
      rule: "failed_verification",
      severity: 4,
      detail: "agent claimed success but its verification commands failed",
    });
  }

  // 6. Code changed with no commands run at all
  const codeTouched = input.files.some((f) => CODE_FILE.test(f.path));
  if (codeTouched && input.commands.length === 0) {
    findings.push({
      rule: "untested_change",
      severity: 2,
      detail: "code files changed but no command was ever executed (nothing compiled, nothing run)",
    });
  }

  // 7. MCP tool drift during this window
  if (input.mcpDrifts > 0) {
    findings.push({
      rule: "mcp_tool_drift",
      severity: 3,
      detail: `${input.mcpDrifts} MCP server(s) changed their tool definitions vs the trusted baseline (possible rug pull)`,
    });
  }

  const weights: Record<number, number> = { 4: 40, 3: 25, 2: 10, 1: 5 };
  const score = Math.min(
    100,
    findings.reduce((acc, f) => acc + weights[f.severity], 0)
  );
  const level: RiskLevel =
    score >= 70 ? "critical" : score >= 40 ? "high" : score >= 15 ? "medium" : "low";

  return { findings, score, level, verifiedClaims };
}
