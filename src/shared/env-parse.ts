/** One physical line, preserved for round-trip fidelity. */
export type EnvLine =
  | { kind: 'var'; key: string; value: string; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'blank' };

export type VarLine = Extract<EnvLine, { kind: 'var' }>;

export type ParsedEnvFile = { lines: EnvLine[]; trailingNewline: boolean };

/** Parse .env text into ordered lines. Splits on '\n' only so CRLF is kept in raw. */
export function parseEnvFile(text: string): ParsedEnvFile {
  const trailingNewline = text.endsWith('\n');
  const raws = text.split('\n');
  if (trailingNewline) raws.pop();
  const lines: EnvLine[] = raws.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') return { kind: 'blank' };
    if (trimmed.startsWith('#')) return { kind: 'comment', raw };
    const body = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) return { kind: 'comment', raw }; // not KEY=VAL → preserve verbatim
    const key = body.slice(0, eq).trim();
    if (!key) return { kind: 'comment', raw };
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return { kind: 'var', key, value, raw };
  });
  return { lines, trailingNewline };
}

export function serializeEnvFile(parsed: ParsedEnvFile): string {
  const body = parsed.lines
    .map((l) => (l.kind === 'blank' ? '' : l.raw))
    .join('\n');
  return parsed.trailingNewline ? `${body}\n` : body;
}

/** Build a `KEY=value` line, quoting when needed and keeping any `export ` prefix. */
export function formatVarLine(key: string, value: string, originalRaw?: string): string {
  const exportPrefix = originalRaw?.trim().startsWith('export ') ? 'export ' : '';
  const needsQuotes = /\s/.test(value) || value.includes('#');
  const body = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
  return `${exportPrefix}${key}=${body}`;
}

export function updateVarLine(line: VarLine, key: string, value: string): VarLine {
  return { kind: 'var', key, value, raw: formatVarLine(key, value, line.raw) };
}

export function newVarLine(key: string, value: string): VarLine {
  return { kind: 'var', key, value, raw: formatVarLine(key, value) };
}

export function countVars(text: string): number {
  return parseEnvFile(text).lines.filter((l) => l.kind === 'var').length;
}
