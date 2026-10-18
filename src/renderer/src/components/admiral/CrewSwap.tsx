import { useEffect, useState } from 'react';
import {
  CREW_RUNTIMES,
  RUNTIME_LABEL,
  type CrewRole,
  type CrewRuntime
} from '../../../../shared/agency-crew';
import type { PlanStep } from '../../../../shared/agency-plan';
import { OnboardingButton, textInputCls } from './onboarding-ui';
import { useRefusable } from './use-refusable';

/**
 * Swap on a crew card: the role, runtime and model the member's step moves
 * to. Sending it makes a plan change card in the conversation, where the
 * client picks whether the new member continues the work or starts over;
 * nothing stops until they approve it.
 */
export function CrewSwapForm({
  repoId,
  jobId,
  step,
  onClose
}: {
  repoId: string;
  jobId: number;
  /** The step as the approved plan has it. */
  step: PlanStep;
  onClose: () => void;
}): React.JSX.Element {
  const [roles, setRoles] = useState<CrewRole[]>([]);
  const [role, setRole] = useState(step.role);
  const [runtime, setRuntime] = useState<CrewRuntime | null>(step.runtime ?? null);
  const [model, setModel] = useState(step.model ?? '');
  const swap = useRefusable(async () => {
    const result = await window.fleet.agency.swapStep({
      jobId,
      stepId: step.id,
      role,
      runtime,
      model: model.trim() === '' ? null : model.trim()
    });
    if (result.ok) onClose();
    return result;
  });

  useEffect(() => {
    let live = true;
    void window.fleet.agency.crew
      .list(repoId)
      .then((catalog) => live && setRoles(catalog.roles))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repoId]);

  const own = roles.find((r) => r.name === role)?.runtime;
  const names = roles.some((r) => r.name === step.role)
    ? roles.map((r) => r.name)
    : [step.role, ...roles.map((r) => r.name)];

  return (
    <form
      aria-label={`Swap ${step.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void swap.run(undefined);
      }}
      className="flex flex-col gap-2 rounded-md border border-fleet-border bg-fleet-bg/60 p-2.5"
    >
      <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        <label htmlFor={`swap-role-${step.id}`} className="text-fleet-text-muted">
          Role
        </label>
        <select
          id={`swap-role-${step.id}`}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className={textInputCls}
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor={`swap-runtime-${step.id}`} className="text-fleet-text-muted">
          Runtime
        </label>
        <select
          id={`swap-runtime-${step.id}`}
          value={runtime ?? ''}
          onChange={(e) => setRuntime(CREW_RUNTIMES.find((r) => r === e.target.value) ?? null)}
          className={textInputCls}
        >
          <option value="">
            {own === undefined ? "The role's own" : `The role's own (${RUNTIME_LABEL[own]})`}
          </option>
          {CREW_RUNTIMES.map((r) => (
            <option key={r} value={r}>
              {RUNTIME_LABEL[r]}
            </option>
          ))}
        </select>
        <label htmlFor={`swap-model-${step.id}`} className="text-fleet-text-muted">
          Model
        </label>
        <input
          id={`swap-model-${step.id}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="The role's own"
          className={textInputCls}
        />
      </div>
      <p className="text-[11px] text-fleet-text-subtle">
        This makes a plan change. The member keeps working until you approve it.
      </p>
      {swap.refused !== null && <p className="text-[11px] text-red-400">{swap.refused}</p>}
      <div className="flex justify-end gap-2">
        <OnboardingButton onClick={onClose}>Cancel</OnboardingButton>
        <OnboardingButton type="submit" kind="primary" disabled={swap.busy}>
          Propose swap
        </OnboardingButton>
      </div>
    </form>
  );
}
