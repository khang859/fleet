import { memo, useState } from 'react';
import { ChevronRight, Users } from 'lucide-react';
import {
  fusionFailureMessage,
  parseFusionResult,
  type FusionAnalysis,
  type FusionFailedModel,
  type FusionPanelResponse
} from '../../../../shared/agent-fusion';
import type { ServerToolRecord } from '../../../../shared/agent-server-tools';
import { AgentMarkdown } from './AgentMarkdown';

/**
 * A panel of models reviewing one change.
 *
 * Drawn apart from the search and advisor rows because what came back is
 * neither a list of pages nor one argument: it is several arguments and a
 * reading of where they part company. The parts that matter are the ones a
 * single reviewer could not have produced - what the panel disagreed about,
 * what only one model saw - so those are drawn first and the agreement is
 * drawn last.
 *
 * A degraded result is drawn rather than hidden. The analyst is a separate call
 * from the panel and fails separately; models drop out one at a time. The
 * expensive part is the answers, and a reader who paid for six of them and is
 * shown an error message has been told the wrong thing about what happened.
 */
export const AgentFusionRow = memo(function AgentFusionRow({
  call
}: {
  call: ServerToolRecord;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const result = parseFusionResult(call.result);
  const answered = result?.status === 'ok' ? result.responses.length : 0;
  const failed = result?.failed ?? [];

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
        <Users size={12} className="shrink-0 opacity-70" />
        <span className="shrink-0">Panel review</span>
        {answered > 0 && (
          <span className="shrink-0 text-fleet-text-subtle">
            {answered} {answered === 1 ? 'model' : 'models'}
          </span>
        )}
        {/*
         * A dropped model is not a failed review - the rest of the panel
         * answered - so it is a note beside the count rather than an error
         * state. It is on the collapsed row because it changes what the review
         * is worth, and that should not need a click to find out.
         */}
        {failed.length > 0 && (
          <span className="shrink-0 text-fleet-text-subtle">{failed.length} did not answer</span>
        )}
        {result?.status === 'error' && (
          <span className="shrink-0 text-fleet-text-subtle">failed</span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-l-2 border-fleet-border pl-3">
          {result === null ? (
            <pre className="max-h-64 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
              {call.result}
            </pre>
          ) : result.status === 'error' ? (
            <>
              <p className="text-[11px] leading-relaxed text-fleet-text-muted">
                {fusionFailureMessage(result.failureReason)}
              </p>
              {result.error !== null && (
                <p className="text-[11px] leading-relaxed text-fleet-text-subtle">{result.error}</p>
              )}
              <FailedModels failed={failed} />
            </>
          ) : (
            <>
              {result.analysis === null ? (
                <p className="text-[11px] leading-relaxed text-fleet-text-subtle">
                  The panel answered but the analyst did not. The replies are below, unreconciled.
                </p>
              ) : (
                <Analysis analysis={result.analysis} />
              )}
              <PanelResponses responses={result.responses} />
              <FailedModels failed={failed} />
            </>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * The analyst's reading of the panel.
 *
 * Ordered by what a single reviewer would have missed: the disagreements, then
 * the things one model saw and the others did not, then what nobody looked at,
 * and only then the agreement. Unanimity is the least informative part of a
 * panel and the easiest to skim, so it goes where skimming costs nothing.
 *
 * Every section is skipped when empty rather than shown as a heading over
 * nothing. A report of five headings and one list reads as four failures.
 */
function Analysis({ analysis }: { analysis: FusionAnalysis }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {analysis.contradictions.length > 0 && (
        <Section title="Disagreed">
          <ul className="flex flex-col gap-2">
            {analysis.contradictions.map((row) => (
              <li key={row.topic} className="flex flex-col gap-1">
                <span className="text-[11px] text-fleet-text-secondary">{row.topic}</span>
                <ul className="flex flex-col gap-0.5 pl-3">
                  {row.stances.map((stance) => (
                    <li
                      key={`${row.topic}:${stance.model}`}
                      className="text-[11px] leading-relaxed"
                    >
                      <span className="font-mono text-fleet-text-subtle">{stance.model}</span>{' '}
                      <span className="text-fleet-text-muted">{stance.stance}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.uniqueInsights.length > 0 && (
        <Section title="Only one model saw">
          <ul className="flex flex-col gap-1">
            {analysis.uniqueInsights.map((row) => (
              <li key={`${row.model}:${row.insight}`} className="text-[11px] leading-relaxed">
                <span className="font-mono text-fleet-text-subtle">{row.model}</span>{' '}
                <span className="text-fleet-text-muted">{row.insight}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.partialCoverage.length > 0 && (
        <Section title="Some models raised">
          <ul className="flex flex-col gap-1">
            {analysis.partialCoverage.map((row) => (
              <li key={row.point} className="text-[11px] leading-relaxed text-fleet-text-muted">
                {row.point}
                {row.models.length > 0 && (
                  <span className="text-fleet-text-subtle"> - {row.models.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.blindSpots.length > 0 && (
        <Section title="Nobody looked at">
          <Bullets items={analysis.blindSpots} />
        </Section>
      )}

      {analysis.consensus.length > 0 && (
        <Section title="Agreed">
          <Bullets items={analysis.consensus} />
        </Section>
      )}
    </div>
  );
}

function Bullets({ items }: { items: string[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item} className="text-[11px] leading-relaxed text-fleet-text-muted">
          {item}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wide text-fleet-text-subtle uppercase">{title}</span>
      {children}
    </div>
  );
}

/**
 * What each model actually wrote, one collapsed row apiece.
 *
 * Collapsed because a panel of six is six full reviews and printing them opens
 * a transcript nobody scrolls to the end of. Kept because the analysis is a
 * summary of these, and the reader checking whether a contradiction is real has
 * nowhere else to look.
 */
function PanelResponses({ responses }: { responses: FusionPanelResponse[] }): React.JSX.Element {
  if (responses.length === 0) return <></>;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wide text-fleet-text-subtle uppercase">Replies</span>
      {responses.map((response) => (
        <PanelResponse key={response.model} response={response} />
      ))}
    </div>
  );
}

function PanelResponse({ response }: { response: FusionPanelResponse }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="truncate font-mono">{response.model}</span>
      </button>
      {open && (
        <div className="border-l-2 border-fleet-border pl-3">
          <AgentMarkdown streaming={false} className="text-[13px] leading-relaxed">
            {response.content}
          </AgentMarkdown>
        </div>
      )}
    </div>
  );
}

/**
 * The models that dropped out.
 *
 * Named rather than counted here, because which one failed decides whether the
 * review is short of a perspective or short of a duplicate.
 */
function FailedModels({ failed }: { failed: FusionFailedModel[] }): React.JSX.Element {
  if (failed.length === 0) return <></>;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wide text-fleet-text-subtle uppercase">No answer</span>
      <ul className="flex flex-col gap-0.5">
        {failed.map((row) => (
          <li key={row.model} className="text-[11px] leading-relaxed text-fleet-text-subtle">
            <span className="font-mono">{row.model}</span>
            {row.reason !== null && <span> - {row.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
