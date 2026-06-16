import { describe, expect, it } from 'vitest';
import { buildPmAgentsMd } from '../pm-agents';

describe('buildPmAgentsMd', () => {
  it('injects the autopilot mandate when enabled', () => {
    const md = buildPmAgentsMd({ projects: [], memory: null, autopilotEnabled: true });
    expect(md).toContain('Autopilot authority');
    expect(md).toContain('kanban_propose');
  });

  it('omits the autopilot mandate when disabled', () => {
    const md = buildPmAgentsMd({ projects: [], memory: null, autopilotEnabled: false });
    expect(md).not.toContain('Autopilot authority');
    expect(md).not.toContain('kanban_propose');
  });

  it('omits the autopilot mandate when the flag is absent (default off)', () => {
    const md = buildPmAgentsMd({ projects: [], memory: null });
    expect(md).not.toContain('Autopilot authority');
  });
});
