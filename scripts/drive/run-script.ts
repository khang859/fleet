interface ScriptStep {
  /** 1-based, so an error can name the line the author sees. */
  line: number;
  text: string;
  argv: string[];
}

/**
 * Split a `drive run` script into steps: one verb per line, quoted the way a
 * shell would quote it on the command line. Blank lines and `#` comments are
 * skipped.
 */
export function parseScript(source: string): ScriptStep[] {
  const steps: ScriptStep[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) return;
    steps.push({ line: i + 1, text, argv: splitLine(text, i + 1) });
  });
  return steps;
}

/**
 * Shell-style word splitting: single quotes are literal, double quotes allow
 * `\"` and `\\`, and a backslash outside quotes escapes the next character.
 * A quoting mistake here fails silently by clicking the wrong selector, so an
 * unterminated quote is an error rather than a guess.
 */
export function splitLine(text: string, line = 1): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`line ${line}: unterminated ${quote} quote`);
  if (inWord) words.push(word);
  return words;
}
