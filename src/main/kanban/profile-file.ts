import type { WorkerProfile } from '../../shared/types';

/**
 * Renders a worker profile as a rune profile markdown file (YAML-ish frontmatter
 * + persona body), matching reference/rune/internal/profile.ParseMarkdown.
 */
export function renderProfileMarkdown(profile: WorkerProfile): string {
  const lines: string[] = ['---', `name: ${profile.name}`];
  if (profile.model.trim() !== '') lines.push(`model: ${profile.model}`);
  if (profile.skills.length > 0) lines.push(`skills: [${profile.skills.join(', ')}]`);
  lines.push('---', '', profile.instructions.trim(), '');
  return lines.join('\n');
}
