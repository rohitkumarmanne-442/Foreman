import type { ReviewCard } from "./types.js";

/** Rule metadata mirrored from the risk engine — shown by GitHub code scanning. */
const RULE_HELP: Record<string, string> = {
  destructive_command: "A command that can permanently destroy work or data ran in this agent session.",
  mass_rewrite: "A large file was replaced by a much smaller one — how agents silently delete working code.",
  secret_in_code: "A credential was written into source code. Rotate it and move it to env/secret storage.",
  sensitive_path: "Auth, migration, CI, or env files were changed — review with extra care.",
  unverified_claims: "The agent claimed success but ran no passing verification command.",
  failed_verification: "The agent's own checks failed, yet it claimed success.",
  untested_change: "Code was written but never compiled or executed in the session.",
  mcp_tool_drift: "An MCP server changed its tool definitions mid-flight (possible rug pull).",
};

const SEV_TO_LEVEL: Record<number, string> = { 4: "error", 3: "error", 2: "warning", 1: "note" };

function fileUri(p: string): string {
  const s = p.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(s) ? "file:///" + s : s;
}

/** SARIF 2.1.0 — GitHub code scanning renders these as native PR annotations. */
export function buildSarif(cards: ReviewCard[]): object {
  const ruleIds = new Set<string>();
  const results: object[] = [];

  for (const card of cards) {
    for (const f of card.findings) {
      ruleIds.add(f.rule);
      // best effort: anchor the finding to a file it names, else the first touched file
      const named = card.files.find((x) => f.detail.includes(x.path) || f.detail.includes(x.path.split(/[\\/]/).pop() ?? ""));
      const anchor = named ?? card.files[0];
      results.push({
        ruleId: f.rule,
        level: SEV_TO_LEVEL[f.severity] ?? "warning",
        message: { text: `${f.detail} (agent ${card.agent}, session ${card.session.slice(0, 12)}, risk ${card.score}/100)` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: anchor ? fileUri(anchor.path) : "unknown" },
            region: { startLine: 1 },
          },
        }],
        partialFingerprints: { foremanSession: card.session, foremanRule: f.rule, detail: f.detail.slice(0, 120) },
      });
    }
  }

  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Foreman",
          informationUri: "https://github.com/rohitkumarmanne-442/foreman",
          rules: [...ruleIds].map((id) => ({
            id,
            shortDescription: { text: id.replace(/_/g, " ") },
            fullDescription: { text: RULE_HELP[id] ?? id },
            helpUri: "https://github.com/rohitkumarmanne-442/foreman#what-it-catches",
          })),
        },
      },
      results,
    }],
  };
}
