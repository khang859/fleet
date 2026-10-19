import type { AgencyRepoRef } from '../../../shared/agency';
import {
  clientEntries,
  clientEntryList,
  normText,
  removeClientLine,
  YOU_LAYER
} from '../../../shared/agency-client-file';
import {
  githubSlug,
  type ClientLineResult,
  type RuleCandidates
} from '../../../shared/agency-projects';
import {
  parseExtraction,
  READ_SOURCE_IDS,
  type ReadProposal,
  type ReadResult,
  type ReadSource,
  type ReadSourceId
} from '../../../shared/agency-understanding';
import { createLogger } from '../../logger';
import { maskCredentials, type Redactor } from '../../redactor';
import type { ClientFiles } from '../projects/client-file';
import { ghState, type GhRun } from '../projects/gh';
import { repoFacts } from '../projects/repo-reader';
import type { GitRun } from '../repo-identity';
import type { SpendService } from '../spend/spend-service';
import type { AgencyStore } from '../store/agency-store';
import {
  commitEmail,
  homeInstructionsExist,
  jobsWithItems,
  readCommits,
  readInstructions,
  readPastJobs,
  readPrs,
  readReviews,
  type Collected
} from './collect';
import { keepProposals, READ_MAX_TOKENS, READ_SYSTEM_PROMPT, readRequest } from './extract';

const log = createLogger('agency:read');

/** One completion on the Admiral's model and target, with what it cost when the target says. */
export type AdmiralCompletion = (req: {
  system: string;
  user: string;
  maxTokens: number;
}) => Promise<{
  text: string;
  costUsd: number | null;
  /** The model stopped at `maxTokens`, so the answer may end mid-way. */
  cutOff: boolean;
}>;

export type UnderstandingDeps = {
  store: Pick<AgencyStore, 'plans' | 'listQuestions' | 'listJobs' | 'preferences'>;
  clientFiles: ClientFiles;
  spend: Pick<SpendService, 'reserveAdmiralCall' | 'admiralCallDone'>;
  git: GitRun;
  gh: GhRun;
  /** The client's home folder, where only `~/.claude/CLAUDE.md` is read. */
  userHome: string;
  /** The repository that speaks for the project, checked against git. */
  root: (repo: AgencyRepoRef) => Promise<string>;
  rules: (repo: AgencyRepoRef) => Promise<RuleCandidates[]>;
  redactor: (repoId: string) => Promise<Redactor>;
  /** Unset, there is no model to read with. */
  complete: AdmiralCompletion | null;
  emit: (repoId: string) => void;
};

const OUTSIDE_CHANGE: ClientLineResult = {
  ok: false,
  reason: 'This file changed outside Fleet. Keep or undo that change in Settings first.'
};

/** What a source reads, as one sentence, when it can be read. */
function instructionsDetail(project: string[], own: boolean): string {
  const files = [...project, ...(own ? ['your ~/.claude/CLAUDE.md'] : [])];
  const list =
    files.length <= 1
      ? (files[0] ?? '')
      : `${files.slice(0, -1).join(', ')} and ${files.at(-1) ?? ''}`;
  return list.charAt(0).toUpperCase() + list.slice(1);
}

/**
 * Read your work: the sources a project offers, the one read of what the
 * client ticked, and saving the lines the client keeps. Nothing is read
 * that is not ticked, and nothing is saved that the client did not keep.
 */
export class Understanding {
  constructor(private readonly deps: UnderstandingDeps) {}

  /** Each source and whether it can be read now, without reading what it holds. */
  async sources(repo: AgencyRepoRef): Promise<ReadSource[]> {
    const root = await this.deps.root(repo);
    const [facts, gh, email, own, rules] = await Promise.all([
      repoFacts(root, this.deps.git),
      ghState(this.deps.gh, root),
      commitEmail(root, this.deps.git),
      homeInstructionsExist(this.deps.userHome),
      this.deps.rules(repo)
    ]);
    const slug = githubSlug(facts.remote);
    const github =
      slug === null
        ? 'The project is not on GitHub.'
        : gh === 'ok'
          ? null
          : gh === 'signed-out'
            ? 'Sign in to the GitHub CLI to read this.'
            : 'Install the GitHub CLI to read this.';
    const jobs = jobsWithItems(this.deps.store, repo.repoId).length;
    const project = rules.map((c) => c.source);
    const found: Record<ReadSourceId, string | null> = {
      instructions: project.length > 0 || own ? null : 'No CLAUDE.md or AGENTS.md here yet.',
      commits: email === null ? 'Git has no user.email set here.' : null,
      reviews: github,
      prs: github,
      jobs: jobs === 0 ? 'No past job here has a plan change or answer yet.' : null
    };
    const detail: Record<ReadSourceId, string> = {
      instructions: instructionsDetail(project, own),
      commits: `Commits by ${email ?? ''}.`,
      reviews: `On ${slug ?? ''}.`,
      prs: `On ${slug ?? ''}.`,
      jobs: jobs === 1 ? '1 job.' : `${jobs} jobs.`
    };
    return READ_SOURCE_IDS.map((id) => ({
      id,
      available: found[id] === null,
      detail: found[id] ?? detail[id]
    }));
  }

  /**
   * Read the ticked sources, mask secrets in what they hold, and ask the
   * Admiral's model once for the lines it shows. Refused with nothing ticked,
   * with no model, and while the monthly cap is reached.
   */
  async read(repo: AgencyRepoRef, ticked: ReadSourceId[]): Promise<ReadResult> {
    const ids = new Set(ticked);
    if (ids.size === 0) return { ok: false, reason: 'Tick at least one thing I may read.' };
    const { complete } = this.deps;
    if (complete === null) {
      return { ok: false, reason: 'The Admiral has no model to read with. Set one in Settings.' };
    }
    const root = await this.deps.root(repo);
    const [collected, rules] = await Promise.all([
      this.collect(repo, root, ids),
      this.deps.rules(repo)
    ]);
    if (collected.length === 0) {
      return { ok: false, reason: 'There was nothing to read in what you ticked.' };
    }
    const saved = {
      you: clientEntries(this.deps.clientFiles.read(YOU_LAYER)),
      project: clientEntries(this.deps.clientFiles.read(repo.repoId))
    };
    const redactor = await this.deps.redactor(repo.repoId);
    const user = maskCredentials(redactor.redact(readRequest({ saved, rules, collected })));
    const gate = this.deps.spend.reserveAdmiralCall();
    if (!gate.ok) return { ok: false, reason: gate.text };
    let out: Awaited<ReturnType<AdmiralCompletion>>;
    try {
      out = await complete({ system: READ_SYSTEM_PROMPT, user, maxTokens: READ_MAX_TOKENS });
      this.deps.spend.admiralCallDone(gate.reservationId, out.costUsd);
    } catch (err) {
      this.deps.spend.admiralCallDone(gate.reservationId, null);
      return { ok: false, reason: `The Admiral's model did not answer: ${String(err)}` };
    }
    const proposals = parseExtraction(out.text);
    if (proposals === null) {
      // Lengths only: the answer quotes the client's own text.
      log.warn('read answer not parsed', { cutOff: out.cutOff, length: out.text.length });
      return {
        ok: false,
        reason: out.cutOff
          ? "The Admiral's model ran out of room before it finished. Tick fewer things, or pick a model that thinks less."
          : "The Admiral's model sent back something Fleet could not read. Try again."
      };
    }
    const lines = keepProposals(proposals, {
      read: new Set(collected.map((c) => c.tag)),
      saved: [...saved.you, ...saved.project],
      rules
    });
    return { ok: true, lines };
  }

  private async collect(
    repo: AgencyRepoRef,
    root: string,
    ids: ReadonlySet<ReadSourceId>
  ): Promise<Collected[]> {
    const { git, gh, userHome, store } = this.deps;
    const slug = ids.has('reviews') || ids.has('prs') ? await this.slug(root) : null;
    const reads = await Promise.all([
      ids.has('instructions') ? readInstructions(root, { git, userHome }) : [],
      ids.has('commits') ? readCommits(root, git) : null,
      ids.has('reviews') && slug !== null ? readReviews(slug, { gh, cwd: root }) : null,
      ids.has('prs') && slug !== null ? readPrs(slug, { gh, cwd: root }) : null,
      Promise.resolve(ids.has('jobs') ? readPastJobs(store, repo.repoId) : null)
    ]);
    return reads.flat().filter((c): c is Collected => c !== null);
  }

  /** The project's GitHub `owner/name`, when the GitHub CLI is signed in to read it. */
  private async slug(root: string): Promise<string | null> {
    const slug = githubSlug((await repoFacts(root, this.deps.git)).remote);
    if (slug === null) return null;
    return (await ghState(this.deps.gh, root)) === 'ok' ? slug : null;
  }

  /**
   * Save lines the client kept, each tagged with where it was read, and open
   * a conflict for one that clashes with a project rule. Refused while a
   * layer it writes has an outside change the client has not kept.
   */
  keep(repo: AgencyRepoRef, lines: ReadProposal[]): ClientLineResult {
    const { clientFiles, store } = this.deps;
    const layerOf = (l: ReadProposal): string => (l.layer === 'you' ? YOU_LAYER : repo.repoId);
    const layers = [...new Set(lines.map(layerOf))];
    if (layers.some((layer) => clientFiles.changedOutside(layer))) return OUTSIDE_CHANGE;
    for (const layer of layers) {
      const mine = lines.filter((l) => layerOf(l) === layer);
      clientFiles.merge(layer, {
        name: layer === YOU_LAYER ? 'You' : repo.name,
        lines: mine.map((l) => ({ text: l.text, source: l.source }))
      });
      for (const l of mine) {
        if (l.clash === null) continue;
        const open = store.preferences
          .conflicts(layer)
          .some((c) => c.normText === normText(l.text));
        if (!open) {
          store.preferences.openConflict({
            layer,
            text: l.text,
            ruleSource: l.clash.source,
            ruleText: l.clash.rule
          });
        }
      }
    }
    this.deps.emit(repo.repoId);
    return { ok: true };
  }

  /**
   * The client picks a conflict's winner. The rule winning removes the line;
   * the line winning keeps it, and the note says it overrides the rule.
   */
  settle(input: {
    repoId: string;
    layer: string;
    id: number;
    winner: 'line' | 'rule';
  }): ClientLineResult {
    const { clientFiles, store } = this.deps;
    const conflict = store.preferences.conflicts(input.layer).find((c) => c.id === input.id);
    if (conflict?.status !== 'open') return { ok: false, reason: 'That clash is settled already.' };
    if (input.winner === 'rule') {
      if (clientFiles.changedOutside(input.layer)) return OUTSIDE_CHANGE;
      const text = clientFiles.read(input.layer) || null;
      const entries = clientEntryList(text);
      const index = entries.findIndex((e) => normText(e.text) === conflict.normText);
      if (index >= 0) {
        const next = removeClientLine(text, { index, was: entries[index].text });
        if (next !== null) clientFiles.write(input.layer, next);
      }
    }
    store.preferences.settleConflict(conflict.id, input.winner);
    this.deps.emit(input.repoId);
    return { ok: true };
  }
}
