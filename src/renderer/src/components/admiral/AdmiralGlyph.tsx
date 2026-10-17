import { Compass } from 'lucide-react';

/** The Admiral's mark: a blue compass, wherever the Admiral is speaking or named. */
export function AdmiralGlyph({
  size,
  className = ''
}: {
  size: number;
  className?: string;
}): React.JSX.Element {
  return <Compass size={size} className={`text-blue-500 dark:text-blue-400 ${className}`} />;
}
