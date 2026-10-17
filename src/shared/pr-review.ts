import { formatList } from './format-list';

/** A review bot's comment thread still open on a PR. */
export type PrComment = {
  /** GitHub's id of the thread's first comment. */
  id: number;
  /** The bot's login, as `name[bot]`. */
  author: string;
  path: string | null;
  line: number | null;
  url: string;
  /** The comment's first line, as plain text. */
  summary: string;
};

/** What a PR still waits on before it is ready, and the bot comments still open. */
export type PrReview = {
  /** Required checks that have not passed yet: not started, or still running. */
  checks: string[];
  /** Review bots that have not reviewed the newest commit, as setup lists them. */
  bots: string[];
  /** Required checks still not started 15 minutes after the newest commit. */
  stuck: string[];
  comments: PrComment[];
};

/** How a review bot reads on a card: `greptile-apps[bot]` is Greptile. */
export function botName(login: string): string {
  const name = login.replace(/\[bot\]$/i, '').replace(/-apps?$/i, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What a PR waits on, as a card says it: "Greptile and the build check". Empty when ready. */
export function waitingFor(review: PrReview | undefined): string {
  if (review === undefined) return '';
  const checks = review.checks.map((c) => `the ${c} check`);
  return formatList([...review.bots.map(botName), ...checks]);
}
