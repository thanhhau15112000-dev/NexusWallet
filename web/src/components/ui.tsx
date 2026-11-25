import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from './icons.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  Card as ShadcnCard,
  CardContent,
  CardHeader,
  CardTitle,
} from './ui/card.js';

export function Card(props: {
  title: string;
  titleIcon?: ReactNode;
  titleAction?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ShadcnCard className={props.className}>
      <CardHeader>
        <CardTitle>
          {props.titleIcon ? (
            <span className="inline-flex text-muted" aria-hidden="true">
              {props.titleIcon}
            </span>
          ) : null}
          <span>{props.title}</span>
          {props.titleAction ? <span className="ml-1">{props.titleAction}</span> : null}
        </CardTitle>
        {props.actions ? <div className="flex items-center gap-2">{props.actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-3">{props.children}</CardContent>
    </ShadcnCard>
  );
}

export function CopyAddressButton(props: { value: string; label: string; inverted?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setStatus('idle');
      resetTimer.current = null;
    }, 1800);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'h-6 w-6',
          props.inverted
            ? 'text-obsidian-muted hover:bg-obsidian-raised hover:text-obsidian-ink'
            : 'text-muted hover:text-ink',
        )}
        aria-label={props.label}
        title={props.label}
        onClick={() => void copy()}
      >
        {status === 'copied' ? (
          <Check size={13} className={props.inverted ? 'text-signal' : 'text-accent'} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </Button>
      {status === 'failed' ? (
        <span className="text-[11px] font-medium text-bad" role="status">
          Copy failed
        </span>
      ) : null}
    </span>
  );
}

export type PillTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'wallet';

export function Pill(props: { tone: string; children: ReactNode; className?: string }) {
  const variant: PillTone =
    props.tone === 'ok' ||
    props.tone === 'warn' ||
    props.tone === 'bad' ||
    props.tone === 'wallet'
      ? props.tone
      : 'neutral';
  return (
    <Badge variant={variant} className={props.className}>
      {props.children}
    </Badge>
  );
}

export function Mono(props: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={cn('font-mono text-xs tabular-nums', props.className)} title={props.title}>
      {props.children}
    </span>
  );
}

export function shorten(value: string, size = 4): string {
  return value.length <= size * 2 + 3 ? value : `${value.slice(0, size)}...${value.slice(-size)}`;
}

export function Empty(props: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-line bg-surface-muted/40 px-3 py-6 text-center text-xs text-muted">
      {props.children}
    </p>
  );
}
