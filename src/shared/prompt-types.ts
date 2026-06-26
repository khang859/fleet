/**
 * Reusable prompt templates invoked via `/name` in the composer. A template's
 * body may contain `{{variable}}` tokens, which pop a fill-in form before the
 * resolved text is inserted into the composer.
 */
export type PromptTemplate = {
  id: string;
  /** Slash-command name (no spaces); shares the composer `/` menu with skills. */
  name: string;
  description: string;
  /** Body, optionally containing `{{var}}` tokens. */
  content: string;
};

/** Matches `{{ var }}` tokens; variable names are word chars, dashes, dots. */
export const PROMPT_VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Distinct variable names in `content`, in first-seen order. */
export function extractPromptVars(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of content.matchAll(PROMPT_VAR_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Substitute `{{var}}` tokens with `values`; unknown vars become empty strings. */
export function fillTemplate(content: string, values: Record<string, string>): string {
  return content.replace(PROMPT_VAR_RE, (_full, name: string) => values[name] ?? '');
}

/** Normalize a free-text name into a slash-command token (lowercase, dashed). */
export function normalizePromptName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
