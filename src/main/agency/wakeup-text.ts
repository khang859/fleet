import { fence } from '../../shared/fleet-tools';
import {
  optionLines,
  questionDisplayId,
  REMEMBER_OPTION,
  type AgencyQuestion,
  type ClientFileProposal
} from '../../shared/agency';

/**
 * What woke the Admiral, one entry per claimed wakeup.
 *
 * `answer` is the client answering a question card. `event` is anything else
 * Fleet reports - a crew member finishing, a plan action - as a one-line
 * summary for the event line and an optional body quoting what happened.
 */
export type WakeupItem =
  | {
      kind: 'answer';
      question: AgencyQuestion;
      /** Questions the answer withdrew because they depended on another option. */
      withdrew: number[];
    }
  | { kind: 'event'; line: string; body: string | null }
  /**
   * The client decided on a card. What they wrote is theirs, so it is not
   * fenced; `detail` is what Fleet adds about the decision.
   */
  | { kind: 'client'; line: string; note: string | null; detail: string | null };

function eventLine(item: WakeupItem): string {
  if (item.kind === 'event' || item.kind === 'client') return item.line;
  const id = questionDisplayId(item.question.id);
  return item.question.late ? `Client answered ${id} (late)` : `Client answered ${id}`;
}

/**
 * An answer, repeating the full question and options so it stands on its own
 * after a compaction. The question is the Admiral's own words and goes in a
 * fence like any other quoted text; the answer is the client speaking and is
 * left outside it, because the client is the one voice with authority here.
 */
function answerBody(item: Extract<WakeupItem, { kind: 'answer' }>): string {
  const q = item.question;
  const id = questionDisplayId(q.id);
  const quoted = [`${id}: ${q.question}`];
  if (q.context !== '') quoted.push(`Context: ${q.context}`);
  if (q.proposal !== null) quoted.push(...proposalLines(q.proposal));
  quoted.push(...optionLines(q, 'your pick'));

  const lines = [fence(id, quoted.join('\n')), ...clientAnswerLines(q)];
  if (q.late) {
    const why = q.withdrawnReason ? ` (${q.withdrawnReason})` : '';
    lines.push(
      `This answer came late: ${id} had been withdrawn${why}. Weigh it against what has happened since.`
    );
  }
  if (item.withdrew.length > 0) {
    lines.push(
      `Withdrawn because they depended on another option: ${item.withdrew.map(questionDisplayId).join(', ')}.`
    );
  }
  return lines.join('\n');
}

/** What the client picked and wrote, and what Fleet did about it. */
function clientAnswerLines(q: AgencyQuestion): string[] {
  const id = questionDisplayId(q.id);
  const lines: string[] = [];
  const option = q.answerOption === null ? undefined : q.options[q.answerOption];
  if (option && q.answerOption !== null) {
    lines.push(`The client's answer to ${id}: ${q.answerOption + 1}. ${option.label}`);
  }
  const remembered =
    q.proposal?.topic != null &&
    (q.answerOption === REMEMBER_OPTION.project || q.answerOption === REMEMBER_OPTION.all);
  if (q.answerText !== null && q.answerText !== '') {
    lines.push(
      remembered
        ? `The client rewrote the line, and Fleet saved their words: ${q.answerText}`
        : option
          ? `The client added: ${q.answerText}`
          : `The client's answer to ${id}: ${q.answerText}`
    );
  }
  if (q.proposal !== null) lines.push(proposalOutcome(q.proposal, q.answerOption));
  return lines;
}

/** What Fleet did with a client file card, by the option the client picked. */
function proposalOutcome(proposal: ClientFileProposal, option: number | null): string {
  if (proposal.topic === null) {
    return option === 0
      ? 'Fleet wrote it to the client file; it is in your note from now on.'
      : 'Nothing was written to the client file.';
  }
  if (option === REMEMBER_OPTION.project) {
    return 'Fleet saved it for this project; it is in your note from now on.';
  }
  if (option === REMEMBER_OPTION.all) {
    return 'Fleet saved it for every project, as a You line; it is in your note from now on.';
  }
  return option === REMEMBER_OPTION.decline
    ? `Nothing was saved. The client does not want to be asked about "${proposal.topic}" again on this project, and Fleet refuses another card on it.`
    : 'Nothing was saved.';
}

/** A client file proposal as lines, for the model. */
export function proposalLines(proposal: ClientFileProposal): string[] {
  return [
    ...proposal.add.map((a) =>
      a.replaces === null ? `Add: ${a.text}` : `Replace: ${a.replaces} -> ${a.text}`
    ),
    ...proposal.remove.map((r) => `Remove: ${r}`)
  ];
}

function itemBody(item: WakeupItem): string | null {
  if (item.kind === 'answer') return answerBody(item);
  if (item.kind === 'client') {
    const lines = [
      ...(item.note === null || item.note === '' ? [] : [`The client wrote: ${item.note}`]),
      ...(item.detail === null || item.detail === '' ? [] : [item.detail])
    ];
    return lines.length === 0 ? null : lines.join('\n');
  }
  return item.body === null || item.body === '' ? null : fence('event', item.body);
}

/**
 * All the wakeups due for one job, as the one message that opens one turn: an
 * event line saying what woke the Admiral, then each wakeup's detail. Null
 * when there is nothing to say.
 */
export function renderWakeupText(items: WakeupItem[]): string | null {
  if (items.length === 0) return null;
  const head = items.map(eventLine).join(' · ');
  const bodies = items.map(itemBody).filter((b): b is string => b !== null);
  return bodies.length === 0 ? head : `${head}\n\n${bodies.join('\n\n')}`;
}
