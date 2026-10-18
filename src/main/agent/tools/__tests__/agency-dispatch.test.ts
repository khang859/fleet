import { describe, expect, it } from 'vitest';
import type { AgentToolContext } from '../../../../shared/agent-tools';
import {
  AGENCY_TOOL_MEMBER,
  AGENCY_TOOL_NAMES,
  type AgencyToolName,
  type AgentAgencyCapability
} from '../../../../shared/agency-tools';
import { runAgentTool } from '../run';

/** Every agency tool the model is offered reaches its capability member. */

/** The smallest arguments each tool takes. */
const ARGS: Record<AgencyToolName, object> = {
  ask_client: { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
  job_open: { title: 'Dark mode', brief: 'Add it' },
  job_list: {},
  job_plan: {
    playbook: 'feature',
    summary: 'x',
    steps: [{ id: 'builder-1', role: 'builder', title: 'Build' }],
    budget: { usd: 5 }
  },
  job_update: { step: 'builder-1', status: 'running' },
  job_deliver: { step: 'builder-1', kind: 'pr', url: 'https://github.com/a/b/pull/1' },
  crew_hire: { step: 'builder-1', brief: 'Build it.' },
  crew_send: { crew: 'builder 1', prompt: 'Go on.' },
  crew_interrupt: { crew: 'builder 1' },
  crew_stop: { crew: 'builder 1' },
  permission_answer: { request: 'p1', decision: 'allow', reason: 'fits step 1' },
  client_file_propose: { reason: 'r', add: [{ text: 'Use pnpm.' }] },
  settings_read: {},
  settings_change: { changes: [{ key: 'agency.admiral.monthlyCapUsd', value: 50 }], reason: 'r' }
};

describe('agency tool dispatch', () => {
  it.each(AGENCY_TOOL_NAMES)('runs %s on its capability member', async (name) => {
    const called: string[] = [];
    const member = async (): Promise<{ text: string; summary: string }> => {
      called.push(name);
      return Promise.resolve({ text: 'ok', summary: 'ok' });
    };
    const agency = Object.fromEntries(
      Object.values(AGENCY_TOOL_MEMBER).map((key) => [key, member])
    ) as unknown as AgentAgencyCapability;
    const ctx = { agency } as unknown as AgentToolContext;

    await runAgentTool(name, JSON.stringify(ARGS[name]), ctx);
    expect(called).toEqual([name]);
  });
});
