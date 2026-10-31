import { z } from 'zod';

/** The kind of pane that asks. Main decides what each kind may do. */
export type PaneKind = 'outside' | 'run' | 'last' | 'post';

const NewItem = {
  kind: z.string().min(1).max(60).describe('Short type, such as bug, style or note.'),
  text: z.string().min(1).max(4000).describe('What you found, in plain words.'),
  file: z.string().max(400).optional().describe('Repo path, for a code finding.'),
  line: z.number().int().min(0).optional().describe('Line in the file.'),
  source: z.string().max(800).optional().describe('Link or title, for a research note.')
};

const noArgs = z.strictObject({});

/**
 * The one list of tool names, descriptions and schemas. Main serves it, so the
 * mod and the Pi extension hold no copy and cannot drift apart.
 */
export const TOOLS = {
  fleet_findings_add: {
    panes: ['run', 'last'],
    description:
      'Add one finding to the shared board. A repeat is refused, and the reply shows the item that is already there.',
    args: z.strictObject(NewItem)
  },
  fleet_findings_list: {
    panes: ['run', 'last'],
    description: 'Read the shared board.',
    args: noArgs
  },
  fleet_findings_merge: {
    panes: ['last'],
    description: 'Replace several board items with one merged item.',
    args: z.strictObject({
      ids: z.array(z.string()).min(1).describe('The items to replace.'),
      ...NewItem
    })
  },
  fleet_run_finish: {
    panes: ['run', 'last'],
    description:
      'Say that your work is done. Call this once, at the very end. The last agent sends the full report as the summary.',
    args: z.strictObject({
      summary: z.string().min(1).max(200_000).describe('What you did and what you found.')
    })
  },
  fleet_post_item: {
    panes: ['post'],
    description: 'Post one stored finding to the pull request, by its id.',
    args: z.strictObject({ id: z.string().min(1) })
  },
  fleet_workflow_list: {
    panes: ['outside', 'run', 'last'],
    description: 'List the workflows of this project, with their approval state.',
    args: z.strictObject({ project: z.string().optional() })
  },
  fleet_workflow_run: {
    panes: ['outside'],
    description:
      'Start an approved, unchanged workflow. Use fleet_workflow_list to see the inputs each one needs.',
    args: z.strictObject({
      workflow: z.string().min(1).describe('The workflow id.'),
      project: z.string().optional().describe('Project path. The default is this pane.'),
      inputs: z.record(z.string(), z.string()).default({})
    })
  },
  fleet_workflow_status: {
    panes: ['outside', 'run', 'last'],
    description: 'Return the state of a run. A finished run includes its report.',
    args: z.strictObject({ run: z.string().min(1) })
  },
  fleet_workflow_create: {
    panes: ['outside'],
    description:
      'Write a new workflow file. It waits for a person to approve it, and it never replaces a file.',
    args: z.strictObject({
      id: z.string().min(1).max(60).describe('File name, with no extension.'),
      project: z.string().optional().describe('Project path. The default is this pane.'),
      toml: z.string().min(1).max(100_000).describe('The whole TOML file.')
    })
  }
} satisfies Record<string, { panes: PaneKind[]; description: string; args: z.ZodType }>;

export type ToolName = keyof typeof TOOLS;

/** Each tool's checked arguments. */
export type ToolArgs = { [Name in ToolName]: z.output<(typeof TOOLS)[Name]['args']> };

export type ToolListing = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

export function toolAllowed(name: ToolName, kind: PaneKind): boolean {
  return (TOOLS[name].panes as PaneKind[]).includes(kind);
}

/** The tools a pane sees, as plain JSON schema. */
export function toolsFor(kind: PaneKind): ToolListing[] {
  return Object.keys(TOOLS)
    .filter(isToolName)
    .filter((name) => toolAllowed(name, kind))
    .map((name) => ({
      name,
      description: TOOLS[name].description,
      inputSchema: z.toJSONSchema(TOOLS[name].args, { io: 'input' }) as Record<string, unknown>
    }));
}

/** The name a program sees a Fleet tool under, for the prompts. */
export function toolNameFor(program: 'pi' | 'claude', name: ToolName): string {
  return program === 'claude' ? `mcp__fleet-bridge__${name}` : name;
}
