import { useCallback, useState } from 'react';
import { SettingsNav } from './SettingsNav';
import type { SettingsSection } from './SettingsNav';
import { GeneralSection } from './GeneralSection';
import { WorkspacesSection } from './WorkspacesSection';
import { NotificationsSection } from './NotificationsSection';
import { SocketSection } from './SocketSection';
import { VisualizerSection } from './VisualizerSection';
import { UpdatesSection } from './UpdatesSection';
import { CopilotSection } from './CopilotSection';
import { AnnotateSection } from './AnnotateSection';
import { EnvSyncSection } from './EnvSyncSection';
import { LearningsSection } from './LearningsSection';
import { RemoteHostsSection } from './RemoteHostsSection';
import { DiagnosticsSection } from './DiagnosticsSection';

/**
 * What a settings page can be handed. Both are optional and most pages ignore
 * them; they exist so Copilot can send the user to the workspace row that owns
 * a connection instead of describing where to find it.
 */
export type SettingsSectionProps = {
  /** A workspace row the target section should open and scroll to. */
  focusWorkspaceId?: string;
  /** Move to another section, optionally aimed at one workspace. */
  onNavigate?: (section: SettingsSection, workspaceId?: string) => void;
};

const SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType<SettingsSectionProps>> = {
  general: GeneralSection,
  workspaces: WorkspacesSection,
  notifications: NotificationsSection,
  socket: SocketSection,
  visualizer: VisualizerSection,
  updates: UpdatesSection,
  copilot: CopilotSection,
  annotate: AnnotateSection,
  envSync: EnvSyncSection,
  remoteHosts: RemoteHostsSection,
  learnings: LearningsSection,
  diagnostics: DiagnosticsSection
};

export function SettingsTab(): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [focusWorkspaceId, setFocusWorkspaceId] = useState<string | undefined>(undefined);
  const SectionComponent = SECTION_COMPONENTS[activeSection];

  const navigate = useCallback((section: SettingsSection, workspaceId?: string) => {
    setActiveSection(section);
    setFocusWorkspaceId(workspaceId);
  }, []);

  return (
    <div className="flex h-full">
      <SettingsNav active={activeSection} onChange={(section) => navigate(section)} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[640px] mx-auto">
          <SectionComponent focusWorkspaceId={focusWorkspaceId} onNavigate={navigate} />
        </div>
      </div>
    </div>
  );
}
