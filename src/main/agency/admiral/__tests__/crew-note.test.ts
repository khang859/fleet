import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMPTY_CREW } from '../../../../shared/agency-crew';
import { loadCrew } from '../../crew/catalog';
import { crewNote } from '../crew-note';

const SHIPPED = fileURLToPath(new URL('../../../../../resources/crew', import.meta.url));

describe('crewNote', () => {
  it('lists each role with its runtime and each playbook step in a fence', async () => {
    const note = crewNote(await loadCrew([['bundled', SHIPPED]]));
    expect(note).toContain('builder (claude): Writes and tests the code for one well-scoped step.');
    expect(note).toContain('build: 2 x builder (server, client), after design');
    expect(note).toContain("review: reviewer, after integrate, in integrate's worktree");
    expect(note).toContain('integrate: builder, after build, merges build');
    expect(note).toContain('design: architect, client looks first');
    expect(note).toContain('session="crew roles"');
  });

  it('says so when the project has no roles', () => {
    expect(crewNote(EMPTY_CREW)).toBe(
      'This project has no crew roles, so no plan can be approved.'
    );
  });
});
