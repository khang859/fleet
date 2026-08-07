import { ImagePlus, RotateCcw } from 'lucide-react';
import {
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
  type AgentCatalogModel,
  type AgentImageConfig
} from '../../../../../shared/agent-types';
import { ModelSelect } from './ModelSelect';
import { OptionPills, RoleCard } from './controls';

/**
 * Image generation: the model, and the three things about a picture that are
 * the user's to decide rather than the agent's.
 *
 * Its own component rather than another `AgentRoleSettings`, because the images
 * endpoint shares nothing with a completion - no output limit, no temperature,
 * no reasoning. Those controls were being drawn here and did nothing at all.
 *
 * What the agent chooses instead is what belongs to the picture it was asked
 * for: the prompt, the aspect ratio, and whether it is editing something.
 */
export function AgentImageSettings({
  models,
  config,
  onChange
}: {
  models: AgentCatalogModel[];
  config: AgentImageConfig;
  onChange: (patch: Partial<AgentImageConfig>) => void;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Image agent"
      description="Generates and edits images on request. With none selected, the agent is not offered the tool at all."
      icon={<ImagePlus size={16} />}
    >
      <ModelSelect
        models={models}
        value={config.model}
        onChange={(id) => onChange({ model: id })}
        allowNone
        noneLabel="None - image generation off"
      />

      {config.model !== null && (
        <>
          <OptionPills
            label="Resolution"
            hint="How large the image comes back. Bigger costs more and takes longer."
            options={IMAGE_RESOLUTIONS}
            value={config.resolution}
            onChange={(resolution) => onChange({ resolution })}
          />

          <OptionPills
            label="Quality"
            hint="How much work the model puts into the render."
            options={IMAGE_QUALITIES}
            value={config.quality}
            onChange={(quality) => onChange({ quality })}
          />

          <SeedField value={config.seed} onChange={(seed) => onChange({ seed })} />
        </>
      )}
    </RoleCard>
  );
}

/**
 * The seed, or nothing.
 *
 * Empty is the useful default and is what the field shows: asking twice should
 * give two different pictures, because the second ask is usually a request for
 * something else. A number here makes the same prompt reproducible, which is
 * what you want while adjusting one word of it - and it is worth knowing that
 * this is the setting quietly making every generation identical.
 */
function SeedField({
  value,
  onChange
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="agent-image-seed" className="text-sm text-fleet-text-secondary">
          Seed
        </label>
        <p className="mt-0.5 text-xs text-fleet-text-muted">
          Fix it to get the same picture from the same prompt. Empty means a new one each time.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          id="agent-image-seed"
          type="number"
          inputMode="numeric"
          min={0}
          value={value ?? ''}
          placeholder="Random"
          onChange={(e) => {
            const next = e.target.value.trim();
            // An unparseable or negative entry is treated as no seed rather
            // than sent - the provider would reject it mid-generation.
            const parsed = Number(next);
            onChange(next === '' || !Number.isFinite(parsed) || parsed < 0 ? null : parsed);
          }}
          className="w-28 rounded-md border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-sm tabular-nums text-fleet-text placeholder:text-fleet-text-subtle focus-ring"
        />
        {value !== null && (
          <button
            type="button"
            onClick={() => onChange(null)}
            title="Back to a new seed each time"
            aria-label="Reset seed"
            className="rounded p-0.5 text-fleet-text-subtle transition-colors hover:text-fleet-text-secondary focus-ring"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
