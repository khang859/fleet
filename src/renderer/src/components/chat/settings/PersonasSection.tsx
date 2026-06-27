import { PersonaManager } from '../PersonaManager';
import { SectionShell } from './primitives';

export function PersonasSection(): React.JSX.Element {
  return (
    <SectionShell
      title="Personas"
      description="Reusable system prompts you can switch between per conversation."
    >
      <PersonaManager />
    </SectionShell>
  );
}
