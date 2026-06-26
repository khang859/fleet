import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { SkillScope } from '../../../shared/skill-types';

/** A skill as read from disk, before settings overlay is applied. */
export type LoadedSkill = {
  name: string;
  description: string;
  scope: SkillScope;
  dir: string;
  /** SKILL.md body (everything after the frontmatter). */
  body: string;
  /** Non-`SKILL.md` files in the folder. */
  files: string[];
  allowedTools?: string[];
};

type Frontmatter = { name: string; description: string; body: string; allowedTools?: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Split a SKILL.md into YAML frontmatter and body. Returns null when the file
 * has no `---`-delimited frontmatter or the YAML lacks name/description.
 */
export function parseSkillMd(content: string): Frontmatter | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const yamlText = content.slice(4, end);
  const body = content.slice(content.indexOf('\n', end + 1) + 1).trim();

  let fm: unknown;
  try {
    fm = parse(yamlText);
  } catch {
    return null;
  }
  if (!isRecord(fm)) return null;
  const rec = fm;
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  const description = typeof rec.description === 'string' ? rec.description.trim() : '';
  if (!name || !description) return null;

  const allowed = rec['allowed-tools'];
  const allowedTools = Array.isArray(allowed)
    ? allowed.filter((t): t is string => typeof t === 'string')
    : undefined;
  return { name, description, body, allowedTools };
}

/**
 * Scan one skills root for `<root>/<dir>/SKILL.md` entries. Missing roots and
 * malformed skills are skipped, never thrown — a broken skill must not take
 * down chat. Folder names are not trusted as the skill name; the frontmatter
 * `name` is authoritative.
 */
export function scanSkillsDir(root: string, scope: SkillScope): LoadedSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: LoadedSkill[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    let content: string;
    try {
      content = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    } catch {
      continue; // folder without a SKILL.md is not a skill
    }
    const parsed = parseSkillMd(content);
    if (!parsed) continue;

    out.push({
      name: parsed.name,
      description: parsed.description,
      scope,
      dir,
      body: parsed.body,
      allowedTools: parsed.allowedTools,
      files: listExtraFiles(dir)
    });
  }
  return out;
}

/** Non-`SKILL.md` files directly inside a skill folder (one level). */
function listExtraFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== 'SKILL.md')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Coarse token estimate (~4 chars/token) for budget metering. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** True when `path` exists and is a directory. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
