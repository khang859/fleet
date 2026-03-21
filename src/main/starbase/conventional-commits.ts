export type CommitType = 'feat' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore';

const SIGNED_OFF_BY = 'Signed-off-by: Fleet - Starcommand';

// Ordered: earlier entries win on keyword match.
const TYPE_RULES: Array<{ type: CommitType; keywords: RegExp }> = [
  { type: 'fix', keywords: /\b(fix|bug|patch|hotfix)\b/ },
  { type: 'refactor', keywords: /\b(refactor|restructure|cleanup)\b/ },
  { type: 'test', keywords: /\btests?\b/ },
  { type: 'docs', keywords: /\bdocs?\b/ },
  { type: 'chore', keywords: /\b(chore|deps|dependency|upgrade|bump)\b/ }
];

/** Infer the conventional commit type from a mission prompt. */
export function inferCommitType(prompt: string): CommitType {
  const lower = prompt.toLowerCase();
  for (const rule of TYPE_RULES) {
    if (rule.keywords.test(lower)) {
      return rule.type;
    }
  }
  return 'feat';
}

/** Truncate prompt to a short summary suitable for commit subjects. */
export function deriveSummary(prompt: string, maxLen = 72): string {
  const firstLine = prompt.split(/[.\n]/)[0].trim();
  const lower = firstLine.charAt(0).toLowerCase() + firstLine.slice(1);
  return lower.length > maxLen ? lower.slice(0, maxLen - 1) + '…' : lower;
}

/** Build a conventional commit subject line: "type(scope): summary". */
export function formatCommitSubject(type: CommitType, scope: string, summary: string): string {
  return `${type}(${scope}): ${summary}`;
}

/**
 * Build a full commit message with Signed-off-by trailer.
 * Returns subject + blank line + trailer.
 */
export function formatCommitMessage(type: CommitType, scope: string, summary: string): string {
  return `${formatCommitSubject(type, scope, summary)}\n\n${SIGNED_OFF_BY}`;
}
