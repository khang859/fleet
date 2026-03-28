const PREFIX = '%c[copilot]';
const STYLE = 'color: #a78bfa; font-weight: bold';

export function createLogger(tag: string) {
  const fullPrefix = `${PREFIX}%c[${tag}]`;
  const tagStyle = 'color: #60a5fa';
  return {
    debug: (msg: string, meta?: Record<string, unknown>) =>
      console.debug(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
    info: (msg: string, meta?: Record<string, unknown>) =>
      console.info(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      console.warn(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) =>
      console.error(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
  };
}
