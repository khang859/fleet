import type { AgentSettings } from '../../../shared/agent-types';
import { isDecisionModel } from '../../../shared/agent-decision-models';
import type { ResolvedTarget } from '../model-routing';
import type { completeOnce } from '../completions';
import type { classifyCommand } from './classifier';
import type { classifyWithDecision } from './decisions';
import type { AutoApproval, AutoApproveRequest } from './gate';

type Deps = {
  getSettings: () => Pick<
    AgentSettings,
    'toolMode' | 'classifierModel' | 'classifierNote' | 'coding'
  >;
  getOpenRouterKey: () => string | null;
  resolveTarget: (modelId: string | null) => ResolvedTarget;
  complete: typeof completeOnce;
  classifyCommand: typeof classifyCommand;
  classifyWithDecision: typeof classifyWithDecision;
};

const ASK: AutoApproval = { verdict: 'ask', usage: null };

/**
 * The gate's `autoApprove`: which model is asked, and how.
 *
 * Its own module so the choice can be tested. Every reason not to consult a
 * model - the mode is off, no model is chosen, no key, nowhere to send the
 * call - comes back as `ask`, which is the answer the gate would have reached
 * without any of this.
 */
export function createAutoApprove(deps: Deps): (req: AutoApproveRequest) => Promise<AutoApproval> {
  return async ({ command, cwd, signal }) => {
    const a = deps.getSettings();
    if (a.toolMode !== 'auto') return ASK;

    // A decision model answers on its own endpoint, not on chat completions,
    // so it skips model routing and goes straight to OpenRouter.
    const model = a.classifierModel;
    if (model !== null && isDecisionModel(model)) {
      const apiKey = deps.getOpenRouterKey();
      // The same "no key" as `resolveTarget`, so a blank key reads as missing
      // rather than as a model that fails on every command.
      if (apiKey === null || apiKey === '') return ASK;
      return deps.classifyWithDecision(apiKey, {
        model,
        command,
        cwd,
        note: a.classifierNote,
        signal
      });
    }

    // Falls through to the coding model rather than to the title model: the
    // one the user already trusts to drive the tools is the honest default,
    // and naming a session is not a judgement about what may run.
    const resolved = deps.resolveTarget(model ?? a.coding.model);
    if (!resolved.ok) return ASK;
    return deps.classifyCommand(deps.complete, {
      target: resolved.target,
      model: resolved.wireModelId,
      command,
      cwd,
      note: a.classifierNote,
      signal
    });
  };
}
