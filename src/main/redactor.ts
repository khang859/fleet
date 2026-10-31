/**
 * Text with the credential shapes Fleet knows masked: `key = value` pairs,
 * bearer tokens, provider, GitHub, Slack and AWS keys, and private key blocks.
 * For text that may hold a secret nobody named, such as a log tail.
 */
export function maskCredentials(text: string): string {
  let out = text;
  // Bearer tokens, first: `Authorization: Bearer x` would mask only the word "Bearer" below
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  // key/secret/token/password = value  →  key = [REDACTED]
  out = out.replace(
    /((?:api[_-]?key|secret|token|password|passphrase|auth(?:orization)?)\s*[:='"]+\s*)\S+/gi,
    '$1[REDACTED]'
  );
  // Provider key prefixes (sk-..., pk-..., rk-...)
  out = out.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-[REDACTED]');
  // GitHub tokens: classic, OAuth, app and fine-grained
  out = out.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    '[REDACTED_GITHUB_TOKEN]'
  );
  // Slack tokens
  out = out.replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]');
  // AWS access key IDs
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  // PEM private keys
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED_PRIVATE_KEY]'
  );
  return out;
}
