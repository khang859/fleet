import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import { diffLineKind } from '../../../../shared/agent-diff';
import { diffBody } from './diff-body';
import { imageBody, toolBody } from './output-body';
import { toolLabel, toolStatus } from './tool-label';
import { AgentImage, AgentImagePreview } from './AgentImage';

/**
 * One tool call, on one line.
 *
 * The agent reads a lot of files to answer one question, and every product
 * that shows that has converged on the same row: a verb, the thing it acted
 * on, and how much came back. The output itself is behind a disclosure because
 * it is the model's input, not the user's - what the user needs from it is
 * confidence that the agent looked at the right file, and that is the target,
 * not the 200 lines it got.
 *
 * A change to a file is the exception, twice over. Its output is the one thing
 * the user does want to read, so the diff is open from the start; and the
 * output is a diff, so it is drawn as one rather than as a page of text.
 *
 * A generated image is the same exception for the same reason, and one further:
 * it is the only tool whose output is worth looking at *before* it is finished,
 * so a running row shows the renders arriving on the way to it.
 *
 * The other exception is a call that failed. Then the row is the only place the
 * reason exists, so the row says so plainly and the disclosure holds the
 * reason rather than a result.
 */
export function AgentToolRow({
  call,
  partial,
  cleared = false
}: {
  call: AgentToolCall;
  /** The latest half-drawn render, while this call is still generating one. */
  partial?: string;
  /**
   * Whether this result has been dropped from what the model is sent.
   *
   * Said on the row because the alternative is a transcript that quietly stops
   * describing the conversation the model is having. The output stays open
   * underneath either way - it is still what happened, and it is still the
   * user's record - so the marker is about the model's memory, not this pane's.
   */
  cleared?: boolean;
}): React.JSX.Element {
  const status = toolStatus(call);
  const { verb, target } = toolLabel(call);
  const body = toolBody(call);
  const diff = status === 'done' ? diffBody(call) : null;
  const image = status === 'done' ? imageBody(call) : null;
  // Open follows what the row is until the user says otherwise, and then it is
  // theirs: the diff arrives after the row has already rendered as running, so
  // an initial state could not have known what this call turned out to be.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (diff !== null || image !== null);

  const label = (
    <>
      <span className="shrink-0">{verb}</span>
      {target !== '' && <span className="truncate font-mono text-[11px]">{target}</span>}
    </>
  );

  if (status === 'running') {
    return (
      <div className="flex flex-col gap-1.5 pl-[18px]">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="fleet-shimmer-text flex min-w-0 items-center gap-1.5">{label}</span>
        </div>
        {partial !== undefined && <AgentImagePreview src={partial} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setChoice(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {label}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {cleared && (
            <span
              title="This result is no longer sent to the model, to save context. The agent can run the tool again if it needs it."
              className="text-[10px] text-fleet-text-muted/60"
            >
              cleared
            </span>
          )}
          {status === 'failed' ? (
            <span className="text-amber-400/90">failed</span>
          ) : (
            <Summary text={call.summary} />
          )}
        </span>
      </button>
      {open &&
        (image !== null ? (
          <AgentImage src={image} alt={target === '' ? 'Generated image' : target} />
        ) : diff !== null ? (
          <DiffBody lines={diff} />
        ) : (
          body !== null && (
            <pre className="max-h-64 overflow-auto border-l-2 border-fleet-border pl-3 text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
              {body}
            </pre>
          )
        ))}
    </div>
  );
}

/**
 * A summary that is an outcome rather than a size. A command that exits 1 did
 * not fail the way a refused tool fails - it ran, and answered - but it is
 * still the line in the transcript the user needs to notice, and so is the one
 * that is waiting on them to do something.
 */
const TROUBLE = /^(exit [1-9]|timed out|killed|stopped|waiting on you|not allowed)/;

/** `+12 -3` in the colours those numbers have everywhere else. */
function Summary({ text }: { text: string | null }): React.JSX.Element | null {
  if (text === null) return null;
  const counts = /^\+(\d+) -(\d+)$/.exec(text);
  if (counts === null) {
    return (
      <span className={TROUBLE.test(text) ? 'text-amber-400/90' : 'text-fleet-text-subtle'}>
        {text}
      </span>
    );
  }

  return (
    <span className="font-mono">
      <span className="text-emerald-400/90">+{counts[1]}</span>{' '}
      <span className="text-rose-400/90">-{counts[2]}</span>
    </span>
  );
}

const LINE_STYLES: Record<ReturnType<typeof diffLineKind>, string> = {
  add: 'bg-emerald-500/10 text-emerald-200/90',
  remove: 'bg-rose-500/10 text-rose-200/90',
  context: 'text-fleet-text-muted',
  // Opaque on purpose: this tints a line of the diff rather than being chrome
  // over the picture, and the block it sits in is already glass.
  hunk: 'bg-fleet-surface-2/50 text-fleet-text-subtle',
  note: 'text-fleet-text-subtle'
};

/**
 * The diff itself.
 *
 * The `+` and `-` sit in a gutter of their own rather than against the code,
 * the way every diff viewer draws them: a marker touching the first character
 * makes the indentation on that line look one column wider than it is, which is
 * exactly the thing a reader is checking. It is also unselectable, so copying a
 * line out of the diff gives back the line rather than the line plus a sign.
 *
 * The block scrolls sideways rather than wrapping, because a wrapped line of
 * code stops looking like the line it is.
 */
function DiffBody({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <div className="max-h-80 overflow-auto rounded border border-fleet-border bg-fleet-glass-bg backdrop-blur-sm">
      <div className="min-w-max py-1 font-mono text-[11px] leading-[1.55]">
        {lines.map((line, i) => {
          const kind = diffLineKind(line);
          const signed = kind === 'add' || kind === 'remove' || kind === 'context';
          return (
            <div key={i} className={`flex px-2 ${LINE_STYLES[kind]}`}>
              {signed && (
                <span className="w-3 shrink-0 select-none opacity-60">
                  {kind === 'context' ? ' ' : line.slice(0, 1)}
                </span>
              )}
              <span className="whitespace-pre">{signed ? line.slice(1) : line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
