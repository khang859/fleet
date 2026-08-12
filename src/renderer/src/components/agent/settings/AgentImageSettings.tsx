import { ExternalLink, ImagePlus, RotateCcw } from 'lucide-react';
import {
  supportedImageConfig,
  type AgentImageConfig,
  type AgentImageModel
} from '../../../../../shared/agent-types';
import { ModelPicker } from './ModelSelect';
import { OptionPills, RoleCard } from './controls';

/**
 * Image generation: the model, and the things about a picture that are the
 * user's to decide rather than the agent's.
 *
 * Its own component rather than another `AgentRoleSettings`, because the images
 * endpoint shares nothing with a completion - no output limit, no temperature,
 * no reasoning. Those controls were being drawn here and did nothing at all.
 *
 * What the agent chooses instead is what belongs to the picture it was asked
 * for: the prompt, the aspect ratio, and whether it is editing something.
 *
 * Every control below is drawn from the chosen model rather than from a list of
 * ours. Most image models take no `quality` at all and under half take a
 * `resolution`, so a fixed set of pills is three settings that look identical
 * for forty-one models and mean something for seven of them.
 */
export function AgentImageSettings({
  models,
  config,
  onChange
}: {
  models: AgentImageModel[];
  config: AgentImageConfig;
  onChange: (patch: Partial<AgentImageConfig>) => void;
}): React.JSX.Element {
  const selected = models.find((m) => m.id === config.model) ?? null;

  /**
   * Switching model carries over the settings the new one shares and drops the
   * rest. Keeping them would leave a resolution set on a model with no
   * resolution parameter: invisible in this panel, and still in the request.
   */
  const chooseModel = (model: string | null): void => {
    const next = models.find((m) => m.id === model) ?? null;
    onChange(next === null ? { model } : supportedImageConfig({ ...config, model }, next));
  };

  return (
    <RoleCard
      title="Image agent"
      description="Generates and edits images on request. With none selected, the agent is not offered the tool at all."
      icon={<ImagePlus size={16} />}
    >
      <ModelPicker
        models={models}
        value={config.model}
        onChange={chooseModel}
        renderMeta={(model) => <ImageModelMeta model={model} />}
        allowNone
        noneLabel="None - image generation off"
      />

      {config.model !== null && selected === null && (
        <p className="text-xs text-amber-400">
          The images endpoint does not list this model. Pick another, or refresh the catalog below.
        </p>
      )}

      {selected !== null && (
        <>
          {selected.resolutions.length > 0 && (
            <OptionPills
              label="Resolution"
              hint="How large the image comes back. Bigger costs more and takes longer."
              options={selected.resolutions}
              value={config.resolution}
              onChange={(resolution) => onChange({ resolution })}
            />
          )}

          {selected.qualities.length > 0 && (
            <OptionPills
              label="Quality"
              hint="How much work the model puts into the render."
              options={selected.qualities}
              value={config.quality}
              onChange={(quality) => onChange({ quality })}
            />
          )}

          {selected.seed && (
            <SeedField value={config.seed} onChange={(seed) => onChange({ seed })} />
          )}

          <ModelLink id={selected.id} />
        </>
      )}
    </RoleCard>
  );
}

/**
 * What a row of the picker says about a model.
 *
 * Not price, which is the one thing the completions rows lead with: image
 * models are billed per megapixel or per image rather than per token, and
 * OpenRouter publishes that only per model per provider. A number in the shape
 * of the one above it that means something else is worse than no number, so the
 * price lives behind the link instead.
 */
function ImageModelMeta({ model }: { model: AgentImageModel }): React.JSX.Element {
  const facts = [
    model.resolutions.length > 0
      ? `up to ${model.resolutions[model.resolutions.length - 1]}`
      : null,
    model.maxReferences > 0
      ? `${model.maxReferences} reference${model.maxReferences === 1 ? '' : 's'}`
      : null,
    model.qualities.length > 0 ? 'quality' : null,
    model.seed ? 'seed' : null,
    model.streams ? 'streams' : null
  ].filter((fact) => fact !== null);

  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fleet-text-muted">
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </span>
  );
}

/** Where the pricing and the sample images are, since neither is shown here. */
function ModelLink({ id }: { id: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void window.fleet.shell.openExternal(`https://openrouter.ai/${id}`)}
      className="flex items-center gap-1 text-xs text-fleet-text-muted transition-colors hover:text-fleet-text-secondary focus-ring"
    >
      Pricing and samples on OpenRouter
      <ExternalLink size={11} />
    </button>
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
