import * as React from 'react';
import { cn } from '../../lib/utils.js';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm text-ink placeholder:text-muted/70 transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
