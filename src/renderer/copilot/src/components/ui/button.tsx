import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900 disabled:pointer-events-none disabled:opacity-30',
  {
    variants: {
      variant: {
        default: 'bg-blue-600/30 text-blue-400 hover:bg-blue-600/50',
        destructive: 'bg-red-600/30 text-red-400 hover:bg-red-600/50',
        success: 'bg-green-600/30 text-green-400 hover:bg-green-600/50',
        outline: 'border border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
        ghost: 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800',
      },
      size: {
        default: 'px-2 py-1',
        sm: 'px-1.5 py-0.5 text-[10px]',
        icon: 'h-6 w-6',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
);
Button.displayName = 'Button';

export { Button, buttonVariants };
