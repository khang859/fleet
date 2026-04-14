type Props = {
  onPick: (providerId: 'anthropic' | 'bedrock' | 'ollama') => void;
  onShowMore: () => void;
};

export function PiWelcomeStrip({ onPick, onShowMore }: Props): React.JSX.Element {
  return (
    <section className="rounded border border-blue-900/40 bg-blue-950/20 px-4 py-3 space-y-2">
      <h2 className="text-sm font-semibold text-neutral-100">Start here</h2>
      <p className="text-xs text-neutral-400">
        Pi needs at least one provider configured before you can run it in a tab.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onPick('anthropic')}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 text-left min-w-[140px]"
        >
          <div className="font-medium">Anthropic</div>
          <div className="text-xs text-neutral-500">Sign in with a Claude subscription</div>
        </button>
        <button
          type="button"
          onClick={() => onPick('bedrock')}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 text-left min-w-[140px]"
        >
          <div className="font-medium">Amazon Bedrock</div>
          <div className="text-xs text-neutral-500">Use your AWS account</div>
        </button>
        <button
          type="button"
          onClick={() => onPick('ollama')}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 text-left min-w-[140px]"
        >
          <div className="font-medium">Ollama (local)</div>
          <div className="text-xs text-neutral-500">Run models on this machine</div>
        </button>
        <button
          type="button"
          onClick={onShowMore}
          className="text-xs text-neutral-400 underline hover:text-neutral-200 self-center"
        >
          more providers ▸
        </button>
      </div>
    </section>
  );
}
