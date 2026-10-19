/**
 * Whether a project in the layer picker matches the search: its name or folder
 * holds the search as typed, so a search never finds a scattered match.
 */
export function matches(_value: string, search: string, keywords: string[] = []): number {
  const term = search.trim().toLowerCase();
  return keywords.some((k) => k.toLowerCase().includes(term)) ? 1 : 0;
}
