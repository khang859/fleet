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

  it("lists each member's skills by runtime, in a fence, and leaves out members with none", async () => {
    const crew = await loadCrew([['bundled', SHIPPED]]);
    const note = crewNote(crew, [
      { member: 'journey', atRoot: true, skills: { claude: ['release'], eva: [] } },
      {
        member: 'fola-journey',
        atRoot: false,
        skills: { claude: ['journey-qa-sweep'], eva: ['lint'] }
      },
      { member: 'api', atRoot: false, skills: { claude: [], eva: [] } }
    ]);
    expect(note).toContain('session="skills"');
    expect(note).toContain(
      'journey (root) - claude: release\nfola-journey - claude: journey-qa-sweep; eva: lint'
    );
    expect(note).not.toContain('api -');
    expect(
      crewNote(crew, [{ member: 'api', atRoot: true, skills: { claude: [], eva: [] } }])
    ).not.toContain('Skills in');
  });

  it('says so when the project has no roles', () => {
    expect(crewNote(EMPTY_CREW)).toBe(
      'This project has no crew roles, so no plan can be approved.'
    );
  });
});
