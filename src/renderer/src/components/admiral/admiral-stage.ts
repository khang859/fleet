import type { AgencyOnboarding } from '../../../../shared/agency';

/**
 * Which screen an Admiral pane shows. Onboarding comes first and in order:
 * first run until there is a model and the client has gone past it, then the
 * picker when asked for, then setup and Meet you for the pane's repository,
 * and only then the lobby and its jobs. Setup shows again when the client
 * asks to redo it, and Meet you when the client goes back to the questions
 * left.
 */
export type AdmiralStage = 'loading' | 'first-run' | 'picker' | 'setup' | 'meet' | 'ready';

export function admiralStage(input: {
  /** The model key has been asked about; until then the answer is not known. */
  keyChecked: boolean;
  /** An OpenRouter key is saved, or a local model is switched on. */
  hasModel: boolean;
  firstRunDone: boolean | null;
  picking: boolean;
  redoingSetup: boolean;
  /** The client went back to the Meet you questions left. */
  meeting: boolean;
  /** The repository's onboarding, from its snapshot; undefined until that is read. */
  onboarding: AgencyOnboarding | undefined;
}): AdmiralStage {
  if (!input.keyChecked || input.firstRunDone === null) return 'loading';
  if (!input.hasModel || !input.firstRunDone) return 'first-run';
  if (input.picking) return 'picker';
  if (input.onboarding === undefined) return 'loading';
  if (input.onboarding.setupDoneAt === null || input.redoingSetup) return 'setup';
  if (input.onboarding.meetDue || input.meeting) return 'meet';
  return 'ready';
}

/** What the header says after the Admiral's name, at each onboarding step. */
export const STAGE_LABEL: Record<Exclude<AdmiralStage, 'ready' | 'loading'>, string> = {
  'first-run': 'First run',
  picker: 'Pick a project',
  setup: 'Setup · step 2 of 3',
  meet: 'Meet your Admiral'
};
