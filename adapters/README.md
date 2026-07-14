# Writing a Foreman adapter (~50 lines)

Every native adapter is a thin translation onto `foreman ingest` — one JSON object per line on stdin:

```jsonc
{ "agent": "windsurf", "session": "s1", "cwd": "C:/repo",
  "kind": "command", "command": "npm test", "ok": true }
{ "kind": "file", "file": "src/a.ts", "lines_after": 40,
  "content": "...", "edits": [{ "old": "a", "new": "b" }] }
{ "kind": "end", "message": "All tests pass." }
```

Three kinds — `command`, `file`, `end` — and Foreman derives everything else (risk, claims, diffs, timeline, receipts stay separate). Ship yours by piping your agent's hook/event stream to `foreman ingest`; see `opencode/foreman.mjs` (plugin API) and `claude-agent-sdk/foreman.mjs` (SDK hooks) as working references. PRs welcome — an adapter for your agent is an afternoon, not a fork.
