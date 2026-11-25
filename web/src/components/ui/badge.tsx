import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-tight whitespace-nowrap tabular-nums',
  {
    variants: {
      variant: {
        neutral: 'border-line bg-surface-muted text-muted',
        ok: 'border-accent-line bg-accent-soft text-accent',
        warn: 'border-warn-line bg-warn-soft text-warn',
        bad: 'border-bad-line bg-bad-soft text-bad',
        wallet: 'border-accent-line bg-wallet-ink text-white',
        signal: 'border-obsidian-line bg-obsidian-raised text-signal',
        obsidian: 'border-obsidian-line bg-obsidian-raised text-obsidian-ink',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
