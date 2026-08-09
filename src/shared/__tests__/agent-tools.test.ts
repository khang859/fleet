import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_SPECS,
  SUBAGENT_TOOL_NAMES,
  toolSpecsFor,
  type AgentToolName,
  type AgentToolSpec
} from '../agent-tools';

/**
 * Which tools exist, and who is offered them.
 *
 * The interesting assertions here are all about the boundary between a turn and
 * a subagent, because that boundary is one spread in `AGENT_TOOL_NAMES` and
 * getting it wrong fails silently: no type error, no other failing test, and no
 * visible misbehaviour until a subagent writes something with no provenance.
 */

/** A stand-in for one of the specs a turn builds from what is on disk. */
const named = (name: AgentToolName): AgentToolSpec => ({
  type: 'function',
  function: { name, description: `stand-in for ${name}`, parameters: {} }
});

describe('the tool lists', () => {
  it('lets a subagent read memory and write neither kind of file', () => {
    const subagent: readonly string[] = SUBAGENT_TOOL_NAMES;
    expect(subagent).toContain('memory');
    expect(subagent).not.toContain('memory_write');
    expect(subagent).not.toContain('skill_write');
  });

  it('gives the pane everything a subagent has, and the writes on top', () => {
    const pane: readonly string[] = AGENT_TOOL_NAMES;
    for (const name of SUBAGENT_TOOL_NAMES) expect(pane).toContain(name);
    expect(pane).toContain('memory_write');
    expect(pane).toContain('skill_write');
  });

  // Both are always advertised: `memory_write` because the first note has to be
  // writable into existence, `skill_write` because `/refine` is a command file
  // rather than a turn with a tool list of its own.
  it('carries both writes as static specs rather than per-turn ones', () => {
    const specs = AGENT_TOOL_SPECS.map((s) => s.function.name);
    expect(specs).toContain('memory_write');
    expect(specs).toContain('skill_write');
    // The reader is built per turn from what is on disk, so it is not here.
    expect(specs).not.toContain('memory');
  });
});

describe('toolSpecsFor', () => {
  it('puts memory ahead of skill, which is ahead of task', () => {
    const offered = toolSpecsFor({
      image: false,
      memory: named('memory'),
      skill: named('skill'),
      task: named('task')
    }).map((s) => s.function.name);

    expect(offered.indexOf('memory')).toBeLessThan(offered.indexOf('skill'));
    expect(offered.indexOf('skill')).toBeLessThan(offered.indexOf('task'));
  });

  it('leaves memory out when nothing was recorded', () => {
    const offered = toolSpecsFor({ image: false, memory: null }).map((s) => s.function.name);
    expect(offered).not.toContain('memory');
    // The write tool is not conditional on it, which is the whole point.
    expect(offered).toContain('memory_write');
  });

  /*
   * How a subagent's narrower list actually excludes the writes: they are in
   * `AGENT_TOOL_SPECS`, and `only` filters that array. A subagent's list is
   * `SubagentToolName[]`, which cannot contain either name.
   */
  it('drops both writes for a run narrowed to a subagent’s tools', () => {
    const offered = toolSpecsFor({
      image: false,
      memory: named('memory'),
      only: SUBAGENT_TOOL_NAMES
    }).map((s) => s.function.name);

    expect(offered).not.toContain('memory_write');
    expect(offered).not.toContain('skill_write');
    expect(offered).toContain('memory');
  });

  it('drops the reader too when the run was narrowed past it', () => {
    const offered = toolSpecsFor({
      image: false,
      memory: named('memory'),
      only: ['read', 'grep']
    }).map((s) => s.function.name);

    expect(offered).toEqual(['read', 'grep']);
  });
});
