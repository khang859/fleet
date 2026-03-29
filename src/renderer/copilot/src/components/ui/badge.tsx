import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

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

function statusIcon(status: BadgeProps['status']): string {
  switch (status) {
    case 'running': return '◎';
    case 'permission': return '△';
    case 'error': return '■';
    case 'complete': return '✓';
    case 'idle':
    default: return '○';
  }
}

function statusSize(status: BadgeProps['status']): string {
  switch (status) {
    case 'permission':
    case 'error':
      return 'text-[10px]';
    case 'running':
    case 'complete':
      return 'text-[8px]';
    case 'idle':
    default:
      return 'text-[6px]';
  }
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, status, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ status }), statusSize(status), className)}
      role="status"
      aria-label={status ?? 'idle'}
      {...props}
    >
      {statusIcon(status)}
    </span>
  )
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
