/** What a masked env file value reads as. */
export const ENV_MASK = '[redacted:env]';

/** Shorter values would hide too much text behind the mask. */
const SECRET_MIN_CHARS = 6;

/** CSI and OSC sequences and two-byte escapes: colors, cursor moves, titles, links. */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Text without terminal escape sequences, which could split a value apart. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Masks the values of the env files the client gave crew, in text the
 * Admiral reads and in Fleet's logs. Escape sequences go first, so a color
 * code inside a value cannot hide it, and longer values are masked before
 * shorter ones, so a value that holds another is masked whole.
 */
export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Iterable<string>) {
    this.secrets = [...new Set(secrets)]
      .filter((s) => s.length >= SECRET_MIN_CHARS)
      .sort((a, b) => b.length - a.length);
  }

  get empty(): boolean {
    return this.secrets.length === 0;
  }

  redact(text: string): string {
    if (this.empty) return text;
    return this.secrets.reduce((out, secret) => out.split(secret).join(ENV_MASK), stripAnsi(text));
  }

  /** Every string in a value masked, keys and structure kept. */
  redactDeep<T>(value: T): T {
    if (this.empty) return value;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the same shape, strings masked
    return walk(value, (s) => this.redact(s)) as T;
  }
}

function walk(value: unknown, mask: (s: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, mask));
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const error = new Error(mask(value.message));
    error.stack = value.stack === undefined ? undefined : mask(value.stack);
    return error;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, mask)]));
}

/** Env file values the agency gave crew, which no log line may hold. */
const logSecrets = new Set<string>();
let forLogs = new Redactor(logSecrets);

/** Mask these values in every Fleet log line from now on. */
export function maskInLogs(values: Iterable<string>): void {
  const before = logSecrets.size;
  for (const value of values) logSecrets.add(value);
  if (logSecrets.size !== before) forLogs = new Redactor(logSecrets);
}

/** What the logger masks with now. */
export const logRedactor = (): Redactor => forLogs;
