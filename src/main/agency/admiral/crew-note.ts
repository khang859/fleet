import type { CrewCatalog, PlaybookStep } from '../../../shared/agency-crew';
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

/**
 * The crew a project can hire, for the Admiral to plan with: each role with
 * its runtime and model, and each playbook's steps. Crew files can come from
 * a repository a teammate shared, so their words go in a fence.
 */
export function crewNote(crew: CrewCatalog): string {
  if (crew.roles.length === 0) return 'This project has no crew roles, so no plan can be approved.';
  const roles = crew.roles.map(
    (r) =>
      `${r.name} (${r.runtime}${r.model === undefined ? '' : `, ${r.model}`}): ${r.description}`
  );
  const playbooks = crew.playbooks.map((p) =>
    [`${p.name}: ${p.description}`, ...p.steps.map((s) => `  ${stepText(s)}`), p.notes].join('\n')
  );
  return [
    'The crew roles a plan can use, by name. A step names one of these as its role.',
    fence('crew roles', roles.join('\n')),
    ...(playbooks.length === 0
      ? []
      : [
          'Playbooks to start a plan from. Fit the steps to the brief: drop, add or split them.',
          fence('playbooks', playbooks.join('\n\n'))
        ])
  ].join('\n');
}
