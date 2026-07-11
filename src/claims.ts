/** Extract "success claims" from an agent's final message — statements a
 * reviewer would expect to be backed by evidence. */
const CLAIM_PATTERNS: RegExp[] = [
  /\btests?\s+(now\s+)?(all\s+)?pass(es|ing)?\b/i,
  /\ball\s+tests?\s+(are\s+)?(green|passing)\b/i,
  /\b(it|this|everything|the\s+\w+)\s+(now\s+)?works\b/i,
  /\bworking\s+(correctly|as\s+expected|now)\b/i,
  /\b(verified|confirmed)\b/i,
  /\b(is|are)\s+(now\s+)?(fixed|resolved|complete[d]?)\b/i,
  /\bsuccessfully\s+(built|ran|deployed|tested|compiled)\b/i,
  /\bbuild\s+(succeeds|passes|is\s+green)\b/i,
  /\bno\s+(more\s+)?errors\b/i,
  /\bdone[.!]?$/i,
];

export function extractClaims(text: string): string[] {
  if (!text) return [];
  const sentences = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && s.length < 400);
  const claims: string[] = [];
  for (const s of sentences) {
    if (CLAIM_PATTERNS.some((p) => p.test(s))) claims.push(s);
    if (claims.length >= 10) break;
  }
  return claims;
}

/** Does a shell command look like it verifies anything (tests, build, run)? */
const VERIFY_PATTERNS: RegExp[] = [
  /\b(pytest|vitest|jest|mocha|unittest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|phpunit|rspec|tox)\b/i,
  /\bnpm\s+(run\s+)?(test|build|typecheck|lint)\b/i,
  /\b(pnpm|yarn|bun)\s+(run\s+)?(test|build|typecheck|lint)\b/i,
  /\bplaywright\b/i,
  /\bcypress\b/i,
  /\btsc\b/,
  /\b(make|cmake)\s+(test|check|build)\b/i,
  /\bcargo\s+(build|check|clippy)\b/i,
  /\bgo\s+(build|vet)\b/i,
  /\bcurl\b.*\b(localhost|127\.0\.0\.1)\b/i,
  /\bruff|eslint|flake8|mypy|pylint\b/i,
];

export function isVerificationCommand(command: string): boolean {
  return VERIFY_PATTERNS.some((p) => p.test(command));
}
