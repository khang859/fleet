import { describe, expect, it } from 'vitest';
import {
  PROJECT_INSTRUCTIONS_WARN_TOKENS,
  projectInstructionsNotice,
  renderProjectInstructions
} from '../agent-project-instructions';

describe('renderProjectInstructions', () => {
  it('frames the file and names where it came from', () => {
    const rendered = renderProjectInstructions('AGENTS.md', 'Run the tests before committing.');
    expect(rendered).toContain('AGENTS.md');
    expect(rendered).toContain('do not override the user');
    expect(rendered).toContain('Run the tests before committing.');
  });

  // The whole point of the feature. A framing header that quietly shortened
  // what it framed would defeat it while still looking correct on screen.
  it('carries the file through whole', () => {
    const long = 'x'.repeat(200_000);
    expect(renderProjectInstructions('CLAUDE.md', long)).toContain(long);
  });
});

describe('projectInstructionsNotice', () => {
  it('says what a small file costs without warning about it', () => {
    const notice = projectInstructionsNotice(1_800, 'AGENTS.md');
    expect(notice.warn).toBe(false);
    expect(notice.line).toContain('AGENTS.md');
    expect(notice.line).toContain('1,800');
  });

  it('warns past the threshold and says what to do about it', () => {
    const notice = projectInstructionsNotice(PROJECT_INSTRUCTIONS_WARN_TOKENS + 1, 'AGENTS.md');
    expect(notice.warn).toBe(true);
    expect(notice.line).toContain('skill');
  });

  // The comparison that goes unnoticed when it reads the wrong side.
  it('warns exactly on the threshold, and not one token below it', () => {
    expect(projectInstructionsNotice(PROJECT_INSTRUCTIONS_WARN_TOKENS, 'AGENTS.md').warn).toBe(
      true
    );
    expect(projectInstructionsNotice(PROJECT_INSTRUCTIONS_WARN_TOKENS - 1, 'AGENTS.md').warn).toBe(
      false
    );
  });
});
