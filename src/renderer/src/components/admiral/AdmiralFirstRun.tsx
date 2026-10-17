import { useEffect, useState } from 'react';
import type { LocalEndpointConfig } from '../../../../shared/agent-endpoints';
import { localModelId, parseModelId } from '../../../../shared/agent-model-id';
import { useAgentStore } from '../../store/agent-store';
import { useSettingsStore } from '../../store/settings-store';
import { openSettings } from '../../store/settings-nav-store';
import { useAdmiralOnboardingStore } from '../../store/admiral-onboarding-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { EndpointDialog } from '../agent/settings/endpoints/EndpointDialog';
import { FirstRunView } from './FirstRunView';
import type { FirstRunModel } from './onboarding-view';

/**
 * The Admiral's first run: the model it thinks with, the crew runtimes
 * found on this Mac, and the GitHub CLI. Shown until there is a model and
 * the client has moved on to picking a project.
 */
export function AdmiralFirstRun({ onPick }: { onPick: () => void }): React.JSX.Element {
  const keyPresent = useAgentStore((s) => s.keyPresent);
  const saveKey = useAgentStore((s) => s.saveKey);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { preflight, checking, ghSkipped, checkPreflight, skipGh } = useAdmiralOnboardingStore();
  const [addingLocal, setAddingLocal] = useState(false);

  // Asked on open and again whenever the window comes back, so a `gh auth
  // login` or an install done elsewhere shows up without a click.
  useEffect(() => {
    void checkPreflight();
    const onFocus = (): void => void checkPreflight();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [checkPreflight]);

  const endpoints = settings?.ai.agent.localEndpoints ?? [];
  const chosen = settings?.agency.admiral.model || settings?.ai.agent.coding.model || '';
  const local = endpoints.find((e) => e.enabled);
  const model: FirstRunModel = keyPresent
    ? { kind: 'openrouter', model: modelName(chosen) }
    : local !== undefined
      ? { kind: 'local', model: modelName(chosen) || (local.name ?? local.baseUrl) }
      : { kind: 'none' };

  const addLocal = (endpoint: LocalEndpointConfig): void => {
    setAddingLocal(false);
    const first = endpoint.lastKnownModels.at(0);
    void updateSettings({
      ai: { agent: { localEndpoints: [...endpoints, { ...endpoint, enabled: true }] } },
      // A local model only helps if the Admiral is set to run on it.
      ...(first === undefined
        ? {}
        : { agency: { admiral: { model: localModelId(endpoint.id, first.wireId) } } })
    });
  };

  return (
    <>
      <FirstRunView
        preflight={preflight}
        checking={checking}
        model={model}
        ghSkipped={ghSkipped}
        onSaveKey={async (key) => {
          await saveKey(key);
          void checkPreflight();
        }}
        onUseLocal={() => setAddingLocal(true)}
        onChangeModel={() => openSettings('agencyAdmiral')}
        onGhLogin={() =>
          useWorkspaceStore
            .getState()
            .openResumeTab(window.fleet.homeDir, 'gh auth login', 'GitHub sign-in')
        }
        onCheckAgain={() => void checkPreflight()}
        onSkipGh={skipGh}
        onPick={onPick}
      />
      <EndpointDialog
        open={addingLocal}
        editing={null}
        takenUrls={endpoints.map((e) => e.baseUrl)}
        onCancel={() => setAddingLocal(false)}
        onSave={addLocal}
      />
    </>
  );
}

/** A model id as a person reads it: the wire id of a local model, the OpenRouter id otherwise. */
function modelName(id: string): string {
  if (id === '') return '';
  const parsed = parseModelId(id);
  return parsed.kind === 'local' ? parsed.wireId : parsed.id;
}
