import { Workflow } from 'lucide-react';
import { isRunActive, useWorkflowsStore } from '../../store/workflows-store';
import { ToolTabCard } from '../ToolTabCard';

const ICON_CLASS = { active: 'text-violet-400', idle: 'text-violet-400/60' };

function statusOf(active: number, waiting: number): string {
  if (waiting > 0) return `${waiting} needs you`;
  return active > 0 ? `${active} running` : 'none running';
}

export function WorkflowsTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const runs = useWorkflowsStore((s) => s.state.runs);
  const active = runs.filter(isRunActive);
  const waiting = active.filter((run) => run.state === 'needs-you').length;

  return (
    <ToolTabCard
      isActive={isActive}
      onClick={onClick}
      icon={Workflow}
      iconClass={ICON_CLASS}
      label="Workflows"
      status={statusOf(active.length, waiting)}
    />
  );
}
