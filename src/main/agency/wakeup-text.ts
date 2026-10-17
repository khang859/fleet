import { fence } from '../../shared/fleet-tools';
import { optionLines, questionDisplayId, type AgencyQuestion } from '../../shared/agency';

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
  /** The client decided on a card. What they wrote is theirs, so it is not fenced. */
  | { kind: 'client'; line: string; note: string | null };

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
  quoted.push(...optionLines(q, 'your pick'));

  const lines = [fence(id, quoted.join('\n'))];
  const option = q.answerOption === null ? undefined : q.options[q.answerOption];
  if (option && q.answerOption !== null) {
    lines.push(`The client's answer to ${id}: ${q.answerOption + 1}. ${option.label}`);
  }
  if (q.answerText !== null && q.answerText !== '') {
    lines.push(
      option ? `The client added: ${q.answerText}` : `The client's answer to ${id}: ${q.answerText}`
    );
  }
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

function itemBody(item: WakeupItem): string | null {
  if (item.kind === 'answer') return answerBody(item);
  if (item.kind === 'client') {
    return item.note === null || item.note === '' ? null : `The client wrote: ${item.note}`;
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
