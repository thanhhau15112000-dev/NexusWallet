import type { ComponentPropsWithoutRef, HTMLAttributes } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from '../icons.js';
import { cn } from '../../lib/utils.js';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent(
  props: ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
    closeLabel?: string;
    disableClose?: boolean;
  },
) {
  const { className, children, closeLabel = 'Close', disableClose = false, ...rest } = props;
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 text-ink shadow-lg focus:outline-none',
          className,
        )}
        {...rest}
      >
        {children}
        <RadixDialog.Close
          disabled={disableClose}
          aria-label={closeLabel}
          className="absolute right-3.5 top-3.5 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          <X size={15} aria-hidden="true" />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 space-y-1 pr-7', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentPropsWithoutRef<typeof RadixDialog.Title>) {
  return <RadixDialog.Title className={cn('text-base font-semibold tracking-tight text-ink', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentPropsWithoutRef<typeof RadixDialog.Description>) {
  return <RadixDialog.Description className={cn('text-xs text-muted', className)} {...props} />;
}
