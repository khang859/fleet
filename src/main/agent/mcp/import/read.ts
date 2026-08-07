import { readFileSync } from 'node:fs';

/**
 * Reading somebody else's config file.
 *
 * These files belong to other tools. They are edited by hand, they are
 * sometimes half-written, and one of them is JSON with comments. None of that
 * is Fleet's business to fix, so anything that cannot be read comes back as
 * `null` and the scan carries on with the rest - a broken `opencode.jsonc`
 * must not be able to stop Claude Code's servers from being found.
 */

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(stripComments(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

/**
 * Remove `//` and block comments, leaving strings alone.
 *
 * String-aware because it has to be: `"url": "https://example.com"` contains a
 * `//`, and a stripper that did not track quoting would cut the config in half
 * on the most common line in the file.
 */
export function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text.charAt(i + 1);

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += ch;
      // A backslash escapes whatever follows, including a quote, so the pair is
      // consumed together rather than letting `\"` end the string.
      if (ch === '\\' && next !== '') {
        out += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }

    out += ch;
  }

  return dropTrailingCommas(out);
}

/**
 * A comma before a closing brace or bracket.
 *
 * Legal in JSON with comments, and common in a file somebody has been editing,
 * so it is worth surviving rather than reporting.
 */
function dropTrailingCommas(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (ch === '\\' && text.charAt(i + 1) !== '') {
        out += text.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',' && isBeforeClose(text, i + 1)) continue;
    out += ch;
  }

  return out;
}

function isBeforeClose(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return ch === '}' || ch === ']';
  }
  return false;
}
