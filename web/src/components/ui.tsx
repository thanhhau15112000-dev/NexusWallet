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

export function CopyAddressButton(props: { value: string; label: string }) {
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
        className="h-6 w-6 text-muted hover:text-ink"
        aria-label={props.label}
        title={props.label}
        onClick={() => void copy()}
      >
        {status === 'copied' ? (
          <Check size={13} className="text-accent" aria-hidden="true" />
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
    <span className={cn('text-xs tabular-nums', props.className)} title={props.title}>
      {props.children}
    </span>
  );
}

export function shorten(value: string, size = 4): string {
  return value.length <= size * 2 + 3 ? value : `${value.slice(0, size)}...${value.slice(-size)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

type DateInput = string | number | Date | null | undefined;

function parseValidDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Fixed-width local `YYYY-MM-DD HH:mm:ss` timestamp so log rows can be correlated across panels. */
export function formatDateTime(value: DateInput): string {
  const date = parseValidDate(value);
  if (!date) return '-';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Local timestamp with the UTC ISO value exposed on hover and as machine-readable `dateTime`. */
export function DateTime(props: { value: DateInput; className?: string }) {
  const date = parseValidDate(props.value);
  if (!date) return <span className={props.className}>-</span>;
  const iso = date.toISOString();
  return (
    <time dateTime={iso} title={iso} className={cn('tabular-nums', props.className)}>
      {formatDateTime(date)}
    </time>
  );
}

export function Empty(props: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-line bg-surface-muted/40 px-3 py-6 text-center text-xs text-muted">
      {props.children}
    </p>
  );
}
