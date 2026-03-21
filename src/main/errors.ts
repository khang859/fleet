export class CodedError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}

/** Narrow an unknown catch value to an Error */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/** Narrow an unknown catch value to an Error, preserving `code` if present */
export function toCodedError(value: unknown): CodedError {
  if (value instanceof CodedError) return value;
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : 'UNKNOWN';
    const coded = new CodedError(value.message, code);
    coded.stack = value.stack;
    return coded;
  }
  return new CodedError(String(value), 'UNKNOWN');
}
