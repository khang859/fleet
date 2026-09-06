import { memo, useState } from 'react';
import { ChevronRight, Globe, Lightbulb, Link2 } from 'lucide-react';
import {
  serverToolLabel,
  serverToolQuery,
  type Citation,
  type ServerToolRecord
} from '../../../../shared/agent-server-tools';
import { parseAdvisorPrompt, parseAdvisorResult } from '../../../../shared/agent-advisor';
import { AgentMarkdown } from './AgentMarkdown';

/**
 * Work OpenRouter did, on one line.
 *
 * The same shape as a local tool row on purpose - a chevron, a verb, what it
 * was about - because from the reader's side it is the same event: the agent
 * went and found something out before answering. The differences are that this
 * one never has a running state, since it is reported only once finished, and
 * that its disclosure holds sources rather than output.
 *
 * Sources rather than the raw result, and that is the whole design of this row.
 * A search result is several thousand characters of excerpts assembled for a
 * model to read; printed into the transcript it buries the answer it was
 * gathered for. What a person wants from a search is the list of pages it went
 * to, so they can judge whether the answer rests on anything worth resting on,
 * and each of those is a line with a link on it.
 *
 * The raw payload is still on the record and still replayed to the model. It is
 * simply not what this row is for.
 */
export const AgentServerToolRow = memo(function AgentServerToolRow({
  call
}: {
  call: ServerToolRecord;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const query = serverToolQuery(call.args);
  const sources = call.citations;

  // A consultation is prose rather than a list of links, so it gets its own
  // row. Everything else here is a search-shaped thing and shares this one.
  if (call.toolName === ADVISOR_TOOL_NAME) return <AgentAdvisorRow call={call} />;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <Globe size={12} className="shrink-0 opacity-70" />
        <span className="shrink-0 capitalize">{serverToolLabel(call.toolName)}</span>
        {query !== null && <span className="truncate font-mono text-[11px]">{query}</span>}
        <span className="flex shrink-0 items-center gap-2">
          {sources.length > 0 && (
            <span className="text-fleet-text-muted">
              {sources.length} {sources.length === 1 ? 'source' : 'sources'}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-l-2 border-fleet-border pl-3">
          {sources.length === 0 ? (
            <pre className="max-h-64 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
              {call.result}
            </pre>
          ) : (
            <AgentCitationList citations={sources} />
          )}
        </div>
      )}
    </div>
  );
});

/**
 * The bibliography under a finished answer.
 *
 * A row of its own rather than something folded into the search rows above it,
 * because it answers a different question. A search row says what the agent
 * went and did; this says what the answer rests on. The two lists overlap when
 * a search was what found the pages, and they do not overlap at all when the
 * provider searched natively - that kind of answer arrives with annotations and
 * no search row to hang them off, and without this it cites pages the reader
 * cannot open.
 *
 * Folded by default, and the count is the whole of the collapsed state: the
 * number is what a reader checks at a glance, and expanding is what they do
 * when the answer says something they want to trace.
 */
export const AgentSources = memo(function AgentSources({
  citations
}: {
  citations: Citation[];
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <Link2 size={12} className="shrink-0 opacity-70" />
        <span className="shrink-0">
          {citations.length} {citations.length === 1 ? 'source' : 'sources'}
        </span>
      </button>
      {open && (
        <div className="border-l-2 border-fleet-border pl-3">
          <AgentCitationList citations={citations} />
        </div>
      )}
    </div>
  );
});

/**
 * The pages behind an answer.
 *
 * The title is the link and the address sits under it in a smaller grey,
 * because the title is what a person reads and the host is what they check. The
 * excerpt is what the model was actually shown, clamped to a couple of lines -
 * enough to see whether the page said what the answer claims it said, without
 * turning the transcript into a reading list.
 *
 * A source with no title falls back to its address rather than rendering an
 * empty link, which is a row nobody can click and nobody can explain.
 */
export function AgentCitationList({ citations }: { citations: Citation[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {citations.map((citation) => (
        <li key={citation.url} className="flex flex-col gap-0.5">
          <a
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[11px] text-fleet-accent hover:underline focus-ring"
          >
            {citation.title ?? citation.url}
          </a>
          <span className="truncate text-[10px] text-fleet-text-subtle">
            {hostOf(citation.url)}
          </span>
          {citation.content !== null && (
            <p className="line-clamp-2 text-[11px] leading-relaxed text-fleet-text-muted">
              {citation.content}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The host, for the line under a title.
 *
 * A whole URL under a title is the title's length again in grey and says less:
 * what the reader is checking is whether this came from the project's own docs
 * or from somebody's blog, and the host answers that in a glance. An address
 * that will not parse is shown as it came rather than dropped - a source
 * nobody can quite read still beats a source nobody can see.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The wire name of the tool the row below is for. */
const ADVISOR_TOOL_NAME = 'openrouter:advisor';

/**
 * A consultation with a stronger model.
 *
 * Drawn apart from the search row because what came back is different in kind:
 * a search returns a list of places to look and an advisor returns an argument,
 * written to be read. Collapsed it says who was asked and about what; opened it
 * shows the advice as prose, rendered the way the assistant's own text is,
 * because it was written by a model for the same reader.
 *
 * The question is shown too. Advice read without the question it answers is how
 * a reader ends up believing the advisor was told more than it was - it sees
 * only what the executor typed, not the folder, not the transcript.
 */
export const AgentAdvisorRow = memo(function AgentAdvisorRow({
  call
}: {
  call: ServerToolRecord;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const prompt = parseAdvisorPrompt(call.args);
  const result = parseAdvisorResult(call.result);
  const failed = result?.status === 'error';

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <Lightbulb size={12} className="shrink-0 opacity-70" />
        <span className="shrink-0">Asked</span>
        <span className="shrink-0 font-mono text-[11px]">
          {result?.status === 'ok' ? (result.model ?? 'an advisor') : 'an advisor'}
        </span>
        {prompt !== null && <span className="truncate">{prompt}</span>}
        {/*
         * A failed consultation is not a failed turn - the model carried on
         * without the advice - so this is a note rather than an error state.
         */}
        {failed && <span className="shrink-0 text-fleet-text-subtle">no answer</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-l-2 border-fleet-border pl-3">
          {prompt !== null && (
            <p className="text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-subtle">
              {prompt}
            </p>
          )}
          {result === null ? (
            <pre className="max-h-64 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
              {call.result}
            </pre>
          ) : result.status === 'ok' ? (
            <AgentMarkdown streaming={false} className="text-[13px] leading-relaxed">
              {result.advice}
            </AgentMarkdown>
          ) : (
            <p className="text-[11px] leading-relaxed text-fleet-text-muted">{result.error}</p>
          )}
        </div>
      )}
    </div>
  );
});
