import { useState } from 'react';
import { SettingsNav } from './SettingsNav';
import type { SettingsSection } from './SettingsNav';
import { GeneralSection } from './GeneralSection';
import { NotificationsSection } from './NotificationsSection';
import { SocketSection } from './SocketSection';
import { VisualizerSection } from './VisualizerSection';
import { UpdatesSection } from './UpdatesSection';
import { CopilotSection } from './CopilotSection';
import { AnnotateSection } from './AnnotateSection';
import { PiSection } from './pi/PiSection';
import { RuneSection } from './rune/RuneSection';
import { KanbanSection } from './kanban/KanbanSection';
import { EnvSyncSection } from './EnvSyncSection';
import { LearningsSection } from './LearningsSection';

const SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  general: GeneralSection,
  notifications: NotificationsSection,
  socket: SocketSection,
  visualizer: VisualizerSection,
  updates: UpdatesSection,
  copilot: CopilotSection,
  annotate: AnnotateSection,
  rune: RuneSection,
  pi: PiSection,
  kanban: KanbanSection,
  envSync: EnvSyncSection,
  learnings: LearningsSection
};

export function SettingsTab(): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const SectionComponent = SECTION_COMPONENTS[activeSection];

  return (
    <div className="flex h-full">
      <SettingsNav active={activeSection} onChange={setActiveSection} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[640px] mx-auto">
          <SectionComponent />
        </div>
      </div>
    </div>
  );
}
