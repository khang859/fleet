// src/shared/learnings.ts
// Fleet-owned, cross-project knowledge base distilled from agent sessions.
// Learnings live in Fleet's own store (NOT in any repo) and are exported by the
// user into their own projects as they please.

import type { SessionAgent } from './sessions';

export type Learning = {
  id: string;
  title: string;
  body: string; // markdown
  tags: string[];
  /** Provenance: the session this was distilled from. Null for hand-written entries. */
  sourceAgent: SessionAgent | null;
  sourceSessionId: string | null;
  sourceCwd: string | null;
  sourceProject: string | null;
  model: string | null;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
};

export type CreateLearningInput = {
  title: string;
  body: string;
  tags?: string[];
  sourceAgent?: SessionAgent;
  sourceSessionId?: string;
  sourceCwd?: string;
  sourceProject?: string;
  model?: string;
};

export type UpdateLearningInput = {
  title?: string;
  body?: string;
  tags?: string[];
};

/** List/search filter. `query` runs full-text over title+body; the rest are exact. */
export type LearningSearchFilter = {
  query?: string;
  project?: string;
  tag?: string;
};

/** Render a learning as a self-contained markdown document (for copy/export). */
export function learningToMarkdown(l: Pick<Learning, 'title' | 'body' | 'tags'>): string {
  // Sanitize the title for export: strip HTML tags (a raw `<img onerror=…>` is a
  // stored-XSS risk when the .md is viewed on GitHub/GitLab), and collapse newlines
  // so an embedded "\n" can't split the H1 into a second heading.
  const title = l.title
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  let body = l.body.trim();
  if (l.tags.length > 0) {
    // Drop any trailing "Tags:" footer the body already carries (e.g. one the
    // distiller left behind) so the authoritative footer below isn't duplicated.
    const lines = body.split('\n');
    while (lines.length > 0 && /^\s*tags:/i.test(lines[lines.length - 1])) lines.pop();
    body = lines.join('\n').trim();
  }
  const parts = [`# ${title}`, '', body];
  if (l.tags.length > 0) parts.push('', `Tags: ${l.tags.join(', ')}`);
  return parts.join('\n').trim() + '\n';
}

// Windows reserved device names: a file named exactly one of these (even with an
// extension, e.g. NUL.md) maps to a device — writeFileSync silently discards data.
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
]);

/** Filesystem-safe slug from a title, for default export filenames. */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) return 'learning';
  // Avoid Windows reserved device names, which would silently swallow the export.
  if (WINDOWS_RESERVED.has(slug)) return `${slug}-file`;
  return slug;
}

/** Which session to distill a learning from (a headless one-shot agent run). */
export type DistillRequest = {
  agent: SessionAgent;
  id: string;
  cwd: string;
  /** Restrict the distill to one Rune branch path (root -> node). Whole session if unset. */
  nodeId?: string;
};

/** A tag and how many learnings carry it, for vocabulary suggestions. */
export type TagCount = { tag: string; count: number };

export type DistillDraft = { title: string; body: string; tags: string[] };

/**
 * Outcome of a distill run. `nothing` = the model judged the session routine with
 * nothing worth recording (not an error). `error` carries a user-facing message.
 */
export type DistillResult =
  | { status: 'ok'; draft: DistillDraft }
  | { status: 'nothing' }
  | { status: 'error'; message: string };
