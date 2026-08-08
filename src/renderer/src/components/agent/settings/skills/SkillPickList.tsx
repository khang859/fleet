import { useMemo } from 'react';
import type { FoundSkill, SkillStatus } from '../../../../../../shared/agent-skill-install';
import { shortenPath } from '../../../../lib/shorten-path';

/**
 * Skills offered as a list to tick.
 *
 * Shared by the two ways skills arrive - a scan of what is already on disk, and
 * a repository just cloned - because from here they are the same thing: some
 * folders, grouped by where they came from, some of which the user wants.
 *
 * Grouped rather than flattened for the reason the MCP import is: two tools both
 * having a `commit-message` skill is ordinary, and the only thing telling them
 * apart is the folder above them.
 */

const FOUND_IN_LABEL: Record<FoundSkill['origin']['foundIn'], string> = {
  fleet: 'Fleet',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  agents: 'Agents',
  git: 'Repository'
};

/** One skills root's worth of findings. */
type Group = {
  key: string;
  label: string;
  /** True when the label is a repository, which is written as its author wrote it. */
  verbatim: boolean;
  path: string;
  found: FoundSkill[];
};

export function SkillPickList({
  found,
  picked,
  onPickedChange,
  within
}: {
  found: FoundSkill[];
  /** The paths ticked. A path is a skill's own folder, which is unique already. */
  picked: Set<string>;
  onPickedChange: (next: Set<string>) => void;
  /**
   * A checkout the roots sit inside, if they came from one.
   *
   * Paths are shown relative to it. The temp folder a clone landed in is not
   * information - `skills/` is, because it says where in the repository to look.
   */
  within?: string;
}): React.JSX.Element {
  const groups = useMemo(() => groupByRoot(found, within), [found, within]);

  const toggle = (path: string): void => {
    const next = new Set(picked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onPickedChange(next);
  };

  const setGroup = (group: Group, on: boolean): void => {
    const next = new Set(picked);
    for (const skill of group.found) {
      if (on) next.add(skill.origin.path);
      else next.delete(skill.origin.path);
    }
    onPickedChange(next);
  };

  return (
    <>
      {groups.map((group) => {
        const allOn = group.found.every((f) => picked.has(f.origin.path));
        return (
          <div key={group.key}>
            <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-1">
              <div className="min-w-0">
                <p
                  className={`truncate text-[10px] font-medium text-fleet-text-subtle ${
                    group.verbatim ? 'font-mono' : 'uppercase tracking-wider'
                  }`}
                >
                  {group.label}
                </p>
                <p className="truncate text-[11px] text-fleet-text-subtle/80" title={group.path}>
                  {group.verbatim ? group.path : shortenPath(group.path)}
                </p>
              </div>
              {group.found.length > 1 && (
                <button
                  type="button"
                  onClick={() => setGroup(group, !allOn)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
                >
                  {allOn ? 'None' : 'All'}
                </button>
              )}
            </div>
            {group.found.map((skill) => (
              <FoundRow
                key={skill.origin.path}
                skill={skill}
                checked={picked.has(skill.origin.path)}
                onToggle={() => toggle(skill.origin.path)}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

function FoundRow({
  skill,
  checked,
  onToggle
}: {
  skill: FoundSkill;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-5 py-2 transition-colors hover:bg-fleet-surface-2/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 size-3.5 shrink-0 fleet-accent-input focus-ring"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fleet-text">{skill.name}</span>
        {/* Two lines of it. The description is what the model reads to decide
            whether to use the skill, so it is also the only thing here that
            tells a user what they are about to install - but a spec allows it
            a thousand characters, and a row is not a document. */}
        <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fleet-text-muted">
          {skill.description}
        </span>
      </span>
      <Marker status={skill.status} />
    </label>
  );
}

/**
 * Whether this one is worth a second look.
 *
 * `known` gets a word rather than a badge: it is the majority on every re-scan,
 * and a badge that appears on nearly every row stops being read.
 */
function Marker({ status }: { status: SkillStatus }): React.JSX.Element {
  if (status === 'known') {
    return (
      <span className="mt-1 w-14 shrink-0 text-right text-[10px] text-fleet-text-subtle">have</span>
    );
  }
  const look =
    status === 'new'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return (
    <span
      className={`mt-0.5 w-14 shrink-0 rounded border px-1.5 py-px text-center text-[10px] font-medium ${look}`}
    >
      {status}
    </span>
  );
}

function groupByRoot(found: FoundSkill[], within: string | undefined): Group[] {
  const groups = new Map<string, Group>();
  for (const skill of found) {
    const { foundIn, scope, root, from } = skill.origin;
    const existing = groups.get(root);
    if (existing !== undefined) {
      existing.found.push(skill);
      continue;
    }
    const fromRepo = foundIn === 'git';
    groups.set(root, {
      key: root,
      // A clone says which repository it is; a folder on disk says whose it is
      // and whether it follows the user or belongs to this project.
      label: fromRepo
        ? from
        : `${FOUND_IN_LABEL[foundIn]} · ${scope === 'user' ? 'all projects' : 'this project'}`,
      verbatim: fromRepo,
      path: fromRepo ? inside(root, within) : root,
      found: [skill]
    });
  }
  return [...groups.values()];
}

/**
 * Where a root sits inside the checkout, written the way the repo would.
 *
 * The repository root itself gets `/`, rather than an empty line that would
 * make the heading jump about between groups.
 */
function inside(root: string, within: string | undefined): string {
  if (within === undefined || !root.startsWith(within)) return root;
  const rest = root.slice(within.length).replace(/^\/+/, '');
  return rest === '' ? '/' : `${rest}/`;
}
