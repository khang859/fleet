import { existsSync } from 'node:fs';
import {
  agentsOf,
  needsPersonAtRun,
  stagesOf,
  type PrRef,
  type RunOrigin,
  type StartRunRequest,
  type StartRunResult,
  type WorkflowAgentDef,
  type WorkflowCheck,
  type WorkflowDef,
  type WorkflowEntry,
  type WorkflowPreview,
  type WorkflowProgram
} from '../../shared/workflows';
import type { ApprovalStore } from './approval';
import type { WorkflowCatalog } from './catalog';
import { parseWorkflow, readWorkflowFile, slugOf, targetOf } from './config';
import { fetchPr, ghStatus, parsePrInput, repoSlug, type Exec, type PrInfo } from './pr';
import type { WorkflowRunManager } from './run-manager';

export type StartDeps = {
  catalog: WorkflowCatalog;
  approvals: ApprovalStore;
  runs: WorkflowRunManager;
  exec: Exec;
  platform: NodeJS.Platform;
  /** Whether the bridge is up, with what is wrong when it is not. */
  bridgeProblem: () => string | null;
  /** Finds a program on the login PATH. */
  hasProgram: (program: WorkflowProgram) => Promise<boolean>;
};

type StartOptions = {
  origin: RunOrigin;
  ruleId: string | null;
  focus: boolean;
};

type Refusal = { ok: false; code: string; message: string; runId?: string };

function refuse(code: string, message: string, runId?: string): Refusal {
  return { ok: false, code, message, runId };
}

function isRefusal<T extends object>(value: T | Refusal): value is Refusal {
  return 'ok' in value && !value.ok;
}

type ResolvedPr = { pr: PrRef; team: boolean; open: boolean; number: number };

function programsIn(def: WorkflowDef): WorkflowProgram[] {
  return [...new Set(agentsOf(def).map((agent) => agent.program))];
}

function hasPlanAgent(def: WorkflowDef): boolean {
  return agentsOf(def).some((agent) => agent.plan === true);
}

const NO_PERSON_AT_RULE = 'This workflow talks with a person, so a rule cannot start it.';

function withProgram(def: WorkflowDef, program: WorkflowProgram | undefined): WorkflowDef {
  if (!program) return def;
  const swap = (agent: WorkflowAgentDef): WorkflowAgentDef => ({ ...agent, program });
  return {
    ...def,
    agents: def.agents.map(swap),
    judge: def.judge ? swap(def.judge) : undefined,
    stages:
      def.stages && stagesOf(def).map((stage) => ({ ...stage, agents: stage.agents.map(swap) }))
  };
}

function refOf(info: PrInfo): PrRef {
  return {
    number: info.number,
    title: info.title,
    url: info.url,
    headSha: info.headSha,
    movedOn: false
  };
}

/** Every check before a run, for the run sheet and for each start. */
export class WorkflowStarts {
  constructor(private readonly deps: StartDeps) {}

  private prInput(def: WorkflowDef, inputs: Record<string, string>): string | null {
    const input = def.inputs.find((candidate) => candidate.type === 'pr');
    return input ? (inputs[input.name] ?? '') : null;
  }

  private missingInput(def: WorkflowDef, inputs: Record<string, string>): string | null {
    const missing = def.inputs.find(
      (input) => input.required && (inputs[input.name] ?? '').trim() === ''
    );
    return missing ? missing.label : null;
  }

  private async resolvePr(projectPath: string, text: string): Promise<ResolvedPr | Refusal> {
    const parsed = parsePrInput(text);
    if (!parsed) return refuse('bad-pr', `${text} is not a PR number or link.`);
    const { exec } = this.deps;
    try {
      if (parsed.repo) {
        const here = await repoSlug(exec, projectPath);
        if (here.toLowerCase() !== parsed.repo.toLowerCase()) {
          return refuse(
            'other-repo',
            `This link is for ${parsed.repo}, and this project is ${here}. Switch project.`
          );
        }
      }
      const info = await fetchPr(exec, projectPath, parsed.number);
      return {
        pr: refOf(info),
        team: info.team,
        open: info.state === 'open',
        number: info.number
      };
    } catch (err) {
      return refuse('no-pr', `PR ${parsed.number} was not found: ${String(err)}`);
    }
  }

  private async programChecks(
    def: WorkflowDef,
    override: WorkflowProgram | undefined
  ): Promise<{ checks: WorkflowCheck[]; notes: string[] }> {
    const checks: WorkflowCheck[] = [];
    const notes: string[] = [];
    for (const program of programsIn(withProgram(def, override))) {
      if (program === 'claude' && this.deps.platform === 'win32') {
        notes.push(
          'Claude Code has no Fleet tools on Windows, as the Fleet mod does not load there.'
        );
        checks.push({
          label: 'Claude Code on Windows',
          ok: false,
          detail: 'Claude Code agents cannot use Fleet tools here.',
          fix: 'Use Pi for this run'
        });
        continue;
      }
      const ok = await this.deps.hasProgram(program);
      const name = program === 'pi' ? 'Pi' : 'Claude Code';
      const other = program === 'pi' ? 'Use Claude Code for this run' : 'Use Pi for this run';
      checks.push({ label: `${name} is installed`, ok, fix: ok ? undefined : other });
    }
    return { checks, notes };
  }

  private bridgeCheck(): WorkflowCheck {
    const problem = this.deps.bridgeProblem();
    return {
      label: 'Fleet tools are ready',
      ok: problem === null,
      detail: problem ?? undefined,
      fix: problem ? 'Turn tracking on' : undefined
    };
  }

  private async githubCheck(projectPath: string): Promise<WorkflowCheck> {
    const status = await ghStatus(this.deps.exec, projectPath);
    return {
      label: 'GitHub CLI is signed in',
      ok: status.ok,
      detail: status.detail,
      fix: status.ok ? undefined : 'Run gh auth login in a terminal'
    };
  }

  private entryOrNull(req: StartRunRequest): WorkflowEntry | undefined {
    return this.deps.catalog.find(req.projectPath, req.workflowId);
  }

  /** What the run sheet shows. Nothing here changes anything. */
  async preview(req: StartRunRequest): Promise<WorkflowPreview> {
    const entry = this.entryOrNull(req);
    const empty: WorkflowPreview = { checks: [], pr: null, programNotes: [], duplicateRunId: null };
    if (!entry?.def)
      return { ...empty, checks: [{ label: 'The workflow file is valid', ok: false }] };

    const { def } = entry;
    const { checks, notes } = await this.programChecks(def, req.programOverride);
    checks.push(this.bridgeCheck());

    const text = this.prInput(def, req.inputs);
    let pr: WorkflowPreview['pr'] = null;
    if (text !== null || def.finish?.action === 'open-pr') {
      checks.push(await this.githubCheck(req.projectPath));
    }
    if (text !== null) pr = text.trim() === '' ? null : await this.previewPr(req, text, checks);
    const target = targetOf(def, this.withNumber(def, req.inputs, pr?.number));
    const duplicate = this.deps.runs.findActive(entry.path, target);
    return { checks, pr, programNotes: notes, duplicateRunId: duplicate?.id ?? null };
  }

  private async previewPr(
    req: StartRunRequest,
    text: string,
    checks: WorkflowCheck[]
  ): Promise<WorkflowPreview['pr']> {
    const resolved = await this.resolvePr(req.projectPath, text);
    if (isRefusal(resolved)) {
      checks.push({ label: 'The pull request is ready', ok: false, detail: resolved.message });
      return null;
    }
    const { pr, team, open } = resolved;
    if (!open) {
      checks.push({
        label: 'The pull request is open',
        ok: req.allowClosedPr === true,
        detail: `PR ${pr.number} is closed.`,
        fix: 'Review it anyway'
      });
    }
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: open ? 'open' : 'closed',
      locked: !team && req.trustPr !== true
    };
  }

  /** The PR input as a plain number, so `123` and a link to 123 are one target. */
  private withNumber(
    def: WorkflowDef,
    inputs: Record<string, string>,
    number: number | undefined
  ): Record<string, string> {
    const input = def.inputs.find((candidate) => candidate.type === 'pr');
    if (!input || number === undefined) return inputs;
    return { ...inputs, [input.name]: String(number) };
  }

  /** The approved bytes of a file, read now, or why they cannot start. */
  private approved(req: StartRunRequest): { entry: WorkflowEntry; text: string } | Refusal {
    const entry = this.entryOrNull(req);
    if (!entry) return refuse('not-found', `No workflow named ${req.workflowId}.`);
    if (entry.error || !entry.def)
      return refuse('invalid', entry.error ?? 'The file is not valid.');
    if (entry.approval === 'needs-approval') {
      return refuse('needs-approval', `${entry.def.name} needs approval.`);
    }
    if (entry.approval === 'changed') {
      return refuse('changed', `${entry.def.name} changed since it was approved.`);
    }
    const file = readWorkflowFile(entry.path);
    if (file.hash !== entry.hash) {
      return refuse('changed', `${entry.def.name} changed since it was approved.`);
    }
    return { entry, text: file.text };
  }

  private async failedCheck(req: StartRunRequest, def: WorkflowDef): Promise<Refusal | null> {
    const missing = this.missingInput(def, req.inputs);
    if (missing) return refuse('missing-input', `${missing} is empty.`);
    if (!existsSync(req.projectPath)) return refuse('no-project', 'The project folder is gone.');
    const { checks } = await this.programChecks(def, req.programOverride);
    checks.push(this.bridgeCheck());
    if (def.finish?.action === 'open-pr') checks.push(await this.githubCheck(req.projectPath));
    const failed = checks.find((check) => !check.ok);
    return failed ? refuse('check-failed', failed.detail ?? failed.label) : null;
  }

  private async prForRun(
    req: StartRunRequest,
    def: WorkflowDef
  ): Promise<{ resolved: ResolvedPr | null; locked: boolean } | Refusal> {
    const text = this.prInput(def, req.inputs);
    // Only an optional input can be blank here.
    if (text === null || text.trim() === '') return { resolved: null, locked: false };
    const resolved = await this.resolvePr(req.projectPath, text);
    if (isRefusal(resolved)) return resolved;
    if (!resolved.open && !req.allowClosedPr) {
      return refuse('pr-closed', `PR ${resolved.number} is closed.`);
    }
    return { resolved, locked: !resolved.team && req.trustPr !== true };
  }

  /** The one way to start a run, from a person, an agent or a rule. */
  async start(req: StartRunRequest, options: StartOptions): Promise<StartRunResult> {
    const approved = this.approved(req);
    if (isRefusal(approved)) return approved;
    const { entry, text } = approved;
    const def = withProgram(parseWorkflow(text), req.programOverride);

    if (options.origin === 'automatic' && needsPersonAtRun(def)) {
      return refuse('needs-person', NO_PERSON_AT_RULE);
    }
    const failed = await this.failedCheck(req, def);
    if (failed) return failed;
    const pr = await this.prForRun(req, def);
    if (isRefusal(pr)) return pr;
    if (pr.locked && hasPlanAgent(def)) {
      return refuse('locked-plan', 'A locked run cannot change code, so it cannot build a plan.');
    }

    const inputs = this.withNumber(def, req.inputs, pr.resolved?.number);
    const target = targetOf(def, inputs);
    const duplicate = this.deps.runs.findActive(entry.path, target);
    if (duplicate && !req.force) {
      return refuse('duplicate', `${def.name} is already running for this target.`, duplicate.id);
    }

    const run = this.deps.runs.create({
      workflowId: entry.id,
      path: entry.path,
      projectPath: req.projectPath,
      def,
      bytes: text,
      hash: entry.hash,
      inputs,
      target,
      slug: slugOf(def, inputs),
      origin: options.origin,
      ruleId: options.ruleId,
      pr: pr.resolved?.pr ?? null,
      locked: pr.locked,
      teamPr: def.workspace === 'pr-worktree' && pr.resolved !== null && !pr.locked,
      focus: options.focus
    });
    return { ok: true, runId: run.id };
  }
}
