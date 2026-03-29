import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { Circle, CircleDot, Triangle, Square, Check } from 'lucide-react';

const badgeVariants = cva(
  'inline-flex items-center justify-center',
  {
    variants: {
      status: {
        idle: 'text-neutral-500',
        running: 'text-blue-400 animate-pulse',
        permission: 'text-amber-400 animate-pulse-amber',
        error: 'text-red-400',
        complete: 'text-green-400 animate-flash-green',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

function StatusIcon({ status }: { status: BadgeProps['status'] }): React.JSX.Element {
  const size = 10;
  switch (status) {
    case 'running': return <CircleDot size={size} />;
    case 'permission': return <Triangle size={size} />;
    case 'error': return <Square size={size} />;
    case 'complete': return <Check size={size} />;
    case 'idle':
    default: return <Circle size={size} />;
  }
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, status, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ status }), className)}
      role="status"
      aria-label={status ?? 'idle'}
      {...props}
    >
      <StatusIcon status={status} />
    </span>
  )
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
