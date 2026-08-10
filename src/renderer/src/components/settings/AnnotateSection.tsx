import { useSettingsStore } from '../../store/settings-store';

export function AnnotateSection(): React.JSX.Element {
  const { settings, updateSettings } = useSettingsStore();
  const retentionDays = settings?.annotate.retentionDays ?? 3;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-fleet-text mb-1">Annotations</h2>
        <p className="text-sm text-fleet-text-muted">
          Configure how webpage annotations are stored and cleaned up.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-fleet-text-secondary">Storage</h3>
        <div className="flex items-center justify-between">
          <label className="text-sm text-fleet-text-muted">Delete annotations older than</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(e) => {
                const days = Math.max(1, Math.min(365, Number(e.target.value) || 3));
                void updateSettings({ annotate: { retentionDays: days } });
              }}
              className="w-16 px-2 py-1 bg-fleet-surface-3 border border-fleet-border-strong rounded text-sm text-fleet-text text-center"
            />
            <span className="text-sm text-fleet-text-muted">days</span>
          </div>
        </div>
      </div>
    </div>
  );
}
