const MAX_SLUG = 64;

/** Reduce a display name to a safe slug: lowercase, [a-z0-9] + internal -/_, 1..64 chars. */
export function deriveBoardSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

export function isValidBoardSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);
}
