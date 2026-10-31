import { useEffect } from 'react';
import { History } from 'lucide-react';
import { useSessionsStore } from '../../store/sessions-store';
import { ToolTabCard } from '../ToolTabCard';

const ICON_CLASS = { active: 'text-blue-400', idle: 'text-blue-400/60' };

export function SessionsTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { sessions, isLoaded, load } = useSessionsStore();

  useEffect(() => {
    if (!isLoaded) void load();
  }, [isLoaded, load]);

  useEffect(() => {
    const cleanup = window.fleet.sessions.onChanged(() => void load());
    return cleanup;
  }, [load]);

  return (
    <ToolTabCard
      isActive={isActive}
      onClick={onClick}
      icon={History}
      iconClass={ICON_CLASS}
      label="Sessions"
      status={sessions.length > 0 ? `${sessions.length} saved` : 'none yet'}
    />
  );
}
