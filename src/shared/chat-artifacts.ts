/**
 * Artifacts: renderable documents a model emits inside fenced code blocks. We
 * surface html/svg/markdown blocks as "artifacts" that open in a side panel with
 * a live preview and an editable source view. Pure string parsing — no DOM — so
 * it is unit-testable and safe to run in the main or renderer process.
 */

export type ArtifactKind = 'html' | 'svg' | 'markdown';

export type Artifact = {
  /** Stable within a message: the block's 0-based position among artifacts. */
  index: number;
  kind: ArtifactKind;
  /** Short human label for the chip / panel header. */
  title: string;
  code: string;
};

/** Fence language → artifact kind. Anything not listed is not an artifact. */
const KIND_BY_LANG: Partial<Record<string, ArtifactKind>> = {
  html: 'html',
  svg: 'svg',
  markdown: 'markdown',
  md: 'markdown'
};

const FENCE_RE = /```([\w+-]*)[ \t]*\n([\s\S]*?)\n?```/g;

const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;
const H1_RE = /^#\s+(.+)$/m;

function deriveTitle(kind: ArtifactKind, code: string): string {
  if (kind === 'html') {
    const m = TITLE_RE.exec(code);
    if (m) return m[1].trim();
    return 'HTML document';
  }
  if (kind === 'svg') return 'SVG image';
  const h1 = H1_RE.exec(code);
  if (h1) return h1[1].trim();
  return 'Markdown document';
}

/**
 * Extract renderable artifacts from a message's markdown content. Only html, svg,
 * and markdown fenced blocks qualify, and only when non-trivial (a one-line snippet
 * isn't worth a panel). Returns them in document order with stable indices.
 */
export function extractArtifacts(content: string): Artifact[] {
  const out: Artifact[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(content)) !== null) {
    const lang = m[1].toLowerCase();
    const kind = KIND_BY_LANG[lang];
    if (!kind) continue;
    const code = m[2];
    // Skip trivial blocks: a single short line is better left inline.
    if (code.trim().length < 24 && !code.includes('\n')) continue;
    out.push({ index: out.length, kind, title: deriveTitle(kind, code), code });
  }
  return out;
}
