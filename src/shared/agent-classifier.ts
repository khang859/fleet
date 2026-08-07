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

/** What the two answers mean, and which commands earn which. */
const RULES = [
  'You decide whether one shell command may run on a developer machine without stopping to ask the person who is supervising the agent.',
  '',
  'Answer with one word: safe, or ask.',
  '',
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

/**
 * The whole prompt, with the user's note in it if they wrote one.
 *
 * Called with `null` by the settings screen, which is how it shows the built-in
 * text exactly as it would be sent.
 */
export function classifierSystemPrompt(note: string | null): string {
  const trimmed = note?.trim() ?? '';
  if (trimmed === '') return `${RULES}\n\n${CLOSING}`;
  return `${RULES}\n\n${NOTE_HEADING}\n\n${trimmed}\n\n${CLOSING}`;
}
