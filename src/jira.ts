import { loadConfig } from "./config.js";
import type { ReviewCard } from "./types.js";

/**
 * Flag → Jira: create an issue carrying the card's evidence.
 * Config: { jira: { base_url, email, project, token_env } } — the API token is
 * read from the environment (default env var: JIRA_API_TOKEN), never stored.
 */
export async function createJiraIssue(card: ReviewCard, note?: string): Promise<{ key: string; url: string }> {
  const cfg = loadConfig().jira;
  if (!cfg?.base_url || !cfg.email || !cfg.project) {
    throw new Error("Jira is not configured. Set jira.base_url / jira.email / jira.project in foreman config (Settings ⚙ in the inbox).");
  }
  const token = process.env[cfg.token_env ?? "JIRA_API_TOKEN"];
  if (!token) throw new Error(`Missing Jira API token — set the ${cfg.token_env ?? "JIRA_API_TOKEN"} environment variable.`);

  const repo = card.cwd.split(/[\\/]/).pop() || card.cwd;
  const lines = [
    `Flagged in the Foreman review inbox${note ? `: "${note}"` : "."}`,
    "",
    `* Agent: ${card.agent} · session ${card.session.slice(0, 12)} · risk ${card.level.toUpperCase()} ${card.score}/100`,
    `* Repo: ${card.cwd}`,
    `* Files: ${card.files.length} · commands: ${card.commands.length}`,
    "",
    ...card.findings.map((f) => `* [sev ${f.severity}] ${f.rule}: ${f.detail}`),
  ];

  const res = await fetch(`${cfg.base_url.replace(/\/$/, "")}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${cfg.email}:${token}`).toString("base64"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: cfg.project },
        issuetype: { name: "Task" },
        summary: `[Foreman] ${card.level.toUpperCase()} agent session in ${repo}${note ? ` — ${note.slice(0, 80)}` : ""}`,
        description: {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: lines.join("\n") }] }],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jira returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { key: string };
  return { key: body.key, url: `${cfg.base_url.replace(/\/$/, "")}/browse/${body.key}` };
}
