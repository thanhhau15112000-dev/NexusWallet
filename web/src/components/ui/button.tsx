import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-accent text-white hover:bg-accent-hover shadow-2xs disabled:border disabled:border-line disabled:bg-surface-muted disabled:text-muted disabled:shadow-none',
        secondary: 'border border-line-strong bg-surface-muted text-ink hover:bg-line/70 disabled:opacity-50',
        outline: 'border border-line-strong bg-panel text-ink hover:bg-surface-muted disabled:opacity-50',
        darkOutline:
          'border border-obsidian-line bg-obsidian-raised text-obsidian-ink hover:bg-obsidian-line/70 disabled:opacity-50',
        ghost: 'text-muted hover:bg-surface-muted hover:text-ink disabled:opacity-50',
        destructive: 'bg-bad text-white hover:bg-bad/90 disabled:opacity-50',
        destructiveOutline: 'border border-bad/35 bg-panel text-bad hover:bg-bad-soft disabled:opacity-50',
        link: 'text-accent underline-offset-4 hover:underline p-0 h-auto font-medium disabled:opacity-50',
      },
      size: {
        default: 'h-9 px-3.5 py-2',
        sm: 'h-8 rounded-md px-2.5 text-xs',
        lg: 'h-10 rounded-md px-4',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
