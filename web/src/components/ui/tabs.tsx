import type { ComponentPropsWithoutRef } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../../lib/utils.js';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-line bg-surface-muted p-0.5 text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'inline-flex cursor-pointer items-center justify-center rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-panel data-[state=active]:text-ink data-[state=active]:shadow-2xs',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn('mt-3 focus-visible:outline-none', className)} {...props} />;
}
