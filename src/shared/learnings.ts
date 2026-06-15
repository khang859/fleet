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
  // Collapse newlines in the title: an embedded "\n" would split the H1 into a
  // second heading (especially if the next line starts with "#"), corrupting the
  // document structure for any downstream markdown parser.
  const title = l.title.replace(/[\r\n]+/g, ' ').trim();
  const parts = [`# ${title}`, '', l.body.trim()];
  if (l.tags.length > 0) parts.push('', `Tags: ${l.tags.join(', ')}`);
  return parts.join('\n').trim() + '\n';
}

/** Filesystem-safe slug from a title, for default export filenames. */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'learning';
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
