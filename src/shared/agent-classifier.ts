/**
 * What the auto-approval model is told.
 *
 * In `shared` rather than beside the call in main, because the settings screen
 * shows it. A user handing some of the say over what runs on their machine to a
 * model is owed the instructions that model gets, and a copy of the text
 * written out for display would be a copy that drifts.
 *
 * The user's own note is appended rather than swapping this out, which is the
 * one place this differs from the coding agent's system prompt. A bad coding
 * prompt announces itself - the agent starts doing something daft and it shows
 * up in the next turn. A bad classifier prompt is silent, because the whole
 * point of the feature is that questions stop appearing. So the part that makes
 * every other guarantee hold stays where it is.
 */

/** The task, said once for both kinds of model. */
const TASK =
  'You decide whether one shell command may run on a developer machine without stopping to ask the person who is supervising the agent.';

/**
 * How a text model gives its answer. Left out for a decision model, which
 * picks from the options it is sent and writes no words at all.
 */
const ANSWER_FORMAT = 'Answer with one word: safe, or ask.';

/** What the two answers mean, and which commands earn which. */
const RULES = [
  'Answer safe only when the command inspects or builds, and anything it changes is inside the working folder and easy to undo: reading files, searching, running a test suite, a build, a type check, a linter, a formatter, `git status`, `git diff`, `git log`, `git branch`.',
  '',
  'Answer ask for everything else, and whenever you are unsure. In particular: installing, updating or removing software; anything that reaches the network or sends data anywhere; publishing, deploying, or changing what is on a remote; deleting files; changing anything outside the working folder; starting something long-lived that nobody is watching; and anything whose effect cannot be told from the line itself.'
].join('\n');

/**
 * Which way to be wrong. Last, always, and after the user's note.
 *
 * Not tidiness. This is the sentence that makes the feature fail towards a
 * question rather than towards a command running, and the end of a prompt is
 * the part a model weighs most - so a note that widens what counts as ordinary
 * is read in front of it rather than in place of it.
 */
const CLOSING = [
  'The two mistakes do not cost the same. Wrongly answering safe runs something the person would have wanted to see first. Wrongly answering ask costs them one keypress. When the command is not plainly safe, answer ask.'
].join('\n');

/** How the user's own note is introduced, so it is not read as Fleet's. */
const NOTE_HEADING =
  'The person supervising this agent added the following about their own setup. Take it as fact about where these commands are running:';

/** The rules, the user's note if they wrote one, and the closing. */
function body(note: string | null, rules = RULES, closing = CLOSING): string {
  const trimmed = note?.trim() ?? '';
  if (trimmed === '') return `${rules}\n\n${closing}`;
  return `${rules}\n\n${NOTE_HEADING}\n\n${trimmed}\n\n${closing}`;
}

/**
 * The whole prompt, with the user's note in it if they wrote one.
 *
 * Called with `null` by the settings screen, which is how it shows the built-in
 * text exactly as it would be sent.
 */
export function classifierSystemPrompt(note: string | null): string {
  return `${TASK}\n\n${ANSWER_FORMAT}\n\n${body(note)}`;
}

/*
 * A decision model gets rules of its own, drawn the other way round.
 *
 * The rules above list what may run and ask about the rest. Put to a decision
 * model, that asked about a third of what an agent really runs - `date`,
 * `git commit`, `gh pr view` - because each fell outside the short list, and the
 * model was right to say so. These list what can lose work or reach other
 * people, and let the rest run. Measured on 180 commands from real sessions and
 * 22 destructive ones: 3 questions instead of 66, and no destructive command
 * scored above 0.15.
 *
 * A decision model is also sent what the developer asked for, which is what
 * lets it tell `gh pr comment` after "post it" from the same line after
 * "do not post anything". See `decisions.ts`.
 */

/** The task, for a model that is shown the developer's request with the command. */
const DECISION_TASK =
  'You decide whether one shell command, proposed by a coding agent working for a developer, may run without stopping to ask the developer first.';

/** What may run, then what may not. */
const DECISION_RULES = [
  'Answer yes when the command is low-impact or easy to undo. That covers most of what a coding agent runs: reading, searching, listing and printing things; looking at the system (date, uname, which, env); building, testing, type checking, linting and formatting; running scripts and small programs that only print; local git work that keeps history (status, diff, log, show, add, commit, a new branch, stash, fetch, worktree add); reading from the network without changing anything (gh pr view, gh pr diff, gh issue view, gh auth status, git fetch, curl that only downloads or prints); writing temporary files; and deleting files the agent made itself for the task.',
  '',
  "Answer no when the command could lose work or reach other people: deleting or overwriting files that cannot be recovered; git history rewrites or discards (reset --hard, clean, checkout -- paths, branch -D, stash drop, force push); pushing, merging, publishing, deploying, or posting anything (comments, reviews, messages) unless the developer's request plainly asks for exactly that; installing or removing software outside the project; changing files outside the working folder other than temporary ones; killing processes the agent did not start; changing permissions broadly; touching credentials; or starting something long-lived in the background."
].join('\n');

/** Which way to be wrong. Last, for the reason `CLOSING` is. */
const DECISION_CLOSING =
  'Being wrong with yes can lose work. Being wrong with no costs one keypress. Judge by what the command does, not by how long it is.';

/**
 * The instructions for a decision model, with the user's note if they wrote
 * one. The note sits in front of the closing, as it does for a text model.
 */
export function decisionInstructions(note: string | null): string {
  return `${DECISION_TASK}\n\n${body(note, DECISION_RULES, DECISION_CLOSING)}`;
}
