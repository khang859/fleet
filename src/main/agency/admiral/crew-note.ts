import type { MemberSkills } from '../../../shared/agency-agent-files';
import { CREW_RUNTIMES, type CrewCatalog, type PlaybookStep } from '../../../shared/agency-crew';
import { fence } from '../../../shared/fleet-tools';

function stepText(step: PlaybookStep): string {
  const ws = step.workspace;
  const parts = [
    step.count > 1 ? `${step.count} x ${step.role} (${step.scopes.join(', ')})` : step.role,
    ...(step.after.length > 0 ? [`after ${step.after.join(', ')}`] : []),
    ...(ws === 'new'
      ? []
      : ['of' in ws ? `in ${ws.of}'s worktree` : `merges ${ws.integrate.join(', ')}`]),
    ...(step.gate === 'client' ? ['client looks first'] : [])
  ];
  return `${step.id}: ${parts.join(', ')}`;
}

/** Each member's skills, a line per member that has any, or null when none has. */
function skillsNote(members: MemberSkills[]): string | null {
  const lines = members.flatMap((m) => {
    const per = CREW_RUNTIMES.filter((r) => m.skills[r].length > 0).map(
      (r) => `${r}: ${m.skills[r].join(', ')}`
    );
    return per.length === 0 ? [] : [`${m.member}${m.atRoot ? ' (root)' : ''} - ${per.join('; ')}`];
  });
  if (lines.length === 0) return null;
  return [
    "Skills in the project's repositories, by member and runtime. A crew member loads only the skills of the repository it starts in: a step that works in one member alone gets that member's, and any other step gets the root's. Name the ones a step uses in its skills.",
    fence('skills', lines.join('\n'))
  ].join('\n');
}

/**
 * The crew a project can hire, for the Admiral to plan with: each role with
 * its runtime and model, each playbook's steps, and the skills each member's
 * repository has. Crew files and skill names come from repositories a
 * teammate can change, so their words go in a fence.
 */
export function crewNote(crew: CrewCatalog, skills: MemberSkills[] = []): string {
  if (crew.roles.length === 0) return 'This project has no crew roles, so no plan can be approved.';
  const roles = crew.roles.map(
    (r) =>
      `${r.name} (${r.runtime}${r.model === undefined ? '' : `, ${r.model}`}): ${r.description}`
  );
  const playbooks = crew.playbooks.map((p) =>
    [`${p.name}: ${p.description}`, ...p.steps.map((s) => `  ${stepText(s)}`), p.notes].join('\n')
  );
  const skillLines = skillsNote(skills);
  return [
    'The crew roles a plan can use, by name. A step names one of these as its role.',
    fence('crew roles', roles.join('\n')),
    ...(playbooks.length === 0
      ? []
      : [
          'Playbooks to start a plan from. Fit the steps to the brief: drop, add or split them.',
          fence('playbooks', playbooks.join('\n\n'))
        ]),
    ...(skillLines === null ? [] : [skillLines])
  ].join('\n');
}
