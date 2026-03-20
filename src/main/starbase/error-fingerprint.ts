import { createHash } from 'crypto'

/** Regex patterns that indicate non-retryable errors */
const NON_RETRYABLE_PATTERNS = [
  /ENOENT|EACCES|EPERM/,
  /MODULE_NOT_FOUND|Cannot find module/i,
  /\b401\b.*Unauthorized|\b403\b.*Forbidden/i,
  /config.*not found|missing.*configuration/i,
  /no such file or directory/i,
]

/** Patterns to strip before hashing (variable parts) */
const STRIP_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g,         // ISO timestamps
  /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/g,           // datetime stamps
  /\bpid[=: ]\d+/gi,                                         // PIDs
  /0x[0-9a-fA-F]{8,}/g,                                      // memory addresses
  /\b\d{4,}\b/g,                                              // large numbers (PIDs, ports)
]

/**
 * Compute a 16-char hex fingerprint from error output.
 * Strips variable parts (timestamps, PIDs, addresses) before hashing.
 * Uses last 50 lines only.
 */
export function computeFingerprint(errorOutput: string): string {
  const lines = errorOutput.split('\n')
  const tail = lines.slice(-50).join('\n')

  let normalized = tail
  for (const pattern of STRIP_PATTERNS) {
    normalized = normalized.replace(pattern, '')
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Classify an error as transient, persistent, or non-retryable.
 * - non-retryable: matches known unrecoverable patterns (zero retries)
 * - persistent: same fingerprint as last attempt (auto-escalate)
 * - transient: default (allow FO triage)
 */
export function classifyError(
  errorOutput: string,
  currentFingerprint?: string,
  lastFingerprint?: string,
): 'transient' | 'persistent' | 'non-retryable' {
  // Check non-retryable patterns first
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(errorOutput)) return 'non-retryable'
  }

  // Check fingerprint match (persistent = same error repeating)
  if (currentFingerprint && lastFingerprint && currentFingerprint === lastFingerprint) {
    return 'persistent'
  }

  return 'transient'
}
